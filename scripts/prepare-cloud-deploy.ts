import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { blsUserAgent } from '../packages/data-providers/src/bls-public';

/** Creates an isolated Firebase upload source. Never reads the workspace .env or deploys resources. */
function main(): void {
  const args = process.argv.slice(2);
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    const allowedFlags = [
      '--project', '--region', '--bls-contact', '--credential-binding',
      '--reconcile-queue', '--trading-mode', '--bybit-environment',
      '--allow-new-entries', '--bybit-account-id', '--dedicated-account-confirmed'
    ];
    if (!flag || !allowedFlags.includes(flag) || !value || value.startsWith('--') || flags.has(flag)) {
      throw new Error('Usage: --project PROJECT_ID [--region southamerica-east1] [--bls-contact EMAIL_OR_HTTPS_URL] [--credential-binding none|mainnet|testnet] [--reconcile-queue QUEUE_NAME] [--trading-mode live|dry_run|testnet] [--bybit-environment mainnet|testnet] [--allow-new-entries true|false] [--bybit-account-id ACCOUNT_ID] [--dedicated-account-confirmed true|false]');
    }
    flags.set(flag, value);
  }
  const projectId = flags.get('--project') ?? '';
  const region = flags.get('--region') ?? 'southamerica-east1';
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)) throw new Error('Invalid Google Cloud project ID');
  if (!/^[a-z]+-[a-z]+[0-9]+$/.test(region)) throw new Error('Invalid Google Cloud region');
  // Optional operator contact for the declared BLS robot User-Agent. Never inferred from accounts or files.
  const blsContact = flags.get('--bls-contact');
  const blsAgent = blsUserAgent(blsContact);
  const tradingMode = flags.get('--trading-mode') ?? 'live';
  if (!['dry_run', 'testnet', 'live'].includes(tradingMode)) throw new Error('Invalid trading mode');
  const bybitEnvironment = flags.get('--bybit-environment') ?? (tradingMode === 'testnet' ? 'testnet' : 'mainnet');
  if (!['testnet', 'mainnet'].includes(bybitEnvironment)) throw new Error('Invalid Bybit environment');
  const allowNewEntries = flags.get('--allow-new-entries') ?? (tradingMode === 'live' ? 'true' : 'false');
  if (!['true', 'false'].includes(allowNewEntries)) throw new Error('Invalid allow-new-entries flag');
  const bybitAccountId = flags.get('--bybit-account-id');
  if (bybitAccountId && !/^\d+$/.test(bybitAccountId)) throw new Error('Invalid Bybit account ID');
  if (tradingMode === 'live' && !bybitAccountId) throw new Error('BYBIT_ACCOUNT_ID is required for live trading mode');
  const dedicatedAccountConfirmed = flags.get('--dedicated-account-confirmed') ?? 'false';
  if (!['true', 'false'].includes(dedicatedAccountConfirmed)) throw new Error('Invalid dedicated-account-confirmed flag');
  const credentialBinding = flags.get('--credential-binding') ?? (tradingMode === 'live' ? 'mainnet' : 'none');
  if (!['none','mainnet','testnet'].includes(credentialBinding)) throw new Error('Invalid credential binding');
  const reconcileQueue = flags.get('--reconcile-queue');
  if (reconcileQueue && !/^[a-zA-Z0-9_-]{1,100}$/.test(reconcileQueue)) throw new Error('Invalid reconciliation queue name');

  const workspace = realpathSync(resolve(__dirname, '..'));
  const withinWorkspace = (path: string): boolean => {
    const fromRoot = relative(workspace, path);
    return fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
  };
  const sourceFile = (path: string): string => {
    const absolute = resolve(workspace, path);
    if (!withinWorkspace(absolute) || !lstatSync(absolute).isFile() || lstatSync(absolute).isSymbolicLink()) {
      throw new Error(`Expected an ordinary workspace file: ${path}`);
    }
    return absolute;
  };
  const sourceDirectory = (path: string): string => {
    const absolute = resolve(workspace, path);
    if (!withinWorkspace(absolute) || !lstatSync(absolute).isDirectory() || lstatSync(absolute).isSymbolicLink() || !withinWorkspace(realpathSync(absolute))) {
      throw new Error(`Expected an ordinary workspace directory: ${path}`);
    }
    return absolute;
  };

  // Validate the complete allowlist before creating a staging directory.
  const directoryAllowlist = ['dist/apps/functions/src', 'dist/packages', 'dist/scenarios'];
  const fileAllowlist = [
    'scenarios/btc-nfp-2026-10-02.demo.json',
    'scenarios/btc-nfp-public-2026-10-02.demo.json',
    'config/source-registry.json',
  ];
  directoryAllowlist.forEach(sourceDirectory);
  [...fileAllowlist, 'package.json', 'package-lock.json', 'firestore.rules', 'firestore.indexes.json', 'dist/apps/functions/src/index.js'].forEach(sourceFile);
  const localDependencies = sourceDirectory('node_modules');
  const packageJson = JSON.parse(readFileSync(sourceFile('package.json'), 'utf8')) as Record<string, unknown>;
  const lockJson = JSON.parse(readFileSync(sourceFile('package-lock.json'), 'utf8')) as Record<string, unknown>;

  const stagingBase = resolve(workspace, '.local/cloud-deploy');
  mkdirSync(stagingBase, { recursive: true });
  if (!withinWorkspace(realpathSync(stagingBase))) throw new Error('Staging directory resolves outside the workspace');
  const timestamp = new Date().toISOString().replace(/[-:.]/g, '');
  const staging = mkdtempSync(join(stagingBase, `${projectId}-${timestamp}-`));
  const functionsSource = join(staging, 'functions');
  mkdirSync(functionsSource);
  let copiedFiles = 0;
  function copy(source: string, destination: string): void {
    mkdirSync(resolve(destination, '..'), { recursive: true });
    copyFileSync(source, destination);
    copiedFiles++;
  }
  function copyProductionTree(source: string, destination: string): void {
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('Production source must not contain symbolic links');
      if (entry.isDirectory()) {
        if (/^(?:tests?|__tests__|fixtures|scripts)$/i.test(entry.name)) continue;
        copyProductionTree(join(source, entry.name), join(destination, entry.name));
      } else if (entry.isFile() && /\.(?:js|json)$/.test(entry.name) && !/\.(?:test|spec)\./.test(entry.name)) {
        copy(join(source, entry.name), join(destination, entry.name));
      }
    }
  }
  for (const path of directoryAllowlist) copyProductionTree(sourceDirectory(path), join(functionsSource, path));
  for (const path of fileAllowlist) copy(sourceFile(path), join(functionsSource, path));

  // Cloud Build receives compiled JavaScript. Retain the exact dependency manifest/lock
  // but disable lifecycle/build scripts that expect TypeScript source in the upload.
  packageJson.scripts = { 'gcp-build': '' };
  packageJson.main = 'deployment-bootstrap.cjs';
  const json = (path: string, value: unknown): void => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  json(join(functionsSource, 'package.json'), packageJson);
  json(join(functionsSource, 'package-lock.json'), lockJson);
  for (const path of ['firestore.rules', 'firestore.indexes.json']) copy(sourceFile(path), join(staging, path));

  const functionName = 'runBtcNfpEtfBybitV1';
  // Region-specific codebases let a replacement be verified before explicitly
  // retiring its predecessor. Firebase must not auto-delete the old region.
  const codebase = `btc-strategy-${region}`;
  const runService = functionName.toLowerCase();
  const runUrl = `https://${region}-${projectId}.cloudfunctions.net/${functionName}`;
  const deploymentEnvironment: Record<string, string> = {
    TRADING_MODE: tradingMode,
    BYBIT_ENVIRONMENT: bybitEnvironment,
    ALLOW_NEW_ENTRIES: allowNewEntries,
    PUBLIC_DATA_ENABLED: 'true',
    DEDICATED_ACCOUNT_CONFIRMED: dedicatedAccountConfirmed,
    APP_REGION: region,
    SCENARIO_CONFIG_PATH: 'scenarios/btc-nfp-public-2026-10-02.demo.json',
    RUNTIME_SERVICE_ACCOUNT: `btc-runtime@${projectId}.iam.gserviceaccount.com`,
    SCHEDULER_SERVICE_ACCOUNT: `btc-scheduler@${projectId}.iam.gserviceaccount.com`,
    RUN_FUNCTION_URL: runUrl,
    BYBIT_CREDENTIAL_BINDING: credentialBinding,
    ...(bybitAccountId ? { BYBIT_ACCOUNT_ID: bybitAccountId } : {}),
    ...(reconcileQueue ? { RECONCILE_QUEUE: reconcileQueue } : {}),
    ...(blsContact ? { BLS_CONTACT: blsContact } : {}),
  };
  // Firebase CLI sanitizes the discovery subprocess environment before loading
  // dotenv. This generated entrypoint supplies the configuration inside that
  // subprocess and in the deployed runtime.
  writeFileSync(join(functionsSource, 'deployment-bootstrap.cjs'),
    `'use strict';\n` +
    `// Generated ${deploymentEnvironment.TRADING_MODE} deployment configuration; contains no credentials.\n` +
    `Object.assign(process.env, ${JSON.stringify(deploymentEnvironment, null, 2)});\n` +
    `module.exports = require('./dist/apps/functions/src/index.js');\n`,
    {encoding:'utf8',flag:'wx'});
  const deployOnly = `firestore:rules,firestore:indexes,functions:${codebase}:${functionName}`;
  const psLiteral = (value: string): string => `'${value.replace(/'/g, "''")}'`;
  // Preserve a consistent parent CLI environment as well. Discovery itself is
  // configured by deployment-bootstrap.cjs because CLI child environments are filtered.
  // Values are generated from this allowlist; the wrapper never reads any .env.
  const deploymentScript = `# Generated configuration only; contains no Bybit credentials.
$ErrorActionPreference = 'Stop'
$deploymentVariables = @{
${Object.entries(deploymentEnvironment).map(([key, value]) => `  ${key} = ${psLiteral(value)}`).join('\n')}
}
$previousVariables = @{}
foreach ($key in $deploymentVariables.Keys) {
  $previousVariables[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
}
# Windows PowerShell 5.1 turns redirected native stderr (progress, "Updated IAM policy") into
# terminating errors under 'Stop'. Native success is decided exclusively by the exit code.
function Invoke-Native {
  param([scriptblock]$Command, [string]$Failure)
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $Command } finally { $ErrorActionPreference = $previousPreference }
  if ($LASTEXITCODE -ne 0) { throw $Failure }
}
$locationPushed = $false
try {
  foreach ($key in $deploymentVariables.Keys) {
    [Environment]::SetEnvironmentVariable($key, $deploymentVariables[$key], 'Process')
  }
  Push-Location -LiteralPath $PSScriptRoot
  $locationPushed = $true
  Invoke-Native { & firebase deploy --project ${psLiteral(projectId)} --only ${psLiteral(deployOnly)} --non-interactive } 'Firebase deployment failed; inspect the preceding CLI output.'
  # invoker:private resets the service policy during deploy; restore only the authorized caller.
  Invoke-Native { & gcloud run services add-iam-policy-binding ${psLiteral(runService)} --project ${psLiteral(projectId)} --region ${psLiteral(region)} --member ${psLiteral(`serviceAccount:${deploymentEnvironment.SCHEDULER_SERVICE_ACCOUNT}`)} --role 'roles/run.invoker' --quiet } 'Invoker IAM binding failed; the deployment is not ready for authenticated calls.'
} finally {
  if ($locationPushed) { Pop-Location }
  foreach ($key in $deploymentVariables.Keys) {
    [Environment]::SetEnvironmentVariable($key, $previousVariables[$key], 'Process')
  }
}
`;
  const deploymentScriptPath = join(staging, 'deploy.ps1');
  writeFileSync(deploymentScriptPath, deploymentScript, {encoding:'utf8',flag:'wx'});
  writeFileSync(join(functionsSource, '.env'), `${Object.entries(deploymentEnvironment).map(([key, value]) => `${key}=${value}`).join('\n')}\n`, { encoding: 'utf8', flag: 'wx' });
  json(join(staging, 'firebase.json'), {
    functions: [{
      source: 'functions', codebase, runtime: 'nodejs22',
      ignore: ['node_modules', '.git', '.env', '.env.*', '.secret.local', '*-debug.log', '**/*.map', '**/*.test.*', '**/*.spec.*'],
    }],
    firestore: { rules: 'firestore.rules', indexes: 'firestore.indexes.json' },
  });
  // The CLI needs installed modules for local function discovery. Its ignore list
  // excludes this junction from the uploaded archive; production installs use the lockfile.
  if (existsSync(join(functionsSource, 'node_modules'))) throw new Error('Staging dependencies already exist');
  symlinkSync(localDependencies, join(functionsSource, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const manifest = {
    projectId, region, codebase, stagingDirectory: staging, functionsSource,
    functionName, functionUrl: runUrl, runService,
    tradingMode: deploymentEnvironment.TRADING_MODE,
    marketDataEnvironment: deploymentEnvironment.BYBIT_ENVIRONMENT,
    allowNewEntries: deploymentEnvironment.ALLOW_NEW_ENTRIES === 'true',
    bybitAccountId: deploymentEnvironment.BYBIT_ACCOUNT_ID ?? null,
    dedicatedAccountConfirmed: deploymentEnvironment.DEDICATED_ACCOUNT_CONFIRMED === 'true',
    credentialFilesRead: false,
    credentialBindings: credentialBinding === 'mainnet' ? ['BYBIT_API_KEY','BYBIT_API_SECRET'] : credentialBinding === 'testnet' ? ['BYBIT_TESTNET_API_KEY','BYBIT_TESTNET_API_SECRET'] : [],
    reconciliationQueue: reconcileQueue ?? null,
    compiledFilesCopied: copiedFiles, environmentKeys: Object.keys(deploymentEnvironment),
    deployOnly, deploymentScript: deploymentScriptPath,
    deploymentEntrypoint: 'deployment-bootstrap.cjs',
    blsUserAgent: blsAgent, blsContactConfigured: Boolean(blsContact),
  };
  json(join(staging, 'deployment.json'), manifest);
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}

try { main(); }
catch (error) {
  process.stderr.write(`CLOUD_DEPLOY_PREPARATION_FAILED: ${error instanceof Error ? error.message : 'Unknown preparation error'}\n`);
  process.exitCode = 1;
}
