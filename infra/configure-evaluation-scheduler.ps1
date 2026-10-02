param(
  [Parameter(Mandatory = $true)][ValidatePattern('^[a-z][a-z0-9-]{4,28}[a-z0-9]$')][string]$ProjectId,
  [ValidatePattern('^[a-z]+(?:-[a-z]+)*[0-9]+$')][string]$Region = 'southamerica-east1',
  [switch]$Apply
)
# Creates or updates ONLY the five-minute evaluation job for the private dry_run deployment.
# No queue, ingestion, recovery job, secrets or exchange credentials. Compatible with Windows PowerShell 5.1.
$ErrorActionPreference = 'Stop'
if (-not $Apply) { throw 'Review this script first. -Apply creates or updates an ACTIVE dry_run evaluation job every five minutes.' }
$functionName = 'runBtcNfpEtfBybitV1'
# Same name as infra/configure-scheduler.ps1: a later operational setup cannot add a second evaluation job.
$jobName = 'btc-nfp-etf-five-minutes'
$schedulerSa = "btc-scheduler@$ProjectId.iam.gserviceaccount.com"
$runUrl = "https://$Region-$ProjectId.cloudfunctions.net/$functionName"
$requestBody = '{"kind":"evaluate"}'
function Invoke-Gcloud {
  param([string[]]$Arguments)
  $output = & gcloud @Arguments
  if ($LASTEXITCODE -ne 0) { throw "GCLOUD_FAILED: $($Arguments[0..2] -join ' ')" }
  return $output
}

# 1. Refuse anything except the private dry_run artifact with new entries paused.
$function = ((Invoke-Gcloud @('functions','describe',$functionName,'--gen2',"--project=$ProjectId","--region=$Region",'--format=json')) -join "`n") | ConvertFrom-Json
$settings = $function.serviceConfig.environmentVariables
if ($function.state -ne 'ACTIVE') { throw 'FUNCTION_NOT_ACTIVE' }
if ($settings.TRADING_MODE -ne 'dry_run' -or $settings.BYBIT_ENVIRONMENT -ne 'mainnet' -or $settings.ALLOW_NEW_ENTRIES -ne 'false') { throw 'ONLY_DRY_RUN_MAINNET_WITH_ENTRIES_PAUSED_IS_SCHEDULED_HERE' }
if (@($function.serviceConfig.secretEnvironmentVariables | Where-Object { $_ }).Count -gt 0 -or @($function.serviceConfig.secretVolumes | Where-Object { $_ }).Count -gt 0) { throw 'UNEXPECTED_SECRET_BINDING' }
if ([string]$settings.RUN_FUNCTION_URL -ne $runUrl -or [string]$settings.SCHEDULER_SERVICE_ACCOUNT -ne $schedulerSa) { throw 'UNEXPECTED_OIDC_AUDIENCE_OR_INVOKER' }
$service = ($function.serviceConfig.service -split '/')[-1]

# 2. Only btc-scheduler invokes the service. The binding is idempotent; deploy.ps1 also reapplies it.
$null = Invoke-Gcloud @('run','services','add-iam-policy-binding',$service,"--project=$ProjectId","--region=$Region","--member=serviceAccount:$schedulerSa",'--role=roles/run.invoker','--quiet','--format=none')
$policy = ((Invoke-Gcloud @('run','services','get-iam-policy',$service,"--project=$ProjectId","--region=$Region",'--format=json')) -join "`n") | ConvertFrom-Json
if (@($policy.bindings | ForEach-Object { $_.members } | Where-Object { $_ -in @('allUsers','allAuthenticatedUsers') }).Count -gt 0) { throw 'PUBLIC_INVOCATION_NOT_EXPECTED' }

# 3. Cloud Scheduler API (idempotent).
$null = Invoke-Gcloud @('services','enable','cloudscheduler.googleapis.com',"--project=$ProjectId",'--format=none')

# 4. Create or update. The body is passed from a file: PowerShell 5.1 strips embedded quotes from native arguments.
$bodyPath = Join-Path ([IO.Path]::GetTempPath()) ("btc-evaluate-body-" + [guid]::NewGuid().ToString('N') + '.json')
[IO.File]::WriteAllText($bodyPath, $requestBody, (New-Object Text.UTF8Encoding $false))
try {
  $common = @("--project=$ProjectId","--location=$Region",'--schedule=*/5 * * * *','--time-zone=UTC',"--uri=$runUrl",'--http-method=POST',
    "--message-body-from-file=$bodyPath","--oidc-service-account-email=$schedulerSa","--oidc-token-audience=$runUrl",
    '--attempt-deadline=180s','--max-retry-attempts=1','--min-backoff=30s','--max-backoff=60s','--format=none')
  $existing = @(Invoke-Gcloud @('scheduler','jobs','list',"--project=$ProjectId","--location=$Region",'--format=value(name)') | Where-Object { ($_ -split '/')[-1] -eq $jobName })
  if ($existing.Count -gt 0) {
    $null = Invoke-Gcloud (@('scheduler','jobs','update','http',$jobName,'--update-headers=Content-Type=application/json') + $common)
    $action = 'updated'
  } else {
    $null = Invoke-Gcloud (@('scheduler','jobs','create','http',$jobName,'--headers=Content-Type=application/json',
      '--description=Private dry_run evaluation of btc-strategy-nfp-observed-v1 every five minutes') + $common)
    $action = 'created'
  }
} finally { Remove-Item -LiteralPath $bodyPath -Force -ErrorAction SilentlyContinue }

# 5. Read back the effective job.
$job = ((Invoke-Gcloud @('scheduler','jobs','describe',$jobName,"--project=$ProjectId","--location=$Region",'--format=json')) -join "`n") | ConvertFrom-Json
$effectiveBody = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([string]$job.httpTarget.body))
if ($job.state -ne 'ENABLED' -or $job.schedule -ne '*/5 * * * *' -or $job.timeZone -ne 'UTC' -or $job.httpTarget.uri -ne $runUrl -or
    $job.httpTarget.httpMethod -ne 'POST' -or $effectiveBody -ne $requestBody -or
    $job.httpTarget.oidcToken.serviceAccountEmail -ne $schedulerSa -or $job.httpTarget.oidcToken.audience -ne $runUrl) { throw 'SCHEDULER_JOB_VERIFICATION_FAILED' }
[ordered]@{
  action = $action
  job = $job.name
  state = $job.state
  schedule = $job.schedule
  timeZone = $job.timeZone
  uri = $job.httpTarget.uri
  body = $effectiveBody
  oidcServiceAccount = $job.httpTarget.oidcToken.serviceAccountEmail
  oidcAudience = $job.httpTarget.oidcToken.audience
  attemptDeadline = $job.attemptDeadline
  retryConfig = $job.retryConfig
  tradingMode = $settings.TRADING_MODE
  marketDataEnvironment = $settings.BYBIT_ENVIRONMENT
  allowNewEntries = $settings.ALLOW_NEW_ENTRIES
} | ConvertTo-Json -Depth 6
