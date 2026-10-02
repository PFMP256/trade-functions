import { makeFixture } from '../../../../fixtures';
import { PUBLIC_NFP_STRATEGY_ID, PublicNfpScenarioConfig, Snapshot, publicNfpScenarioConfigSchema } from '../../../shared/src';

export function makePublicFixture(direction:'LONG'|'SHORT'='LONG'): {snapshot:Snapshot;config:PublicNfpScenarioConfig;now:string} {
  const base=makeFixture(direction);
  const {minTreasuryObservations:_observations,maxTreasuryGapSeconds:_gap,...common}=base.config;
  const {treasurySeconds:_ttl,...freshness}=common.freshness;
  const config=publicNfpScenarioConfigSchema.parse({...common,strategyId:PUBLIC_NFP_STRATEGY_ID,
    scenarioId:'btc-nfp-public-2026-10-02',freshness,
    thresholds:{unemploymentLongPct:'4.2',nfpShortPersons:'150000'},conflictingMacroPolicy:'BLOCK',confirmationMinutes:15});
  const snapshot:Snapshot={...base.snapshot,snapshotId:`synthetic-public-nfp-${direction.toLowerCase()}`,
    location:`synthetic-public-fixture:${direction.toLowerCase()}`,consensus:null,treasury:[],etf:null,marketCalendar:null};
  snapshot.employment!.wages=null;
  return {snapshot,config,now:base.now};
}
