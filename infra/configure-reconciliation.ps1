param(
  [Parameter(Mandatory = $true)][ValidatePattern('^[a-z][a-z0-9-]{4,28}[a-z0-9]$')][string]$ProjectId,
  [ValidatePattern('^[a-z]+(?:-[a-z]+)*[0-9]+$')][string]$Region = 'southamerica-east1',
  [string]$FunctionName = 'runBtcNfpEtfBybitV1',
  [string]$RecoveryJobName = 'btc-nfp-etf-recovery',
  [string]$RecoverySchedule = '* * * * *',
  [switch]$Apply
)
# Idempotent reconciliation infrastructure. Does not change the evaluation job, function configuration,
# secrets or exchange state. The recovery job becomes active and can reconcile existing durable intents.
# Windows PowerShell 5.1 compatible; no dotenv files are read.
$ErrorActionPreference = 'Stop'
if (-not $Apply) { throw 'Review this script first. -Apply configures the queue, IAM and an ACTIVE recovery job every minute.' }
$functionName = $FunctionName
$queueName = 'btc-reconcile'
$jobName = $RecoveryJobName
$runtimeSa = "btc-runtime@$ProjectId.iam.gserviceaccount.com"
$schedulerSa = "btc-scheduler@$ProjectId.iam.gserviceaccount.com"
$runUrl = "https://$Region-$ProjectId.cloudfunctions.net/$functionName"
$requestBody = '{"kind":"reconcile"}'
function Invoke-Gcloud {
  param([string[]]$Arguments)
  $previousErrorAction = $ErrorActionPreference
  try {
    # PowerShell 5.1 can treat informational native stderr as a terminating error.
    # gcloud's exit status determines success; stdout alone carries JSON results.
    $ErrorActionPreference = 'Continue'
    $output = & gcloud @Arguments
    $exitCode = $LASTEXITCODE
  } finally { $ErrorActionPreference = $previousErrorAction }
  if ($exitCode -ne 0) { throw "GCLOUD_FAILED: $($Arguments[0..2] -join ' ')" }
  return $output
}
function Read-GcloudJson {
  param([string[]]$Arguments)
  return (((Invoke-Gcloud ($Arguments + '--format=json')) -join "`n") | ConvertFrom-Json)
}
function Test-Binding {
  param($Policy, [string]$Role, [string]$Member)
  return @($Policy.bindings | Where-Object { $_.role -eq $Role -and -not $_.condition -and $_.members -contains $Member }).Count -gt 0
}

# Inspect the deployed target before making changes. Supports preparation against dry_run and reapplication
# after testnet/live deployment. A missing RECONCILE_QUEUE is expected on the initial dry_run deployment.
$function = Read-GcloudJson @('functions','describe',$functionName,'--gen2',"--project=$ProjectId","--region=$Region")
$settings = $function.serviceConfig.environmentVariables
if ($function.state -ne 'ACTIVE') { throw 'FUNCTION_NOT_ACTIVE' }
if ($function.serviceConfig.serviceAccountEmail -ne $runtimeSa) { throw 'UNEXPECTED_RUNTIME_IDENTITY' }
if ([string]$settings.RUN_FUNCTION_URL -ne $runUrl -or [string]$settings.SCHEDULER_SERVICE_ACCOUNT -ne $schedulerSa) { throw 'UNEXPECTED_OIDC_AUDIENCE_OR_INVOKER' }
if ($settings.RECONCILE_QUEUE -and $settings.RECONCILE_QUEUE -ne $queueName) { throw 'UNEXPECTED_RECONCILIATION_QUEUE' }
if ($settings.APP_REGION -and $settings.APP_REGION -ne $Region) { throw 'UNEXPECTED_RUNTIME_REGION' }
$service = ($function.serviceConfig.service -split '/')[-1]
$runPolicy = Read-GcloudJson @('run','services','get-iam-policy',$service,"--project=$ProjectId","--region=$Region")
if (@($runPolicy.bindings | ForEach-Object { $_.members } | Where-Object { $_ -in @('allUsers','allAuthenticatedUsers') }).Count -gt 0) { throw 'PUBLIC_INVOCATION_NOT_EXPECTED' }
$null = Invoke-Gcloud @('iam','service-accounts','describe',$schedulerSa,"--project=$ProjectId",'--format=none')
$projectNumber = ((Invoke-Gcloud @('projects','describe',$ProjectId,'--format=value(projectNumber)')) -join '').Trim()
if ($projectNumber -notmatch '^\d+$') { throw 'INVALID_PROJECT_NUMBER' }
$tasksAgent = "service-$projectNumber@gcp-sa-cloudtasks.iam.gserviceaccount.com"

# Enabling the API provisions its primary service agent and standard serviceAgent role.
$null = Invoke-Gcloud @('services','enable','cloudtasks.googleapis.com','cloudscheduler.googleapis.com',"--project=$ProjectId",'--format=none')
$queues = @(Invoke-Gcloud @('tasks','queues','list',"--project=$ProjectId","--location=$Region",'--format=value(name)'))
$queueExists = @($queues | Where-Object { ($_ -split '/')[-1] -eq $queueName }).Count -gt 0
$queueCommon = @("--project=$ProjectId","--location=$Region",'--max-concurrent-dispatches=1','--max-dispatches-per-second=1',
  '--min-backoff=20s','--max-backoff=60s','--max-attempts=100','--max-retry-duration=86400s','--format=none')
if ($queueExists) {
  $currentQueue = Read-GcloudJson @('tasks','queues','describe',$queueName,"--project=$ProjectId","--location=$Region")
  # Runtime supplies routing/authentication per task. Queue-level overrides could silently redirect it.
  if ($currentQueue.httpTarget -or $currentQueue.appEngineRoutingOverride) { throw 'UNEXPECTED_QUEUE_ROUTING_OVERRIDE' }
  $null = Invoke-Gcloud (@('tasks','queues','update',$queueName) + $queueCommon)
  $queueAction = 'updated'
} else {
  $null = Invoke-Gcloud (@('tasks','queues','create',$queueName) + $queueCommon)
  $queueAction = 'created'
}

# getQueue is the pre-entry check; createTask must be allowed to attach the scheduler identity.
foreach ($role in @('roles/cloudtasks.enqueuer','roles/cloudtasks.viewer')) {
  $null = Invoke-Gcloud @('tasks','queues','add-iam-policy-binding',$queueName,"--project=$ProjectId","--location=$Region",
    "--member=serviceAccount:$runtimeSa","--role=$role",'--quiet','--format=none')
}
$null = Invoke-Gcloud @('iam','service-accounts','add-iam-policy-binding',$schedulerSa,"--project=$ProjectId",
  "--member=serviceAccount:$runtimeSa",'--role=roles/iam.serviceAccountUser','--quiet','--format=none')
# Cloud Tasks documentation also requires its primary service agent to act as the HTTP target identity.
# https://docs.cloud.google.com/tasks/docs/creating-http-target-tasks#http-target-auth
$null = Invoke-Gcloud @('iam','service-accounts','add-iam-policy-binding',$schedulerSa,"--project=$ProjectId",
  "--member=serviceAccount:$tasksAgent",'--role=roles/iam.serviceAccountUser','--quiet','--format=none')
$null = Invoke-Gcloud @('run','services','add-iam-policy-binding',$service,"--project=$ProjectId","--region=$Region",
  "--member=serviceAccount:$schedulerSa",'--role=roles/run.invoker','--quiet','--format=none')

$queue = Read-GcloudJson @('tasks','queues','describe',$queueName,"--project=$ProjectId","--location=$Region")
if ($queue.state -eq 'PAUSED') {
  $null = Invoke-Gcloud @('tasks','queues','resume',$queueName,"--project=$ProjectId","--location=$Region",'--quiet','--format=none')
}

# Recovery scans durable intents if a process crashed before enqueueing its Cloud Task.
# File body preserves JSON quotes when gcloud is launched from Windows PowerShell 5.1.
$bodyPath = Join-Path ([IO.Path]::GetTempPath()) ('btc-reconcile-body-' + [guid]::NewGuid().ToString('N') + '.json')
[IO.File]::WriteAllText($bodyPath, $requestBody, (New-Object Text.UTF8Encoding $false))
try {
  $common = @("--project=$ProjectId","--location=$Region","--schedule=$RecoverySchedule",'--time-zone=UTC',"--uri=$runUrl",'--http-method=POST',
    "--message-body-from-file=$bodyPath","--oidc-service-account-email=$schedulerSa","--oidc-token-audience=$runUrl",
    '--attempt-deadline=180s','--max-retry-attempts=5','--min-backoff=20s','--max-backoff=60s','--format=none')
  $existing = @(Invoke-Gcloud @('scheduler','jobs','list',"--project=$ProjectId","--location=$Region",'--format=value(name)') | Where-Object { ($_ -split '/')[-1] -eq $jobName })
  if ($existing.Count -gt 0) {
    $null = Invoke-Gcloud (@('scheduler','jobs','update','http',$jobName,'--update-headers=Content-Type=application/json') + $common)
    $jobAction = 'updated'
  } else {
    $null = Invoke-Gcloud (@('scheduler','jobs','create','http',$jobName,'--headers=Content-Type=application/json',
      '--description=Reconcile durable Bybit intents every minute, including missed task dispatches') + $common)
    $jobAction = 'created'
  }
} finally { Remove-Item -LiteralPath $bodyPath -Force -ErrorAction SilentlyContinue }
$job = Read-GcloudJson @('scheduler','jobs','describe',$jobName,"--project=$ProjectId","--location=$Region")
if ($job.state -eq 'PAUSED') {
  $null = Invoke-Gcloud @('scheduler','jobs','resume',$jobName,"--project=$ProjectId","--location=$Region",'--quiet','--format=none')
}

# Read back effective configuration and permissions. Delivery is checked separately through real logs.
$queue = Read-GcloudJson @('tasks','queues','describe',$queueName,"--project=$ProjectId","--location=$Region")
$job = Read-GcloudJson @('scheduler','jobs','describe',$jobName,"--project=$ProjectId","--location=$Region")
$queuePolicy = Read-GcloudJson @('tasks','queues','get-iam-policy',$queueName,"--project=$ProjectId","--location=$Region")
$identityPolicy = Read-GcloudJson @('iam','service-accounts','get-iam-policy',$schedulerSa,"--project=$ProjectId")
$projectPolicy = Read-GcloudJson @('projects','get-iam-policy',$ProjectId)
$runPolicy = Read-GcloudJson @('run','services','get-iam-policy',$service,"--project=$ProjectId","--region=$Region")
if ($queue.state -ne 'RUNNING' -or $queue.rateLimits.maxConcurrentDispatches -ne 1 -or $queue.rateLimits.maxDispatchesPerSecond -ne 1 -or
    $queue.retryConfig.minBackoff -ne '20s' -or $queue.retryConfig.maxBackoff -ne '60s' -or
    $queue.retryConfig.maxAttempts -ne 100 -or $queue.retryConfig.maxRetryDuration -ne '86400s') { throw 'QUEUE_VERIFICATION_FAILED' }
foreach ($role in @('roles/cloudtasks.enqueuer','roles/cloudtasks.viewer')) {
  if (-not (Test-Binding $queuePolicy $role "serviceAccount:$runtimeSa")) { throw 'QUEUE_IAM_VERIFICATION_FAILED' }
}
foreach ($member in @("serviceAccount:$runtimeSa","serviceAccount:$tasksAgent")) {
  if (-not (Test-Binding $identityPolicy 'roles/iam.serviceAccountUser' $member)) { throw 'TASK_IDENTITY_IAM_VERIFICATION_FAILED' }
}
if (-not (Test-Binding $projectPolicy 'roles/cloudtasks.serviceAgent' "serviceAccount:$tasksAgent")) { throw 'CLOUD_TASKS_SERVICE_AGENT_ROLE_MISSING' }
if (-not (Test-Binding $projectPolicy 'roles/cloudscheduler.serviceAgent' "serviceAccount:service-$projectNumber@gcp-sa-cloudscheduler.iam.gserviceaccount.com")) { throw 'CLOUD_SCHEDULER_SERVICE_AGENT_ROLE_MISSING' }
if (-not (Test-Binding $runPolicy 'roles/run.invoker' "serviceAccount:$schedulerSa")) { throw 'RUN_INVOKER_VERIFICATION_FAILED' }
$effectiveBody = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([string]$job.httpTarget.body))
if ($job.state -ne 'ENABLED' -or $job.schedule -ne $RecoverySchedule -or $job.timeZone -ne 'UTC' -or $job.httpTarget.uri -ne $runUrl -or
    $job.httpTarget.httpMethod -ne 'POST' -or $effectiveBody -ne $requestBody -or
    $job.httpTarget.oidcToken.serviceAccountEmail -ne $schedulerSa -or $job.httpTarget.oidcToken.audience -ne $runUrl) { throw 'RECOVERY_JOB_VERIFICATION_FAILED' }
[ordered]@{
  queueAction = $queueAction
  queue = $queue.name
  queueState = $queue.state
  jobAction = $jobAction
  job = $job.name
  jobState = $job.state
  schedule = $job.schedule
  uri = $runUrl
  body = $effectiveBody
  runtimeServiceAccount = $runtimeSa
  oidcServiceAccount = $schedulerSa
  requiredRuntimeEnvironment = [ordered]@{
    GCLOUD_PROJECT = $ProjectId
    APP_REGION = $Region
    RECONCILE_QUEUE = $queueName
    RUN_FUNCTION_URL = $runUrl
    SCHEDULER_SERVICE_ACCOUNT = $schedulerSa
  }
  runtimeQueueConfigured = ([string]$settings.RECONCILE_QUEUE -eq $queueName)
} | ConvertTo-Json -Depth 6
