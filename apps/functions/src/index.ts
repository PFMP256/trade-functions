import { onRequest } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import { z } from 'zod';
import { authenticate, scheduledTime } from './auth';
import { createRuntime, firestore, loadScenario, sourceRegistry } from './runtime';
import { runEvaluation } from './orchestrator';
import { evaluateScenario } from '../../../packages/strategies';
import { environmentSchema, type Snapshot } from '../../../packages/shared/src';
import { FeedStore } from './feed-store';
import { AuditStore, hash } from './audit-store';

// Firebase resolves every declared secret during discovery, even without a binding.
// Declare only the active pair. A dry_run deployment can explicitly mount a pair
// for production provisioning; it still never passes credentials to the executor.
// Deployment must be repeated when mode or credential bindings change.
const provisionedCredentials = z.enum(['none','mainnet','testnet']).parse(process.env.BYBIT_CREDENTIAL_BINDING ?? 'none');
const credentialParams = process.env.TRADING_MODE === 'live'
  ? {mode:'live' as const,key:defineSecret('BYBIT_API_KEY'),secret:defineSecret('BYBIT_API_SECRET')}
  : process.env.TRADING_MODE === 'testnet'
    ? {mode:'testnet' as const,key:defineSecret('BYBIT_TESTNET_API_KEY'),secret:defineSecret('BYBIT_TESTNET_API_SECRET')}
    : provisionedCredentials === 'mainnet'
      ? {mode:'live' as const,key:defineSecret('BYBIT_API_KEY'),secret:defineSecret('BYBIT_API_SECRET')}
      : provisionedCredentials === 'testnet'
        ? {mode:'testnet' as const,key:defineSecret('BYBIT_TESTNET_API_KEY'),secret:defineSecret('BYBIT_TESTNET_API_SECRET')}
        : undefined;
const credentialBindings = credentialParams ? [credentialParams.key,credentialParams.secret] : [];
const region = process.env.APP_REGION ?? process.env.FUNCTION_REGION ?? 'us-central1';
const emails = (value:string|undefined) => (value ?? '').split(',').map(s=>s.trim()).filter(Boolean);
const baseOptions = {region, invoker:'private' as const, cors:false, timeoutSeconds:180, memory:'512MiB' as const, maxInstances:3, concurrency:1,
  ...(process.env.RUNTIME_SERVICE_ACCOUNT ? {serviceAccount:process.env.RUNTIME_SERVICE_ACCOUNT} : {}),
};
const runBody = z.object({kind:z.enum(['evaluate','reconcile']).default('evaluate')}).strict();
async function auth(req: Parameters<typeof authenticate>[0], audience:string|undefined, allowed:string[]): Promise<{email:string}> {
  if (process.env.FUNCTIONS_EMULATOR === 'true' && process.env.GCLOUD_PROJECT?.startsWith('demo-') && req.headers['x-emulator-auth'] === 'local-development') return {email:'emulator@local.invalid'};
  return authenticate(req,audience ?? '',allowed);
}
export const runBtcNfpEtfBybitV1 = onRequest({...baseOptions,secrets:credentialBindings},async (req,res) => {
  if (req.method !== 'POST') { res.status(405).json({error:'METHOD_NOT_ALLOWED'}); return; }
  try { await auth(req,process.env.RUN_FUNCTION_URL,emails(process.env.SCHEDULER_SERVICE_ACCOUNT)); }
  catch { res.status(401).json({error:'UNAUTHENTICATED'}); return; }
  const body = runBody.safeParse(req.body ?? {});
  if (!body.success) { res.status(400).json({error:'INVALID_REQUEST'}); return; }
  let scheduledAtUtc: string;
  try { scheduledAtUtc = scheduledTime(req.headers['x-cloudscheduler-scheduletime'],new Date()); }
  catch { res.status(400).json({error:'INVALID_SCHEDULE_TIME'}); return; }
  try {
    const mode = process.env.TRADING_MODE ?? 'dry_run';
    const credentials = credentialParams?.mode === mode
      ? {apiKey:credentialParams.key.value(),apiSecret:credentialParams.secret.value()} : undefined;
    const runtime = createRuntime(credentials);
    if (body.data.kind === 'reconcile') {
      const result = await runtime.executor.reconcile();
      res.status(['LOCKED','UNKNOWN','EMERGENCY_CLOSE_PENDING','BLOCKED'].includes(result.status) ? 503 : 200).json({execution:result}); return;
    }
    const result = await runEvaluation(runtime.scenario,scheduledAtUtc,runtime.deps);
    res.set('Cache-Control','no-store').status(result.status === 'ERROR' ? 503 : 200).json(result);
  } catch {
    // Never echo exceptions, response bodies, headers, keys or signatures.
    const now = new Date();
    let config: unknown;
    try { config=loadScenario(); } catch { config={}; }
    const snapshot: Snapshot = {snapshotId:`error-${now.toISOString()}`,environment:'testnet',synthetic:false,quote:null,usdPerUsdt:null,calendar:null,employment:null,consensus:null,treasury:[],etf:null,marketCalendar:null,providerErrors:['INFRASTRUCTURE_FAILURE']};
    const error = evaluateScenario(snapshot,config,now);
    error.decision='NO_TRADE'; error.status='ERROR'; error.reasonCodes=['INFRASTRUCTURE_FAILURE']; error.explanation='Falló la infraestructura; no se autorizan nuevas entradas. La exposición no se presume cerrada.';
    error.validUntilUtc=error.evaluatedAtUtc; error.execution={tradingMode:process.env.TRADING_MODE ?? 'dry_run',executorId:'bybit-linear-executor-v1',executorVersion:'1.0.0',status:'UNKNOWN',reasonCodes:['INFRASTRUCTURE_FAILURE']};
    error.evaluationId=hash({error:error.evaluationId,scheduledAtUtc});
    try { const audit=new AuditStore(firestore()); error.snapshot={...error.snapshot,...await audit.snapshot(snapshot)}; await audit.save(error,scheduledAtUtc); } catch { /* HTTP 503 stays explicit if audit storage is unavailable. */ }
    res.set('Cache-Control','no-store').status(503).json(error);
  }
});

export const ingestBtcNfpEtfDataV1 = onRequest({...baseOptions,timeoutSeconds:60},async (req,res) => {
  if (req.method !== 'POST') { res.status(405).json({error:'METHOD_NOT_ALLOWED'}); return; }
  let identity: {email:string};
  try { identity=await auth(req,process.env.INGEST_FUNCTION_URL,emails(process.env.INGESTOR_SERVICE_ACCOUNTS)); }
  catch { res.status(401).json({error:'UNAUTHENTICATED'}); return; }
  if (req.rawBody.byteLength > 700_000) { res.status(413).json({error:'PAYLOAD_TOO_LARGE'}); return; }
  try {
    const environment=environmentSchema.parse(process.env.BYBIT_ENVIRONMENT ?? 'testnet');
    const store=new FeedStore(firestore(),environment);
    const result=await store.ingest(req.body,new Date().toISOString(),sourceRegistry(),identity.email);
    res.status(201).json(result);
  } catch { res.status(422).json({error:'INGESTION_REJECTED',explanation:'Revise esquema, registro de fuentes, evidencia, revisiones y disponibilidad temporal.'}); }
});
