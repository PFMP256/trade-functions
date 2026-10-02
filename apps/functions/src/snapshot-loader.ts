import { PUBLIC_NFP_STRATEGY_ID, type AnyScenarioConfig, type Snapshot } from '../../../packages/shared/src';
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

/** The public strategy has no dependency on the manual-feed collection, including read failures there. */
export async function loadRuntimeSnapshot(options: RuntimeSnapshotOptions): Promise<Snapshot> {
  const onlyPublic = options.config?.strategyId === PUBLIC_NFP_STRATEGY_ID;
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
  return snapshot;
}
