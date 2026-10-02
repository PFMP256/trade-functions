import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

/** Sends only the named Bybit pair to Secret Manager; values never enter argv or logs. */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 3 || args[0] !== '--project' || args[2] !== '--apply' || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(args[1]!)) {
    throw new Error('Usage: --project PROJECT_ID --apply');
  }
  const project = args[1]!;
  const names = ['BYBIT_API_KEY','BYBIT_API_SECRET'] as const;
  const values = parseEnv(readFileSync(resolve(__dirname, '../.env'), 'utf8'));
  for (const name of names) {
    if (!values[name]?.trim() || values[name] !== values[name]!.trim() || /[\r\n\0]/.test(values[name]!)) throw new Error(`Invalid or missing ${name}`);
  }
  let token: string;
  try {
    token = (process.platform === 'win32'
      ? execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command','gcloud auth print-access-token --quiet'],{encoding:'utf8',stdio:['ignore','pipe','pipe']})
      : execFileSync('gcloud',['auth','print-access-token','--quiet'],{encoding:'utf8',stdio:['ignore','pipe','pipe']})).trim();
  } catch { throw new Error('Google authentication failed'); }
  const base = `https://secretmanager.googleapis.com/v1/projects/${project}/secrets`;
  async function request(url: string, method = 'GET', body?: unknown, allow404 = false): Promise<any> {
    let response: Response;
    try {
      response = await fetch(url,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
        ...(body === undefined ? {} : {body:JSON.stringify(body)}),signal:AbortSignal.timeout(30000)});
    } catch { throw new Error(`Secret Manager ${method} request failed`); }
    if (allow404 && response.status === 404) return undefined;
    if (!response.ok) throw new Error(`Secret Manager ${method} HTTP ${response.status}`);
    return response.json();
  }
  const result: Array<{secret:string;version:string;changed:boolean}> = [];
  for (const name of names) {
    const resource = `${base}/${name}`;
    const exists = await request(resource,'GET',undefined,true);
    if (!exists) await request(`${base}?secretId=${name}`,'POST',{replication:{automatic:{}}});
    const versions = exists ? await request(`${resource}/versions?pageSize=1`) : undefined;
    const newest = versions?.versions?.[0];
    let version: string | undefined;
    if (newest?.state === 'ENABLED') {
      const latest = await request(`https://secretmanager.googleapis.com/v1/${newest.name}:access`);
      if (Buffer.from(latest.payload.data,'base64').equals(Buffer.from(values[name]!,'utf8'))) version = latest.name;
    }
    const changed = !version;
    if (!version) {
      const added = await request(`${resource}:addVersion`,'POST',{payload:{data:Buffer.from(values[name]!,'utf8').toString('base64')}});
      version = added.name;
    }
    const policy = await request(`${resource}:getIamPolicy`);
    policy.bindings ??= [];
    const role = 'roles/secretmanager.secretAccessor';
    const member = `serviceAccount:btc-runtime@${project}.iam.gserviceaccount.com`;
    let binding = policy.bindings.find((item: {role:string;condition?:unknown}) => item.role === role && !item.condition);
    if (!binding) { binding = {role,members:[]}; policy.bindings.push(binding); }
    if (!binding.members.includes(member)) {
      binding.members.push(member);
      await request(`${resource}:setIamPolicy`,'POST',{policy});
    }
    // Confirm uploaded bytes in memory without revealing values or hashes.
    const verified = await request(`https://secretmanager.googleapis.com/v1/${version}:access`);
    if (!Buffer.from(verified.payload.data,'base64').equals(Buffer.from(values[name]!,'utf8'))) throw new Error(`Verification failed for ${name}`);
    result.push({secret:name,version:version!,changed});
    delete values[name];
  }
  process.stdout.write(`${JSON.stringify({project,verified:true,secrets:result},null,2)}\n`);
}

main().catch(error => {
  // Only controlled messages; never emit objects from SDKs, HTTP bodies or credentials.
  process.stderr.write(`SECRET_SYNC_FAILED: ${error instanceof Error && /^(Usage:|Invalid or missing|Google authentication|Secret Manager|Verification failed)/.test(error.message) ? error.message : 'Unable to synchronize secrets'}\n`);
  process.exitCode = 1;
});
