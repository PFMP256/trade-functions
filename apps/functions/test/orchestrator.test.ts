import { describe, expect, it, vi } from 'vitest';
import { makeFixture } from '../../../fixtures';
import { evaluationSchema, type Evaluation, type Snapshot } from '../../../packages/shared/src';
import { runEvaluation, type OrchestratorDeps } from '../src/orchestrator';
import { hash, type EvaluationLease, type EvaluationPreparation, type PreparedEvaluation } from '../src/audit-store';
import type { ExecutionResult } from '../../../packages/execution/bybit/types';

const idle: ExecutionResult={tradingMode:'dry_run',executorId:'bybit-linear-executor-v1',executorVersion:'1.0.0',environment:'testnet',accountId:'test',status:'NO_ENTRY',reasonCodes:[],leverage:'1'};
function harness() {
  const fixture=makeFixture(); const sequence:string[]=[];const results=new Map<string,unknown>();
  const drafts=new Map<string,{evaluation:Evaluation;snapshot:Snapshot;lease:EvaluationLease}>();
  const deps:OrchestratorDeps={now:()=>new Date(fixture.now),
    reconcile:vi.fn(async()=>{sequence.push('reconcile');return idle;}),
    execute:vi.fn(async():Promise<ExecutionResult>=>{sequence.push('execute');return {...idle,status:'DRY_RUN'};}),
    loadSnapshot:vi.fn(async()=>{sequence.push('providers');return fixture.snapshot;}),
    saveSnapshot:vi.fn(async s=>{sequence.push('snapshot');return {hash:hash(s),location:'snapshots/test'};}),
    readEvaluation:async id=>results.get(id),
    prepareEvaluation:async () => {
      throw new Error('placeholder');
    },
    finalizeEvaluation:async (record,_scheduledAt,lease,nowMs)=>{
      sequence.push('finalize');const draft=drafts.get(record.evaluationId);
      if (!draft || draft.lease.owner!==lease.owner || draft.lease.fence!==lease.fence || draft.lease.expiresAtMs<=nowMs) throw new Error('EVALUATION_CLAIM_LOST');
      if (hash({...draft.evaluation,execution:{}})!==hash({...record,execution:{}})) throw new Error('CANONICAL_MISMATCH');
      results.set(record.evaluationId,structuredClone(record));return evaluationSchema.parse(record);
    },
  };
  deps.prepareEvaluation=vi.fn(async (input:EvaluationPreparation):Promise<PreparedEvaluation>=>{
    sequence.push('prepare');const final=results.get(input.evaluation.evaluationId);
    if(final)return {status:'COMPLETE',evaluation:evaluationSchema.parse(final)};
    const old=drafts.get(input.evaluation.evaluationId);
    if(old&&old.lease.expiresAtMs>input.nowMs)return {status:'BUSY',evaluation:structuredClone(old.evaluation)};
    const lease={evaluationId:input.evaluation.evaluationId,owner:input.owner,fence:(old?.lease.fence??0)+1,expiresAtMs:input.nowMs+240000};
    const canonical={evaluation:structuredClone(old?.evaluation??input.evaluation),snapshot:structuredClone(old?.snapshot??input.snapshot),lease};
    drafts.set(input.evaluation.evaluationId,canonical);
    return {status:'ACQUIRED',...structuredClone(canonical),recovered:Boolean(old)};
  });
  return {fixture,sequence,results,drafts,deps};
}
describe('orchestration and safe persistence boundary',()=>{
  it('reconciles before providers; persists snapshot AND canonical decision before execution',async()=>{
    const {fixture,sequence,deps}=harness();const result=await runEvaluation(fixture.config,fixture.now,deps);
    expect(result.decision).toBe('LONG');expect(sequence).toEqual(['reconcile','providers','snapshot','prepare','execute','finalize']);
  });
  it('persists provider failure as a fresh NO_TRADE/error',async()=>{
    const {fixture,deps}=harness();deps.loadSnapshot=vi.fn(async()=>{throw new Error('secret must not escape');});
    const result=await runEvaluation(fixture.config,fixture.now,deps);
    expect(result.decision).toBe('NO_TRADE');expect(result.status).toBe('ERROR');expect(JSON.stringify(result)).not.toContain('secret');expect(deps.execute).not.toHaveBeenCalled();
  });
  it('unavailable persistence blocks all execution',async()=>{
    const {fixture,deps}=harness();deps.saveSnapshot=async()=>{throw new Error('offline');};
    await expect(runEvaluation(fixture.config,fixture.now,deps)).rejects.toThrow('offline');expect(deps.execute).not.toHaveBeenCalled();expect(deps.reconcile).toHaveBeenCalledOnce();
  });
  it('a failed canonical decision commit blocks execution even when snapshot persistence succeeded',async()=>{
    const {fixture,deps}=harness();deps.prepareEvaluation=async()=>{throw new Error('draft unavailable');};
    await expect(runEvaluation(fixture.config,fixture.now,deps)).rejects.toThrow('draft unavailable');expect(deps.execute).not.toHaveBeenCalled();
  });
  it('retries reconcile but never execute again; expired cached signal becomes NO_TRADE',async()=>{
    const {fixture,deps}=harness();await runEvaluation(fixture.config,fixture.now,deps);await runEvaluation(fixture.config,fixture.now,deps);
    expect(deps.execute).toHaveBeenCalledOnce();expect(deps.reconcile).toHaveBeenCalledTimes(2);
    deps.now=()=>new Date('2026-10-02T13:00:00Z');const expired=await runEvaluation(fixture.config,fixture.now,deps);
    expect(expired.decision).toBe('NO_TRADE');expect(expired.reasonCodes).toContain('EVALUATION_EXPIRED');
  });
  it('invalid config and expiry still reconcile existing positions first',async()=>{
    const {fixture,sequence,deps}=harness();await runEvaluation({},fixture.now,deps);expect(sequence[0]).toBe('reconcile');expect(deps.execute).not.toHaveBeenCalled();
    deps.now=()=>new Date('2026-10-03T00:00:00Z');const expired=await runEvaluation(fixture.config,'2026-10-03T00:00:00Z',deps);expect(expired.reasonCodes).toContain('SCENARIO_EXPIRED');
  });
  it('keeps decision distinct from exchange rejection',async()=>{
    const {fixture,deps}=harness();deps.execute=async()=>({...idle,status:'REJECTED',reasonCodes:['EXCHANGE_REJECTED']});
    const result=await runEvaluation(fixture.config,fixture.now,deps);expect(result.decision).toBe('LONG');expect(result.execution.status).toBe('REJECTED');
  });
  it('concurrent NO_TRADE worker cannot replace the decision/snapshot authorizing an in-flight LONG',async()=>{
    const {fixture,deps,drafts,results}=harness();
    let notifySubmitted:()=>void=()=>undefined;const submitted=new Promise<void>(resolve=>{notifySubmitted=resolve;});
    let finishSubmission:()=>void=()=>undefined;const pending=new Promise<void>(resolve=>{finishSubmission=resolve;});
    deps.execute=vi.fn(async request=>{
      const draft=drafts.get(request.evaluationId)!;
      expect(draft.evaluation.decision).toBe('LONG');expect(draft.snapshot.quote).not.toBeNull();
      notifySubmitted();await pending;return {...idle,status:'PROTECTED' as const};
    });
    const winner=runEvaluation(fixture.config,fixture.now,deps);await submitted;
    deps.loadSnapshot=async()=>({...structuredClone(fixture.snapshot),quote:null});
    const loser=await runEvaluation(fixture.config,fixture.now,deps);
    expect(loser.decision).toBe('NO_TRADE');expect(loser.reasonCodes).toEqual(['EVALUATION_IN_PROGRESS']);
    expect(results.size).toBe(0);expect(deps.execute).toHaveBeenCalledOnce();
    finishSubmission();const final=await winner;
    expect(final.decision).toBe('LONG');expect(final.execution.status).toBe('PROTECTED');
    expect(evaluationSchema.parse(results.get(final.evaluationId)).snapshot.hash).toBe(hash(fixture.snapshot));
  });
  it('recovers the frozen decision after a crash after submission without regenerating or resending',async()=>{
    const {fixture,deps,results,drafts}=harness();
    const finalize=deps.finalizeEvaluation;
    deps.finalizeEvaluation=async()=>{throw new Error('crash after exchange acceptance');};
    await expect(runEvaluation(fixture.config,fixture.now,deps)).rejects.toThrow('crash after exchange acceptance');
    expect(deps.execute).toHaveBeenCalledOnce();expect(results.size).toBe(0);
    const canonical=[...drafts.values()][0]!.evaluation;
    deps.now=()=>new Date(Date.parse(fixture.now)+240001);
    deps.reconcile=vi.fn(async()=>({...idle,status:'PROTECTED' as const}));
    deps.loadSnapshot=vi.fn(async()=>{throw new Error('feed offline during recovery');});
    deps.finalizeEvaluation=finalize;
    const recovered=await runEvaluation(fixture.config,fixture.now,deps);
    expect(recovered.decision).toBe('NO_TRADE');expect(recovered.reasonCodes).toContain('EVALUATION_EXPIRED');
    expect(deps.execute).toHaveBeenCalledOnce();
    const historical=evaluationSchema.parse(results.get(canonical.evaluationId));
    expect(historical.decision).toBe('LONG');expect(historical.snapshot).toEqual(canonical.snapshot);
    expect(historical.execution.status).toBe('PROTECTED');
    expect(historical.execution.reasonCodes).toContain('EVALUATION_RECOVERED_NO_RESUBMISSION');
  });
});
