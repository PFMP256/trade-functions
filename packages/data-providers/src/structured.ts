import { z } from 'zod';
import { DateTime } from 'luxon';
import {
  snapshotSchema, sha256, type Provenance, type Snapshot, type EmploymentReport, type Consensus,
  type TreasuryObservation, type EtfReport, type NumericDatum, type EventCalendar,
} from '../../shared/src';
import { type QuoteProvider } from './bybit-market';
import { ProviderError } from './http';

export const structuredFeedSchema = snapshotSchema.pick({ usdPerUsdt: true, calendar: true, employment: true,
  consensus: true, treasury: true, etf: true, marketCalendar: true });
export type StructuredFeed = z.infer<typeof structuredFeedSchema>;
export const feedKindSchema = z.enum(['calendar', 'employment', 'consensus', 'treasury', 'etf', 'marketCalendar', 'usdPerUsdt']);
export type FeedKind = z.infer<typeof feedKindSchema>;
export const allowedSourceSchema = z.object({ sourceId: z.string().min(1),
  allowedOrigins: z.array(z.string().url()).min(1), usageApproved: z.boolean(),
  allowedKinds: z.array(feedKindSchema).min(1),
}).strict();
export const allowedSourcesSchema = z.array(allowedSourceSchema);
export type AllowedSource = z.infer<typeof allowedSourceSchema>;

export interface EmploymentProvider { getEmployment(eventId: string, asOfUtc: string): Promise<EmploymentReport | null> }
export interface ConsensusProvider { getConsensus(eventId: string, asOfUtc: string): Promise<Consensus | null> }
export interface CalendarProvider { getCalendar(eventId: string, asOfUtc: string): Promise<EventCalendar | null> }
export interface TreasuryProvider { getObservations(fromUtc: string, asOfUtc: string): Promise<TreasuryObservation[]> }
export interface EtfProvider { getReport(sessionDate: string, asOfUtc: string): Promise<EtfReport | null> }
export interface FxProvider { getUsdPerUsdt(asOfUtc: string): Promise<NumericDatum | null> }

type ProvenanceRecord = { provenance: Provenance; [key: string]: unknown };
function recordsIn(value: unknown): ProvenanceRecord[] {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(recordsIn);
  const record = value as Record<string, unknown>;
  return [...('provenance' in record ? [record as ProvenanceRecord] : []),
    ...Object.entries(record).filter(([key]) => key !== 'provenance').flatMap(([, child]) => recordsIn(child))];
}
function immutableContent(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(immutableContent);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !['firstSeenAt', 'availableAt', 'fetchedAt', 'frozenAtUtc'].includes(key))
    .map(([key, child]) => [key, immutableContent(child)]));
}
function datumIdentity(kind: FeedKind, record: ProvenanceRecord): string {
  const p = record.provenance;
  return [kind, p.sourceId, p.revision, p.observedAt, record.seriesId ?? '', record.period ?? '',
    record.sessionDate ?? '', record.eventId ?? '', record.calendarId ?? ''].join('|');
}

export interface ValidateStructuredOptions {
  receivedAt: string;
  allowedSources: AllowedSource[];
  previous?: StructuredFeed;
}

/**
 * Authenticated ingestion boundary. The HTTP layer supplies server receipt time and the previous immutable feed.
 * A trusted ingestor attests provenance and archives evidence; this function does not claim a URL proves content.
 * First receipt is authoritative for availability, making backdated post-event consensus unusable.
 */
export function validateStructuredFeed(input: unknown, options: ValidateStructuredOptions): StructuredFeed {
  const received = DateTime.fromISO(options.receivedAt, { setZone: true });
  if (!received.isValid || !options.receivedAt.endsWith('Z')) throw new ProviderError('INGEST_INVALID_RECEIPT_TIME');
  const receivedAt = received.toUTC().toISO()!;
  const feed = structuredFeedSchema.parse(input);
  const sources = allowedSourcesSchema.parse(options.allowedSources);
  if (new Set(sources.map(source => source.sourceId)).size !== sources.length) throw new ProviderError('INGEST_DUPLICATE_SOURCE');
  for (const source of sources) {
    if (source.allowedOrigins.some(origin => { const u = new URL(origin); return u.origin !== origin || u.protocol !== 'https:'; })) {
      throw new ProviderError('INGEST_INVALID_ALLOWED_ORIGIN');
    }
  }
  const previous = options.previous ? structuredFeedSchema.parse(options.previous) : undefined;
  const existing = new Map<string, { hash: string; provenance: Provenance }>();
  if (previous) for (const kind of feedKindSchema.options) for (const record of recordsIn(previous[kind])) {
    existing.set(datumIdentity(kind, record), { hash: sha256(immutableContent(record)), provenance: record.provenance });
  }
  const seen = new Map<string, string>();
  // Capture all hashes before mutating timestamps in nested records.
  const incoming = feedKindSchema.options.flatMap(kind => recordsIn(feed[kind]).map(record => ({
    kind, record, hash: sha256(immutableContent(record)),
  })));
  for (const { kind, record, hash } of incoming) {
    const p = record.provenance;
    const source = sources.find(candidate => candidate.sourceId === p.sourceId);
    const url = new URL(p.sourceUrl);
    if (!source || !source.usageApproved || !source.allowedKinds.includes(kind) || !source.allowedOrigins.includes(url.origin) ||
        url.protocol !== 'https:' || url.username || url.password ||
        [...url.searchParams.keys()].some(key => /token|secret|password|api.?key|authorization/i.test(key))) {
      throw new ProviderError('INGEST_UNTRUSTED_SOURCE');
    }
    if (!p.verified || p.synthetic) throw new ProviderError('INGEST_UNVERIFIED_OR_SYNTHETIC_DATA');
    if (!p.evidenceSha256 || !/^[a-f0-9]{64}$/.test(p.evidenceSha256)) throw new ProviderError('INGEST_SOURCE_EVIDENCE_MISSING');
    const times = [p.observedAt, p.publishedAt, p.firstSeenAt, p.availableAt, p.fetchedAt].filter((value): value is string => value !== null);
    if (times.some(time => Date.parse(time) > received.toMillis())) throw new ProviderError('INGEST_FUTURE_DATA');
    if (p.publishedAt !== null && Date.parse(p.publishedAt) < Date.parse(p.observedAt) && kind !== 'marketCalendar' && kind !== 'calendar') {
      throw new ProviderError('INGEST_INVALID_SOURCE_CHRONOLOGY');
    }
    const id = datumIdentity(kind, record);
    const old = existing.get(id);
    if ((old && old.hash !== hash) || (seen.has(id) && seen.get(id) !== hash)) throw new ProviderError('INGEST_REVISION_CONTENT_CONFLICT');
    seen.set(id, hash);
    p.firstSeenAt = old?.provenance.firstSeenAt ?? receivedAt;
    p.availableAt = old?.provenance.availableAt ?? receivedAt;
    p.fetchedAt = receivedAt;
  }
  if (feed.consensus) {
    const unchanged = previous?.consensus && sha256(immutableContent(previous.consensus)) === sha256(immutableContent(feed.consensus));
    feed.consensus.frozenAtUtc = unchanged ? previous!.consensus!.frozenAtUtc : receivedAt;
    const effectiveRelease = feed.employment?.releasedAtUtc ?? feed.calendar?.scheduledAtUtc;
    if (!effectiveRelease || Date.parse(feed.consensus.frozenAtUtc) >= Date.parse(effectiveRelease)) {
      throw new ProviderError('CONSENSUS_NOT_FROZEN_BEFORE_EVENT');
    }
    if (feed.calendar && (feed.consensus.eventId !== feed.calendar.eventId || feed.consensus.period !== feed.calendar.period)) {
      throw new ProviderError('CONSENSUS_EVENT_MISMATCH');
    }
  }
  return structuredFeedSchema.parse(feed);
}

export interface FeedVersion { receivedAt: string; feed: StructuredFeed; versionId: string }
/** Select entire historical versions; never splice future revisions into an earlier evaluation. */
export function selectAsOfVersion(versions: FeedVersion[], asOfUtc: string): FeedVersion | null {
  if (!Number.isFinite(Date.parse(asOfUtc))) throw new ProviderError('INVALID_AS_OF_TIME');
  const eligible = versions.filter(version => Number.isFinite(Date.parse(version.receivedAt)) && Date.parse(version.receivedAt) <= Date.parse(asOfUtc));
  eligible.sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt) || b.versionId.localeCompare(a.versionId));
  return eligible[0] ? structuredClone(eligible[0]) : null;
}

export const emptyStructuredFeed = (): StructuredFeed => ({
  usdPerUsdt: null, calendar: null, employment: null, consensus: null, treasury: [], etf: null, marketCalendar: null,
});

export interface AssembleSnapshotOptions {
  snapshotId: string;
  location?: string;
  environment: Snapshot['environment'];
  asOf: string;
  quoteProvider: QuoteProvider;
  structured?: StructuredFeed | null;
}
/** Missing structured integrations remain null, never zero, previous-success quotes, or synthetic fixtures. */
export async function assembleSnapshot(options: AssembleSnapshotOptions): Promise<Snapshot> {
  if (!Number.isFinite(Date.parse(options.asOf))) throw new ProviderError('INVALID_AS_OF_TIME');
  const providerErrors: string[] = [];
  let quote: Snapshot['quote'] = null;
  try {
    quote = await options.quoteProvider.getQuote({ fresh: true });
    if (quote.environment !== options.environment) throw new ProviderError('PROVIDER_ENVIRONMENT_MISMATCH');
  } catch (error) {
    quote = null;
    providerErrors.push(error instanceof ProviderError ? error.code : 'QUOTE_PROVIDER_FAILURE');
  }
  let structured = emptyStructuredFeed();
  if (options.structured) {
    const parsed = structuredFeedSchema.safeParse(options.structured);
    if (parsed.success) {
      const future = recordsIn(parsed.data).some(record =>
        Date.parse(record.provenance.availableAt) > Date.parse(options.asOf) ||
        Date.parse(record.provenance.firstSeenAt) > Date.parse(options.asOf));
      if (future) providerErrors.push('STRUCTURED_FEED_AFTER_AS_OF');
      else structured = parsed.data;
    }
    else providerErrors.push('STRUCTURED_FEED_INVALID');
  } else providerErrors.push('STRUCTURED_FEED_UNAVAILABLE');
  return snapshotSchema.parse({ snapshotId: options.snapshotId, ...(options.location ? { location: options.location } : {}),
    environment: options.environment, synthetic: false, quote, ...structured, providerErrors });
}
