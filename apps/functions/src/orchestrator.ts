import { evaluationSchema, anyScenarioConfigSchema, type Evaluation, type AnyScenarioConfig, type Snapshot } from '../../../packages/shared/src';
import { evaluateScenario } from '../../../packages/strategies';
import type { ExecutionRequest, ExecutionResult } from '../../../packages/execution/bybit/types';
import { ExecutionResultSchema } from '../../../packages/execution/bybit/types';
import { randomUUID } from 'node:crypto';
import { hash, type EvaluationLease, type EvaluationPreparation, type PreparedEvaluation } from './audit-store';

export interface OrchestratorDeps {
  reconcile(): Promise<ExecutionResult>;
  execute(request: ExecutionRequest): Promise<ExecutionResult>;
  loadSnapshot(now: Date): Promise<Snapshot>;
  saveSnapshot(snapshot: Snapshot): Promise<{hash: string; location: string}>;
  readEvaluation(id: string): Promise<unknown | undefined>;
  prepareEvaluation(input: EvaluationPreparation): Promise<PreparedEvaluation>;
  finalizeEvaluation(record: Evaluation, scheduledAtUtc: string, lease: EvaluationLease, nowMs: number): Promise<Evaluation>;
  now(): Date;
}
export function executionRequest(evaluation: Evaluation, config: AnyScenarioConfig, snapshot: Snapshot): ExecutionRequest {
  return {
    decision:evaluation.decision, scenarioId:config.scenarioId, evaluationId:evaluation.evaluationId,
    configHash:evaluation.configHash, validUntilUtc:evaluation.validUntilUtc, expiresAtUtc:config.expiresAtUtc,
    isDemo:config.demo, sourcesValidated:config.sourcesValidated && config.validationStatus === 'VALIDATED',
    snapshotSynthetic:snapshot.synthetic || evaluation.sources.some(s => s.synthetic), environment:config.environment,
    closeOnScenarioExpiry:config.closeOnScenarioExpiry,
    ...(snapshot.usdPerUsdt ? {usdPerUsdt:{value:snapshot.usdPerUsdt.value,observedAtUtc:snapshot.usdPerUsdt.provenance.observedAt,verified:snapshot.usdPerUsdt.provenance.verified}} : {}),
    ...(evaluation.decision !== 'NO_TRADE' ? {levels:config.levels[evaluation.decision]} : {}),
    costs:config.costs, minRewardRisk:config.minRewardRisk,
  };
}

export async function runEvaluation(configInput: unknown, scheduledAtUtc: string, deps: OrchestratorDeps): Promise<Evaluation> {
  // This MUST precede config validation, provider access and even deduplication.
  const reconciliation = ExecutionResultSchema.parse(await deps.reconcile());
  const parsed = anyScenarioConfigSchema.safeParse(configInput);
  const configDigest = hash(configInput);
  const scenarioId = parsed.success ? parsed.data.scenarioId : 'invalid-config';
  const id = hash({scenarioId, configHash:configDigest, schedule:scheduledAtUtc});
  const replayView = (record: Evaluation): Evaluation => {
    // The immutable audit remains intact, but an HTTP retry never advertises an expired signal.
    if (record.decision !== 'NO_TRADE' && Date.parse(record.validUntilUtc) <= deps.now().getTime()) return evaluationSchema.parse({
      ...record, decision:'NO_TRADE', status:'BLOCKED', reasonCodes:['EVALUATION_EXPIRED'],
      explanation:'La evaluación original venció; la conciliación de posiciones continúa.', execution:{...reconciliation},
    });
    return evaluationSchema.parse({...record, execution:{...reconciliation}});
  };
  const old = await deps.readEvaluation(id);
  if (old) return replayView(evaluationSchema.parse(old));
  let snapshot: Snapshot = { snapshotId:id, environment:parsed.success ? parsed.data.environment : 'testnet', synthetic:false,
    quote:null, usdPerUsdt:null, calendar:null, employment:null, consensus:null, treasury:[], etf:null, marketCalendar:null, providerErrors:[] };
  let infrastructureFailure = false;
  try { snapshot = await deps.loadSnapshot(deps.now()); infrastructureFailure=snapshot.providerErrors.length>0; }
  catch { snapshot.providerErrors = ['PROVIDER_INFRASTRUCTURE_FAILURE']; infrastructureFailure = true; }
  // Persistence is a precondition for execution; this throws before opening on Firestore failure.
  const savedSnapshot = await deps.saveSnapshot(snapshot);
  let result = evaluateScenario(snapshot, configInput, deps.now());
  result = {...result, evaluationId:id, configHash:configDigest, snapshot:{...result.snapshot, ...savedSnapshot}, execution:{...reconciliation}};
  if (infrastructureFailure) result = {...result, decision:'NO_TRADE',status:'ERROR',reasonCodes:[...new Set([...result.reasonCodes,'PROVIDER_INFRASTRUCTURE_FAILURE'])],explanation:'Falló la obtención de datos; se bloquean nuevas entradas.',validUntilUtc:result.evaluatedAtUtc};
  // The transactional draft determines the ONE canonical input and decision for this invocation key.
  // Another worker may have frozen a different snapshot while this worker was reading providers.
  const prepared = await deps.prepareEvaluation({ evaluation:evaluationSchema.parse(result), snapshot,
    scheduledAtUtc, owner:randomUUID(), nowMs:deps.now().getTime() });
  if (prepared.status === 'COMPLETE') return replayView(prepared.evaluation);
  if (prepared.status === 'BUSY') return evaluationSchema.parse({ ...prepared.evaluation,
    decision:'NO_TRADE', status:'BLOCKED', reasonCodes:['EVALUATION_IN_PROGRESS'],
    explanation:'Otra invocación conserva la evaluación canónica; esta respuesta transitoria no autoriza una entrada.',
    validUntilUtc:deps.now().toISOString(), execution:{...reconciliation},
  });
  result = {...prepared.evaluation, execution:{...reconciliation}};
  snapshot = prepared.snapshot;
  if (prepared.recovered) {
    // A crashed worker may already have submitted. Reconciliation above is authoritative; never resubmit
    // from a recovered draft, even when an exchange response is missing or the prior quote remains current.
    result.execution = {...reconciliation, reasonCodes:[...reconciliation.reasonCodes,'EVALUATION_RECOVERED_NO_RESUBMISSION']};
  } else if (parsed.success && result.decision !== 'NO_TRADE') {
    if (['LOCKED','UNKNOWN','EMERGENCY_CLOSE_PENDING'].includes(reconciliation.status)) result.execution = {...reconciliation};
    else {
      try { result.execution = {...ExecutionResultSchema.parse(await deps.execute(executionRequest(result, parsed.data, snapshot)))}; }
      catch { result.execution = {...reconciliation,status:'UNKNOWN',reasonCodes:['EXECUTION_INFRASTRUCTURE_FAILURE']}; }
    }
  }
  const final = await deps.finalizeEvaluation(evaluationSchema.parse(result), scheduledAtUtc, prepared.lease, deps.now().getTime());
  return prepared.recovered ? replayView(final) : final;
}
