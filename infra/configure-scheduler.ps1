param(
  [Parameter(Mandatory)][string]$ProjectId,
  [string]$Region = 'southamerica-east1',
  [Parameter(Mandatory)][string]$RunUrl,
  [Parameter(Mandatory)][string]$IngestUrl,
  [switch]$Apply
)
$ErrorActionPreference = 'Stop'
if (-not $Apply) { throw 'Prepared configuration only. Review this script and pass -Apply explicitly to publish infrastructure.' }
if (-not $RunUrl.StartsWith('https://') -or -not $IngestUrl.StartsWith('https://')) { throw 'HTTPS function URLs are required.' }
$runtimeSa = "btc-runtime@$ProjectId.iam.gserviceaccount.com"
$schedulerSa = "btc-scheduler@$ProjectId.iam.gserviceaccount.com"
$ingestorSa = "btc-ingestor@$ProjectId.iam.gserviceaccount.com"
function Invoke-Gcloud { param([string[]]$Arguments) & gcloud @Arguments; if ($LASTEXITCODE -ne 0) { throw 'gcloud failed; inspect the preceding command result.' } }
# Run AFTER bootstrap service accounts and private Firebase deployment (see README).
Invoke-Gcloud @('functions','add-invoker-policy-binding','runBtcNfpEtfBybitV1',"--project=$ProjectId","--region=$Region","--member=serviceAccount:$schedulerSa")
Invoke-Gcloud @('functions','add-invoker-policy-binding','ingestBtcNfpEtfDataV1',"--project=$ProjectId","--region=$Region","--member=serviceAccount:$ingestorSa")
Invoke-Gcloud @('tasks','queues','create','btc-reconcile',"--project=$ProjectId","--location=$Region",'--max-concurrent-dispatches=1','--max-dispatches-per-second=1','--min-backoff=20s','--max-backoff=60s','--max-attempts=100','--max-retry-duration=86400s')
Invoke-Gcloud @('tasks','queues','add-iam-policy-binding','btc-reconcile',"--project=$ProjectId","--location=$Region","--member=serviceAccount:$runtimeSa",'--role=roles/cloudtasks.enqueuer')
Invoke-Gcloud @('tasks','queues','add-iam-policy-binding','btc-reconcile',"--project=$ProjectId","--location=$Region","--member=serviceAccount:$runtimeSa",'--role=roles/cloudtasks.viewer')
Invoke-Gcloud @('iam','service-accounts','add-iam-policy-binding',$schedulerSa,"--project=$ProjectId","--member=serviceAccount:$runtimeSa",'--role=roles/iam.serviceAccountUser')
$common = @("--project=$ProjectId","--location=$Region","--uri=$RunUrl",'--http-method=POST',"--oidc-service-account-email=$schedulerSa","--oidc-token-audience=$RunUrl",'--time-zone=UTC','--headers=Content-Type=application/json','--attempt-deadline=180s','--max-retry-attempts=5','--min-backoff=20s','--max-backoff=60s')
# Bodies come from files: Windows PowerShell 5.1 strips embedded double quotes from native arguments.
# The dry_run job created by configure-evaluation-scheduler.ps1 uses the same evaluation job name, so this
# create fails explicitly instead of adding a second evaluation job; update or delete that job deliberately first.
$bodyFiles = @{}
try {
  foreach ($kind in @('evaluate','reconcile')) {
    $bodyFiles[$kind] = Join-Path ([IO.Path]::GetTempPath()) ("btc-$kind-body-" + [guid]::NewGuid().ToString('N') + '.json')
    [IO.File]::WriteAllText($bodyFiles[$kind], "{`"kind`":`"$kind`"}", (New-Object Text.UTF8Encoding $false))
  }
  Invoke-Gcloud (@('scheduler','jobs','create','http','btc-nfp-etf-five-minutes','--schedule=*/5 * * * *',"--message-body-from-file=$($bodyFiles['evaluate'])") + $common)
  # Recovery scans durable intents even if an invocation crashed before enqueueing its Cloud Task.
  Invoke-Gcloud (@('scheduler','jobs','create','http','btc-nfp-etf-recovery','--schedule=* * * * *',"--message-body-from-file=$($bodyFiles['reconcile'])") + $common)
} finally { $bodyFiles.Values | ForEach-Object { Remove-Item -LiteralPath $_ -Force -ErrorAction SilentlyContinue } }
