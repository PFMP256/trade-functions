import { createHash } from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { evaluationSchema, snapshotSchema, type Evaluation, type Snapshot } from '../../../packages/shared/src';

export function hash(value: unknown): string {
  function canonical(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canonical(x)]));
    return v;
  }
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
export function jsonValue<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
export interface AuditRecord { evaluationId: string; scenarioId: string; configHash: string; evaluatedAtUtc: string; [key: string]: unknown; }
export interface EvaluationLease { evaluationId: string; owner: string; fence: number; expiresAtMs: number; }
export interface EvaluationPreparation {
  evaluation: Evaluation; snapshot: Snapshot; scheduledAtUtc: string; owner: string; nowMs: number;
}
export type PreparedEvaluation =
  | { status: 'COMPLETE'; evaluation: Evaluation }
  | { status: 'BUSY'; evaluation: Evaluation }
  | { status: 'ACQUIRED'; evaluation: Evaluation; snapshot: Snapshot; lease: EvaluationLease; recovered: boolean };
const EVALUATION_CLAIM_TTL_MS = 240_000;
function decisionDigest(record: Evaluation): string { return hash({ ...record, execution: {} }); }
export class AuditStore {
  constructor(private readonly db: Firestore) {}
  evaluationKey(scenarioId: string, configHash: string, schedule: string): string { return hash({scenarioId, configHash, schedule}); }
  async read(id: string): Promise<AuditRecord | undefined> {
    const data = (await this.db.collection('evaluations').doc(id).get()).data();
    if (!data) return undefined;
    const {scheduledAtUtc: _schedule, ...record} = data;
    return record as AuditRecord;
  }
  async snapshot(snapshot: unknown): Promise<{hash: string; location: string}> {
    const digest = hash(snapshot);
    const ref = this.db.collection('snapshots').doc(digest);
    await this.db.runTransaction(async tx => { const old = await tx.get(ref); if (!old.exists) tx.create(ref, { snapshot: jsonValue(snapshot), hash: digest }); });
    return { hash: digest, location: ref.path };
  }
  /**
   * Atomically freezes the exact decision AND input snapshot before an exchange side effect.
   * A losing worker cannot substitute its newly fetched data for the winning canonical decision.
   * Reclaim only changes lease metadata; the original evaluation and snapshot remain immutable.
   */
  async prepare(input: EvaluationPreparation): Promise<PreparedEvaluation> {
    const evaluation = evaluationSchema.parse(input.evaluation);
    const snapshot = snapshotSchema.parse(input.snapshot);
    if (!Number.isFinite(input.nowMs) || !input.owner || !Number.isFinite(Date.parse(input.scheduledAtUtc))) throw new Error('INVALID_EVALUATION_CLAIM');
    if (evaluation.snapshot.hash !== hash(snapshot) || evaluation.snapshot.snapshotId !== snapshot.snapshotId) throw new Error('EVALUATION_SNAPSHOT_MISMATCH');
    const finalRef = this.db.collection('evaluations').doc(evaluation.evaluationId);
    const draftRef = this.db.collection('evaluationDrafts').doc(evaluation.evaluationId);
    return this.db.runTransaction(async tx => {
      const [finalDoc, draftDoc] = await Promise.all([tx.get(finalRef), tx.get(draftRef)]);
      if (finalDoc.exists) {
        const { scheduledAtUtc: _schedule, ...record } = finalDoc.data()!;
        return { status: 'COMPLETE', evaluation: evaluationSchema.parse(record) };
      }
      const prior = draftDoc.data();
      const canonical = prior ? evaluationSchema.parse(prior.evaluation) : evaluation;
      if (prior && (canonical.configHash !== evaluation.configHash || prior.scheduledAtUtc !== input.scheduledAtUtc ||
          canonical.evaluationId !== evaluation.evaluationId)) throw new Error('EVALUATION_DRAFT_IDENTITY_MISMATCH');
      if (prior && Number(prior.expiresAtMs) > input.nowMs) return { status: 'BUSY', evaluation: canonical };
      const lease: EvaluationLease = { evaluationId: evaluation.evaluationId, owner: input.owner,
        fence: Number(prior?.fence ?? 0) + 1, expiresAtMs: input.nowMs + EVALUATION_CLAIM_TTL_MS };
      if (prior) tx.update(draftRef, { ...lease, claimedAtUtc: new Date(input.nowMs).toISOString() });
      else tx.create(draftRef, jsonValue({ ...lease, claimedAtUtc: new Date(input.nowMs).toISOString(),
        preparedAtUtc: new Date(input.nowMs).toISOString(), scheduledAtUtc: input.scheduledAtUtc,
        decisionHash: decisionDigest(evaluation), evaluation, snapshot }));
      return { status: 'ACQUIRED', evaluation: canonical,
        snapshot: prior ? snapshotSchema.parse(prior.snapshot) : snapshot, lease, recovered: Boolean(prior) };
    });
  }
  /** Execution is the only mutable output of a prepared decision; final evaluations and latest are atomic. */
  async finalize(recordInput: Evaluation, scheduledAtUtc: string, lease: EvaluationLease, nowMs: number): Promise<Evaluation> {
    const record = evaluationSchema.parse(recordInput);
    if (record.evaluationId !== lease.evaluationId) throw new Error('EVALUATION_CLAIM_IDENTITY_MISMATCH');
    const ref = this.db.collection('evaluations').doc(record.evaluationId);
    const draftRef = this.db.collection('evaluationDrafts').doc(record.evaluationId);
    const latest = this.db.collection('latest').doc(hash(record.scenarioId));
    return this.db.runTransaction(async tx => {
      const [draftDoc, old, current] = await Promise.all([tx.get(draftRef), tx.get(ref), tx.get(latest)]);
      const draft = draftDoc.data();
      if (!draft || draft.owner !== lease.owner || draft.fence !== lease.fence || Number(draft.expiresAtMs) <= nowMs) throw new Error('EVALUATION_CLAIM_LOST');
      if (draft.scheduledAtUtc !== scheduledAtUtc || draft.decisionHash !== decisionDigest(record)) throw new Error('EVALUATION_CANONICAL_DECISION_MISMATCH');
      if (old.exists) {
        const { scheduledAtUtc: _schedule, ...existing } = old.data()!;
        return evaluationSchema.parse(existing);
      }
      const data = jsonValue({ ...record, scheduledAtUtc });
      tx.create(ref, data);
      tx.update(draftRef, { finalizedAtUtc: new Date(nowMs).toISOString() });
      const prior = current.data();
      if (!prior || Date.parse(scheduledAtUtc) > Date.parse(prior.scheduledAtUtc as string) ||
          (scheduledAtUtc === prior.scheduledAtUtc && record.evaluatedAtUtc > String(prior.evaluatedAtUtc))) tx.set(latest, data);
      return record;
    });
  }
  async save(record: AuditRecord, scheduledAtUtc: string): Promise<AuditRecord> {
    const ref = this.db.collection('evaluations').doc(record.evaluationId);
    const latest = this.db.collection('latest').doc(hash(record.scenarioId));
    return this.db.runTransaction(async tx => {
      const [old, current, draft] = await Promise.all([tx.get(ref), tx.get(latest), tx.get(this.db.collection('evaluationDrafts').doc(record.evaluationId))]);
      if (old.exists) { const {scheduledAtUtc: _schedule, ...existing} = old.data()!; return existing as AuditRecord; }
      if (draft.exists) throw new Error('PREPARED_EVALUATION_REQUIRES_FINALIZE');
      const data = jsonValue({...record, scheduledAtUtc});
      tx.create(ref, data);
      const prior = current.data();
      if (!prior || Date.parse(scheduledAtUtc) > Date.parse(prior.scheduledAtUtc as string) || (scheduledAtUtc === prior.scheduledAtUtc && record.evaluatedAtUtc > String(prior.evaluatedAtUtc))) tx.set(latest, data);
      return record;
    });
  }
}
