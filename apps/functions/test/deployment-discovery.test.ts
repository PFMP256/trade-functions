import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Isolated SDK discovery imports only: no handlers, .env files, credentials or API requests.
// A fresh process matters because Firebase keeps its parameter registry in globalThis.
function discover(mode: string | undefined, binding = 'none') {
  const env: NodeJS.ProcessEnv = {...process.env, APP_REGION:'us-central1', FUNCTION_REGION:'europe-west1',
    RUNTIME_SERVICE_ACCOUNT:'btc-runtime@trade-functions-20261001.iam.gserviceaccount.com', BYBIT_CREDENTIAL_BINDING:binding};
  for (const key of ['BYBIT_API_KEY','BYBIT_API_SECRET','BYBIT_TESTNET_API_KEY','BYBIT_TESTNET_API_SECRET']) delete env[key];
  if (mode === undefined) delete env.TRADING_MODE;
  else env.TRADING_MODE = mode;
  const code = `
    const functions = require('./apps/functions/src/index.ts');
    const params = require('firebase-functions/params').declaredParams;
    const endpoint = functions.runBtcNfpEtfBybitV1.__endpoint;
    process.stdout.write(JSON.stringify({
      declared: params.map(param => param.name),
      bound: endpoint.secretEnvironmentVariables.map(param => param.key),
      invoker: endpoint.httpsTrigger.invoker,
      region: endpoint.region,
      serviceAccountEmail: endpoint.serviceAccountEmail
    }));
  `;
  return JSON.parse(execFileSync(process.execPath, ['--import','tsx','-e',code], {
    cwd:resolve(__dirname,'../../..'), env, encoding:'utf8', timeout:10000,
  })) as {declared:string[];bound:string[];invoker:string[];region:string[];serviceAccountEmail:string};
}

describe('Firebase deployment discovery credentials', () => {
  it('can provision production secrets without enabling live execution', () => {
    const manifest = discover('dry_run','mainnet');
    expect(manifest.declared).toEqual(['BYBIT_API_KEY','BYBIT_API_SECRET']);
    expect(manifest.bound).toEqual(['BYBIT_API_KEY','BYBIT_API_SECRET']);
    expect(manifest.invoker).toEqual(['private']);
  });
  it('operating mode takes precedence over a provisioned pair', () => {
    expect(discover('testnet','mainnet').bound).toEqual(['BYBIT_TESTNET_API_KEY','BYBIT_TESTNET_API_SECRET']);
    expect(discover('live','testnet').bound).toEqual(['BYBIT_API_KEY','BYBIT_API_SECRET']);
  });
  it.each([undefined,'dry_run'])('declares no secret parameters or bindings for mode %s', mode => {
    expect(discover(mode)).toEqual({declared:[],bound:[],invoker:['private'],region:['us-central1'],
      serviceAccountEmail:'btc-runtime@trade-functions-20261001.iam.gserviceaccount.com'});
  });
  it.each([
    ['live',['BYBIT_API_KEY','BYBIT_API_SECRET']],
    ['testnet',['BYBIT_TESTNET_API_KEY','BYBIT_TESTNET_API_SECRET']],
  ] as const)('declares and binds only the selected pair for %s without reading credentials', (mode, names) => {
    const manifest = discover(mode);
    expect(manifest.declared).toEqual(names);
    expect(manifest.bound).toEqual(names);
    expect(manifest.invoker).toEqual(['private']);
    expect(manifest.serviceAccountEmail).toBe('btc-runtime@trade-functions-20261001.iam.gserviceaccount.com');
  });
});
