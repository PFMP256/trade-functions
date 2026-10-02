param(
  [ValidatePattern('^[a-z][a-z0-9-]{4,28}[a-z0-9]$')]
  [string]$ProjectId = 'trade-functions-20261001',
  [ValidatePattern('^[a-z]+(?:-[a-z]+)*[0-9]+$')]
  [string]$Region = 'southamerica-east1',
  # Supply an earlier ID to check its logs again without creating another task.
  [ValidatePattern('^[a-f0-9]{32}$')]
  [string]$VerificationId
)

# Sends exactly one reconciliation smoke task after verifying the deployment is
# dry_run with entries disabled. Credentials remain in memory. No exchange calls
# are made by this script; the checked dry_run handler performs no mutations.
$ErrorActionPreference = 'Stop'
function Invoke-Gcloud {
  param([string[]]$Arguments)
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $output = & gcloud @Arguments } finally { $ErrorActionPreference = $previous }
  if ($LASTEXITCODE -ne 0) { throw "GCLOUD_FAILED: $($Arguments[0..([Math]::Min(2,$Arguments.Length-1))] -join ' ')" }
  return $output
}
function Get-GcloudJson {
  param([string[]]$Arguments)
  return ((Invoke-Gcloud ($Arguments + @('--format=json'))) -join "`n") | ConvertFrom-Json
}
function Save-VerificationReport {
  $report | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $reportPath -Encoding UTF8
}

$functionName = 'runBtcNfpEtfBybitV1'
$queueName = 'btc-reconcile'
$schedulerSa = "btc-scheduler@$ProjectId.iam.gserviceaccount.com"
$baseUrl = "https://$Region-$ProjectId.cloudfunctions.net/$functionName"
$queuePath = "projects/$ProjectId/locations/$Region/queues/$queueName"
$function = Get-GcloudJson @('functions','describe',$functionName,'--gen2',"--project=$ProjectId","--region=$Region")
$settings = $function.serviceConfig.environmentVariables
if ($function.state -ne 'ACTIVE' -or $settings.TRADING_MODE -ne 'dry_run' -or
    $settings.ALLOW_NEW_ENTRIES -ne 'false' -or $settings.BYBIT_ENVIRONMENT -ne 'mainnet') { throw 'ONLY_ACTIVE_DRY_RUN_WITH_ENTRIES_DISABLED_CAN_BE_VERIFIED' }
if ($settings.RUN_FUNCTION_URL -ne $baseUrl -or $settings.SCHEDULER_SERVICE_ACCOUNT -ne $schedulerSa -or
    $settings.RECONCILE_QUEUE -ne $queueName -or $settings.APP_REGION -ne $Region) { throw 'UNEXPECTED_RECONCILIATION_CONFIGURATION' }
$queue = Get-GcloudJson @('tasks','queues','describe',$queueName,"--project=$ProjectId","--location=$Region")
if ($queue.name -ne $queuePath -or $queue.state -ne 'RUNNING') { throw 'RECONCILIATION_QUEUE_NOT_RUNNING' }
$serviceName = ([string]$function.serviceConfig.service -split '/')[-1]
if (-not $serviceName) { throw 'CLOUD_RUN_SERVICE_MISSING' }
$service = Get-GcloudJson @('run','services','describe',$serviceName,"--project=$ProjectId","--region=$Region")
$revision = [string]$service.status.latestReadyRevisionName
$currentTraffic = @($service.status.traffic | Where-Object { $_.revisionName -eq $revision -and $_.percent -eq 100 })
if (-not $revision -or $service.status.latestCreatedRevisionName -ne $revision -or $currentTraffic.Count -ne 1) { throw 'CURRENT_REVISION_MUST_BE_READY_WITH_ALL_TRAFFIC' }
if ($function.serviceConfig.revision -and $function.serviceConfig.revision -ne $revision) { throw 'FUNCTION_AND_CLOUD_RUN_REVISIONS_DIFFER' }

$createTask = -not $VerificationId
if ($createTask) { $VerificationId = [guid]::NewGuid().ToString('N') }
$VerificationId = $VerificationId.ToLowerInvariant()
$targetUrl = "${baseUrl}?verification=$VerificationId"
$taskName = "$queuePath/tasks/verification-$VerificationId"
$startedAt = [DateTime]::UtcNow
$reportDirectory = Join-Path (Split-Path -Parent $PSScriptRoot) '.local'
if (-not (Test-Path -LiteralPath $reportDirectory -PathType Container)) { $null = New-Item -ItemType Directory -Path $reportDirectory }
$stamp = $startedAt.ToString("yyyyMMdd'T'HHmmssfffffff'Z'", [Globalization.CultureInfo]::InvariantCulture)
$reportPath = Join-Path $reportDirectory "reconciliation-delivery-verification-$Region-$stamp.json"
$report = [ordered]@{
  startedAtUtc = $startedAt.ToString('o')
  verifiedAtUtc = $null
  projectId = $ProjectId
  region = $Region
  functionName = $functionName
  tradingMode = $settings.TRADING_MODE
  allowNewEntries = $false
  queue = $queuePath
  queueState = $queue.state
  service = $serviceName
  revision = $revision
  verificationId = $VerificationId
  taskName = $taskName
  taskCreatedThisRun = $false
  requestUrl = $targetUrl
  requestBody = [ordered]@{ kind = 'reconcile' }
  oidcServiceAccount = $schedulerSa
  oidcAudience = $baseUrl
  logPolls = 0
  deliveries = @()
  deliveryAccepted = $false
  failure = $null
}
Save-VerificationReport
$accessToken = $null
$headers = $null
try {
  $accessToken = (Invoke-Gcloud @('auth','print-access-token','--quiet')) -join ''
  if (-not $accessToken) { throw 'GOOGLE_AUTH_FAILED' }
  $headers = @{ Authorization = "Bearer $accessToken" }
  if ($createTask) {
    $taskPayload = @{ task = @{
      name = $taskName
      dispatchDeadline = '180s'
      httpRequest = @{
        httpMethod = 'POST'
        url = $targetUrl
        headers = @{ 'Content-Type' = 'application/json' }
        body = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('{"kind":"reconcile"}'))
        oidcToken = @{ serviceAccountEmail = $schedulerSa; audience = $baseUrl }
      }
    } } | ConvertTo-Json -Depth 8 -Compress
    try {
      $created = Invoke-RestMethod -Uri "https://cloudtasks.googleapis.com/v2/$queuePath/tasks" -Method Post -Headers $headers -ContentType 'application/json' -Body $taskPayload -TimeoutSec 30
    } catch { throw 'CLOUD_TASK_CREATION_FAILED_OR_UNCONFIRMED' }
    if ($created.name -ne $taskName) { throw 'UNEXPECTED_CREATED_TASK_NAME' }
    $report.taskCreatedThisRun = $true
    Save-VerificationReport
  }

  # A GUID isolates this delivery from recovery Scheduler and other task traffic.
  # Use REST to avoid Windows PowerShell 5.1 native-argument quote conversion.
  $filter = "resource.type=`"cloud_run_revision`" AND resource.labels.service_name=`"$serviceName`" AND resource.labels.revision_name=`"$revision`" AND logName=`"projects/$ProjectId/logs/run.googleapis.com%2Frequests`" AND httpRequest.requestUrl:`"verification=$VerificationId`" AND httpRequest.userAgent:`"Google-Cloud-Tasks`""
  $logQuery = @{ resourceNames = @("projects/$ProjectId"); filter = $filter; orderBy = 'timestamp desc'; pageSize = 20 } | ConvertTo-Json -Depth 5 -Compress
  for ($attempt = 1; $attempt -le 6; $attempt++) {
    if ($attempt -gt 1) { Start-Sleep -Seconds 10 }
    try {
      $logResponse = Invoke-RestMethod -Uri 'https://logging.googleapis.com/v2/entries:list' -Method Post -Headers $headers -ContentType 'application/json' -Body $logQuery -TimeoutSec 15
    } catch { throw 'CLOUD_TASK_DELIVERY_LOG_QUERY_FAILED' }
    $report.logPolls = $attempt
    $report.deliveries = @($logResponse.entries | Where-Object { $_ -and $_.httpRequest } | ForEach-Object {
      [ordered]@{
        timestamp = $_.timestamp
        status = [int]$_.httpRequest.status
        requestUrl = [string]$_.httpRequest.requestUrl
        userAgent = [string]$_.httpRequest.userAgent
        latency = [string]$_.httpRequest.latency
        revision = [string]$_.resource.labels.revision_name
        insertId = [string]$_.insertId
      }
    })
    $report.deliveryAccepted = @($report.deliveries | Where-Object {
      $_.status -eq 200 -and $_.revision -eq $revision -and $_.requestUrl -eq $targetUrl -and $_.userAgent -like '*Google-Cloud-Tasks*'
    }).Count -ge 1
    Save-VerificationReport
    if ($report.deliveryAccepted) { break }
  }
  if (-not $report.deliveryAccepted) { throw 'CLOUD_TASK_HTTP_200_DELIVERY_NOT_YET_VERIFIED' }
} catch {
  $report.failure = [string]$_.Exception.Message
  throw
} finally {
  $accessToken = $null
  $headers = $null
  $report.verifiedAtUtc = [DateTime]::UtcNow.ToString('o')
  Save-VerificationReport
  [ordered]@{
    verificationId = $VerificationId
    taskName = $taskName
    taskCreatedThisRun = $report.taskCreatedThisRun
    revision = $revision
    logPolls = $report.logPolls
    deliveries = $report.deliveries
    deliveryAccepted = $report.deliveryAccepted
    failure = $report.failure
    reportPath = $reportPath
  } | ConvertTo-Json -Depth 8
}
