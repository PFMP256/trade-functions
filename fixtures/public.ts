import { makeFixture } from './index';
import { publicDemoScenarioConfig } from '../scenarios';
import type { PublicNfpScenarioConfig, Snapshot } from '../packages/shared/src';

/** Deliberately synthetic public-strategy examples; never fetched or imported by the deployed runtime. */
export function makePublicFixture(direction: 'LONG' | 'SHORT' = 'LONG'): { snapshot: Snapshot; config: PublicNfpScenarioConfig; now: string } {
  const { snapshot, now } = makeFixture(direction);
  snapshot.snapshotId = `synthetic-public-${direction.toLowerCase()}-2026-10-02`;
  snapshot.location = `fixtures/public-${direction.toLowerCase()}.json`;
  snapshot.consensus = null; snapshot.treasury = []; snapshot.etf = null; snapshot.marketCalendar = null;
  // Salaries remain available in BLS responses, but are not a direction predicate in this variant.
  snapshot.employment!.wages = null;
  return { snapshot, now, config: publicDemoScenarioConfig() };
}
