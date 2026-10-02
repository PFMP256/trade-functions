import { BlsPublicProvider, BybitMarketDataProvider, KrakenFxProvider, ProviderError, blsUserAgent } from '../packages/data-providers/src';
import { publicDemoScenarioConfig } from '../scenarios';

/** Connectivity diagnostic only: no .env, private credentials, Firestore, decisions or orders. */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const environmentFlag = args.indexOf('--environment');
  const environment = environmentFlag === -1 ? 'testnet' : args[environmentFlag + 1] ?? '';
  if (!['testnet', 'mainnet'].includes(environment)) throw new Error('Use --environment testnet|mainnet');
  const config = publicDemoScenarioConfig();
  // Same declared automated agent as the runtime; BLS_CONTACT is read from the process only, never from .env.
  const bls = new BlsPublicProvider({ userAgent: blsUserAgent(process.env.BLS_CONTACT || undefined) });
  const results = await Promise.allSettled([
    new BybitMarketDataProvider(environment as 'testnet' | 'mainnet').getQuote({ fresh: true }),
    bls.getCalendar(config.event),
    bls.getEmployment(config.event, null, { requireWages: false }),
    new KrakenFxProvider().getUsdPerUsdt(),
  ]);
  const sources = results.map((result, index) => {
    const name = ['bybit', 'bls-calendar', 'bls-employment', 'kraken-fx'][index]!;
    if (result.status === 'rejected') return { name, status: 'ERROR', reason: result.reason instanceof ProviderError ? result.reason.code : 'PUBLIC_SOURCE_FAILURE' };
    const datum = 'data' in result.value ? result.value.data : result.value;
    return { name, status: datum ? 'OK' : 'REPORT_NOT_PUBLISHED_FOR_PERIOD',
      sourceUrl: datum?.provenance.sourceUrl ?? 'https://www.bls.gov/news.release/empsit.nr0.htm',
      observedAt: datum?.provenance.observedAt ?? null, fetchedAt: datum?.provenance.fetchedAt ?? null,
      ...(datum && 'period' in datum ? { period: datum.period } : {}) };
  });
  process.stdout.write(JSON.stringify({ diagnosticOnly: true, environment, checkedAtUtc: new Date().toISOString(),
    strategyId: config.strategyId, eventPeriod: config.event.period, sources }, null, 2) + '\n');
  if (results.some(result => result.status === 'rejected')) process.exitCode = 1;
}
main().catch(() => { process.stderr.write('PUBLIC_CONNECTIVITY_CHECK_FAILED\n'); process.exitCode = 1; });
