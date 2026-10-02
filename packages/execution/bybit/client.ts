import { createHmac } from 'node:crypto';
import Decimal from 'decimal.js';
import { z } from 'zod';
import type { Account, Book, ClosePayload, EntryPayload, Environment, ExchangeClient, Fill, Instrument, Order, Position, ProtectionPayload } from './types';

const decimal = z.string().regex(/^-?\d+(\.\d+)?$/);
const positive = decimal.refine(v => new Decimal(v).gt(0));
const nonnegative = decimal.refine(v => new Decimal(v).gte(0));
// Some V5 endpoints (including account/info) omit the unused envelope timestamp.
const envelope = z.object({ retCode: z.number().int(), result: z.unknown(), time: z.number().optional() });
const orderSchema = z.object({
  orderId: z.string().min(1), orderLinkId: z.string(), parentOrderLinkId: z.string().optional(),
  symbol: z.string(), side: z.string(), orderStatus: z.string(), qty: nonnegative,
  cumExecQty: nonnegative, leavesQty: nonnegative, avgPrice: z.string(), reduceOnly: z.boolean(),
  positionIdx: z.number().int(), stopOrderType: z.string().optional(), triggerPrice: z.string().optional(),
  triggerBy: z.string().optional(), tpslMode: z.string().optional(), orderType: z.string().optional(), createdTime: z.string(),
});
const fillSchema = z.object({
  execId: z.string(), orderId: z.string(), orderLinkId: z.string(), side: z.string(), execQty: nonnegative,
  execPrice: nonnegative, execFee: decimal, feeCurrency: z.string().optional().transform(v => v || 'UNKNOWN'),
  execTime: z.string(), execType: z.string(),
});
const positionSchema = z.object({
  symbol: z.string(), positionIdx: z.number().int(), side: z.string().nullable().transform(v => v ?? ''),
  size: nonnegative, avgPrice: z.string(), leverage: z.string(), takeProfit: z.string(), stopLoss: z.string(),
  seq: z.number().optional(),
});

/** Messages contain only stable codes, never provider payloads, credentials, headers or URLs with signatures. */
export class BybitError extends Error {
  constructor(public readonly code: string, public readonly ambiguous: boolean, public readonly retCode?: number) {
    super(code); this.name = 'BybitError';
  }
}
export interface BybitClientOptions {
  environment: Environment;
  credentials?: { apiKey: string; apiSecret: string };
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}
export class BybitClient implements ExchangeClient {
  readonly environment: Environment;
  readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly credentials: BybitClientOptions['credentials'];
  constructor(options: BybitClientOptions) {
    this.environment = options.environment;
    this.baseUrl = options.environment === 'testnet' ? 'https://api-testnet.bybit.com' : 'https://api.bybit.com';
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.timeoutMs = Math.min(options.timeoutMs ?? 4000, 5000);
    this.credentials = options.credentials;
  }
  private async request(method: 'GET' | 'POST', path: string, params: Record<string, string | number | boolean> = {}, authenticated = true): Promise<unknown> {
    const query = new URLSearchParams(Object.entries(params).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, String(v)])).toString();
    const body = method === 'POST' ? JSON.stringify(params) : undefined;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (authenticated) {
      if (!this.credentials) throw new BybitError('BYBIT_CREDENTIALS_MISSING', false);
      const timestamp = String(this.now());
      const recvWindow = '5000';
      headers['X-BAPI-API-KEY'] = this.credentials.apiKey;
      headers['X-BAPI-TIMESTAMP'] = timestamp;
      headers['X-BAPI-RECV-WINDOW'] = recvWindow;
      headers['X-BAPI-SIGN'] = createHmac('sha256', this.credentials.apiSecret)
        .update(timestamp + this.credentials.apiKey + recvWindow + (body ?? query)).digest('hex');
    }
    // Mutations are NEVER retried at this transport layer. Reads get at most one retry.
    for (let attempt = 0; attempt < (method === 'GET' ? 2 : 1); attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetcher(this.baseUrl + path + (method === 'GET' && query ? '?' + query : ''), { method, headers, body, signal: controller.signal, redirect: 'error' });
        if (!response.ok) throw new BybitError('BYBIT_HTTP_ERROR', method === 'POST');
        const decoded = envelope.safeParse(await response.json());
        if (!decoded.success) throw new BybitError('BYBIT_INVALID_RESPONSE', method === 'POST');
        if (decoded.data.retCode !== 0) {
          // Timeouts, duplicated request IDs, internal errors and throttling can hide an accepted request.
          const uncertain = [10000, 10006, 10014, 10016, 10019, 20006, 110072].includes(decoded.data.retCode);
          throw new BybitError(`BYBIT_RETCODE_${decoded.data.retCode}`, method === 'POST' && uncertain, decoded.data.retCode);
        }
        return decoded.data.result;
      } catch (error) {
        const safe = error instanceof BybitError ? error : new BybitError('BYBIT_NETWORK_OR_PARSE_ERROR', method === 'POST');
        if (method === 'POST' || attempt === 1 || safe.retCode !== undefined) throw safe;
      } finally { clearTimeout(timer); }
    }
    throw new BybitError('BYBIT_READ_FAILED', false);
  }
  private async pages<T>(path: string, params: Record<string, string | number>, schema: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<T[]> {
    const output: T[] = [];
    let cursor = '';
    const seen = new Set<string>();
    for (let page = 0; page < 50; page++) {
      const parsed = z.object({ list: z.array(schema), nextPageCursor: z.string().optional() }).safeParse(await this.request('GET', path, { ...params, ...(cursor ? { cursor } : {}) }));
      if (!parsed.success) throw new BybitError('BYBIT_INVALID_LIST_RESPONSE', false);
      output.push(...parsed.data.list);
      cursor = parsed.data.nextPageCursor ?? '';
      if (!cursor) return output;
      if (seen.has(cursor)) throw new BybitError('BYBIT_PAGINATION_LOOP', false);
      seen.add(cursor);
    }
    throw new BybitError('BYBIT_PAGINATION_LIMIT', false);
  }
  async getAccountIdentity(): Promise<{ uid: string }> {
    const result = z.object({ userID: z.union([z.string().min(1), z.number().int().safe()]) }).safeParse(await this.request('GET', '/v5/user/query-api'));
    if (!result.success) throw new BybitError('BYBIT_ACCOUNT_IDENTITY_UNVERIFIABLE', false);
    return { uid: String(result.data.userID) };
  }
  async getAccount(): Promise<Account> {
    const [identityRaw, infoRaw, walletRaw] = await Promise.all([
      this.request('GET', '/v5/user/query-api'), this.request('GET', '/v5/account/info'),
      this.request('GET', '/v5/account/wallet-balance', { accountType: 'UNIFIED', coin: 'USDT' }),
    ]);
    const identity = z.object({ userID: z.union([z.string(), z.number().int().safe()]), readOnly: z.number(), permissions: z.object({ ContractTrade: z.array(z.string()).default([]), Derivatives: z.array(z.string()).default([]), Wallet: z.array(z.string()).default([]) }) }).safeParse(identityRaw);
    const info = z.object({ marginMode: z.string(), unifiedMarginStatus: z.number() }).safeParse(infoRaw);
    const wallet = z.object({ list: z.array(z.object({ accountType: z.string(), coin: z.array(z.object({ coin: z.string(), walletBalance: decimal, totalPositionIM: decimal, totalOrderIM: decimal, locked: decimal, bonus: decimal })) })) }).safeParse(walletRaw);
    if (!identity.success || !info.success || !wallet.success) throw new BybitError('BYBIT_ACCOUNT_UNVERIFIABLE', false);
    const coin = wallet.data.list.find(x => x.accountType === 'UNIFIED')?.coin.find(x => x.coin === 'USDT');
    if (!coin) throw new BybitError('BYBIT_USDT_BALANCE_MISSING', false);
    // Bybit documents this coin-level formula for isolated margin. Account-wide totalAvailableBalance does not apply.
    const available = new Decimal(coin.walletBalance).minus(coin.totalPositionIM).minus(coin.totalOrderIM).minus(coin.locked).minus(coin.bonus);
    const permissions = identity.data.permissions;
    return {
      uid: String(identity.data.userID), marginMode: info.data.marginMode, unifiedMarginStatus: info.data.unifiedMarginStatus,
      readOnly: identity.data.readOnly !== 0,
      canTrade: permissions.Derivatives.includes('DerivativesTrade') || permissions.ContractTrade.includes('Order') && permissions.ContractTrade.includes('Position'),
      canWithdraw: permissions.Wallet.includes('Withdraw'), availableUsdt: Decimal.max(available, 0).toFixed(),
    };
  }
  async getInstrument(): Promise<Instrument> {
    const result = z.object({ list: z.array(z.object({
      symbol: z.literal('BTCUSDT'), status: z.string(), baseCoin: z.string(), quoteCoin: z.string(), settleCoin: z.string(), contractType: z.string(),
      priceFilter: z.object({ tickSize: positive, minPrice: positive, maxPrice: positive }),
      lotSizeFilter: z.object({ qtyStep: positive, minOrderQty: positive, minNotionalValue: nonnegative, maxOrderQty: positive, maxMktOrderQty: positive }),
    })) }).safeParse(await this.request('GET', '/v5/market/instruments-info', { category: 'linear', symbol: 'BTCUSDT' }, false));
    const row = result.success ? result.data.list[0] : undefined;
    if (!row) throw new BybitError('BYBIT_INSTRUMENT_UNVERIFIABLE', false);
    return { symbol: row.symbol, status: row.status, baseCoin: row.baseCoin, quoteCoin: row.quoteCoin, settleCoin: row.settleCoin, contractType: row.contractType, ...row.priceFilter, ...row.lotSizeFilter };
  }
  async getBook(): Promise<Book> {
    const result = z.object({ s: z.literal('BTCUSDT'), ts: z.number().int(), b: z.array(z.tuple([positive, positive])), a: z.array(z.tuple([positive, positive])) }).safeParse(await this.request('GET', '/v5/market/orderbook', { category: 'linear', symbol: 'BTCUSDT', limit: 1 }, false));
    if (!result.success || !result.data.b[0] || !result.data.a[0]) throw new BybitError('BYBIT_BOOK_UNVERIFIABLE', false);
    return { environment: this.environment, bid: result.data.b[0][0], ask: result.data.a[0][0], observedAtMs: result.data.ts };
  }
  async getPositions(): Promise<Position[]> {
    const list = await this.pages('/v5/position/list', { category: 'linear', symbol: 'BTCUSDT', limit: 200 }, positionSchema);
    return list.filter(p => p.seq === undefined || p.seq !== -1);
  }
  getOpenOrders(): Promise<Order[]> { return this.pages('/v5/order/realtime', { category: 'linear', symbol: 'BTCUSDT', openOnly: 0, limit: 50 }, orderSchema); }
  private async timeWindows<T>(path: string, startMs: number, schema: z.ZodType<T, z.ZodTypeDef, unknown>, extra: Record<string, string | number> = {}): Promise<T[]> {
    const end = this.now(); const values: T[] = [];
    if (startMs > end || end - startMs > 90 * 86400000) throw new BybitError('BYBIT_HISTORY_WINDOW_UNSUPPORTED', false);
    for (let start = startMs; start <= end; start += 7 * 86400000) {
      values.push(...await this.pages(path, { category: 'linear', symbol: 'BTCUSDT', startTime: start, endTime: Math.min(start + 7 * 86400000 - 1, end), limit: 50, ...extra }, schema));
    }
    return values;
  }
  getOrdersSince(startMs: number): Promise<Order[]> { return this.timeWindows('/v5/order/history', startMs, orderSchema); }
  getFills(startMs: number): Promise<Fill[]> { return this.timeWindows('/v5/execution/list', startMs, fillSchema); }
  async findOrder(orderLinkId: string, startMs: number): Promise<Order | undefined> {
    const recent = await this.pages('/v5/order/realtime', { category: 'linear', symbol: 'BTCUSDT', orderLinkId, limit: 50 }, orderSchema);
    const history = await this.timeWindows('/v5/order/history', startMs, orderSchema, { orderLinkId });
    return [...recent, ...history].find(x => x.orderLinkId === orderLinkId);
  }
  async createOrder(payload: EntryPayload | ClosePayload): Promise<{ orderId: string }> {
    const result = z.object({ orderId: z.string().min(1) }).safeParse(await this.request('POST', '/v5/order/create', { ...payload }));
    if (!result.success) throw new BybitError('BYBIT_ORDER_ACK_INVALID', true);
    return result.data;
  }
  async cancelOrder(orderId: string): Promise<void> { await this.request('POST', '/v5/order/cancel', { category: 'linear', symbol: 'BTCUSDT', orderId }); }
  async setTradingStop(payload: ProtectionPayload): Promise<void> { await this.request('POST', '/v5/position/trading-stop', { ...payload }); }
}
