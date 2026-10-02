import { describe, expect, it, vi } from 'vitest';
import { type Provenance, type Quote } from '../../shared/src';
import {
  BybitMarketDataProvider, PublicJsonHttpClient, createUsEquitiesCalendar2026, resolveLatestClosedSession,
  normalizeEtfCells, parseEtfCell, emptyStructuredFeed, validateStructuredFeed, selectAsOfVersion,
  assembleSnapshot, type AllowedSource, type StructuredFeed,
} from '../src';

const NOW = '2026-10-02T12:50:00.000Z';
function provenance(changes: Partial<Provenance> = {}): Provenance {
  return { sourceId: 'trusted', sourceUrl: 'https://source.example/data', observedAt: '2026-10-01T20:00:00.000Z',
    publishedAt: null, firstSeenAt: '2026-10-01T20:05:00.000Z', availableAt: '2026-10-01T20:05:00.000Z',
    fetchedAt: '2026-10-01T20:05:00.000Z', revision: 'v1', verified: true, synthetic: false, conflicts: [],
    evidenceSha256: 'a'.repeat(64), ...changes };
}
const allowedSources: AllowedSource[] = [{ sourceId: 'trusted', allowedOrigins: ['https://source.example'],
  usageApproved: true, allowedKinds: ['calendar', 'employment', 'consensus', 'treasury', 'etf', 'marketCalendar', 'usdPerUsdt'] }];
function feed(): StructuredFeed {
  return { ...emptyStructuredFeed(), calendar: { eventId: 'nfp-sep-2026', period: '2026-09', scheduledAtUtc: '2026-10-02T12:30:00.000Z',
    provenance: provenance() },
    consensus: { eventId: 'nfp-sep-2026', period: '2026-09', frozenAtUtc: '2026-10-01T20:05:00.000Z',
      nfp: { value: '90000', unit: 'persons', period: '2026-09', seriesId: 'nfp', provenance: provenance() }, wages: null },
  };
}

describe('verified equity session manifest', () => {
  const calendar = createUsEquitiesCalendar2026('2026-10-01T20:00:00.000Z');
  it('requires yesterday after NFP instead of predicting the current session flows', () => {
    expect(resolveLatestClosedSession(NOW, calendar).sessionDate).toBe('2026-10-01');
    expect(resolveLatestClosedSession('2026-10-02T20:00:00Z', calendar).sessionDate).toBe('2026-10-02');
  });
  it('skips Labor Day, Good Friday, observed July 4, weekends and Thanksgiving', () => {
    for (const [time, expected] of [
      ['2026-09-08T12:00:00Z', '2026-09-04'], ['2026-04-06T12:00:00Z', '2026-04-02'],
      ['2026-07-06T12:00:00Z', '2026-07-02'], ['2026-11-27T12:00:00Z', '2026-11-25'],
    ]) expect(resolveLatestClosedSession(time!, calendar).sessionDate).toBe(expected);
  });
  it('uses early close and IANA daylight time', () => {
    expect(resolveLatestClosedSession('2026-11-27T18:00:00Z', calendar)).toEqual({ sessionDate: '2026-11-27', closeAtUtc: '2026-11-27T18:00:00.000Z' });
    expect(calendar.sessions.find(s => s.sessionDate === '2026-03-06')?.closeAtUtc).toBe('2026-03-06T21:00:00.000Z');
    expect(calendar.sessions.find(s => s.sessionDate === '2026-03-09')?.closeAtUtc).toBe('2026-03-09T20:00:00.000Z');
    expect(calendar.sessions.find(s => s.sessionDate === '2026-10-12')).toBeDefined(); // Columbus Day is not an equity holiday.
  });
  it('blocks out-of-coverage and malformed/duplicate session manifests', () => {
    expect(() => resolveLatestClosedSession('2027-01-04T12:00:00Z', calendar)).toThrow('OUT_OF_COVERAGE');
    expect(() => resolveLatestClosedSession('2026-01-01T22:00:00Z', calendar)).toThrow('NO_CLOSED_SESSION');
    expect(() => resolveLatestClosedSession(NOW, { ...calendar, sessions: [...calendar.sessions, calendar.sessions[0]!] })).toThrow('INVALID_SESSIONS');
  });
});

describe('ETF structured normalization', () => {
  it('preserves missing cells, distinguishes zero and converts USD millions', () => {
    expect(parseEtfCell('-', 'USD_MILLIONS')).toBeNull();
    expect(parseEtfCell('', 'USD_MILLIONS')).toBeNull();
    expect(parseEtfCell('0.0', 'USD_MILLIONS')).toBe('0');
    expect(parseEtfCell('(31.4)', 'USD_MILLIONS')).toBe('-31400000');
    expect(parseEtfCell('1,200.1', 'USD_MILLIONS')).toBe('1200100000');
    expect(() => parseEtfCell('N/A*', 'USD_MILLIONS')).toThrow('UNKNOWN_CELL_SYMBOL');
    expect(() => parseEtfCell('1,2.3', 'USD_MILLIONS')).toThrow('UNKNOWN_CELL_SYMBOL');
  });
  it('a visible total cannot turn partial coverage into complete data', () => {
    const result = normalizeEtfCells({ sessionDate: '2026-10-01', expectedFunds: ['IBIT', 'BTC'],
      cells: { IBIT: '-', BTC: '14.6' }, declaredTotal: '14.6', unit: 'USD_MILLIONS', declaredComplete: true, provenance: provenance() });
    expect(result.complete).toBe(false);
    expect(result.totalUsd).toBe('14600000');
    expect(result.funds[0]?.netFlowUsd).toBeNull();
  });
  it('checks summation, units and a dated dynamic fund universe', () => {
    const input = { sessionDate: '2026-10-01', expectedFunds: ['IBIT', 'NEW'], cells: { IBIT: '1.2', NEW: '-0.2' },
      declaredTotal: '1.0', unit: 'USD_MILLIONS' as const, declaredComplete: true, provenance: provenance() };
    expect(normalizeEtfCells(input).complete).toBe(true);
    expect(normalizeEtfCells({ ...input, declaredTotal: '1.1' }).provenance.conflicts).toContain('ETF_SUM_MISMATCH');
    expect(() => normalizeEtfCells({ ...input, expectedFunds: ['IBIT'] })).toThrow('UNEXPECTED_FUND');
    expect(() => normalizeEtfCells({ ...input, expectedFunds: ['IBIT', 'IBIT'] })).toThrow('INVALID_FUND_UNIVERSE');
  });
});

describe('authenticated structured ingestion validation', () => {
  it('assigns authoritative first availability and preserves it across a refetch', () => {
    const first = validateStructuredFeed(feed(), { receivedAt: '2026-10-01T21:00:00Z', allowedSources });
    expect(first.consensus?.frozenAtUtc).toBe('2026-10-01T21:00:00.000Z');
    expect(first.consensus?.nfp?.provenance.firstSeenAt).toBe('2026-10-01T21:00:00.000Z');
    const second = validateStructuredFeed(feed(), { receivedAt: NOW, allowedSources, previous: first });
    expect(second.consensus?.frozenAtUtc).toBe(first.consensus?.frozenAtUtc);
    expect(second.consensus?.nfp?.provenance.observedAt).toBe('2026-10-01T20:00:00.000Z');
    expect(second.consensus?.nfp?.provenance.fetchedAt).toBe(NOW);
    expect(second.consensus?.nfp?.provenance.publishedAt).toBeNull();
  });
  it('rejects a post-event consensus even when the caller backdates it', () => {
    expect(() => validateStructuredFeed(feed(), { receivedAt: NOW, allowedSources })).toThrow('CONSENSUS_NOT_FROZEN_BEFORE_EVENT');
  });
  it('rejects mutation of the same revision and admits an explicitly new pre-event revision', () => {
    const first = validateStructuredFeed(feed(), { receivedAt: '2026-10-01T21:00:00Z', allowedSources });
    const changed = feed(); changed.consensus!.nfp!.value = '100000';
    expect(() => validateStructuredFeed(changed, { receivedAt: '2026-10-01T22:00:00Z', allowedSources, previous: first })).toThrow('REVISION_CONTENT_CONFLICT');
    changed.consensus!.nfp!.provenance.revision = 'v2';
    expect(validateStructuredFeed(changed, { receivedAt: '2026-10-01T22:00:00Z', allowedSources, previous: first }).consensus?.frozenAtUtc).toBe('2026-10-01T22:00:00.000Z');
  });
  it('rejects untrusted origins, unapproved usage, evidence omissions and synthetic data', () => {
    const input = feed(); input.consensus = null;
    expect(() => validateStructuredFeed(input, { receivedAt: NOW, allowedSources: [] })).toThrow('UNTRUSTED_SOURCE');
    expect(() => validateStructuredFeed(input, { receivedAt: NOW, allowedSources: [{ ...allowedSources[0]!, usageApproved: false }] })).toThrow('UNTRUSTED_SOURCE');
    input.calendar!.provenance.sourceUrl = 'https://source.example.attacker.test/data';
    expect(() => validateStructuredFeed(input, { receivedAt: NOW, allowedSources })).toThrow('UNTRUSTED_SOURCE');
    input.calendar!.provenance = provenance({ evidenceSha256: undefined });
    expect(() => validateStructuredFeed(input, { receivedAt: NOW, allowedSources })).toThrow('EVIDENCE_MISSING');
    input.calendar!.provenance = provenance({ synthetic: true });
    expect(() => validateStructuredFeed(input, { receivedAt: NOW, allowedSources })).toThrow('SYNTHETIC');
  });
  it('rejects future observations and secret-bearing evidence URLs', () => {
    const input = feed(); input.consensus = null;
    input.calendar!.provenance.observedAt = '2026-10-03T00:00:00Z';
    expect(() => validateStructuredFeed(input, { receivedAt: NOW, allowedSources })).toThrow('FUTURE_DATA');
    input.calendar!.provenance = provenance({ sourceUrl: 'https://source.example/data?apiKey=credential' });
    expect(() => validateStructuredFeed(input, { receivedAt: NOW, allowedSources })).toThrow('UNTRUSTED_SOURCE');
  });
  it('selects only immutable versions actually received before the requested time', () => {
    const old = { versionId: '1', receivedAt: '2026-10-01T21:00:00Z', feed: feed() };
    const revision = { versionId: '2', receivedAt: '2026-10-03T21:00:00Z', feed: feed() };
    expect(selectAsOfVersion([revision, old], NOW)?.versionId).toBe('1');
    expect(selectAsOfVersion([old], '2026-09-30T21:00:00Z')).toBeNull();
  });
});

function response(value: unknown, status = 200): Response { return new Response(JSON.stringify(value), { status }); }
function marketFetcher(overrides: { book?: object; ticker?: object; retCode?: number } = {}) {
  return vi.fn(async (url: string | URL | Request): Promise<Response> => {
    const time = Date.parse(NOW) - 100;
    return response({ retCode: overrides.retCode ?? 0, time, result: String(url).includes('orderbook') ? {
      s: 'BTCUSDT', b: [['84000', '1']], a: [['84001', '2']], ts: time, cts: time - 100, u: 4, seq: 9, ...overrides.book,
    } : { category: 'linear', list: [{ symbol: 'BTCUSDT', lastPrice: '84000.5', markPrice: '84002' }], ...overrides.ticker } });
  });
}

describe('Bybit market adapter via mocked HTTP integration', () => {
  it('uses exact selected environment, matching-engine observation, separate bid/ask/last/mark', async () => {
    const fetcher = marketFetcher();
    const provider = new BybitMarketDataProvider('testnet', { fetch: fetcher as typeof fetch, now: () => new Date(NOW) });
    const market = await provider.getMarketView();
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith('https://api-testnet.bybit.com/'))).toBe(true);
    expect(market.quote).toMatchObject({ bid: '84000', ask: '84001', last: '84000.5', mark: '84002', environment: 'testnet' });
    expect(market.orderBook.provenance.observedAt).toBe('2026-10-02T12:49:59.800Z');
    expect(market.quote.provenance.publishedAt).toBeNull();
  });
  it('does not rejuvenate cache observation/fetch timestamps or let callers mutate it', async () => {
    let now = new Date(NOW); const fetcher = marketFetcher();
    const provider = new BybitMarketDataProvider('testnet', { fetch: fetcher as typeof fetch, now: () => now, cacheMs: 1000 });
    const first = await provider.getQuote(); const original = structuredClone(first); first.bid = '1';
    now = new Date(Date.parse(NOW) + 500);
    expect(await provider.getQuote()).toEqual(original);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await provider.getQuote({ fresh: true });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it.each([
    [{ book: { a: [] } }, 'SCHEMA_CHANGED'], [{ book: { a: [['83999', '2']] } }, 'CROSSED_ORDERBOOK'],
    [{ book: { b: [['84000', '1'], ['84001', '1']] } }, 'UNSORTED_ORDERBOOK'],
    [{ ticker: { category: 'spot' } }, 'SCHEMA_CHANGED'], [{ retCode: 10001 }, 'MARKET_RETCODE'],
  ])('fails closed on malformed or incompatible exchange responses', async (overrides, error) => {
    const provider = new BybitMarketDataProvider('testnet', { fetch: marketFetcher(overrides) as typeof fetch, now: () => new Date(NOW) });
    await expect(provider.getQuote()).rejects.toThrow(error);
  });
  it('marks provider failure explicitly and never injects a fixture or parity assumption', async () => {
    const snapshot = await assembleSnapshot({ snapshotId: 'failed', environment: 'testnet', asOf: NOW,
      quoteProvider: { getQuote: async (): Promise<Quote> => { throw new Error('private response details'); } } });
    expect(snapshot.quote).toBeNull(); expect(snapshot.usdPerUsdt).toBeNull();
    expect(snapshot.providerErrors).toEqual(['QUOTE_PROVIDER_FAILURE', 'STRUCTURED_FEED_UNAVAILABLE']);
    expect(JSON.stringify(snapshot)).not.toContain('private response');
  });
  it('blocks an environment mismatch and structured data unavailable at the as-of cutoff', async () => {
    const provider = new BybitMarketDataProvider('testnet', { fetch: marketFetcher() as typeof fetch, now: () => new Date(NOW) });
    const quote = await provider.getQuote();
    const structured = feed(); structured.calendar!.provenance.availableAt = '2026-10-03T00:00:00Z';
    const snapshot = await assembleSnapshot({ snapshotId: 'mismatch', environment: 'mainnet', asOf: NOW,
      quoteProvider: { getQuote: async () => quote }, structured });
    expect(snapshot.quote).toBeNull(); expect(snapshot.calendar).toBeNull();
    expect(snapshot.providerErrors).toEqual(['PROVIDER_ENVIRONMENT_MISMATCH', 'STRUCTURED_FEED_AFTER_AS_OF']);
  });
});

describe('read-only bounded HTTP transport', () => {
  it('retries transient reads only within configured limits', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response({}, 503)).mockResolvedValueOnce(response({ ok: true }));
    const sleep = vi.fn(async () => undefined);
    const client = new PublicJsonHttpClient({ fetch: fetcher, sleep, maxRetries: 1 });
    expect(await client.get('https://api-testnet.bybit.com/v5/market/tickers')).toEqual({ ok: true });
    expect(fetcher).toHaveBeenCalledTimes(2); expect(sleep).toHaveBeenCalledTimes(1);
    const invalid = vi.fn().mockResolvedValue(response({}, 403));
    await expect(new PublicJsonHttpClient({ fetch: invalid }).get('https://api-testnet.bybit.com/v5/market/tickers')).rejects.toThrow('HTTP_403');
    expect(invalid).toHaveBeenCalledTimes(1);
  });
  it('bounds a stalled request and rejects invalid configuration', async () => {
    const stalled = vi.fn(() => new Promise<Response>(() => undefined));
    await expect(new PublicJsonHttpClient({ fetch: stalled as typeof fetch, timeoutMs: 5, maxRetries: 0 })
      .get('https://api-testnet.bybit.com/v5/market/tickers')).rejects.toThrow('TIMEOUT');
    expect(() => new PublicJsonHttpClient({ maxRetries: 100 })).toThrow('CONFIGURATION');
  });
});
