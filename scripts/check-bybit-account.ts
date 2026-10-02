import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { BybitClient, BybitError } from '../packages/execution/bybit/client';

// This diagnostic never imports the executor, runtime, reconciliation or any order-writing method.
const allowedPaths = new Set(['/v5/user/query-api', '/v5/account/info', '/v5/account/wallet-balance', '/v5/position/list', '/v5/order/realtime']);
const numeric = (value: unknown): string | null => typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value) ? value : null;

function credentials(): { apiKey: string; apiSecret: string } {
  const buffer = readFileSync(resolve(__dirname, '../.env'));
  const encoding = buffer[0] === 0xff && buffer[1] === 0xfe ? 'utf16le' : 'utf8';
  const text = buffer.toString(encoding).replace(/^\uFEFF/, '');
  const variables = parseEnv(text);
  let apiKey = variables.BYBIT_API_KEY ?? variables.API_KEY;
  let apiSecret = variables.BYBIT_API_SECRET ?? variables.API_SECRET;
  // Also support this workspace's existing labelled format without rewriting or echoing the file.
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  for (let i = 0; i < lines.length - 1; i++) {
    const label = lines[i]!.toLowerCase().replace(/[\s_:\-]/g, '');
    if (['apikey', 'bybitapikey', 'claveapi'].includes(label)) apiKey ??= lines[i + 1];
    if (['secret', 'apisecret', 'bybitapisecret', 'secretkey'].includes(label)) apiSecret ??= lines[i + 1];
  }
  if (!apiKey || !apiSecret || /[\r\n]/.test(apiKey + apiSecret)) throw new Error('BYBIT_CREDENTIALS_FORMAT_INVALID');
  return { apiKey, apiSecret };
}

async function main(): Promise<void> {
  const auth = credentials();
  let wallet: { walletBalanceUsdt: string | null; equityUsdt: string | null; lockedUsdt: string | null } | null = null;
  const requests: { path: string; status: number }[] = [];
  const readOnlyFetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    if (method !== 'GET' || url.origin !== 'https://api.bybit.com' || url.username || url.password || !allowedPaths.has(url.pathname)) {
      throw new BybitError('READ_ONLY_DIAGNOSTIC_REQUEST_REJECTED', false);
    }
    const response = await fetch(input, { ...init, redirect: 'error' });
    requests.push({ path: url.pathname, status: response.status });
    if (url.pathname === '/v5/account/wallet-balance' && response.ok) {
      try {
        const body = await response.clone().json() as { retCode?: number; result?: { list?: { accountType?: string; coin?: { coin?: string; walletBalance?: unknown; equity?: unknown; locked?: unknown }[] }[] } };
        const coin = body.retCode === 0 ? body.result?.list?.find(row => row.accountType === 'UNIFIED')?.coin?.find(row => row.coin === 'USDT') : undefined;
        if (coin) wallet = { walletBalanceUsdt: numeric(coin.walletBalance), equityUsdt: numeric(coin.equity), lockedUsdt: numeric(coin.locked) };
      } catch { /* The client still validates the original response; raw bodies are never logged. */ }
    }
    return response;
  };
  const client = new BybitClient({ environment: 'mainnet', credentials: auth, fetch: readOnlyFetch });
  const identity = await client.getAccountIdentity();
  const [account, positions, orders] = await Promise.allSettled([client.getAccount(), client.getPositions(), client.getOpenOrders()]);
  const failure = (reason: unknown) => ({ status: 'ERROR', code: reason instanceof BybitError ? reason.code : 'READ_ONLY_QUERY_FAILED' });
  const openPositions = positions.status === 'fulfilled' ? positions.value.filter(position => Number(position.size) > 0) : [];
  process.stdout.write(JSON.stringify({ diagnosticOnly: true, readOnly: true, environment: 'mainnet',
    checkedAtUtc: new Date().toISOString(), authentication: 'OK', accountUid: identity.uid,
    scope: { wallet: 'UNIFIED USDT', positionsAndOrders: 'BTCUSDT linear' },
    account: account.status === 'fulfilled' ? { status: 'OK', marginMode: account.value.marginMode,
      unifiedMarginStatus: account.value.unifiedMarginStatus, readOnlyKey: account.value.readOnly,
      tradingPermission: account.value.canTrade, withdrawalPermission: account.value.canWithdraw,
      availableUsdtForIsolatedMargin: account.value.marginMode === 'ISOLATED_MARGIN' ? account.value.availableUsdt : null } : failure(account.reason),
    wallet,
    positions: positions.status === 'fulfilled' ? { status: 'OK', openCount: openPositions.length,
      settings: positions.value.map(position => ({ symbol: position.symbol, positionIdx: position.positionIdx, side: position.side, leverage: position.leverage })),
      open: openPositions } : failure(positions.reason),
    orders: orders.status === 'fulfilled' ? { status: 'OK', count: orders.value.length, shown: orders.value.slice(0, 20).map(order => ({
      orderId: order.orderId, side: order.side, qty: order.qty, status: order.orderStatus, reduceOnly: order.reduceOnly,
      stopOrderType: order.stopOrderType ?? null })), truncated: orders.value.length > 20 } : failure(orders.reason),
    requests }, null, 2) + '\n');
  if ([account, positions, orders].some(result => result.status === 'rejected')) process.exitCode = 1;
}

main().catch(error => {
  // Only known constant codes leave this process. Never serialize errors, client instances or credentials.
  const code = error instanceof BybitError ? error.code : error instanceof Error && error.message === 'BYBIT_CREDENTIALS_FORMAT_INVALID' ? error.message : 'READ_ONLY_DIAGNOSTIC_FAILED';
  process.stdout.write(JSON.stringify({ diagnosticOnly: true, readOnly: true, environment: 'mainnet', status: 'ERROR', code }) + '\n');
  process.exitCode = 1;
});
