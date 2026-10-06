import { PUBLIC_NFP_STRATEGY_ID, FUNDAMENTAL_TRIGGER_STRATEGY_ID, type AnyScenarioConfig, type Snapshot } from '../../../packages/shared/src';
import { assembleSnapshot, emptyStructuredFeed, type StructuredFeed, type QuoteProvider } from '../../../packages/data-providers/src';

export interface RuntimeSnapshotOptions {
  config: AnyScenarioConfig | undefined;
  environment: Snapshot['environment'];
  now: Date;
  publicDataEnabled: boolean;
  latestStructured(asOf: string): Promise<StructuredFeed | undefined>;
  publicSources(config: AnyScenarioConfig, ingested: StructuredFeed | undefined): Promise<{ structured: StructuredFeed; errors: string[] }>;
  quoteProvider: QuoteProvider;
  clock?: () => Date;
}

/** The public and fundamental trigger strategies have no dependency on the manual-feed collection, including read failures there. */
export async function loadRuntimeSnapshot(options: RuntimeSnapshotOptions): Promise<Snapshot> {
  const onlyPublic = options.config?.strategyId === PUBLIC_NFP_STRATEGY_ID || options.config?.strategyId === FUNDAMENTAL_TRIGGER_STRATEGY_ID;
  let structured = onlyPublic ? emptyStructuredFeed() : await options.latestStructured(options.now.toISOString());
  let errors: string[] = [];
  if (onlyPublic && !options.publicDataEnabled) {
    errors.push('PUBLIC_SOURCES_REQUIRED');
  } else if (options.publicDataEnabled && options.config) {
    const sources = await options.publicSources(options.config, structured);
    structured = sources.structured; errors = sources.errors;
  }
  const asOf = (options.clock?.() ?? new Date()).toISOString();
  const snapshot = await assembleSnapshot({ snapshotId: `bybit-${options.environment}-${asOf}`,
    environment: options.environment, asOf, quoteProvider: options.quoteProvider, structured });
  snapshot.providerErrors.push(...errors);
  if (options.config?.strategyId === FUNDAMENTAL_TRIGGER_STRATEGY_ID && !snapshot.klines) {
    try {
      if (options.quoteProvider.getKlines) {
        const klines = await options.quoteProvider.getKlines(options.config.validFromUtc, asOf);
        snapshot.klines = klines;
        snapshot.priceRangeSinceValidFrom = klines;
      }
    } catch (e) {
      snapshot.providerErrors.push(e instanceof Error && 'code' in e ? (e as any).code : 'KLINE_PROVIDER_FAILURE');
    }
  }
  return snapshot;
}
