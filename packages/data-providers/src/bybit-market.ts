import Decimal from 'decimal.js';
import { z } from 'zod';
import { environmentSchema, positiveDecimalSchema, provenanceSchema, quoteSchema, klineRangeSchema, type KlineRange, type Provenance, type Quote } from '../../shared/src';
import { ProviderError, PublicJsonHttpClient, type PublicHttpOptions } from './http';

export const BYBIT_PUBLIC_ORIGINS = {
  testnet: 'https://api-testnet.bybit.com', mainnet: 'https://api.bybit.com',
} as const;
export type MarketEnvironment = keyof typeof BYBIT_PUBLIC_ORIGINS;
const levelSchema = z.tuple([positiveDecimalSchema, positiveDecimalSchema]);
export const orderBookSchema = z.object({
  symbol: z.literal('BTCUSDT'), category: z.literal('linear'), environment: environmentSchema,
  bids: z.array(levelSchema).min(1), asks: z.array(levelSchema).min(1), provenance: provenanceSchema,
}).strict();
export type OrderBook = z.infer<typeof orderBookSchema>;
export interface MarketView { quote: Quote; orderBook: OrderBook }
export interface QuoteProvider {
  getQuote(options?: { fresh?: boolean }): Promise<Quote>;
  getKlines?(validFromUtc: string, toUtc?: string): Promise<KlineRange>;
}
export interface OrderBookProvider { getOrderBook(options?: { fresh?: boolean }): Promise<OrderBook> }
const envelopeSchema = z.object({ retCode: z.number().int(), time: z.number().int().positive(), result: z.unknown() });
const tickerSchema = z.object({ category: z.literal('linear'), list: z.array(z.object({
  symbol: z.literal('BTCUSDT'), lastPrice: positiveDecimalSchema, markPrice: positiveDecimalSchema,
})).length(1) });
const rawBookSchema = z.object({
  s: z.literal('BTCUSDT'), b: z.array(levelSchema).min(1), a: z.array(levelSchema).min(1),
  ts: z.number().int().positive(), cts: z.number().int().positive().optional(),
  u: z.number().int().nonnegative(), seq: z.number().int().nonnegative(),
});

/** No credentials, no arbitrary base URL and no write endpoint. Both prices use the selected execution environment. */
export class BybitMarketDataProvider implements QuoteProvider, OrderBookProvider {
  readonly environment: MarketEnvironment;
  private readonly http: PublicJsonHttpClient;
  private readonly now: () => Date;
  private readonly cacheMs: number;
  private cache: { fetchedAt: number; value: MarketView } | undefined;
  private readonly firstSeen = new Map<string, string>();

  constructor(environment: MarketEnvironment, options: PublicHttpOptions & { now?: () => Date; cacheMs?: number } = {}) {
    this.environment = environmentSchema.parse(environment);
    this.http = new PublicJsonHttpClient(options);
    this.now = options.now ?? (() => new Date());
    this.cacheMs = options.cacheMs ?? 1_000;
    if (!Number.isFinite(this.cacheMs) || this.cacheMs < 0 || this.cacheMs > 60_000) throw new ProviderError('INVALID_PROVIDER_CACHE');
  }

  async getQuote(options: { fresh?: boolean } = {}): Promise<Quote> { return (await this.getMarketView(options)).quote; }
  async getOrderBook(options: { fresh?: boolean } = {}): Promise<OrderBook> { return (await this.getMarketView(options)).orderBook; }

  async getMarketView(options: { fresh?: boolean } = {}): Promise<MarketView> {
    const before = this.now().getTime();
    if (!options.fresh && this.cache && before >= this.cache.fetchedAt && before - this.cache.fetchedAt < this.cacheMs) {
      // The cached object includes its ORIGINAL observations/availability/fetch times.
      return structuredClone(this.cache.value);
    }
    const origin = BYBIT_PUBLIC_ORIGINS[this.environment];
    const tickerUrl = `${origin}/v5/market/tickers?category=linear&symbol=BTCUSDT`;
    const bookUrl = `${origin}/v5/market/orderbook?category=linear&symbol=BTCUSDT&limit=50`;
    const [tickerResult, bookResult] = await Promise.allSettled([this.http.get(tickerUrl), this.http.get(bookUrl)]);
    if (tickerResult.status === 'rejected') throw tickerResult.reason;
    if (bookResult.status === 'rejected') throw bookResult.reason;
    const tickerEnvelope = envelopeSchema.safeParse(tickerResult.value);
    const bookEnvelope = envelopeSchema.safeParse(bookResult.value);
    if (!tickerEnvelope.success || !bookEnvelope.success) throw new ProviderError('BYBIT_INVALID_ENVELOPE');
    if (tickerEnvelope.data.retCode !== 0 || bookEnvelope.data.retCode !== 0) throw new ProviderError('BYBIT_MARKET_RETCODE');
    const tickerParsed = tickerSchema.safeParse(tickerEnvelope.data.result);
    const bookParsed = rawBookSchema.safeParse(bookEnvelope.data.result);
    if (!tickerParsed.success || !bookParsed.success) throw new ProviderError('BYBIT_MARKET_SCHEMA_CHANGED');
    const ticker = tickerParsed.data.list[0]!;
    const book = bookParsed.data;
    const fetchedAt = this.now().toISOString();
    const bookObserved = book.cts ?? book.ts;
    if ([bookObserved, book.ts, bookEnvelope.data.time, tickerEnvelope.data.time].some(t => t > Date.parse(fetchedAt))) {
      throw new ProviderError('BYBIT_MARKET_FUTURE_TIMESTAMP');
    }
    const bid = book.b[0]![0];
    const ask = book.a[0]![0];
    if (new Decimal(bid).gt(ask)) throw new ProviderError('BYBIT_CROSSED_ORDERBOOK');
    if (book.b.some((level, index) => index > 0 && new Decimal(level[0]).gte(book.b[index - 1]![0])) ||
        book.a.some((level, index) => index > 0 && new Decimal(level[0]).lte(book.a[index - 1]![0]))) {
      throw new ProviderError('BYBIT_UNSORTED_ORDERBOOK');
    }
    const bookRevision = `${book.seq}:${book.u}:${bookObserved}`;
    const bookProvenance = this.provenance(bookUrl, bookObserved, bookRevision, fetchedAt);
    // REST ticker time means snapshot time; it does not claim the last trade happened then.
    // The quote uses the older timestamp, so combining requests never makes the book younger.
    const quoteProvenance = this.provenance(tickerUrl, Math.min(bookObserved, tickerEnvelope.data.time),
      `${bookRevision}:${tickerEnvelope.data.time}`, fetchedAt);
    const value: MarketView = {
      quote: quoteSchema.parse({ exchange: 'BYBIT', symbol: 'BTCUSDT', category: 'linear', quoteCurrency: 'USDT',
        environment: this.environment, bid, ask, last: ticker.lastPrice, mark: ticker.markPrice, provenance: quoteProvenance }),
      orderBook: orderBookSchema.parse({ symbol: 'BTCUSDT', category: 'linear', environment: this.environment,
        bids: book.b, asks: book.a, provenance: bookProvenance }),
    };
    this.cache = { fetchedAt: Date.parse(fetchedAt), value };
    return structuredClone(value);
  }

  async getKlines(validFromUtc: string, toUtc?: string): Promise<KlineRange> {
    const origin = BYBIT_PUBLIC_ORIGINS[this.environment];
    const startMs = Date.parse(validFromUtc);
    const endMs = toUtc ? Date.parse(toUtc) : this.now().getTime();
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
      throw new ProviderError('BYBIT_MARKET_SCHEMA_CHANGED');
    }
    const fetchedAt = this.now().toISOString();
    const validCandles: string[][] = [];
    const seenTimes = new Set<string>();

    let currentEnd = endMs;
    while (currentEnd >= startMs) {
      const klineUrl = `${origin}/v5/market/kline?category=linear&symbol=BTCUSDT&interval=1&start=${startMs}&end=${currentEnd}&limit=1000`;
      const response = await this.http.get(klineUrl);
      const envelope = envelopeSchema.safeParse(response);
      if (!envelope.success || envelope.data.retCode !== 0) throw new ProviderError('BYBIT_MARKET_RETCODE');
      const resultObj = envelope.data.result as { list?: string[][] } | undefined;
      const list = resultObj?.list ?? [];
      if (!Array.isArray(list)) throw new ProviderError('BYBIT_MARKET_SCHEMA_CHANGED');
      if (list.length === 0) break;

      let oldestTimeInPage = Infinity;
      for (const c of list) {
        const t = Number(c[0]);
        if (Number.isFinite(t) && t >= startMs && t <= endMs && !seenTimes.has(c[0]!)) {
          seenTimes.add(c[0]!);
          validCandles.push(c);
        }
        if (Number.isFinite(t) && t < oldestTimeInPage) {
          oldestTimeInPage = t;
        }
      }

      if (list.length < 1000 || oldestTimeInPage <= startMs || !Number.isFinite(oldestTimeInPage)) {
        break;
      }
      currentEnd = oldestTimeInPage - 1;
    }

    let minPrice: Decimal;
    let maxPrice: Decimal;
    if (validCandles.length > 0) {
      minPrice = new Decimal(validCandles[0]![3]!);
      maxPrice = new Decimal(validCandles[0]![2]!);
      for (const c of validCandles) {
        const high = new Decimal(c[2]!);
        const low = new Decimal(c[3]!);
        if (high.gt(maxPrice)) maxPrice = high;
        if (low.lt(minPrice)) minPrice = low;
      }
    } else {
      const quote = await this.getQuote();
      minPrice = new Decimal(quote.bid);
      maxPrice = new Decimal(quote.ask);
    }
    const revision = `${validCandles.length}:${minPrice.toFixed()}:${maxPrice.toFixed()}`;
    const provenanceUrl = `${origin}/v5/market/kline?category=linear&symbol=BTCUSDT&interval=1&start=${startMs}&limit=1000`;
    const provenance = this.provenance(provenanceUrl, validCandles.length > 0 ? Number(validCandles[0]![0]) : Date.parse(fetchedAt), revision, fetchedAt);
    return klineRangeSchema.parse({
      minPrice: minPrice.toFixed(),
      maxPrice: maxPrice.toFixed(),
      fromUtc: validFromUtc,
      toUtc: new Date(endMs).toISOString(),
      count: validCandles.length,
      provenance,
    });
  }

  private provenance(url: string, observedMs: number, revision: string, fetchedAt: string): Provenance {
    const key = `${url}:${revision}`;
    const seen = this.firstSeen.get(key) ?? fetchedAt;
    // Bounded instance memory; durable immutable snapshots retain historical versions.
    if (this.firstSeen.size >= 512 && !this.firstSeen.has(key)) this.firstSeen.delete(this.firstSeen.keys().next().value!);
    this.firstSeen.set(key, seen);
    return { sourceId: `bybit-${this.environment}`, sourceUrl: url, observedAt: new Date(observedMs).toISOString(),
      publishedAt: null, firstSeenAt: seen, availableAt: seen, fetchedAt, revision, verified: true,
      synthetic: false, conflicts: [] };
  }
}
