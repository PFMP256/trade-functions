/** Synthetic support only. Never use this client/store in a deployed execution path. */
import Decimal from 'decimal.js';
import { BybitError } from './client';
import type { Account, Book, Clock, ClosePayload, EntryPayload, Environment, ExchangeClient, ExecutorStore, Fill, Instrument, Intent, Lease, Order, Position, ProtectionPayload } from './types';

export class FakeClock implements Clock {
  constructor(public time = Date.parse('2026-10-02T13:00:00Z')) {}
  now(): number { return this.time; }
  async sleep(ms: number): Promise<void> { this.time += ms; }
}
export class MemoryExecutorStore implements ExecutorStore {
  readonly intents = new Map<string, Intent>();
  private readonly locks = new Map<string, Lease>();
  private fence = 0;
  constructor(private readonly now: () => number = Date.now) {}
  async acquire(scope: string, owner: string, nowMs: number, ttlMs: number): Promise<Lease | null> {
    const active = this.locks.get(scope);
    if (active && active.expiresAtMs > nowMs) return null;
    const lease = { scope, owner, fence: ++this.fence, expiresAtMs: nowMs + ttlMs };
    this.locks.set(scope, lease); return structuredClone(lease);
  }
  async assertLease(lease: Lease, nowMs: number): Promise<void> {
    const current = this.locks.get(lease.scope);
    if (!current || current.owner !== lease.owner || current.fence !== lease.fence || current.expiresAtMs <= nowMs) throw new Error('LEASE_FENCE_REJECTED');
  }
  async readIntents(lease: Lease): Promise<Intent[]> { await this.assertLease(lease, this.now()); return [...this.intents.values()].filter(i => i.scope === lease.scope).map(i => structuredClone(i)); }
  async createIntent(lease: Lease, intent: Intent): Promise<boolean> {
    await this.assertLease(lease, this.now()); const key = lease.scope + ':' + intent.scenarioId;
    if (this.intents.has(key)) return false;
    this.intents.set(key, structuredClone(intent)); return true;
  }
  async saveIntent(lease: Lease, intent: Intent): Promise<void> { await this.assertLease(lease, this.now()); this.intents.set(lease.scope + ':' + intent.scenarioId, structuredClone(intent)); }
  async release(lease: Lease): Promise<void> { const active = this.locks.get(lease.scope); if (active?.fence === lease.fence && active.owner === lease.owner) this.locks.delete(lease.scope); }
}
export const syntheticInstrument: Instrument = {
  symbol: 'BTCUSDT', status: 'Trading', baseCoin: 'BTC', quoteCoin: 'USDT', settleCoin: 'USDT', contractType: 'LinearPerpetual',
  tickSize: '0.1', minPrice: '1', maxPrice: '10000000', qtyStep: '0.0001', minOrderQty: '0.0001', minNotionalValue: '5', maxOrderQty: '100', maxMktOrderQty: '10',
};
export class FakeBybitClient implements ExchangeClient {
  readonly account: Account = { uid: 'fake-account', marginMode: 'ISOLATED_MARGIN', unifiedMarginStatus: 5, readOnly: false, canTrade: true, canWithdraw: false, availableUsdt: '1000' };
  instrument: Instrument = structuredClone(syntheticInstrument);
  book: Book;
  positions: Position[] = [{ symbol: 'BTCUSDT', positionIdx: 0, side: '', size: '0', avgPrice: '', leverage: '1', takeProfit: '0', stopLoss: '0' }];
  orders: Order[] = [];
  fills: Fill[] = [];
  submitted: Array<EntryPayload | ClosePayload> = [];
  cancelled: string[] = [];
  stopWrites = 0;
  privateReads = 0;
  fillRatio = '1';
  fillPrice?: string;
  initialProtection = true;
  protectionWritesFail = false;
  entryReject = false;
  entryAmbiguousAfterAccept = false;
  entryAmbiguousWithoutEvidence = false;
  closeReject = false;
  closeAmbiguousAfterAccept = false;
  onCreate?: () => void;
  constructor(readonly environment: Environment = 'testnet', readonly clock: Clock = new FakeClock()) {
    this.book = { environment, bid: '84000', ask: '84001', observedAtMs: clock.now() };
  }
  async getAccount(): Promise<Account> { this.privateReads++; return structuredClone(this.account); }
  async getInstrument(): Promise<Instrument> { return structuredClone(this.instrument); }
  async getBook(): Promise<Book> { return structuredClone(this.book); }
  async getPositions(): Promise<Position[]> { this.privateReads++; return structuredClone(this.positions); }
  async getOpenOrders(): Promise<Order[]> { this.privateReads++; return structuredClone(this.orders.filter(o => ['New', 'Untriggered', 'PartiallyFilled'].includes(o.orderStatus))); }
  async getOrdersSince(): Promise<Order[]> { this.privateReads++; return structuredClone(this.orders); }
  async findOrder(link: string): Promise<Order | undefined> { this.privateReads++; return structuredClone(this.orders.find(o => o.orderLinkId === link)); }
  async getFills(): Promise<Fill[]> { this.privateReads++; return structuredClone(this.fills); }
  private protect(payload: ProtectionPayload, parentLink: string): void {
    const position = this.positions[0]!;
    position.takeProfit = payload.takeProfit; position.stopLoss = payload.stopLoss;
    this.orders = this.orders.filter(o => o.parentOrderLinkId !== parentLink);
    for (const kind of ['TakeProfit', 'StopLoss']) this.orders.push({
      orderId: parentLink + '-' + kind, orderLinkId: '', parentOrderLinkId: parentLink, symbol: 'BTCUSDT', side: position.side === 'Buy' ? 'Sell' : 'Buy',
      orderStatus: 'Untriggered', qty: position.size, cumExecQty: '0', leavesQty: position.size, avgPrice: '', reduceOnly: true, positionIdx: 0,
      stopOrderType: kind, triggerPrice: kind === 'TakeProfit' ? payload.takeProfit : payload.stopLoss, triggerBy: 'LastPrice', tpslMode: 'Full', orderType: 'Market', createdTime: String(this.clock.now()),
    });
  }
  async createOrder(payload: EntryPayload | ClosePayload): Promise<{ orderId: string }> {
    this.submitted.push(structuredClone(payload)); this.onCreate?.();
    if (!payload.reduceOnly && this.entryReject || payload.reduceOnly && this.closeReject) throw new BybitError('BYBIT_RETCODE_110003', false, 110003);
    if (!payload.reduceOnly && this.entryAmbiguousWithoutEvidence) throw new BybitError('BYBIT_NETWORK_OR_PARSE_ERROR', true);
    const orderId = 'fake-' + this.submitted.length;
    const qty = payload.reduceOnly ? Decimal.min(payload.qty, this.positions[0]!.size) : new Decimal(payload.qty).mul(this.fillRatio);
    const price = this.fillPrice ?? (payload.side === 'Buy' ? this.book.ask : this.book.bid);
    const order: Order = { orderId, orderLinkId: payload.orderLinkId, symbol: 'BTCUSDT', side: payload.side, orderStatus: qty.eq(payload.qty) ? 'Filled' : 'Cancelled', qty: payload.qty, cumExecQty: qty.toFixed(), leavesQty: '0', avgPrice: qty.eq(0) ? '' : price, reduceOnly: payload.reduceOnly, positionIdx: 0, createdTime: String(this.clock.now()) };
    this.orders.push(order);
    if (qty.gt(0)) {
      this.fills.push({ execId: orderId + '-fill', orderId, orderLinkId: payload.orderLinkId, side: payload.side, execQty: qty.toFixed(), execPrice: price, execFee: qty.mul(price).mul('0.00055').toFixed(), feeCurrency: 'USDT', execTime: String(this.clock.now()), execType: 'Trade' });
      if (payload.reduceOnly) {
        this.positions[0]!.size = new Decimal(this.positions[0]!.size).minus(qty).toFixed();
        for (const stop of this.orders.filter(o => o.stopOrderType)) stop.qty = this.positions[0]!.size;
      } else {
        this.positions[0] = { symbol: 'BTCUSDT', positionIdx: 0, side: payload.side, size: qty.toFixed(), avgPrice: price, leverage: '1', takeProfit: '0', stopLoss: '0' };
        if (this.initialProtection) this.protect(payload, payload.orderLinkId);
      }
    }
    if (!payload.reduceOnly && this.entryAmbiguousAfterAccept || payload.reduceOnly && this.closeAmbiguousAfterAccept) throw new BybitError('BYBIT_NETWORK_OR_PARSE_ERROR', true);
    return { orderId };
  }
  async cancelOrder(orderId: string): Promise<void> { this.cancelled.push(orderId); const order = this.orders.find(o => o.orderId === orderId); if (order) order.orderStatus = 'Cancelled'; }
  async setTradingStop(payload: ProtectionPayload): Promise<void> {
    this.stopWrites++;
    if (this.protectionWritesFail) throw new BybitError('BYBIT_RETCODE_110003', false, 110003);
    const entry = this.submitted.find(p => !p.reduceOnly);
    if (entry) this.protect(payload, entry.orderLinkId);
  }
}
