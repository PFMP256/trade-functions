param(
  [ValidatePattern('^[a-z][a-z0-9-]{4,28}[a-z0-9]$')]
  [string]$ProjectId = 'trade-functions-20261001',
  [ValidatePattern('^[a-z]+(?:-[a-z]+)*[0-9]+$')]
  [string]$Region = 'southamerica-east1',
  [string]$FunctionName = 'runBtcNfpEtfBybitV1',
  [string]$RecoveryJobName = 'btc-nfp-etf-recovery'
)

# Verifies the private production deployment while execution remains dry_run.
# Reads cloud configuration and secret metadata (never secret payloads), invokes
# dry_run smoke checks, and saves evidence in .local. Does not change infrastructure.
$ErrorActionPreference = 'Stop'
# PowerShell 7 turns ISO strings into DateTime unless -DateKind String is available (7.5+).
# Windows PowerShell 5.1 keeps them as strings; exact schedule comparisons require strings.
$jsonKeepsStrings = (Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')
function ConvertFrom-JsonText {
  param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Text)
  if ($jsonKeepsStrings) { return $Text | ConvertFrom-Json -DateKind String }
  if ($PSVersionTable.PSVersion.Major -ge 6) { throw 'POWERSHELL_7_5_OR_WINDOWS_POWERSHELL_5_1_REQUIRED' }
  return $Text | ConvertFrom-Json
}
function Get-GcloudJson {
  param([string[]]$Arguments)
  $output = & gcloud @Arguments --format=json
  if ($LASTEXITCODE -ne 0) { throw "GCLOUD_READ_FAILED: $($Arguments[0..([Math]::Min(2,$Arguments.Length-1))] -join ' ')" }
  return ConvertFrom-JsonText -Text ($output -join "`n")
}
function Assert-UnconditionalBinding {
  param($Policy, [string]$Role, [string]$Member, [string]$Failure)
  if (@($Policy.bindings | Where-Object { $_.role -eq $Role -and $Member -in $_.members -and -not $_.condition }).Count -lt 1) { throw $Failure }
}
$functionName = $FunctionName
$functionJson = & gcloud functions describe $functionName --gen2 --project=$projectId --region=$region --format=json
if ($LASTEXITCODE -ne 0) { throw 'FUNCTION_DESCRIPTION_FAILED' }
$function = $functionJson | ConvertFrom-Json
$settings = $function.serviceConfig.environmentVariables
if ($function.state -ne 'ACTIVE' -or $settings.BYBIT_ENVIRONMENT -ne 'mainnet' -or $settings.BYBIT_CREDENTIAL_BINDING -ne 'mainnet') { throw 'UNEXPECTED_DEPLOYMENT_CONFIGURATION' }
if ($settings.TRADING_MODE -eq 'live') {
  if ($settings.ALLOW_NEW_ENTRIES -ne 'true' -or $settings.BYBIT_ACCOUNT_ID -ne '548108699') { throw 'UNEXPECTED_LIVE_CONFIGURATION' }
} elseif ($settings.TRADING_MODE -eq 'dry_run') {
  if ($settings.ALLOW_NEW_ENTRIES -ne 'false') { throw 'UNEXPECTED_DRY_RUN_CONFIGURATION' }
} else {
  throw 'UNEXPECTED_TRADING_MODE'
}
$runtimeSa = "btc-runtime@$projectId.iam.gserviceaccount.com"
$schedulerSa = "btc-scheduler@$projectId.iam.gserviceaccount.com"
if ($function.serviceConfig.serviceAccountEmail -ne $runtimeSa -or $settings.RUNTIME_SERVICE_ACCOUNT -ne $runtimeSa) { throw 'UNEXPECTED_RUNTIME_IDENTITY' }
if ($settings.APP_REGION -ne $Region -or $settings.SCHEDULER_SERVICE_ACCOUNT -ne $schedulerSa -or $settings.RECONCILE_QUEUE -ne 'btc-reconcile') { throw 'UNEXPECTED_RECONCILIATION_CONFIGURATION' }
if (@($function.serviceConfig.secretVolumes | Where-Object { $_ }).Count -gt 0) { throw 'UNEXPECTED_SECRET_VOLUME' }
if (@($settings.PSObject.Properties.Name | Where-Object { $_ -match '^BYBIT_.*(?:KEY|SECRET)$|^API_(?:KEY|SECRET)$' }).Count -gt 0) { throw 'UNEXPECTED_CREDENTIAL_VARIABLE' }
$project = Get-GcloudJson @('projects','describe',$ProjectId)
$secretBindings = @($function.serviceConfig.secretEnvironmentVariables | Where-Object { $_ })
if ($secretBindings.Count -ne 2) { throw 'EXPECTED_EXACTLY_TWO_MAINNET_SECRET_BINDINGS' }
$verifiedSecrets = @()
foreach ($secretName in @('BYBIT_API_KEY','BYBIT_API_SECRET')) {
  $bindings = @($secretBindings | Where-Object { $_.key -ceq $secretName })
  if ($bindings.Count -ne 1) { throw "MISSING_OR_DUPLICATE_SECRET_BINDING_$secretName" }
  $binding = $bindings[0]
  if ($binding.secret -cne $secretName -or [string]$binding.projectId -notin @($ProjectId,[string]$project.projectNumber) -or [string]$binding.version -notmatch '^[1-9][0-9]*$') { throw "UNEXPECTED_SECRET_REFERENCE_$secretName" }
  $version = Get-GcloudJson @('secrets','versions','describe',[string]$binding.version,"--secret=$secretName","--project=$ProjectId")
  if ($version.state -ne 'ENABLED') { throw "SECRET_VERSION_NOT_ENABLED_$secretName" }
  $secretPolicy = Get-GcloudJson @('secrets','get-iam-policy',$secretName,"--project=$ProjectId")
  Assert-UnconditionalBinding $secretPolicy 'roles/secretmanager.secretAccessor' "serviceAccount:$runtimeSa" "RUNTIME_SECRET_ACCESS_MISSING_$secretName"
  $verifiedSecrets += [pscustomobject]@{ key = $binding.key; secret = $binding.secret; projectId = $binding.projectId; version = $binding.version; state = $version.state; runtimeAccessor = $true }
}
$url = [string]$settings.RUN_FUNCTION_URL
if ($url -ne "https://$region-$projectId.cloudfunctions.net/$functionName") { throw 'UNEXPECTED_FUNCTION_AUDIENCE' }
$service = ($function.serviceConfig.service -split '/')[-1]
$policyJson = & gcloud run services get-iam-policy $service --project=$projectId --region=$region --format=json
if ($LASTEXITCODE -ne 0) { throw 'IAM_CHECK_FAILED' }
$policy = $policyJson | ConvertFrom-Json
if (@($policy.bindings | ForEach-Object { $_.members } | Where-Object { $_ -in @('allUsers','allAuthenticatedUsers') }).Count -gt 0) { throw 'PUBLIC_INVOCATION_NOT_EXPECTED' }
Assert-UnconditionalBinding $policy 'roles/run.invoker' "serviceAccount:$schedulerSa" 'SCHEDULER_INVOKER_BINDING_MISSING'

$queue = Get-GcloudJson @('tasks','queues','describe','btc-reconcile',"--project=$ProjectId","--location=$Region")
if ($queue.name -ne "projects/$ProjectId/locations/$Region/queues/btc-reconcile" -or $queue.state -ne 'RUNNING') { throw 'RECONCILIATION_QUEUE_NOT_RUNNING' }
$queuePolicy = Get-GcloudJson @('tasks','queues','get-iam-policy','btc-reconcile',"--project=$ProjectId","--location=$Region")
Assert-UnconditionalBinding $queuePolicy 'roles/cloudtasks.enqueuer' "serviceAccount:$runtimeSa" 'RUNTIME_QUEUE_ENQUEUER_MISSING'
Assert-UnconditionalBinding $queuePolicy 'roles/cloudtasks.viewer' "serviceAccount:$runtimeSa" 'RUNTIME_QUEUE_VIEWER_MISSING'
$schedulerPolicy = Get-GcloudJson @('iam','service-accounts','get-iam-policy',$schedulerSa,"--project=$ProjectId")
Assert-UnconditionalBinding $schedulerPolicy 'roles/iam.serviceAccountUser' "serviceAccount:$runtimeSa" 'RUNTIME_SCHEDULER_ACT_AS_MISSING'
$recoveryJob = Get-GcloudJson @('scheduler','jobs','describe',$RecoveryJobName,"--project=$ProjectId","--location=$Region")
try { $recoveryBody = ConvertFrom-JsonText -Text ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([string]$recoveryJob.httpTarget.body))) }
catch { throw 'RECOVERY_JOB_BODY_INVALID' }
if ($recoveryJob.state -ne 'ENABLED' -or $recoveryJob.schedule -notin @('* * * * *', '*/5 * * * *') -or $recoveryJob.timeZone -ne 'UTC' -or
    $recoveryJob.httpTarget.uri -ne $url -or $recoveryJob.httpTarget.httpMethod -ne 'POST' -or
    $recoveryJob.httpTarget.oidcToken.serviceAccountEmail -ne $schedulerSa -or $recoveryJob.httpTarget.oidcToken.audience -ne $url -or
    $recoveryJob.httpTarget.headers.'Content-Type' -ne 'application/json' -or
    $recoveryBody.kind -ne 'reconcile' -or @($recoveryBody.PSObject.Properties).Count -ne 1) { throw 'RECOVERY_JOB_CONFIGURATION_INVALID' }

function Invoke-FunctionCheck {
  param([hashtable]$RequestHeaders, [string]$Body)
  $content = $null
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $url -Method Post -Headers $RequestHeaders -ContentType 'application/json' -Body $Body -TimeoutSec 180
    $status = [int]$response.StatusCode
    $content = $response.Content
  } catch {
    if (-not $_.Exception.Response) { throw 'FUNCTION_NETWORK_FAILURE' }
    $status = [int]$_.Exception.Response.StatusCode
    $content = $_.ErrorDetails.Message
    if (-not $content) {
      $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
      try { $content = $reader.ReadToEnd() } finally { $reader.Dispose() }
    }
  }
  try { $bodyJson = ConvertFrom-JsonText -Text ([string]$content) } catch { $bodyJson = @{ error = 'NON_JSON_RESPONSE' } }
  return [pscustomobject]@{ httpStatus = $status; body = $bodyJson }
}

$anonymous = Invoke-FunctionCheck -RequestHeaders @{} -Body '{"kind":"reconcile"}'
if ($anonymous.httpStatus -notin @(401,403)) { throw 'ANONYMOUS_REQUEST_WAS_NOT_REJECTED' }
# Keep Google credentials in process memory; never print or persist them.
$accessToken = (& gcloud auth print-access-token --quiet) -join ''
if ($LASTEXITCODE -ne 0 -or -not $accessToken) { throw 'GOOGLE_AUTH_FAILED' }
$invoker = [string]$settings.SCHEDULER_SERVICE_ACCOUNT
$tokenUri = "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${invoker}:generateIdToken"
$tokenBody = @{ audience = $url; includeEmail = $true } | ConvertTo-Json -Compress
try {
  $identity = Invoke-RestMethod -Uri $tokenUri -Method Post -Headers @{ Authorization = "Bearer $accessToken" } -ContentType 'application/json' -Body $tokenBody
} catch { throw 'IDENTITY_TOKEN_GENERATION_FAILED' }
$requestHeaders = @{ Authorization = "Bearer $($identity.token)" }
$reconcile = Invoke-FunctionCheck -RequestHeaders $requestHeaders -Body '{"kind":"reconcile"}'
if ($reconcile.httpStatus -ne 200) { throw "RECONCILE_SMOKE_FAILED_HTTP_$($reconcile.httpStatus)" }
if ($settings.TRADING_MODE -eq 'live') {
  if ($reconcile.body.execution.tradingMode -ne 'live' -or $reconcile.body.execution.status -notin @('NO_ENTRY','PROTECTED') -or $reconcile.body.execution.accountId -ne '548108699') { throw 'RECONCILE_LIVE_CHECK_FAILED' }
} else {
  if ($reconcile.body.execution.tradingMode -ne 'dry_run' -or 'DRY_RUN_NO_EXCHANGE_MUTATIONS' -notin $reconcile.body.execution.reasonCodes) { throw "RECONCILE_DRY_RUN_CHECK_FAILED" }
}
# Use this real invocation time instead of the five-minute default bucket, which can
# replay an evaluation created in another region against the shared Firestore database.
$evaluationScheduledAtUtc = [DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fff'Z'", [Globalization.CultureInfo]::InvariantCulture)
$evaluationHeaders = @{
  Authorization = "Bearer $($identity.token)"
  'x-cloudscheduler-scheduletime' = $evaluationScheduledAtUtc
}
$evaluation = Invoke-FunctionCheck -RequestHeaders $evaluationHeaders -Body '{"kind":"evaluate"}'
$evaluationId = [string]$evaluation.body.evaluationId
if ($evaluationId -notmatch '^[a-f0-9]{64}$') { throw "EVALUATION_SMOKE_FAILED_HTTP_$($evaluation.httpStatus)" }
if ($settings.TRADING_MODE -eq 'live') {
  if ($evaluation.body.execution.tradingMode -ne 'live' -or $evaluation.body.execution.status -notin @('NO_ENTRY','ENTRY_SUBMITTED','ENTRY_FILLED','PROTECTED') -or $evaluation.body.execution.accountId -ne '548108699') { throw 'EVALUATION_LIVE_CHECK_FAILED' }
} else {
  if ($evaluation.body.execution.tradingMode -ne 'dry_run' -or 'DRY_RUN_NO_EXCHANGE_MUTATIONS' -notin $evaluation.body.execution.reasonCodes) { throw 'EVALUATION_DRY_RUN_CHECK_FAILED' }
}
$documentUri = "https://firestore.googleapis.com/v1/projects/$projectId/databases/(default)/documents/evaluations/$evaluationId"
# Firestore stringValue must remain a string. Invoke-RestMethod automatically turns
# ISO strings into DateTime on PowerShell 7, making an exact schedule comparison fail.
try {
  $documentResponse = Invoke-WebRequest -UseBasicParsing -Uri $documentUri -Headers @{ Authorization = "Bearer $accessToken" }
  $document = ConvertFrom-JsonText -Text $documentResponse.Content
} catch { throw 'EVALUATION_PERSISTENCE_CHECK_FAILED' }
if ($document.fields.scheduledAtUtc.stringValue -ne $evaluationScheduledAtUtc) { throw 'EVALUATION_SCHEDULE_MISMATCH' }
$snapshotLocation = [string]$evaluation.body.snapshot.location
$snapshotHash = [string]$evaluation.body.snapshot.hash
if ($snapshotLocation -notmatch '^snapshots/[a-f0-9]{64}$' -or $snapshotLocation -ne "snapshots/$snapshotHash") { throw 'UNEXPECTED_SNAPSHOT_LOCATION' }
if ($document.fields.snapshot.mapValue.fields.location.stringValue -ne $snapshotLocation -or $document.fields.snapshot.mapValue.fields.hash.stringValue -ne $snapshotHash) { throw 'PERSISTED_SNAPSHOT_IDENTITY_MISMATCH' }
$snapshotUri = "https://firestore.googleapis.com/v1/projects/$projectId/databases/(default)/documents/$snapshotLocation"
try {
  $snapshotResponse = Invoke-WebRequest -UseBasicParsing -Uri $snapshotUri -Headers @{ Authorization = "Bearer $accessToken" }
  $snapshotDocument = ConvertFrom-JsonText -Text $snapshotResponse.Content
} catch { throw 'SNAPSHOT_PERSISTENCE_CHECK_FAILED' }
if ($snapshotDocument.fields.hash.stringValue -ne $snapshotHash) { throw 'SNAPSHOT_HASH_MISMATCH' }
$snapshotFields = $snapshotDocument.fields.snapshot.mapValue.fields
if (-not $snapshotFields -or $snapshotFields.environment.stringValue -ne 'mainnet' -or $snapshotFields.synthetic.booleanValue -ne $false) { throw 'UNEXPECTED_SNAPSHOT_CONFIGURATION' }
$providerErrors = @($snapshotFields.providerErrors.arrayValue.values | Where-Object { $_ } | ForEach-Object { [string]$_.stringValue })
$providerChecks = [ordered]@{
  quotePresent = $null -ne $snapshotFields.quote.mapValue
  fxPresent = $null -ne $snapshotFields.usdPerUsdt.mapValue
  calendarPresent = $null -ne $snapshotFields.calendar.mapValue
  employmentPresent = $null -ne $snapshotFields.employment.mapValue
}
# A provider error is never a correct evaluation. Before publication, NO_TRADE/WAITING_FOR_NFP is valid.
$calendarRequired = $evaluation.body.strategyId -ne 'btc-strategy-fundamental-trigger-v1'
$evaluationAccepted = $evaluation.httpStatus -eq 200 -and [string]$evaluation.body.status -ne 'ERROR' -and $providerErrors.Count -eq 0 -and
  $providerChecks.quotePresent -and $providerChecks.fxPresent -and (-not $calendarRequired -or $providerChecks.calendarPresent)
$verifiedAt = [DateTime]::UtcNow
# A distinct file per region and run preserves earlier regional evidence.
$reportStamp = $verifiedAt.ToString("yyyyMMdd'T'HHmmssfffffff'Z'", [Globalization.CultureInfo]::InvariantCulture)
$reportDirectory = Join-Path (Split-Path -Parent $PSScriptRoot) '.local'
if (-not (Test-Path -LiteralPath $reportDirectory -PathType Container)) { $null = New-Item -ItemType Directory -Path $reportDirectory }
$reportPath = Join-Path $reportDirectory "production-verification-$region-$reportStamp.json"
$report = [ordered]@{
  verifiedAtUtc = $verifiedAt.ToString('o')
  projectId = $projectId
  region = $region
  functionName = $functionName
  functionUrl = $url
  cloudRunUrl = $function.serviceConfig.uri
  state = $function.state
  revision = $function.serviceConfig.revision
  tradingMode = $settings.TRADING_MODE
  marketDataEnvironment = $settings.BYBIT_ENVIRONMENT
  allowNewEntries = ($settings.ALLOW_NEW_ENTRIES -eq 'true')
  bybitAccountId = $settings.BYBIT_ACCOUNT_ID
  credentialBinding = $settings.BYBIT_CREDENTIAL_BINDING
  secretBindings = $verifiedSecrets
  credentialVariables = 0
  runtimeServiceAccount = $function.serviceConfig.serviceAccountEmail
  privateInvocationVerified = $true
  anonymousHttpStatus = $anonymous.httpStatus
  reconciliationQueue = [ordered]@{
    name = $queue.name
    state = $queue.state
    runtimeEnqueuer = $true
    runtimeViewer = $true
    runtimeSchedulerActAs = $true
    rateLimits = $queue.rateLimits
    retryConfig = $queue.retryConfig
  }
  recoveryScheduler = [ordered]@{
    name = $recoveryJob.name
    state = $recoveryJob.state
    schedule = $recoveryJob.schedule
    timeZone = $recoveryJob.timeZone
    uri = $recoveryJob.httpTarget.uri
    oidcServiceAccount = $recoveryJob.httpTarget.oidcToken.serviceAccountEmail
    oidcAudience = $recoveryJob.httpTarget.oidcToken.audience
    body = $recoveryBody
  }
  reconcileHttpStatus = $reconcile.httpStatus
  reconciliation = $reconcile.body.execution
  evaluationHttpStatus = $evaluation.httpStatus
  evaluationScheduledAtUtc = $evaluationScheduledAtUtc
  evaluation = $evaluation.body
  firestoreDocument = $document.name
  snapshotDocument = $snapshotDocument.name
  providerErrors = $providerErrors
  providerChecks = $providerChecks
  evaluationAccepted = $evaluationAccepted
}
$report | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $reportPath -Encoding UTF8
[ordered]@{
  region = $region
  state = $report.state
  tradingMode = $report.tradingMode
  allowNewEntries = $report.allowNewEntries
  bybitAccountId = $report.bybitAccountId
  credentialBinding = $report.credentialBinding
  secretBindingNames = @($verifiedSecrets | ForEach-Object { $_.key })
  reconciliationQueueState = $queue.state
  recoverySchedulerState = $recoveryJob.state
  anonymousHttpStatus = $report.anonymousHttpStatus
  reconcileHttpStatus = $report.reconcileHttpStatus
  reconcileReasonCodes = $reconcile.body.execution.reasonCodes
  evaluationHttpStatus = $report.evaluationHttpStatus
  decision = $evaluation.body.decision
  status = $evaluation.body.status
  reasonCodes = $evaluation.body.reasonCodes
  evaluationId = $evaluationId
  firestorePersisted = [bool]$document.name
  evaluationScheduledAtUtc = $evaluationScheduledAtUtc
  snapshotLocation = $snapshotLocation
  providerErrors = $providerErrors
  providerChecks = $providerChecks
  evaluationAccepted = $evaluationAccepted
  reportPath = $reportPath
} | ConvertTo-Json -Depth 8
$accessToken = $null
$identity = $null
$requestHeaders = $null
$evaluationHeaders = $null
# The per-run report is written first, so a rejected evaluation keeps its evidence.
if (-not $evaluationAccepted) { throw "EVALUATION_NOT_ACCEPTED: HTTP $($evaluation.httpStatus), status $($evaluation.body.status), provider errors [$($providerErrors -join ',')]" }
