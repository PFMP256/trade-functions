import {
  FUNDAMENTAL_TRIGGER_STRATEGY_ID,
  STRATEGY_VERSION,
  FundamentalTriggerScenarioConfig,
  Snapshot,
  fundamentalTriggerScenarioConfigSchema,
  Provenance,
} from '../../../shared/src';

export function makeSyntheticProvenance(observedAt: string, sourceUrl = 'https://example.invalid/provenance'): Provenance {
  return {
    sourceId: 'synthetic-test',
    sourceUrl,
    observedAt,
    publishedAt: null,
    firstSeenAt: observedAt,
    availableAt: observedAt,
    fetchedAt: observedAt,
    revision: 'synthetic-rev-1',
    verified: true,
    synthetic: false,
    conflicts: [],
  };
}

export function makeFundamentalFixture(direction: 'LONG' | 'SHORT' = 'LONG'): {
  snapshot: Snapshot;
  config: FundamentalTriggerScenarioConfig;
  now: string;
} {
  const now = '2026-10-05T20:25:00.000Z';
  const observedAt = '2026-10-05T20:24:50.000Z';

  const isLong = direction === 'LONG';
  const ask = isLong ? '85713.10' : '85970.00';
  const bid = isLong ? '85713.00' : '85713.00';
  const entryZone: [string, string] = isLong
    ? ['85455.96', '85970.24']
    : ['85400.00', '86000.00'];

  const levels = isLong
    ? { takeProfitUsd: '87800.00', stopLossUsd: '84800.00' }
    : { takeProfitUsd: '82000.00', stopLossUsd: '86800.00' };

  const config = fundamentalTriggerScenarioConfigSchema.parse({
    strategyId: FUNDAMENTAL_TRIGGER_STRATEGY_ID,
    strategyVersion: STRATEGY_VERSION,
    scenarioId: 'btc-fund-20261005-2018',
    validFromUtc: '2026-10-05T20:18:00.000Z',
    expiresAtUtc: '2026-10-06T20:18:00.000Z',
    timezone: 'America/Mexico_City',
    direction,
    entryZone,
    levels: {
      LONG: { takeProfitUsd: '87800.00', stopLossUsd: '84800.00' },
      SHORT: { takeProfitUsd: '82000.00', stopLossUsd: '86800.00' },
    },
    takeProfitUsd: levels.takeProfitUsd,
    stopLossUsd: levels.stopLossUsd,
    costs: {
      entryFeeBps: '0',
      exitFeeBps: '0',
      exitSlippageBps: '0',
      fundingToTpPerBtcUsdt: '0',
      fundingToSlPerBtcUsdt: '0',
      description: 'Synthetic explicit costs',
    },
    minRewardRisk: '1.5',
    demo: false,
    validationStatus: 'VALIDATED',
    sourcesValidated: true,
    tradingMode: 'dry_run',
    environment: 'testnet',
    allowNewEntries: true,
    closeOnScenarioExpiry: true,
    instrument: {
      exchange: 'BYBIT',
      symbol: 'BTCUSDT',
      marketType: 'LINEAR_PERPETUAL',
      category: 'linear',
      quoteCurrency: 'USDT',
    },
    freshness: {
      quoteSeconds: 60,
      fxSeconds: 60,
    },
    nextEvaluationSeconds: 60,
    execution: {
      targetPositionNotionalUsd: '2000',
      leverage: '20',
      marginMode: 'REGULAR',
      positionMode: 'ONE_WAY',
      positionIdx: 0,
      maxOpenPositionsPerSymbol: 1,
      maxEntryIntentsPerScenario: 1,
      entrySlippageBps: '10',
      entryOrderType: 'Limit',
      timeInForce: 'IOC',
      tpslMode: 'Full',
      tpOrderType: 'Market',
      slOrderType: 'Market',
      tpTriggerBy: 'LastPrice',
      slTriggerBy: 'LastPrice',
      monetaryPrecisionUsd: '0.01',
      protectionTimeoutSeconds: 15,
    },
  });

  const quoteProv = makeSyntheticProvenance(observedAt, 'https://api-testnet.bybit.com/v5/market/tickers');
  const fxProv = makeSyntheticProvenance(observedAt, 'https://api.kraken.com/0/public/Ticker');
  const klineProv = makeSyntheticProvenance(observedAt, 'https://api-testnet.bybit.com/v5/market/kline');

  const snapshot: Snapshot = {
    snapshotId: `synthetic-fundamental-${direction.toLowerCase()}`,
    environment: 'testnet',
    synthetic: false,
    quote: {
      exchange: 'BYBIT',
      symbol: 'BTCUSDT',
      category: 'linear',
      quoteCurrency: 'USDT',
      environment: 'testnet',
      bid,
      ask,
      last: ask,
      mark: ask,
      provenance: quoteProv,
    },
    usdPerUsdt: {
      value: '1.0000',
      unit: 'USD_PER_USDT',
      period: 'realtime',
      seriesId: 'USD_USDT',
      provenance: fxProv,
    },
    calendar: null,
    employment: null,
    consensus: null,
    treasury: [],
    etf: null,
    marketCalendar: null,
    klines: {
      minPrice: isLong ? '85600.00' : '85500.00',
      maxPrice: isLong ? '85800.00' : '85900.00',
      fromUtc: '2026-10-05T20:18:00.000Z',
      toUtc: now,
      count: 7,
      provenance: klineProv,
    },
    priceRangeSinceValidFrom: {
      minPrice: isLong ? '85600.00' : '85500.00',
      maxPrice: isLong ? '85800.00' : '85900.00',
      fromUtc: '2026-10-05T20:18:00.000Z',
      toUtc: now,
      count: 7,
      provenance: klineProv,
    },
    providerErrors: [],
  };

  return { snapshot, config, now };
}
