import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { makeFixture } from '../fixtures';
import { makePublicFixture } from '../fixtures/public';
import { makeFundamentalFixture } from '../packages/strategies/btc-strategy-fundamental-trigger-v1/test/fixtures';
import { evaluateScenario } from '../packages/strategies';
import { evaluationSchema, anyScenarioConfigSchema, snapshotSchema, PUBLIC_NFP_STRATEGY_ID, FUNDAMENTAL_TRIGGER_STRATEGY_ID } from '../packages/shared/src';
import { BybitExecutor } from '../packages/execution/bybit/executor';
import { FakeBybitClient, FakeClock, MemoryExecutorStore } from '../packages/execution/bybit/testing';
import { executionRequest } from '../apps/functions/src/orchestrator';

async function main(): Promise<void> {
  const args=process.argv.slice(2);
  const option=(name:string) => {const at=args.indexOf(name);return at>=0 ? args[at+1] : undefined;};
  const fixtureName=option('--fixture') ?? 'long';
  if (!['long','short','expired'].includes(fixtureName)) throw new Error('Use --fixture long|short|expired');
  const inputSnapshot=option('--snapshot'); const inputConfig=option('--config');
  const strategy=option('--strategy') ?? 'public';
  if(!['public','original','fundamental'].includes(strategy))throw new Error('Use --strategy public|original|fundamental');
  const configured=inputConfig?anyScenarioConfigSchema.parse(JSON.parse(readFileSync(resolve(inputConfig),'utf8'))):undefined;
  const isFundamental=configured?configured.strategyId===FUNDAMENTAL_TRIGGER_STRATEGY_ID:strategy==='fundamental';
  const usePublic=configured?configured.strategyId===PUBLIC_NFP_STRATEGY_ID:strategy==='public';
  const fixture=isFundamental
    ? makeFundamentalFixture(fixtureName==='short'?'SHORT':'LONG')
    : (usePublic?makePublicFixture:makeFixture)(fixtureName==='short'?'SHORT':'LONG');
  const config=configured ?? fixture.config;
  if (!inputSnapshot) {
    fixture.snapshot.environment = config.environment;
    if (fixture.snapshot.quote) fixture.snapshot.quote.environment = config.environment;
  }
  const snapshot=snapshotSchema.parse(inputSnapshot ? JSON.parse(readFileSync(resolve(inputSnapshot),'utf8')) : fixture.snapshot);
  if (config.tradingMode !== 'dry_run') throw new Error('LOCAL_CLI_DRY_RUN_ONLY');
  const defaultExpiredNow = isFundamental ? '2026-10-06T20:20:00.000Z' : '2026-10-02T21:42:00.000Z';
  const now=option('--now') ?? (fixtureName==='expired'?defaultExpiredNow:fixture.now);
  let result=evaluateScenario(snapshot,config,now);
  const clock=new FakeClock(Date.parse(now));
  const client=new FakeBybitClient(config.environment,clock);
  if (snapshot.quote) client.book={environment:config.environment,bid:snapshot.quote.bid,ask:snapshot.quote.ask,observedAtMs:Date.parse(snapshot.quote.provenance.observedAt)};
  const executor=new BybitExecutor(client,new MemoryExecutorStore(()=>clock.now()),{
    tradingMode:'dry_run',environment:config.environment,expectedAccountId:'synthetic-local-fixture',dedicatedAccountConfirmed:false,allowNewEntries:config.allowNewEntries,
    targetPositionNotionalUsd:config.execution.targetPositionNotionalUsd,leverage:config.execution.leverage,
    entrySlippageBps:config.execution.entrySlippageBps,monetaryPrecisionUsd:config.execution.monetaryPrecisionUsd
  },clock);
  result=evaluationSchema.parse({...result,execution:{...await executor.execute(executionRequest(result,config,snapshot)),simulationInstrument:'synthetic; actual Bybit specifications are fetched at runtime'}});
  const json=JSON.stringify(result,null,2)+'\n';
  const out=option('--out');
  if (out) { const path=resolve(out);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,json); }
  process.stdout.write(json);
}
main().catch(error=>{process.stderr.write((error instanceof Error ? error.message : 'LOCAL_EVALUATION_FAILED')+'\n');process.exitCode=1;});
