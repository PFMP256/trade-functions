import { createHash, randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { makePublicFixture } from '../../../fixtures/public';
import { evaluateScenario } from '../../../packages/strategies';
import { PUBLIC_NFP_STRATEGY_ID, type EmploymentReport, type NumericDatum, type Provenance } from '../../../packages/shared/src';
import type { PublicEvidence } from '../../../packages/data-providers/src/kraken-fx';
import { PublicDataStore } from '../src/public-data-store';
import { AuditStore, hash } from '../src/audit-store';

// No Firebase app or connection is created unless an emulator was explicitly configured.
// The project is always the nonproduction demo project, never inherited from deployment settings.
const enabled = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const first = '2026-10-02T12:31:00.000Z';
const later = '2026-10-02T12:36:00.000Z';
function evidence(content: string): PublicEvidence { return { content, sha256: createHash('sha256').update(content).digest('hex') }; }
function provenance(at: string, revision: string, proof: PublicEvidence, sourceId = 'kraken-usdt-usd'): Provenance {
  return { sourceId, sourceUrl: sourceId === 'kraken-usdt-usd' ? 'https://api.kraken.com/0/public/Trades?pair=USDTUSD&count=1' : 'https://www.bls.gov/news.release/empsit.nr0.htm',
    observedAt: first, publishedAt: null, firstSeenAt: at, availableAt: at, fetchedAt: at,
    revision, verified: true, synthetic: true, conflicts: [], evidenceSha256: proof.sha256 };
}
function fx(seed: string, at = first, revision = 'trade-1', value = '1.001'): { data: NumericDatum; evidence: PublicEvidence[] } {
  const proof = evidence(JSON.stringify({ explicitlySyntheticFirestoreTest: seed, revision, value }));
  return { data: { value, unit: 'USD_PER_USDT', seriesId: 'USD_USDT', period: '2026-10-02', provenance: provenance(at, revision, proof) }, evidence: [proof] };
}
function employment(seed: string, at = first, revision = 'report-1', nfp = '90000'): { data: EmploymentReport; evidence: PublicEvidence[] } {
  const proof = evidence(JSON.stringify({ explicitlySyntheticFirestoreTest: seed, revision, nfp }));
  const p = provenance(at, revision, proof, 'bls-public-employment'); p.observedAt = at;
  const datum = (value: string, unit: string, seriesId: string): NumericDatum => ({ value, unit, seriesId, period: '2026-09', provenance: { ...p } });
  return { data: { eventId: 'synthetic-nfp-' + seed, period: '2026-09', releasedAtUtc: at, provenance: p,
    nfp: datum(nfp, 'persons', 'US_NFP_CHANGE'), unemployment: datum('4.2', 'percent', 'US_UNEMPLOYMENT_RATE'), wages: datum('0.2', 'percent_mom', 'US_AHE_MOM') }, evidence: [proof] };
}

describe.skipIf(!enabled)('Public strategy Firestore emulator archive and canonical decisions (never production)', () => {
  const app = enabled ? initializeApp({ projectId: 'demo-trade-functions' }, 'public-data-test-' + randomUUID()) : undefined;
  const db = app ? getFirestore(app) : undefined;
  afterAll(async () => { if (db) await db.terminate(); if (app) await deleteApp(app); });

  it('atomically archives evidence, immutable revision and latest before returning a public datum', async () => {
    const key = 'emulator-fx-' + randomUUID(); const input = fx(key); const store = new PublicDataStore(db!);
    const output = await store.record(key, input.data, input.evidence);
    const root = db!.collection('publicData').doc(hash(key));
    const [latest, revision, proof] = await Promise.all([
      root.get(), root.collection('revisions').doc(hash(input.data.provenance.revision)).get(),
      db!.collection('sourceEvidence').doc(input.evidence[0]!.sha256).get(),
    ]);
    expect(output).toEqual(input.data); expect(latest.data()?.data).toEqual(output); expect(revision.data()?.data).toEqual(output);
    expect(proof.data()).toMatchObject({ sha256: input.evidence[0]!.sha256, content: input.evidence[0]!.content, receivedAt: first });
    expect(await store.previous<NumericDatum>(key)).toEqual(output);
  }, 30000);

  it('bad or unlinked evidence leaves no root, revision or proof documents', async () => {
    const store = new PublicDataStore(db!);
    for (const failure of ['wrong-hash', 'missing-proof', 'nested-unlinked'] as const) {
      const key = 'emulator-invalid-' + randomUUID(); const input = employment(key);
      if (failure === 'wrong-hash') input.evidence[0]!.content += 'tampered';
      if (failure === 'nested-unlinked') input.data.nfp!.provenance.evidenceSha256 = evidence('unrelated-' + key).sha256;
      const supplied = failure === 'missing-proof' ? [] : input.evidence;
      await expect(store.record(key, input.data, supplied)).rejects.toThrow(failure === 'wrong-hash' ? 'PUBLIC_EVIDENCE_HASH_MISMATCH' : 'PUBLIC_SOURCE_EVIDENCE_MISSING');
      const root = db!.collection('publicData').doc(hash(key));
      const [head, revisions, proof] = await Promise.all([root.get(), root.collection('revisions').get(), db!.collection('sourceEvidence').doc(input.evidence[0]!.sha256).get()]);
      expect(head.exists).toBe(false); expect(revisions.empty).toBe(true); expect(proof.exists).toBe(false);
    }
  }, 30000);

  it('concurrent identical revisions preserve first availability and create a shared proof once', async () => {
    const key = 'emulator-concurrent-' + randomUUID(); const store = new PublicDataStore(db!);
    const initial = fx(key); await store.record(key, initial.data, initial.evidence);
    const inputs = ['2026-10-02T12:34:00.000Z', '2026-10-02T12:35:00.000Z', later].map(time => fx(key, time));
    const results = await Promise.all(inputs.map(input => store.record(key, input.data, [input.evidence[0]!, input.evidence[0]!])));
    for (const result of results) expect(result.provenance).toMatchObject({ firstSeenAt: first, availableAt: first, observedAt: first });
    const root = db!.collection('publicData').doc(hash(key));
    const versions = await root.collection('revisions').get(); expect(versions.size).toBe(1);
    expect(versions.docs[0]!.data().data.provenance.fetchedAt).toBe(first);
    expect((await store.previous<NumericDatum>(key))?.provenance.fetchedAt).toBe(later);
    expect((await db!.collection('sourceEvidence').doc(initial.evidence[0]!.sha256).get()).data()?.receivedAt).toBe(first);
  }, 30000);

  it('concurrent contradictory values for one revision allow exactly one canonical value and proof', async () => {
    const key = 'emulator-conflicting-' + randomUUID(); const store = new PublicDataStore(db!);
    const candidates = [fx(key, first, 'trade-1', '1.001'), fx(key, first, 'trade-1', '0.995')];
    const results = await Promise.allSettled(candidates.map(input => store.record(key, input.data, input.evidence)));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejection = results.find(result => result.status === 'rejected');
    if (!rejection || rejection.status !== 'rejected') throw new Error('Expected one revision conflict');
    expect(String(rejection.reason)).toContain('PUBLIC_REVISION_CONFLICT');
    const winnerIndex = results.findIndex(result => result.status === 'fulfilled'); const winner = candidates[winnerIndex]!;
    const loser = candidates[1 - winnerIndex]!;
    expect((await store.previous<NumericDatum>(key))?.value).toBe(winner.data.value);
    expect((await db!.collection('publicData').doc(hash(key)).collection('revisions').get()).size).toBe(1);
    expect((await db!.collection('sourceEvidence').doc(winner.evidence[0]!.sha256).get()).exists).toBe(true);
    expect((await db!.collection('sourceEvidence').doc(loser.evidence[0]!.sha256).get()).exists).toBe(false);
  }, 30000);

  it('a slower old revision is retained for audit but cannot replace or return an older latest datum', async () => {
    const key = 'emulator-late-' + randomUUID(); const store = new PublicDataStore(db!);
    const newer = fx(key, later, 'trade-2', '1.002'); const older = fx(key, first, 'trade-1', '1.001');
    await store.record(key, newer.data, newer.evidence);
    const returned = await store.record(key, older.data, older.evidence);
    expect(returned).toEqual(newer.data); expect(await store.previous<NumericDatum>(key)).toEqual(newer.data);
    const oldVersion = await db!.collection('publicData').doc(hash(key)).collection('revisions').doc(hash('trade-1')).get();
    expect(oldVersion.data()?.data).toEqual(older.data);
    expect((await db!.collection('sourceEvidence').doc(older.evidence[0]!.sha256).get()).exists).toBe(true);
  }, 30000);

  it('employment refresh and later corrections preserve original release without backdating revision availability', async () => {
    const key = 'emulator-employment-' + randomUUID(); const store = new PublicDataStore(db!);
    const initial = employment(key); const refresh = employment(key, '2026-10-02T12:34:00.000Z'); const correction = employment(key, later, 'report-2', '85000');
    await store.record(key, initial.data, initial.evidence);
    const refreshed = await store.record(key, refresh.data, refresh.evidence);
    expect(refreshed.releasedAtUtc).toBe(first);
    expect(refreshed.nfp!.provenance).toMatchObject({ firstSeenAt: first, availableAt: first, observedAt: first, fetchedAt: refresh.data.provenance.fetchedAt });
    const corrected = await store.record(key, correction.data, correction.evidence);
    expect(corrected.releasedAtUtc).toBe(first); expect(corrected.nfp!.value).toBe('85000');
    expect(corrected.provenance).toMatchObject({ firstSeenAt: later, availableAt: later, revision: 'report-2' });
    expect(corrected.nfp!.provenance.availableAt).toBe(later);
    const original = await db!.collection('publicData').doc(hash(key)).collection('revisions').doc(hash('report-1')).get();
    expect(original.data()?.data).toEqual(initial.data);
  }, 30000);

  it('freezes and finalizes the public strategy identity with its exact snapshot under real transactions', async () => {
    const store = new AuditStore(db!); const fixture = makePublicFixture(); const now = Date.parse(fixture.now);
    fixture.config.scenarioId = 'emulator-public-strategy-' + randomUUID();
    const evaluationId = randomUUID(); const snapshot = fixture.snapshot;
    const saved = await store.snapshot(snapshot); const evaluated = evaluateScenario(snapshot, fixture.config, fixture.now);
    expect(evaluated.strategyId).toBe(PUBLIC_NFP_STRATEGY_ID); expect(evaluated.decision).toBe('LONG');
    const evaluation = { ...evaluated, evaluationId, snapshot: { ...evaluated.snapshot, ...saved } };
    const claims = await Promise.all(['worker-a', 'worker-b'].map(owner => store.prepare({ evaluation, snapshot, scheduledAtUtc: fixture.now, owner, nowMs: now })));
    expect(claims.filter(claim => claim.status === 'ACQUIRED')).toHaveLength(1);
    expect(claims.filter(claim => claim.status === 'BUSY')).toHaveLength(1);
    const winner = claims.find(claim => claim.status === 'ACQUIRED');
    if (!winner || winner.status !== 'ACQUIRED') throw new Error('Missing canonical public-strategy claim');
    const final = await store.finalize({ ...winner.evaluation, execution: { status: 'DRY_RUN', executorId: 'bybit-linear-executor-v1' } }, fixture.now, winner.lease, now + 1);
    expect(final.strategyId).toBe(PUBLIC_NFP_STRATEGY_ID); expect(final.snapshot.hash).toBe(hash(snapshot));
    expect((await store.read(evaluationId))?.strategyId).toBe(PUBLIC_NFP_STRATEGY_ID);
    expect((await db!.collection('latest').doc(hash(fixture.config.scenarioId)).get()).data()?.evaluationId).toBe(evaluationId);
  }, 30000);
});
