import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { z } from 'zod';
import { publicDemoScenarioConfig } from '../../../scenarios';
import { tradingModeSchema, environmentSchema, anyScenarioConfigSchema } from '../../../packages/shared/src';
import { BybitMarketDataProvider, allowedSourcesSchema } from '../../../packages/data-providers/src';
import { BybitClient } from '../../../packages/execution/bybit/client';
import { BybitExecutor } from '../../../packages/execution/bybit/executor';
import { ExecutorSettingsSchema } from '../../../packages/execution/bybit/types';
import { AuditStore } from './audit-store';
import { FirestoreExecutorStore } from './executor-store';
import { FeedStore } from './feed-store';
import { ReconcileQueue } from './tasks';
import type { OrchestratorDeps } from './orchestrator';
import { PublicDataStore } from './public-data-store';
import { fetchPublicFeeds } from './public-feeds';
import { loadRuntimeSnapshot } from './snapshot-loader';

const bool = (v:string|undefined, fallback=false) => v === undefined ? fallback : z.enum(['true','false']).parse(v) === 'true';
function jsonFile(path: string): unknown { return JSON.parse(readFileSync(resolve(path),'utf8')); }
export function loadScenario(): unknown {
  const base = process.env.SCENARIO_CONFIG_PATH ? jsonFile(process.env.SCENARIO_CONFIG_PATH) : publicDemoScenarioConfig();
  if (!base || typeof base !== 'object' || Array.isArray(base)) return base;
  return {...base,
    tradingMode:tradingModeSchema.parse(process.env.TRADING_MODE ?? 'dry_run'),
    environment:environmentSchema.parse(process.env.BYBIT_ENVIRONMENT ?? 'testnet'),
    allowNewEntries:bool(process.env.ALLOW_NEW_ENTRIES,true),
  };
}
export function firestore() { return getFirestore(getApps()[0] ?? initializeApp()); }
export function sourceRegistry() {
  return allowedSourcesSchema.parse(process.env.SOURCE_REGISTRY_PATH ? jsonFile(process.env.SOURCE_REGISTRY_PATH) : []);
}
export function createRuntime(credentials?: {apiKey:string;apiSecret:string}) {
  const tradingMode = tradingModeSchema.parse(process.env.TRADING_MODE ?? 'dry_run');
  const environment = environmentSchema.parse(process.env.BYBIT_ENVIRONMENT ?? 'testnet');
  const db = firestore(); const audit = new AuditStore(db); const feed = new FeedStore(db,environment);
  let scenario: unknown;
  try { scenario=loadScenario(); } catch { scenario={}; }
  const parsedScenario=anyScenarioConfigSchema.safeParse(scenario);
  const scenarioExecution: Record<string,unknown> = parsedScenario.success ? parsedScenario.data.execution : {};
  let attestation: unknown;
  try { attestation=process.env.BYBIT_COMPATIBILITY_ATTESTATION_PATH ? jsonFile(process.env.BYBIT_COMPATIBILITY_ATTESTATION_PATH) : undefined; } catch { attestation=undefined; }
  const parsedAttestation=ExecutorSettingsSchema.innerType().shape.compatibilityAttestation.safeParse(attestation);
  const settings = ExecutorSettingsSchema.parse({
    tradingMode,environment,expectedAccountId:process.env.BYBIT_ACCOUNT_ID ?? 'unconfigured-dry-run',
    dedicatedAccountConfirmed:bool(process.env.DEDICATED_ACCOUNT_CONFIRMED),
    allowNewEntries:bool(process.env.ALLOW_NEW_ENTRIES,true),
    targetPositionNotionalUsd:(scenarioExecution.targetPositionNotionalUsd as '100' | '2000') ?? '100',
    leverage:(scenarioExecution.leverage as '1' | '20') ?? '1',
    entrySlippageBps:scenarioExecution.entrySlippageBps ?? '10',monetaryPrecisionUsd:scenarioExecution.monetaryPrecisionUsd ?? '0.01',
    protectionDeadlineMs:Math.min(Number(scenarioExecution.protectionTimeoutSeconds ?? 15),15)*1000,
    ...(parsedAttestation.success && parsedAttestation.data ? {compatibilityAttestation:parsedAttestation.data} : {}),
  });
  let queue: ReconcileQueue | undefined;
  if (tradingMode !== 'dry_run') {
    const required = z.object({project:z.string().min(1),region:z.string().min(1),queue:z.string().min(1),url:z.string().url(),serviceAccountEmail:z.string().email()}).safeParse({
      project:process.env.GCLOUD_PROJECT,region:process.env.APP_REGION ?? process.env.FUNCTION_REGION ?? 'us-central1',queue:process.env.RECONCILE_QUEUE,
      url:process.env.RUN_FUNCTION_URL,serviceAccountEmail:process.env.SCHEDULER_SERVICE_ACCOUNT,
    });
    if (required.success && required.data.url.startsWith('https://')) queue = new ReconcileQueue(required.data);
  }
  const store = new FirestoreExecutorStore(db,async (scope,due) => { if (queue) await queue.enqueue(scope,due); });
  const client = new BybitClient({environment,...(tradingMode === 'dry_run' ? {} : {credentials})});
  const executor = new BybitExecutor(client,store,settings);
  const provider = new BybitMarketDataProvider(environment);
  const deps: OrchestratorDeps = {
    now:()=>new Date(), reconcile:()=>executor.reconcile(),
    execute:async request => {
      // Verify the emergency dispatch channel BEFORE considering a new entry.
      if (tradingMode !== 'dry_run' && !queue) return {tradingMode,environment,executorId:'bybit-linear-executor-v1',executorVersion:'1.0.0',accountId:settings.expectedAccountId,status:'BLOCKED',reasonCodes:['RECONCILIATION_QUEUE_NOT_CONFIGURED'],leverage:settings.leverage};
      if (queue) {
        try { await queue.check(); }
        catch { return {tradingMode,environment,executorId:'bybit-linear-executor-v1',executorVersion:'1.0.0',accountId:settings.expectedAccountId,status:'BLOCKED',reasonCodes:['RECONCILIATION_QUEUE_UNAVAILABLE'],leverage:settings.leverage}; }
      }
      return executor.execute(request);
    },
    loadSnapshot:now=>loadRuntimeSnapshot({config:parsedScenario.success?parsedScenario.data:undefined,environment,now,
      publicDataEnabled:bool(process.env.PUBLIC_DATA_ENABLED,true),latestStructured:asOf=>feed.latest(asOf),
      publicSources:(config,ingested)=>fetchPublicFeeds(config,new PublicDataStore(db),ingested,{blsContact:process.env.BLS_CONTACT || undefined}),quoteProvider:provider}),
    saveSnapshot:snapshot=>audit.snapshot(snapshot),
    readEvaluation:id=>audit.read(id),
    prepareEvaluation:input=>audit.prepare(input),
    finalizeEvaluation:(record,scheduledAtUtc,lease,nowMs)=>audit.finalize(record,scheduledAtUtc,lease,nowMs),
  };
  return {scenario,deps,executor,audit,feed,queue,environment};
}
