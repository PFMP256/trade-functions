import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { BybitClient, BybitError } from './client';
import type { EntryPayload } from './types';

const credentials = { apiKey: 'SYNTHETIC_API_KEY', apiSecret: 'SYNTHETIC_API_SECRET' };
const now = 1790946000000;
const response = (result: unknown, retCode = 0, retMsg = 'OK') => new Response(JSON.stringify({ retCode, retMsg, result, time: now }), { status: 200 });
const payload: EntryPayload = { category: 'linear', symbol: 'BTCUSDT', side: 'Buy', orderType: 'Limit', timeInForce: 'IOC', positionIdx: 0, qty: '0.001', price: '84000', orderLinkId: 'test', reduceOnly: false, takeProfit: '87400', stopLoss: '82900', tpslMode: 'Full', tpOrderType: 'Market', slOrderType: 'Market', tpTriggerBy: 'LastPrice', slTriggerBy: 'LastPrice' };
describe('Bybit V5 transport with synthetic HTTP responses', () => {
  it('signs exact POST JSON using HMAC SHA256 and testnet host', async () => {
    const mock = vi.fn<typeof fetch>(async () => response({ orderId: 'order-1' }));
    const client = new BybitClient({ environment: 'testnet', credentials, fetch: mock, now: () => now });
    expect(await client.createOrder(payload)).toEqual({ orderId: 'order-1' });
    const [url, options] = mock.mock.calls[0]!;
    expect(url).toBe('https://api-testnet.bybit.com/v5/order/create');
    const body = JSON.stringify(payload);
    expect(options?.body).toBe(body);
    expect(options?.headers).toMatchObject({ 'X-BAPI-SIGN': createHmac('sha256', credentials.apiSecret).update(String(now) + credentials.apiKey + '5000' + body).digest('hex') });
    expect(options?.redirect).toBe('error');
  });
  it('uses account info marginMode and isolated USDT formula, excluding account-wide balance', async () => {
    const mock = vi.fn<typeof fetch>(async (url) => {
      if (String(url).includes('query-api')) return response({ userID: 12345, apiKey: credentials.apiKey, secret: credentials.apiSecret, readOnly: 0, permissions: { ContractTrade: ['Order', 'Position'], Wallet: [], Derivatives: [] } });
      if (String(url).includes('/account/info')) return response({ marginMode: 'ISOLATED_MARGIN', unifiedMarginStatus: 5 });
      return response({ list: [{ accountType: 'UNIFIED', totalAvailableBalance: '999999', coin: [{ coin: 'USDT', walletBalance: '100', totalPositionIM: '20', totalOrderIM: '10', locked: '5', bonus: '1' }] }] });
    });
    const client = new BybitClient({ environment: 'testnet', credentials, fetch: mock, now: () => now });
    const account = await client.getAccount();
    expect(account).toMatchObject({ uid: '12345', availableUsdt: '64', marginMode: 'ISOLATED_MARGIN', canTrade: true });
    expect(JSON.stringify(account)).not.toContain(credentials.apiKey); expect(JSON.stringify(account)).not.toContain(credentials.apiSecret);
    const wallet = mock.mock.calls.find(([url]) => String(url).includes('wallet-balance'))!;
    const query = 'accountType=UNIFIED&coin=USDT';
    expect(wallet[1]?.headers).toMatchObject({ 'X-BAPI-SIGN': createHmac('sha256', credentials.apiSecret).update(String(now) + credentials.apiKey + '5000' + query).digest('hex') });
  });
  it('accepts the documented account/info response without a top-level time', async () => {
    const mock = vi.fn<typeof fetch>(async url => {
      if (String(url).includes('query-api')) return response({ userID: 12345, readOnly: 0, permissions: { ContractTrade: ['Order', 'Position'], Wallet: [], Derivatives: [] } });
      if (String(url).includes('/account/info')) return new Response(JSON.stringify({ retCode: 0, retMsg: 'OK', result: { marginMode: 'ISOLATED_MARGIN', unifiedMarginStatus: 5, updatedTime: String(now) } }), { status: 200 });
      return response({ list: [{ accountType: 'UNIFIED', coin: [{ coin: 'USDT', walletBalance: '100', totalPositionIM: '20', totalOrderIM: '10', locked: '5', bonus: '1' }] }] });
    });
    const client = new BybitClient({ environment: 'testnet', credentials, fetch: mock, now: () => now });
    await expect(client.getAccount()).resolves.toMatchObject({ uid: '12345', marginMode: 'ISOLATED_MARGIN', availableUsdt: '64' });
    expect(mock).toHaveBeenCalledTimes(3);
    expect(mock.mock.calls.every(([, options]) => options?.method === 'GET')).toBe(true);
  });
  it('preserves a safe exchange error code when an error response omits time', async () => {
    const mock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ retCode: 10005, retMsg: credentials.apiSecret, result: {} }), { status: 200 }));
    const client = new BybitClient({ environment: 'testnet', credentials, fetch: mock, now: () => now });
    await expect(client.getAccountIdentity()).rejects.toMatchObject({ code: 'BYBIT_RETCODE_10005', message: 'BYBIT_RETCODE_10005', retCode: 10005, ambiguous: false });
    expect(mock).toHaveBeenCalledTimes(1);
  });
  it.each([null, String(now)])('still rejects an invalid timestamp when time is present: %s', async time => {
    const mock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ retCode: 0, result: { userID: 12345 }, time }), { status: 200 }));
    const client = new BybitClient({ environment: 'testnet', credentials, fetch: mock, now: () => now });
    await expect(client.getAccountIdentity()).rejects.toMatchObject({ code: 'BYBIT_INVALID_RESPONSE', ambiguous: false });
    expect(mock).toHaveBeenCalledTimes(2);
  });
  it('does not retry POST after network ambiguity or expose original exception', async () => {
    const mock = vi.fn<typeof fetch>(async () => { throw new Error('sensitive ' + credentials.apiSecret); });
    const client = new BybitClient({ environment: 'testnet', credentials, fetch: mock, now: () => now });
    await expect(client.createOrder(payload)).rejects.toMatchObject({ code: 'BYBIT_NETWORK_OR_PARSE_ERROR', ambiguous: true });
    expect(mock).toHaveBeenCalledTimes(1);
  });
  it('redacts provider errors; duplicate and internal-error replies remain ambiguous', async () => {
    for (const code of [10000, 10014, 10016, 110072]) {
      const mock = vi.fn<typeof fetch>(async () => response({}, code, credentials.apiSecret));
      const client = new BybitClient({ environment: 'testnet', credentials, fetch: mock, now: () => now });
      await expect(client.createOrder(payload)).rejects.toMatchObject({ message: 'BYBIT_RETCODE_' + code, ambiguous: true });
      expect(mock).toHaveBeenCalledTimes(1);
    }
  });
  it('a definitive exchange rejection differs from transport ambiguity', async () => {
    const client = new BybitClient({ environment: 'testnet', credentials, now: () => now, fetch: async () => response({}, 110003) });
    await expect(client.createOrder(payload)).rejects.toMatchObject({ ambiguous: false, retCode: 110003 });
  });
  it('invalid success acknowledgment is ambiguous and public reads retry only once', async () => {
    const mock = vi.fn<typeof fetch>(async () => response({}));
    const client = new BybitClient({ environment: 'testnet', credentials, fetch: mock, now: () => now });
    await expect(client.createOrder(payload)).rejects.toMatchObject({ ambiguous: true }); expect(mock).toHaveBeenCalledTimes(1);
    const failed = vi.fn<typeof fetch>(async () => { throw new Error('network'); });
    const reads = new BybitClient({ environment: 'testnet', fetch: failed });
    await expect(reads.getBook()).rejects.toBeInstanceOf(BybitError); expect(failed).toHaveBeenCalledTimes(2);
  });
  it('reads bid/ask and exchange observation time without rejuvenating it', async () => {
    const mock = vi.fn<typeof fetch>(async () => response({ s: 'BTCUSDT', ts: now - 20000, b: [['84000', '1']], a: [['84001', '2']] }));
    const client = new BybitClient({ environment: 'testnet', fetch: mock, now: () => now });
    expect(await client.getBook()).toEqual({ environment: 'testnet', bid: '84000', ask: '84001', observedAtMs: now - 20000 });
    expect(mock.mock.calls[0]?.[1]?.headers).not.toHaveProperty('X-BAPI-API-KEY');
  });
  it('handles pagination and consults history even if the recent cache is empty', async () => {
    const mock = vi.fn<typeof fetch>(async url => {
      if (String(url).includes('/realtime')) return response({ list: [], nextPageCursor: '' });
      if (!String(url).includes('cursor=')) return response({ list: [], nextPageCursor: 'next page' });
      return response({ list: [{ orderId: 'found', orderLinkId: 'link', symbol: 'BTCUSDT', side: 'Buy', orderStatus: 'Cancelled', qty: '.001', cumExecQty: '0', leavesQty: '0', avgPrice: '', reduceOnly: false, positionIdx: 0, createdTime: String(now) }], nextPageCursor: '' });
    });
    const client = new BybitClient({ environment: 'testnet', credentials, fetch: mock, now: () => now });
    // V5 uses leading zeros in decimals; invalid response fails closed first.
    await expect(client.findOrder('link', now - 1000)).rejects.toMatchObject({ code: 'BYBIT_INVALID_LIST_RESPONSE' });
    expect(mock.mock.calls.length).toBe(3);
  });
  it('timeout aborts an in-flight POST and remains unknown', async () => {
    const mock: typeof fetch = async (_url, options) => new Promise((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new Error('timeout'))));
    const client = new BybitClient({ environment: 'testnet', credentials, fetch: mock, timeoutMs: 5 });
    await expect(client.createOrder(payload)).rejects.toMatchObject({ ambiguous: true });
  });
});
