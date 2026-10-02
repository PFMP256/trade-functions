import { createHash } from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PublicDataStore } from '../src/public-data-store';
import { hash } from '../src/audit-store';
import type { EmploymentReport, EventCalendar, NumericDatum, Provenance } from '../../../packages/shared/src';
import type { PublicEvidence } from '../../../packages/data-providers/src/kraken-fx';

type Row = Record<string, unknown>;
type Ref = { path: string; collection: (name: string) => Collection; get: () => Promise<Doc> };
type Collection = { doc: (id: string) => Ref };
type Doc = { exists: boolean; data: () => Row | undefined };
type Transaction = { get: (ref: Ref) => Promise<Doc>; create: (ref: Ref, data: Row) => void; set: (ref: Ref, data: Row) => void };
/** Serialized atomic transactions, immutable create, read-before-write, and retry/commit fault injection. */
class PublicTransactionDatabase {
  readonly documents = new Map<string, Row>();
  activeTransactions = 0;
  callbackCalls = 0;
  retryNext = false;
  failNextCommit = false;
  private tail = Promise.resolve();
  private snapshot(path: string): Doc { const row = this.documents.get(path); return { exists: row !== undefined, data: () => row ? structuredClone(row) : undefined }; }
  collection(path: string): Collection { return { doc: id => this.ref(path + '/' + id) }; }
  private ref(path: string): Ref { return { path, collection: name => this.collection(path + '/' + name), get: async () => this.snapshot(path) }; }
  async runTransaction<T>(callback: (tx: Transaction) => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      const attempts = this.retryNext ? 2 : 1; this.retryNext = false;
      for (let attempt = 0; attempt < attempts; attempt++) {
        const staged = new Map<string, { data: Row; create: boolean }>();
        const tx: Transaction = {
          get: async ref => { if (staged.size) throw new Error('TRANSACTION_READ_AFTER_WRITE'); return this.snapshot(ref.path); },
          create: (ref, data) => {
            if (staged.has(ref.path)) throw new Error('DUPLICATE_TRANSACTION_CREATE');
            staged.set(ref.path, { data: structuredClone(data), create: true });
          },
          set: (ref, data) => { staged.set(ref.path, { data: structuredClone(data), create: false }); },
        };
        this.activeTransactions++; this.callbackCalls++;
        let output: T;
        try { output = await callback(tx); } finally { this.activeTransactions--; }
        if (attempt < attempts - 1) continue;
        if (this.failNextCommit) { this.failNextCommit = false; throw new Error('SIMULATED_FIRESTORE_COMMIT_FAILURE'); }
        for (const [path, operation] of staged) if (operation.create && this.documents.has(path)) throw new Error('ALREADY_EXISTS');
        for (const [path, operation] of staged) this.documents.set(path, operation.data);
        return output;
      }
      throw new Error('UNREACHABLE');
    } finally { release(); }
  }
  firestore(): Firestore { return this as unknown as Firestore; }
}

const first = '2026-10-02T12:31:00.000Z';
const later = '2026-10-02T12:36:00.000Z';
const proof = (content: string): PublicEvidence => ({ content, sha256: createHash('sha256').update(content).digest('hex') });
function provenance(at: string, revision: string, evidence: PublicEvidence, sourceId = 'kraken-usdt-usd'): Provenance {
  return { sourceId, sourceUrl: sourceId === 'kraken-usdt-usd' ? 'https://api.kraken.com/0/public/Trades?pair=USDTUSD&count=1' : 'https://www.bls.gov/news.release/empsit.nr0.htm',
    observedAt: first, publishedAt: null, firstSeenAt: at, availableAt: at, fetchedAt: at, revision,
    verified: true, synthetic: false, conflicts: [], evidenceSha256: evidence.sha256 };
}
function numeric(at = first, revision = 'trade-100', value = '1.002'): { data: NumericDatum; evidence: PublicEvidence[] } {
  const item = proof(JSON.stringify({ revision, value }));
  return { data: { value, unit: 'USD_PER_USDT', seriesId: 'USD_USDT', period: '2026-10-02', provenance: provenance(at, revision, item) }, evidence: [item] };
}
function employment(at = first, revision = 'report-r1'): { data: EmploymentReport; evidence: PublicEvidence[] } {
  const item = proof('Synthetic official response: ' + revision);
  const p = provenance(at, revision, item, 'bls-public-employment'); p.observedAt = at;
  const datum = (value: string, unit: string, seriesId: string): NumericDatum => ({ value, unit, seriesId, period: '2026-09', provenance: { ...p } });
  return { data: { eventId: 'nfp-2026-09', period: '2026-09', releasedAtUtc: at, provenance: p,
    nfp: datum('90000', 'persons', 'US_NFP_CHANGE'), unemployment: datum('4.2', 'percent', 'US_UNEMPLOYMENT_RATE'), wages: datum('0.2', 'percent_mom', 'US_AHE_MOM') }, evidence: [item] };
}
const rootPath = (key: string): string => 'publicData/' + hash(key);
const revisionPath = (key: string, revision: string): string => rootPath(key) + '/revisions/' + hash(revision);

afterEach(() => vi.unstubAllGlobals());
describe('public source archive transaction and availability semantics', () => {
  it('archives content and first semantic revision atomically before returning usable data', async () => {
    const db = new PublicTransactionDatabase(); const store = new PublicDataStore(db.firestore()); const { data, evidence } = numeric();
    const output = await store.record('fx', data, evidence);
    expect(output).toEqual(data); expect(output).not.toBe(data);
    expect(db.documents.get('sourceEvidence/' + evidence[0]!.sha256)).toMatchObject({ sha256: evidence[0]!.sha256, content: evidence[0]!.content, receivedAt: first });
    expect(db.documents.get(revisionPath('fx', data.provenance.revision))).toEqual({ key: 'fx', data });
    expect(await store.previous<NumericDatum>('fx')).toEqual(output);
  });
  it('same revision preserves firstSeenAt and availableAt while fetchedAt advances', async () => {
    const db = new PublicTransactionDatabase(); const store = new PublicDataStore(db.firestore());
    const original = numeric(); const refreshed = numeric(later);
    await store.record('fx', original.data, original.evidence);
    const output = await store.record('fx', refreshed.data, refreshed.evidence);
    expect(output.provenance).toMatchObject({ firstSeenAt: first, availableAt: first, fetchedAt: later, observedAt: first });
    expect((db.documents.get(revisionPath('fx', 'trade-100'))?.data as NumericDatum).provenance.fetchedAt).toBe(first);
    expect(refreshed.data.provenance.firstSeenAt).toBe(later); // Caller input is never mutated.
  });
  it('same employment revision freezes release and nested availability even if previous read raced', async () => {
    const db = new PublicTransactionDatabase(); const store = new PublicDataStore(db.firestore());
    const a = employment(); const b = employment(later);
    await store.record('employment', a.data, a.evidence);
    const output = await store.record('employment', b.data, b.evidence);
    expect(output.releasedAtUtc).toBe(first);
    for (const p of [output.provenance, output.nfp!.provenance, output.unemployment!.provenance, output.wages!.provenance]) {
      expect(p.firstSeenAt).toBe(first); expect(p.availableAt).toBe(first); expect(p.fetchedAt).toBe(later);
    }
  });
  it('a new employment revision retains the first observed release but has its own later availability', async () => {
    const db = new PublicTransactionDatabase(); const store = new PublicDataStore(db.firestore());
    const a = employment(); const b = employment(later, 'report-r2'); b.data.nfp!.value = '85000';
    await store.record('employment', a.data, a.evidence);
    const output = await store.record('employment', b.data, b.evidence);
    expect(output.releasedAtUtc).toBe(first);
    expect(output.provenance).toMatchObject({ revision: 'report-r2', firstSeenAt: later, availableAt: later });
    expect(output.nfp!.provenance.availableAt).toBe(later);
    expect((db.documents.get(revisionPath('employment', 'report-r1'))?.data as EmploymentReport).nfp!.value).toBe('90000');
  });
  it('different employment event does not inherit the older event release time', async () => {
    const db = new PublicTransactionDatabase(); const store = new PublicDataStore(db.firestore());
    const a = employment(); const b = employment(later, 'report-r2'); b.data.eventId = 'nfp-2026-10'; b.data.period = '2026-10';
    await store.record('employment', a.data, a.evidence);
    expect((await store.record('employment', b.data, b.evidence)).releasedAtUtc).toBe(later);
  });
  it('late completion archives its revision without replacing a newer latest observation', async () => {
    const db = new PublicTransactionDatabase(); const store = new PublicDataStore(db.firestore());
    const newer = numeric(later, 'trade-101', '1.001'); const older = numeric(first, 'trade-100', '1.002');
    await store.record('fx', newer.data, newer.evidence);
    const returned = await store.record('fx', older.data, older.evidence);
    expect(returned).toEqual(newer.data); // An overlapping slower read cannot feed a superseded revision to the engine.
    expect(returned).not.toBe(newer.data);
    expect((await store.previous<NumericDatum>('fx'))!.provenance.revision).toBe('trade-101');
    expect(db.documents.has(revisionPath('fx', 'trade-100'))).toBe(true);
  });
  it('concurrent equal revisions converge to one immutable firstSeen and preserve newer fetch', async () => {
    const db = new PublicTransactionDatabase(); const store = new PublicDataStore(db.firestore());
    const a = numeric(); const b = numeric(later);
    const [one, two] = await Promise.all([store.record('fx', a.data, a.evidence), store.record('fx', b.data, b.evidence)]);
    expect(one.provenance.firstSeenAt).toBe(first); expect(two.provenance.firstSeenAt).toBe(first);
    expect((await store.previous<NumericDatum>('fx'))?.provenance.fetchedAt).toBe(later);
    expect([...db.documents.keys()].filter(path => path.includes('/revisions/'))).toHaveLength(1);
  });
  it('a checksum mismatch is rejected before any transaction or write', async () => {
    const db = new PublicTransactionDatabase(); const store = new PublicDataStore(db.firestore()); const input = numeric();
    input.evidence[0]!.content += 'tampered';
    await expect(store.record('fx', input.data, input.evidence)).rejects.toThrow('PUBLIC_EVIDENCE_HASH_MISMATCH');
    expect(db.callbackCalls).toBe(0); expect(db.documents.size).toBe(0);
  });
  it('empty or unrelated valid evidence cannot back a claimed source digest', async () => {
    for (const evidence of [[], [proof('Unrelated document')]]) {
      const db = new PublicTransactionDatabase(); const store = new PublicDataStore(db.firestore());
      await expect(store.record('fx', numeric().data, evidence)).rejects.toThrow();
      expect(db.documents.size).toBe(0);
    }
  });
  it('requires proof for nested numeric data as well as the outer employment report', async () => {
    const db = new PublicTransactionDatabase(); const store = new PublicDataStore(db.firestore()); const input = employment();
    input.data.nfp!.provenance.evidenceSha256 = proof('different nested source').sha256;
    await expect(store.record('employment', input.data, input.evidence)).rejects.toThrow(); expect(db.documents.size).toBe(0);
  });
  it('same revision with a different value is rejected inside the transaction despite stale previous()', async () => {
    const db = new PublicTransactionDatabase(); const store = new PublicDataStore(db.firestore()); const a = numeric(); const b = numeric(later, 'trade-100', '0.1');
    await store.record('fx', a.data, a.evidence);
    await expect(store.record('fx', b.data, b.evidence)).rejects.toThrow();
    expect((await store.previous<NumericDatum>('fx'))!.value).toBe(a.data.value);
    expect(db.documents.has('sourceEvidence/' + b.evidence[0]!.sha256)).toBe(false);
  });
  it('a trade revision cannot rejuvenate the actual trade observation time', async () => {
    const db = new PublicTransactionDatabase(); const store = new PublicDataStore(db.firestore()); const a = numeric(); const b = numeric(later);
    await store.record('fx', a.data, a.evidence); b.data.provenance.observedAt = later;
    await expect(store.record('fx', b.data, b.evidence)).rejects.toThrow();
    expect((await store.previous<NumericDatum>('fx'))!.provenance.observedAt).toBe(first);
  });
  it('one document shared by multiple nested data is archived once even if supplied twice', async () => {
    const db = new PublicTransactionDatabase(); const store = new PublicDataStore(db.firestore()); const input = employment();
    await store.record('employment', input.data, [input.evidence[0]!, input.evidence[0]!]);
    expect([...db.documents.keys()].filter(path => path.startsWith('sourceEvidence/'))).toHaveLength(1);
  });
  it('calendar observations may advance on a new verified HTTP read of the same document', async () => {
    const db = new PublicTransactionDatabase(); const store = new PublicDataStore(db.firestore()); const item = proof('Synthetic October calendar');
    const calendar: EventCalendar = { eventId: 'nfp-2026-09', period: '2026-09', scheduledAtUtc: '2026-10-02T12:30:00.000Z', provenance: provenance(first, 'calendar-r1', item, 'bls-public-calendar') };
    calendar.provenance.sourceUrl = 'https://www.bls.gov/schedule/2026/10_sched.htm';
    await store.record('calendar', calendar, [item]);
    const updated = structuredClone(calendar); updated.provenance.observedAt = later; updated.provenance.fetchedAt = later; updated.provenance.firstSeenAt = later; updated.provenance.availableAt = later;
    const output = await store.record('calendar', updated, [item]);
    expect(output.provenance).toMatchObject({ firstSeenAt: first, availableAt: first, observedAt: later, fetchedAt: later });
  });
  it('a Firestore retry performs no network work and still creates each proof once', async () => {
    const fetch = vi.fn(async () => { throw new Error('Network is forbidden in archive transactions'); }); vi.stubGlobal('fetch', fetch);
    const db = new PublicTransactionDatabase(); db.retryNext = true;
    const store = new PublicDataStore(db.firestore()); const input = employment();
    await store.record('employment', input.data, input.evidence);
    expect(db.callbackCalls).toBe(2); expect(fetch).not.toHaveBeenCalled();
    expect([...db.documents.keys()].filter(path => path.startsWith('sourceEvidence/'))).toHaveLength(1);
  });
  it('commit failure returns no usable datum and leaves neither latest, revision nor evidence', async () => {
    const db = new PublicTransactionDatabase(); db.failNextCommit = true;
    const store = new PublicDataStore(db.firestore()); const input = numeric();
    await expect(store.record('fx', input.data, input.evidence)).rejects.toThrow('SIMULATED_FIRESTORE_COMMIT_FAILURE');
    expect(db.documents.size).toBe(0); expect(await store.previous('fx')).toBeNull();
  });
});
