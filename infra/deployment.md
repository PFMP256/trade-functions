# Despliegue privado en Google Cloud

Proyecto: **trade-functions-20261001**, nombre visible **trade-functions**, número **712373537119**. El identificador global `trade-functions` ya estaba ocupado. La función usa **southamerica-east1 (São Paulo, Brasil)**; Firestore conserva su base y registros existentes en **us-central1**. Facturación habilitada con la cuenta activa existente del operador.

## Despliegue en modo live y activación de entradas en producción

La configuración activa pasa a ejecución real en producción (`TRADING_MODE=live`, `BYBIT_ENVIRONMENT=mainnet`, `ALLOW_NEW_ENTRIES=true`), asociando el identificador verificado de Bybit (`BYBIT_ACCOUNT_ID=548108699`) y confirmación explícita de cuenta dedicada (`DEDICATED_ACCOUNT_CONFIRMED=true`). Las claves de Secret Manager se consumen en memoria por el runtime para la firma HMAC-SHA256, sin imprimirse ni incluirse en el paquete de despliegue.

**Verificado el 2 de octubre de 2026 a las 04:38 UTC:**
- **Revisión Cloud Run**: `runbtcnfpetfbybitv1-00007-piq` en estado **ACTIVE** en `southamerica-east1`.
- **Configuración efectiva**: `TRADING_MODE=live`, `BYBIT_ENVIRONMENT=mainnet`, `ALLOW_NEW_ENTRIES=true`, `BYBIT_ACCOUNT_ID=548108699`, `DEDICATED_ACCOUNT_CONFIRMED=true`, `BYBIT_CREDENTIAL_BINDING=mainnet`, `RECONCILE_QUEUE=btc-reconcile`.
- **Parámetros de ejecución (Opción B Agresiva)**:
  - `targetPositionNotionalUsd`: `2000` USD (BTC nominal ~2,000 USD, margen requerido ~100 USD USDT con balance disponible de 551.84 USDT).
  - `leverage`: `20`x.
  - `marginMode`: `REGULAR_MARGIN` (modo por defecto de Bybit Unified Trading Account - UTA).
  - `positionMode`: `ONE_WAY` con `positionIdx: 0` (el paginador de Bybit filtra particiones fantasma `seq: -1` y conserva la posición unificada limpia).
- **Invocación anónima**: **HTTP 403** (bloqueado por IAM y token OIDC obligatorio).
- **Conciliación periódica autenticada**: **HTTP 200**, `tradingMode=live`, `status=NO_ENTRY`, `leverage=20`, `reasonCodes=[]`. Sin intenciones previas ni mutaciones espurias.
- **Evaluación programada autenticada**: **HTTP 200**, `decision=NO_TRADE`, `status=WAITING`, `reasonCodes=["WAITING_FOR_NFP"]`, con snapshot de mercado y evaluación persistidos en Firestore en la hora programada exacta (`2026-10-02T04:38:47.073Z`).
- **Secretos e IAM**: Bindings a `BYBIT_API_KEY` y `BYBIT_API_SECRET` versión 1 `ENABLED`; `roles/secretmanager.secretAccessor` para `btc-runtime`; `roles/run.invoker` para `btc-scheduler`.
- **Cola Cloud Tasks y Schedulers**: Cola `btc-reconcile` en estado `RUNNING`; jobs `btc-nfp-etf-recovery` (cada minuto) y `btc-nfp-etf-five-minutes` (cada 5 minutos) en estado `ENABLED`.
- **Evidencia guardada**: `.local/production-verification-southamerica-east1-20261002T0438556615942Z.json`.
- **Pruebas automáticas**: 341 pruebas locales aprobadas, typecheck y build limpios.

### Estado de ejecución en Bybit: LISTO PARA OPERAR
A diferencia de la revisión anterior, **todos los parámetros de la cuenta de Bybit han sido alineados en el código y en el escenario**:
1. **Modo de Margen**: La cuenta tiene `REGULAR_MARGIN` (UTA), el ejecutor ahora lo acepta plenamente sin emitir `MARGIN_MODE_INCOMPATIBLE`.
2. **Apalancamiento**: La cuenta tiene apalancamiento `20x`, el escenario y el ejecutor operan a `20x` sin emitir `LEVERAGE_INCOMPATIBLE`.
3. **Modo de Posición**: El paginador de Bybit descarta el registro de partición `seq: -1`, validando exactamente 1 posición One-Way con `positionIdx: 0` sin emitir `POSITION_MODE_INCOMPATIBLE`.
4. **Margen y Fondos**: Con balance disponible de 551.84 USDT y margen requerido de ~100 USDT para un tamaño de posición de 2,000 USD a 20x, no hay restricción de fondos.

**Conclusión**: El bot **SÍ puede ejecutar órdenes reales** cuando se publique el reporte de empleo NFP a las 12:30:00 UTC y se cumplan las condiciones de la estrategia.

### Procedimiento de preparación y despliegue en live
```powershell
npm run typecheck
npm test
npm run build
node --import tsx scripts/prepare-cloud-deploy.ts --project trade-functions-20261001 --region southamerica-east1 --credential-binding mainnet --reconcile-queue btc-reconcile --trading-mode live --bybit-environment mainnet --allow-new-entries true --bybit-account-id 548108699 --dedicated-account-confirmed true
gcloud scheduler jobs pause btc-nfp-etf-five-minutes --project trade-functions-20261001 --location southamerica-east1
gcloud scheduler jobs pause btc-nfp-etf-recovery --project trade-functions-20261001 --location southamerica-east1
& 'C:\trade-functions\.local\cloud-deploy\YOUR_STAGING_DIRECTORY\deploy.ps1'
gcloud scheduler jobs resume btc-nfp-etf-five-minutes --project trade-functions-20261001 --location southamerica-east1
gcloud scheduler jobs resume btc-nfp-etf-recovery --project trade-functions-20261001 --location southamerica-east1
& .\infra\verify-production.ps1 -ProjectId trade-functions-20261001 -Region southamerica-east1
```

## Secretos y conciliación en producción (Histórico dry_run)

La actualización posterior añade las claves mainnet a Secret Manager y la cola `btc-reconcile`, conservando `TRADING_MODE=dry_run` y `ALLOW_NEW_ENTRIES=false`. Las etiquetas `demo`, `validationStatus` y `sourcesValidated` quedan como metadatos auditables, sin impedir por sí solas una señal live. La constancia histórica de compatibilidad testnet pasa a ser opcional; no se creó evidencia ficticia. Se mantienen el rechazo de datos sintéticos y los controles de fuentes, vigencia, riesgo, identidad de cuenta y TP/SL.

**Verificado el 2 de octubre de 2026 a las 03:57 UTC:** revisión `runbtcnfpetfbybitv1-00005-tuz` ACTIVE, par mainnet montado con la versión 1 de cada secreto, cola RUNNING y recuperación ENABLED. HTTP anónimo 403; conciliación autenticada 200 con `DRY_RUN_NO_EXCHANGE_MUTATIONS`; evaluación autenticada 200 con `WAITING_FOR_NFP`, sin errores de proveedor y con snapshot/evaluación persistidos. Evidencia: `.local/production-verification-southamerica-east1-20261002T0357278282605Z.json`. Typecheck y build aprobaron, junto con **340 pruebas locales**; 12 pruebas optativas/emulador quedaron omitidas. No se enviaron órdenes a Bybit.

La restricción `RECONCILIATION_QUEUE_NOT_CONFIGURED` se resuelve configurando una cola real; se conserva la comprobación de disponibilidad antes de cualquier entrada. El runtime puede ver la cola y encolar tareas, el agente Cloud Tasks puede emitir OIDC con `btc-scheduler` y el job `btc-nfp-etf-recovery` concilia cada minuto. El job de evaluación sigue cada cinco minutos.

La entrega real por Cloud Tasks quedó comprobada a las **03:59:49 UTC**, con `POST {"kind":"reconcile"}`, token OIDC de `btc-scheduler` y HTTP **200** en la revisión `00005-tuz`. Informe: `.local/reconciliation-delivery-verification-southamerica-east1-20261002T0359460087729Z.json`. `infra/verify-reconciliation-delivery.ps1` permite repetir esta comprobación exclusivamente en dry_run; `-VerificationId` reconsulta una prueba existente sin duplicar tareas.

Procedimiento reproducible, manteniendo ejecución simulada:

```powershell
gcloud services enable secretmanager.googleapis.com cloudtasks.googleapis.com --project trade-functions-20261001 --quiet
node --import tsx scripts/sync-production-secrets.ts --project trade-functions-20261001 --apply
& .\infra\configure-reconciliation.ps1 -ProjectId trade-functions-20261001 -Region southamerica-east1 -Apply
npm run typecheck
npm test
npm run build
node --import tsx scripts/prepare-cloud-deploy.ts --project trade-functions-20261001 --region southamerica-east1 --credential-binding mainnet --reconcile-queue btc-reconcile
# Pause ambos jobs, ejecute el deploymentScript devuelto y reanude después de publicar.
& .\infra\verify-production.ps1 -ProjectId trade-functions-20261001 -Region southamerica-east1
& .\infra\verify-reconciliation-delivery.ps1 -ProjectId trade-functions-20261001 -Region southamerica-east1
```

`sync-production-secrets.ts` lee exclusivamente el par `BYBIT_API_KEY`/`BYBIT_API_SECRET` de `.env`, envía sus valores en memoria a Secret Manager y verifica igualdad sin imprimirlos. Si la última versión habilitada ya coincide, la reutiliza. Da acceso a `btc-runtime` sobre esos dos secretos. El preparador no lee `.env`: sólo declara los bindings y escribe configuración no secreta. [Firebase documenta los bindings explícitos de secretos](https://firebase.google.com/docs/functions/config-env); [Cloud Tasks documenta la autenticación OIDC](https://docs.cloud.google.com/tasks/docs/creating-http-target-tasks).

`BYBIT_CREDENTIAL_BINDING=mainnet` permite montar las claves mientras sigue activo dry_run. No cambia `TRADING_MODE`, no confirma dedicación de cuenta y no activa nuevas entradas. El bootstrap sigue imponiendo esos valores. `infra/verify-production.ps1` sustituye al verificador inicial sin secretos: verifica los dos bindings exactos, versiones habilitadas, IAM, cola, recuperación, endpoint privado y evaluación/snapshot persistidos. Guarda evidencia nueva en `.local`.

Las secciones siguientes documentan el despliegue inicial sin secretos y su diagnóstico histórico; para repetir la configuración actual use los dos flags nuevos y el verificador de producción de esta sección.

## Estado histórico comprobado en GCP antes de incorporar secretos y cola

Verificado el **2026-10-02 entre las 03:14 y las 03:35 UTC** (1 de octubre por la noche en Ciudad de México): `runBtcNfpEtfBybitV1` está **ACTIVE** en São Paulo, revisión Cloud Run `runbtcnfpetfbybitv1-00004-hop`, Node.js 22, 512 MiB, concurrencia 1 y máximo 3 instancias. La identidad efectiva es `btc-runtime@trade-functions-20261001.iam.gserviceaccount.com`, con `roles/datastore.user`. La cuenta `btc-scheduler@trade-functions-20261001.iam.gserviceaccount.com` tiene `roles/run.invoker` únicamente sobre este servicio. No hay acceso anónimo ni secretos montados. La función anterior en `us-central1` sigue retirada.

- [Consola del proyecto](https://console.firebase.google.com/project/trade-functions-20261001/overview).
- [Endpoint privado](https://southamerica-east1-trade-functions-20261001.cloudfunctions.net/runBtcNfpEtfBybitV1), que requiere POST y un ID token con esa audiencia exacta.
- Solicitud anónima: **HTTP 403**, correctamente rechazada.
- Solicitud autenticada `reconcile`: **HTTP 200**, `NO_ENTRY / DRY_RUN_NO_EXCHANGE_MUTATIONS`.
- Solicitud autenticada `evaluate`: **HTTP 200**, `NO_TRADE / WAITING / WAITING_FOR_NFP`, sin errores de proveedor, con evaluación y snapshot persistidos.
- Cloud Scheduler `btc-nfp-etf-five-minutes`: **ENABLED**, cada cinco minutos en UTC, OIDC con `btc-scheduler`; sus entregas reales respondieron HTTP 200 y persistieron la evaluación de su hora programada exacta.

**BLS resuelto.** El `BLS_HTTP_403` anterior se reprodujo desde Cloud Build en `southamerica-east1`: Akamai rechazaba el User-Agent genérico `node` de Node.js 22 desde rangos de nube, tanto en el calendario como en el comunicado. Las mismas páginas oficiales respondieron 200 cuando el cliente se identificó como robot automatizado, conforme a la [política de robots de BLS](https://www.bls.gov/bls/pss.htm). El adaptador envía ahora un User-Agent declarado, sin imitar navegadores ni usar proxies. Conserva URLs oficiales, parsers, periodo, NFP como variación mensual, desempleo, revisiones por SHA-256, evidencia y primera detección persistida. El diagnóstico completo y las alternativas investigadas están en [las fuentes](../packages/data-providers/SOURCES.md#acceso-automatizado-a-bls-desde-google-cloud).

El snapshot verificado contiene cotización Bybit mainnet, USD/USDT de Kraken y el calendario BLS de septiembre: `scheduledAtUtc=2026-10-02T12:30:00.000Z`, `publishedAt=null`, procedencia `bls-public-calendar` y evidencia archivada. El reporte laboral es `null` porque BLS todavía publica el de agosto; la estrategia responde `WAITING_FOR_NFP`, no `PROVIDER_FAILURE`. Tras la publicación, la primera lectura correcta fijará `releasedAtUtc` como primera detección persistida y la espera de 15 minutos partirá de ella.

Evidencia local, una por ejecución y sin tokens ni credenciales de Bybit:

| Comprobación | Hora programada | Evaluación | Informe |
| --- | --- | --- | --- |
| Manual, revisión `00003-yeh` | `2026-10-02T03:17:43.123Z` | `78c93b00…71d3` | `.local/cloud-deployment-verification-southamerica-east1-20261002T0317524868193Z.json` |
| Scheduler, revisión `00003-yeh` | `2026-10-02T03:20:00.000Z` | `7dc8fb9d…b9fe6` | `.local/scheduler-verification-southamerica-east1-20261002T0321463552542Z.json` |
| Manual, revisión `00004-hop` | `2026-10-02T03:24:56.288Z` | `7465486f…b140` | `.local/cloud-deployment-verification-southamerica-east1-20261002T0325061067764Z.json` |
| Scheduler, revisión `00004-hop` | `2026-10-02T03:30:00.000Z` | `2cb4dde6…3056f` | `.local/scheduler-verification-southamerica-east1-20261002T0331071154985Z.json` |

La revisión intermedia `00002-fit` se publicó con el generador anterior: Firebase y el binding del invocador terminaron bien, pero Windows PowerShell 5.1 trató como error el mensaje informativo de gcloud al capturar la salida. Se corrigió el generador para decidir por código de salida y se republicó limpiamente como `00003-yeh`; `00004-hop` añade la tolerancia al título con doble guion. Los informes anteriores de us-central1 y de la migración se conservan. Las comprobaciones manuales envían su hora UTC real como `x-cloudscheduler-scheduletime`, por lo que no reutilizan evaluaciones de cinco minutos ya persistidas.

El despliegue está en `dry_run`, usa entorno público mainnet, mantiene entradas desactivadas y no monta secretos de Bybit. No se desplegó la función de ingesta ni se crearon Cloud Tasks ni el job de recuperación por minuto: en dry_run no hay intenciones que conciliar. Artifact Registry en la región elimina imágenes de más de 30 días. El escenario demo sigue **UNVALIDATED** y vence el **2026-10-02T21:41:00Z**; no se cambió ninguna fecha.

La selección regional se contrastó con la [guía de Bybit](https://bybit-exchange.github.io/docs/v5/guide), que documenta el bloqueo de IP estadounidenses, y su [lista de jurisdicciones excluidas](https://www.bybit.com/en/help-center/article/Service-Restricted-Countries), que no incluía Brasil al verificar. La API de ubicaciones de Cloud Functions v2 confirmó `GEN_2` en `southamerica-east1`; México no figuraba en esa API. La consulta real de Bybit desde la función nueva confirmó conectividad.

## Preparación aislada

Desde `C:\trade-functions`:

```powershell
npm run typecheck
npm run build
node --import tsx scripts/prepare-cloud-deploy.ts --project trade-functions-20261001 --region southamerica-east1
# Opcional y recomendado por BLS: contacto del operador en el User-Agent del robot.
node --import tsx scripts/prepare-cloud-deploy.ts --project trade-functions-20261001 --region southamerica-east1 --bls-contact EMAIL_O_URL_HTTPS
```

El preparador no lee el `.env` privado ni ejecuta operaciones cloud. Devuelve una carpeta única bajo `.local/cloud-deploy` con `firebase.json`, reglas de Firestore, un manifiesto `deployment.json`, un script `deploy.ps1` y la fuente de funciones. No se reemplazan ni eliminan preparaciones anteriores. El manifiesto informa el User-Agent BLS efectivo y si se configuró un contacto. `--bls-contact` añade `BLS_CONTACT` a la configuración generada; un email o URL inválidos detienen la preparación. No es un secreto y no se deduce de la cuenta local.

La fuente contiene únicamente JavaScript/JSON productivo, package/lock y configuración permitida. Excluye pruebas, scripts de diagnóstico, fixtures y sourcemaps. El `.env` generado contiene sólo variables de configuración; no contiene API keys, API secrets ni tokens. La junction local de `node_modules` se usa para descubrir los exports y está excluida de la subida. `engines.npm=11.13.0` mantiene el mismo resolvedor de dependencias que produjo y verificó el lockfile, conservando el override de `uuid` 11.1.1; npm 10.9.4 reproduce un error de instalación con ese lockfile.

## Publicación explícita

Ejecute exactamente la ruta `deploymentScript` que devolvió el preparador:

```powershell
& 'C:\trade-functions\.local\cloud-deploy\YOUR_STAGING_DIRECTORY\deploy.ps1'
```

El script fija proyecto `trade-functions-20261001`, selector `firestore:rules,firestore:indexes,functions:btc-strategy-southamerica-east1:runBtcNfpEtfBybitV1` y `--non-interactive`. El codebase incorpora la región para que una migración no elimine automáticamente la versión anterior antes de comprobar la nueva. Antes de llamar a la CLI carga en el proceso solamente la configuración generada, sin leer archivos dotenv. Después de Firebase reaplica mediante gcloud `roles/run.invoker` exclusivamente a `btc-scheduler` sobre `runbtcnfpetfbybitv1`: `invoker:private` restablece la política al desplegar, por lo que una autorización anterior no basta. Si falla ese binding, el script termina con error; no concede acceso anónimo ni crea jobs. Las llamadas nativas se evalúan exclusivamente por su código de salida: Windows PowerShell 5.1 convierte en error terminante cualquier mensaje de stderr redirigido, como `Updated IAM policy`, aunque gcloud haya terminado bien. Finalmente restaura las variables y la ubicación originales mediante `finally`, también ante errores. El dotenv del staging conserva esos mismos valores para la revisión desplegada.

La CLI filtra las variables al crear el subproceso de descubrimiento, por lo que configurar únicamente el proceso padre no garantiza esos metadatos. El mecanismo decisivo es `deployment-bootstrap.cjs`, el `package.main` del staging: fija la configuración permitida dentro del propio subproceso antes de importar los exports. También la fija en el runtime desplegado. El artefacto es exclusivamente dry_run y no acepta que variables heredadas lo conviertan en live; cambiar esa configuración exige generar y revisar otro artefacto. El despliegue regional confirmó `btc-runtime`, `southamerica-east1` y cero bindings secretos.

No sustituya este paso por un `firebase deploy` desde la raíz: la CLI puede cargar el `.env` privado pese a las exclusiones del paquete, y cargar variables después del descubrimiento no actualiza los metadatos de la función.

El despliegue inicial declara función privada, Node.js 22, memoria de 512 MiB, concurrencia 1, máximo 3 instancias y timeout de 180 segundos. Conserva el escenario fechado de demostración y fija:

| Variable | Valor |
| --- | --- |
| `TRADING_MODE` | `dry_run` |
| `BYBIT_ENVIRONMENT` | `mainnet` |
| `ALLOW_NEW_ENTRIES` | `false` |
| `PUBLIC_DATA_ENABLED` | `true` |
| `APP_REGION` | `southamerica-east1` |
| `RUNTIME_SERVICE_ACCOUNT` | `btc-runtime@trade-functions-20261001.iam.gserviceaccount.com` |
| `SCHEDULER_SERVICE_ACCOUNT` | `btc-scheduler@trade-functions-20261001.iam.gserviceaccount.com` |
| `RUN_FUNCTION_URL` | `https://southamerica-east1-trade-functions-20261001.cloudfunctions.net/runBtcNfpEtfBybitV1` |

Mainnet se usa para consultar datos públicos. `dry_run` evita mutaciones del exchange y no monta secretos de Bybit. La función de ingesta y los jobs de Scheduler no se seleccionan en este despliegue. `BLS_CONTACT` sólo aparece si se preparó con `--bls-contact`.

### Redesplegar con el Scheduler activo

Firebase restablece la política del invocador durante la publicación y `deploy.ps1` la restaura después. IAM puede tardar en propagarse, por lo que una invocación programada intermedia podría recibir 403. Para evitarlo:

```powershell
gcloud scheduler jobs pause btc-nfp-etf-five-minutes --project trade-functions-20261001 --location southamerica-east1
& 'C:\trade-functions\.local\cloud-deploy\YOUR_STAGING_DIRECTORY\deploy.ps1'
& 'C:\trade-functions\.local\verify-cloud-deployment.ps1' -Region southamerica-east1
gcloud scheduler jobs resume btc-nfp-etf-five-minutes --project trade-functions-20261001 --location southamerica-east1
```

Si la verificación autenticada devuelve 403 inmediatamente después de publicar, espere uno o dos minutos y repítala antes de reanudar. Así se hizo con la revisión `00004-hop`.

## Cloud Scheduler en dry_run

`infra/configure-evaluation-scheduler.ps1` crea o actualiza **solamente** el job de evaluación:

```powershell
./infra/configure-evaluation-scheduler.ps1 -ProjectId trade-functions-20261001 -Region southamerica-east1 -Apply
```

Antes de tocar Scheduler comprueba que la función esté ACTIVE, en `dry_run`, mainnet, `ALLOW_NEW_ENTRIES=false`, sin secretos y con audiencia e invocador esperados. Reaplica de forma idempotente `roles/run.invoker` para `btc-scheduler` y rechaza `allUsers`/`allAuthenticatedUsers`. Habilita `cloudscheduler.googleapis.com`. El job `btc-nfp-etf-five-minutes` usa `*/5 * * * *` en UTC, `POST`, `Content-Type: application/json` y cuerpo `{"kind":"evaluate"}`. El token OIDC usa `btc-scheduler` y audiencia exactamente igual a `RUN_FUNCTION_URL`. El plazo es 180 s, igual que el timeout de la función, con un reintento tras 30-60 s. El cuerpo se pasa desde un archivo porque PowerShell 5.1 elimina las comillas internas de los argumentos nativos; el script relee el job y verifica el cuerpo decodificado.

Cloud Scheduler envía `X-CloudScheduler-ScheduleTime`; el handler lo usa como identidad de la evaluación. Un reintento de la misma ejecución reproduce la evaluación ya persistida y no vuelve a consultar fuentes. Una respuesta 503 por proveedor queda registrada como `ERROR` y se reevalúa en la siguiente frontera de cinco minutos.

No se crean la cola de Cloud Tasks, la ingesta ni el job de recuperación por minuto. `infra/configure-scheduler.ps1` sigue siendo el procedimiento operativo completo para testnet/live y no se ejecutó. Usa el mismo nombre para el job de evaluación: su `create` fallará explícitamente mientras exista este job, evitando dos evaluaciones por frontera. Actualice o elimine deliberadamente el job dry_run antes de aplicar ese procedimiento.

Para comprobar una ejecución real programada, después de la siguiente frontera de cinco minutos:

```powershell
& 'C:\trade-functions\.local\verify-scheduler-run.ps1' -Region southamerica-east1
```

El verificador lee el job, la entrega en los logs de Cloud Run con agente `Google-Cloud-Scheduler` y la evaluación de Firestore cuya `scheduledAtUtc` coincide exactamente con esa frontera. Después inspecciona el snapshot. Sólo acepta estado del job correcto, entrega HTTP 200, evaluación distinta de `ERROR`, ninguna `providerError`, cotización, FX y calendario presentes, dry_run y mainnet. Guarda un informe nuevo por ejecución en `.local/scheduler-verification-REGION-STAMP.json`. `-ScheduledAtUtc 2026-10-02T12:35:00.000Z` permite revisar una frontera concreta.

El escenario vence el **2026-10-02T21:41:00Z**. Después, cada evaluación devolverá `NO_TRADE / SCENARIO_EXPIRED` y seguirá consultando las fuentes públicas cada cinco minutos. Cuando ya no se necesite esa auditoría, pause el job:

```powershell
gcloud scheduler jobs pause btc-nfp-etf-five-minutes --project trade-functions-20261001 --location southamerica-east1
```

## Verificación después del despliegue

1. Compruebe el estado de la función y la URL efectiva; verifique modo, entorno y ausencia de secretos en la revisión desplegada.
2. La SA `btc-runtime` necesita `roles/datastore.user` sobre el proyecto. Autorice a `btc-scheduler` mediante `roles/run.invoker` sobre el servicio de esta función, sin acceso anónimo.
3. Obtenga un ID token para esa identidad con audiencia exactamente igual a `RUN_FUNCTION_URL` y email incluido. Si usa impersonación desde la identidad operadora, necesita permiso para generar el token en esa SA. Mantenga el token en memoria; no lo imprima ni guarde.
4. Una petición sin autenticación debe ser rechazada por IAM. Con un token válido en `Authorization: Bearer ...`, envíe `POST` JSON `{"kind":"reconcile"}`: en dry_run debe responder `NO_ENTRY` y `DRY_RUN_NO_EXCHANGE_MUTATIONS`.
5. Envíe `POST` JSON `{"kind":"evaluate"}` para verificar obtención de fuentes y persistencia de evaluación/snapshot en Firestore. La decisión puede ser `NO_TRADE` por pausa, datos ausentes, evento pendiente o escenario vencido; distinga ese resultado esperado de un error de infraestructura. Antes de la publicación, `NO_TRADE / WAITING_FOR_NFP` es válido. `PROVIDER_FAILURE` o cualquier `providerError` no es una evaluación correcta.

`.local/verify-cloud-deployment.ps1 -Region southamerica-east1` automatiza esos pasos y guarda un informe nuevo por ejecución. Envía la hora UTC actual como hora programada y comprueba que Firestore conserve exactamente esa hora, para no reutilizar una evaluación anterior. Primero escribe el informe y después termina con `EVALUATION_NOT_ACCEPTED` si la respuesta no es HTTP 200, si el estado es `ERROR`, si hay errores de proveedor o si faltan cotización, FX o calendario. Funciona con Windows PowerShell 5.1, que conserva las fechas ISO como texto, y con PowerShell 7.5+ mediante `-DateKind String`.

El handler comprueba el token además de IAM: issuer, audiencia, email verificado y allowlist. Según la [documentación de autenticación de Cloud Run](https://docs.cloud.google.com/run/docs/authenticating/service-to-service), si se envían `Authorization` y `X-Serverless-Authorization` juntos, la plataforma valida el segundo; este handler utiliza el primero para su verificación adicional.

Repita estas comprobaciones después de cada nuevo despliegue. El estado observado en este proyecto está registrado al inicio; una función ACTIVE no garantiza que sus proveedores externos estén disponibles.

## Comprobaciones locales del paquete

Se reprodujo el error `Missing: uuid@9.0.1 from lock file` con npm 10.9.4 en un directorio limpio. La misma instalación con npm 11.13.0 y `NODE_ENV=production` aprobó: 275 paquetes instalados. Fijar `engines.npm` no cambió versiones transitivas ni el override que mantiene `uuid` 11.1.1. `npm audit` reportó cero vulnerabilidades.

Tras el cambio de BLS del 2 de octubre, la suite ordinaria terminó con **336 pruebas aprobadas y 12 omitidas**; las omisiones corresponden a 11 pruebas de emulador y una opcional de exchange. `npm run test:emulator` volvió a aprobar sus 11 pruebas después del último cambio. Typecheck, build y schemas aprobaron. Las 10 regresiones nuevas cubren el User-Agent declarado, el rechazo de agentes de navegador o genéricos, contactos inválidos o con inyección de cabeceras, el bloqueo ante contacto inválido y el título con doble guion. Anteriormente la suite tenía 326 pruebas aprobadas.

`node --import tsx scripts/check-public-sources.ts --environment mainnet` confirmó desde este equipo el calendario BLS, la ausencia del reporte de septiembre y Kraken. Bybit respondió `BYBIT_MARKET_FUTURE_TIMESTAMP` sólo en local: el reloj del equipo estaba 335 ms por detrás de Bybit y el servicio de hora de Windows estaba detenido. El adaptador rechaza correctamente timestamps futuros. En GCP la cotización se obtuvo sin ese error. Las cuatro regresiones nuevas de descubrimiento importan el SDK en procesos aislados, sin invocar handlers, para comprobar que dry_run no declara secretos y cada modo operativo declara exclusivamente su par correspondiente.
