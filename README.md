# trade-functions

Implementación TypeScript estricta con Firebase Functions gen2, Node.js 22, Firestore y Bybit V5. La estrategia predeterminada es **`btc-strategy-nfp-observed-v1` / `1.0.0`**, basada exclusivamente en fuentes públicas gratuitas BLS, Bybit y Kraken. La estrategia original `btc-strategy-nfp-etf-v1` permanece disponible mediante su configuración explícita. El selector puro `packages/strategies/index.ts` elige el motor por `strategyId`; los dos reutilizan el ejecutor `bybit-linear-executor-v1` / `1.0.0`.

El endpoint privado conserva el nombre `runBtcNfpEtfBybitV1` por compatibilidad; la estrategia efectiva se identifica en el JSON de cada evaluación. La ingesta privada `ingestBtcNfpEtfDataV1` se conserva para la estrategia original y no es una dependencia de la variante pública.

El estado inicial es **UNVALIDATED**, con `tradingMode=dry_run` y preset demo fechado. La variante pública consulta automáticamente las fuentes y no necesita registrar fuentes de ingesta manual. El código contiene envío real, conciliación, TP/SL nativos y cierre reduceOnly. No se han enviado operaciones reales durante la implementación. La preparación del despliegue mantiene dry_run, utiliza datos públicos mainnet y permite montar las claves desde Secret Manager sin incluir sus valores en el paquete; consulte [la configuración cloud](infra/deployment.md). Las etiquetas demo/UNVALIDATED se conservan como metadatos y ya no bloquean por sí mismas el modo live; los datos sintéticos siguen bloqueados. Las pruebas sintéticas no acreditan rentabilidad ni compatibilidad operativa de una cuenta real.

La función está desplegada y privada en **`trade-functions-20261001` / `southamerica-east1` (São Paulo)**, revisión `runbtcnfpetfbybitv1-00004-hop`. Se verificaron autenticación, cotización pública Bybit, FX de Kraken, **calendario y comunicado oficiales de BLS** y persistencia en Firestore. El antiguo `BLS_HTTP_403` se debía a que BLS/Akamai rechaza desde redes cloud el User-Agent genérico `node`; el adaptador ahora se identifica como robot automatizado, sin cambiar fuentes ni semántica. Antes de publicarse el reporte de septiembre, la evaluación responde HTTP 200 con `NO_TRADE / WAITING_FOR_NFP`, sin errores de proveedor. **Cloud Scheduler** invoca la evaluación cada cinco minutos mediante OIDC con `btc-scheduler`, en dry_run, y sus ejecuciones reales quedaron verificadas en Firestore. Firestore conserva la base existente en `us-central1`. Consulte el [estado comprobado del despliegue](infra/deployment.md#estado-comprobado-en-gcp).

## Instalación y comandos locales

```powershell
npm ci
npm run typecheck
npm test
npm run build
npm run schemas
npm run evaluate
node --import tsx scripts/evaluate.ts --fixture long --out evaluations/public-long.demo.json
node --import tsx scripts/evaluate.ts --fixture short --out evaluations/public-short.demo.json
node --import tsx scripts/evaluate.ts --fixture expired --out evaluations/public-expired.demo.json
node --import tsx scripts/evaluate.ts --strategy original --fixture long
npm run check:public
```

El CLI de evaluación no carga `.env`, no llama a Bybit y rechaza configuraciones distintas de `dry_run`. Por defecto simula la variante pública; `--strategy original` selecciona los ejemplos anteriores. `--config` selecciona la estrategia por la identidad del archivo. Simula el payload con especificaciones de instrumento explícitamente sintéticas. Para archivos propios: `node --import tsx scripts/evaluate.ts --snapshot archivo.json --config escenario.json --now 2026-10-02T12:46:30Z`. Los precios/contratos mínimos del fixture no se usan en el runtime: allí se consultan a Bybit antes de dimensionar. En PowerShell, el launcher `npm.ps1` puede consumir flags después de `--`; use `node --import tsx` como arriba, o `npm.cmd`.

`check:public` es un diagnóstico separado: consulta realmente los endpoints públicos, sin cargar `.env`, credenciales, Firestore ni enviar órdenes. Usa el mismo User-Agent BLS declarado que el runtime; `BLS_CONTACT` sólo se toma del entorno del proceso. Por defecto comprueba Bybit testnet; `node --import tsx scripts/check-public-sources.ts --environment mainnet` comprueba exclusivamente lecturas públicas mainnet. Informa errores de conectividad o reporte aún no publicado para el periodo solicitado; no genera señales ni conserva una primera detección durable.

`npm run check:bybit` es un diagnóstico privado **exclusivamente de lectura en mainnet**. Lee las credenciales del `.env` local sin modificarlo ni mostrarlas; acepta `BYBIT_API_KEY`/`BYBIT_API_SECRET`, `API_KEY`/`API_SECRET` o el formato existente de etiquetas `api key` y `secret` seguidas por su valor en otra línea. Consulta identidad, cuenta unificada USDT, posiciones y órdenes BTCUSDT linear. Su transporte sólo admite GET a esos cinco endpoints de `api.bybit.com`; rechaza escrituras y redirecciones. No importa el ejecutor ni invoca conciliación, no activa live, no calcula señales y no guarda la respuesta en archivos. La salida contiene información privada de cuenta y debe tratarse como tal. `walletBalanceUsdt` no es una promesa de saldo retirable; la disponibilidad calculada para margen aislado sólo se muestra si la cuenta declara `ISOLATED_MARGIN`.

## Organización

| Ruta | Responsabilidad |
| --- | --- |
| `apps/functions/src` | HTTP/OIDC, orquestación, persistencia, bloqueo transaccional y Cloud Tasks |
| `packages/strategies/btc-strategy-nfp-etf-v1` | Motor sin red/Firebase, lógica ternaria y RR decimal |
| `packages/strategies/btc-strategy-nfp-observed-v1` | Motor basado en NFP y desempleo observados, sin consenso, bono ni ETF |
| `packages/data-providers` | Bybit público, contratos/validación de ingesta, ETF y calendario |
| `packages/execution/bybit` | HMAC, cuenta, dimensionamiento, máquina de estados y protección |
| `packages/shared/src` | Schemas y contratos compartidos |
| `scenarios` | Preset fechado y supuestos documentados |
| `fixtures`, `evaluations` | Datos y resultados sintéticos reproducibles |
| `schemas` | JSON Schemas generados; refinamientos semánticos adicionales se ejecutan con Zod |
| `infra` | Guía de despliegue, Scheduler dry_run de evaluación y configuración operativa completa (cola, ingesta, recuperación) no aplicada |

## Variante automática con fuentes gratuitas

`scenarios/btc-nfp-public-2026-10-02.demo.json` es el preset predeterminado si no se indica `SCENARIO_CONFIG_PATH`. Mantiene el evento, la vigencia, TP/SL y límites monetarios del escenario original, con identidad de estrategia y escenario propias.

| Condición observada después del reporte BLS | Resultado candidato |
| --- | --- |
| Desempleo >= 4.2% y NFP <= 150,000 | LONG |
| NFP > 150,000 y desempleo < 4.2% | SHORT |
| Desempleo >= 4.2% y NFP > 150,000 | NO_TRADE / CONFLICTING_MACRO |
| Ninguna condición, o falta un dato requerido | NO_TRADE |

Ambos datos pertenecen al mismo evento, periodo y revisión. El límite de 150,000 y el desempleo de 4.2% proceden del escenario original; no son consensos. El antiguo consenso citado de 90,000 no se convierte en una constante ni se utiliza. Los salarios dejan de participar en las reglas.

Se esperan **15 minutos desde la primera detección persistida del reporte BLS correcto**. Esta es una espera operativa: no acredita confirmación del Treasury ni persistencia de la reacción del precio. Una revisión del reporte conserva la detección inicial; no reinicia el reloj. El calendario programado por sí solo no habilita entradas.

Consenso, Treasury, ETF y calendario NYSE no son entradas requeridas de esta variante. El runtime no consulta la colección de ingesta manual; datos antiguos o fallos de esa ingesta no pueden afectarla. `PUBLIC_DATA_ENABLED=false` bloquea esta estrategia con `PUBLIC_SOURCES_REQUIRED`; no activa un reemplazo manual. Los fallos de BLS, Kraken o Bybit sí bloquean.

Una dirección candidata sólo llega a LONG/SHORT si la cotización y FX están vigentes, los niveles son válidos y el RR neto es >=1.5. Permanecen el nominal máximo de 100 USD a 1x, TP/SL nativos, persistencia previa, conciliación, cierre de emergencia y límite de una intención por escenario. Es una hipótesis de empleo observado distinta de la tesis empleo + bonos + flujos; reducir dependencias no prueba su rendimiento. El preset continúa en demo/UNVALIDATED/dry_run.

## Escenario y reglas de la estrategia original

El [calendario oficial BLS](https://www.bls.gov/schedule/2026/10_sched.htm), verificado al implementar, programa Employment Situation de septiembre de 2026 para el 2 de octubre, 08:30 `America/New_York`: 12:30 UTC / 06:30 `America/Mexico_City`. El feed de calendario es revisable; la hora programada no acredita publicación. El reporte debe identificar evento, período y publicación efectiva. El consenso debe haber llegado a la ingesta antes del evento; no se acepta reconstruirlo después.

La ventana demo permanece `2026-10-01T21:41:00Z`–`2026-10-02T21:41:00Z`. Son 24 horas elegidas desde la referencia histórica del análisis, no una hora comprobada de publicación. No se modifica al ejecutar el programa otro día. El precio 84,480.81 USD es contexto histórico, nunca el precio operativo. El nominal objetivo es **100 USD de posición total a 1x**, no 100 USD de margen apalancable ni pérdida al stop.

LONG exige `(NFP <= consenso OR desempleo >= 4.2)` y bono `< 5.15` y ETF neto `> 0`. SHORT exige `(NFP > 150000 OR salarios MoM > consenso salarial)` y bono `> 5.36` y ETF neto `< 0`. Predicados desconocidos no se convierten en falsos. Ambas condiciones macro verdaderas bloquean por defecto. No hay puntuaciones ni indicadores añadidos.

Confirmación: al menos cuatro observaciones intradía del bono, estrictamente posteriores a publicación, cubriendo 15 minutos, separadas como máximo seis minutos, todas estrictamente del mismo lado. No se exige cruce desde el otro lado. TTL inicial: cotización 60 s, bono 300 s, FX 60 s; son elecciones de ingeniería. Un feed diario no satisface la confirmación. Todos los tiempos se guardan en UTC; Luxon/IANA produce la hora local.

ETFs: se usa la última sesión estadounidense cerrada, contemplando festivos/cierres anticipados. Hace falta cobertura completa y suma coherente de fondos esperados para esa sesión. No se vuelve silenciosamente a otra sesión. El manifiesto incluido cubre NYSE 2026; fuera de esa cobertura hace falta otro manifiesto verificado. Un total visible puede ser parcial. Guion/vacío no son cero; los millones se convierten a USD. Entrada/salida significa total de esa única sesión mayor/menor que cero, no una secuencia; su disponibilidad anterior al NFP no implica respuesta al NFP.

TP/SL demo: LONG 87,400/82,900 USD; SHORT 82,000/86,000 USD. Se convierten con `usdPerUsdt`, se cuantizan conservadoramente y se calcula RR neto con comisiones, salida con deslizamiento y financiación explícita. La entrada ya utiliza ask/bid y no añade spread otra vez. El ejecutor recalcula al peor límite IOC y con fills reales; no mueve el stop para alcanzar RR. RR mínimo >=1.5, beneficio y pérdida netos positivos.

Los costes demo son supuestos sintéticos, no una tarifa vigente: 5.5 bps por lado, 2 bps de deslizamiento de salida y 10 USDT/BTC de financiación por recorrido. Antes de habilitar live deben sustituirse por supuestos documentados aplicables a la cuenta y horizonte. Financiación desconocida no puede omitirse; no se pretende pronosticar perfectamente su coste.

## Fuentes e ingesta requerida

La cotización y libro vienen directamente del mismo endpoint Bybit del ejecutor; se conservan bid, ask, last, mark y timestamp del exchange. Se implementaron HTTP timeout/reintentos limitados y caché que conserva tiempos originales. En testnet se usan exclusivamente precios y credenciales testnet para el instrumento ejecutado.

Con `PUBLIC_DATA_ENABLED=true` (por defecto), el runtime obtiene automáticamente calendario y resultados de fuentes oficiales BLS sin clave, y USD/USDT de la API pública de Kraken. Las lecturas BLS se identifican como `trade-functions-bls-release-monitor/1.0 (automated read-only monitor ...)`, conforme a la [política de robots de BLS](https://www.bls.gov/bls/pss.htm): no imitan un navegador. `BLS_CONTACT` opcional añade un email o URL HTTPS de contacto; un valor inválido bloquea la evaluación. La API de series de BLS, su feed Atom y su iCalendar se investigaron y no sustituyen al comunicado: niveles sin calendario ni hora de publicación, límite de 25 consultas diarias sin clave, timestamps de feed anteriores al embargo y eventos iCalendar sin periodo de referencia. El calendario y comunicado BLS se leen mediante parsers específicos que rechazan cambios de estructura; no se presenta una tabla HTML como una API JSON. El comunicado debe corresponder al período requerido. La primera detección de publicación se conserva en Firestore; la hora de embargo impresa no se presenta como un timestamp de publicación verificado. Kraken proporciona el precio de un trade USDT/USD y su timestamp original; si envejece, el motor bloquea, sin suponer paridad. Sólo la estrategia original utiliza el manifiesto NYSE 2026 cuando no se aportó otro calendario de sesiones.

**Sólo la estrategia original requiere conectar consenso previo, Treasury intradía y flujos ETF completos** mediante ingesta autenticada. Esas dependencias ya no bloquean la variante pública predeterminada. No se inventó una API de Farside ni se sustituyó el bono intradía por una serie diaria. La exportación gratuita de Forex Factory existe, pero sus términos de base de datos requieren aclarar el uso de almacenamiento antes de configurarla como fuente. Farside publica HTML gratuito; no se verificó API documentada. CoinGlass tiene una API de ETF documentada, con clave y plan de acceso. Consulte [fuentes, contratos y limitaciones](packages/data-providers/SOURCES.md).

En la estrategia original, `PUBLIC_DATA_ENABLED=false` permite utilizar exclusivamente la ingesta estructurada también para BLS y FX. Cuando están activadas, las fuentes públicas configuradas tienen prioridad explícita y sus fallos no se ocultan reutilizando datos anteriores. El HTML original BLS y la respuesta JSON serializada de Kraken se archivan por SHA-256 en `sourceEvidence`; `publicData` conserva primera recepción y revisiones. Estas consultas son de lectura y no necesitan las credenciales privadas de Bybit.

El cuerpo de ingesta sigue `schemas/ingestion.schema.json`: `{ "feed": StructuredFeed, "evidence": [{"sha256":"...","content":"documento o payload original"}] }`. `feed` sigue `schemas/structuredFeed.schema.json`. Evidencia máxima por petición: 700 KB; archive documentos largos externamente y envíe un extracto estructurado verificable como evidencia, identificando su origen. El servidor comprueba SHA-256 del contenido y conserva `sourceEvidence/{hash}`. Cada procedencia referencia `evidenceSha256`; se puede reutilizar evidencia ya archivada. No incluya secretos, cabeceras de autenticación ni datos privados de cuenta en fuentes/evidencias.

Para la ingesta externa, la cuenta de servicio autorizada atestigua el contenido: una URL sola no prueba su veracidad. El endpoint de ingesta no descarga URLs arbitrarias. El registro `config/source-registry.json` empieza vacío; los adaptadores públicos integrados consultan sus URLs fijas independientemente de ese registro. Cada fuente externa requiere `sourceId`, `allowedOrigins` HTTPS exactos, `allowedKinds` y `usageApproved:true` tras comprobar su permiso de uso. Ejemplo de estructura (no habilitado por defecto):

```json
[{"sourceId":"bls-official","allowedOrigins":["https://www.bls.gov"],"usageApproved":true,"allowedKinds":["calendar","employment"]}]
```

Cada campo conserva unidad, serie, período/sesión, `observedAt`, `publishedAt:null` si no se conoce, primera recepción, disponibilidad, consulta y revisión. El servidor fija primera recepción/disponibilidad de datos nuevos al instante de ingesta; un reenvío idéntico conserva esas fechas. Cambiar contenido sin cambiar revisión se rechaza. El consenso se congela en la primera recepción previa al evento. Los datos revisados crean versiones nuevas, no reescriben decisiones. El feed completo puede incluir las observaciones de bono necesarias; actualícelo antes de cada evaluación.

## Persistencia, concurrencia y recuperación

Firestore usa credenciales de la cuenta de servicio y reglas que niegan todo acceso de clientes. Colecciones: `snapshots`, `evaluationDrafts`, `evaluations`, `latest`, `structuredFeeds/{environment}/versions`, `publicData`, `sourceEvidence`, `executionScopes/{scopeHash}/intents` y `reconciliationOutbox`. Intenciones y revisiones conservan todos los estados/fills sin secretos. `latest` compara la ejecución programada para que una finalización antigua no sustituya una posterior. El cliente debe respetar `validUntilUtc`, mínimo de escenario, próxima evaluación y caducidad de datos críticos; nunca cachear una señal indefinidamente.

La decisión y snapshot canónicos se persisten antes de ejecutar, con claim transaccional de 240 s. Dos invocaciones de la misma ejecución programada no pueden asociar decisiones diferentes al mismo ID. La perdedora responde `EVALUATION_IN_PROGRESS` sin sustituir la evaluación. Tras una caída, la recuperación conserva el snapshot original, concilia y nunca reenvía la entrada. La evaluación final es inmutable; solo el resultado de ejecución se incorpora al finalizar el draft. Una repetición HTTP puede presentar una vista actualizada de conciliación y NO_TRADE por vencimiento, sin alterar el historial.

La primera acción de cada evaluación es conciliar exposición propia, incluso ante NO_TRADE, expiración, pausa de aperturas o error de proveedor. Hay bloqueo transaccional por entorno/UID/BTCUSDT con fencing; las transacciones no llaman al exchange. Intención durable antes de enviar y una sola intención por escenario incluso cambiando config. La respuesta aceptada no acredita fills. Ante timeout, se busca el mismo `orderLinkId` en órdenes, historial y ejecuciones; jamás se genera otra entrada por incertidumbre.

Los TP/SL nativos permanecen en Bybit. Protección no confirmada tras 15 s exige intento de cierre reduceOnly; un cierre aceptado permanece pendiente hasta obtener evidencia de posición plana. Dos lecturas planas y orden de entrada terminal son necesarias para CLOSED. No se usa cancel-all. Cambios manuales que impidan atribuir el volumen causan OWNERSHIP_CONFLICT y bloquean gestión de volumen no atribuible.

Cloud Tasks solicita conciliación pronta cada ~20 s mientras hay intención no terminal. Un outbox se escribe junto con el estado y un Scheduler independiente cada minuto recupera fallos de despacho o caídas antes de crear la tarea. La cola usa reintentos acotados; la recuperación por minuto persiste aunque esos reintentos se agoten. La gestión protectora continúa si Tasks falla; nuevas entradas exigen cola disponible. El bloqueo dura >=240 s frente al timeout HTTP de 180 s; tras una caída puede demorarse la recuperación hasta liberar/vencer el bloqueo. Fallos de red/exchange pueden extenderla: nunca se informa posición cerrada por timeout.

`closeOnScenarioExpiry=true` cierra exclusivamente la exposición propia vencida. La evaluación de cinco minutos implica hasta aproximadamente cinco minutos de retraso nominal; la conciliación adicional suele reducirlo. Los fallos de infraestructura no permiten garantizar ese máximo. `ALLOW_NEW_ENTRIES=false` pausa entradas y conserva gestión. Mantenga el mismo entorno/UID/modo operativo al pausar; cambiar a dry_run detiene escrituras, incluida gestión. No retire el despliegue ni cambie de cuenta hasta confirmar que no hay intenciones pendientes ni exposición propia.

## Emulador

Requiere Firebase CLI y Java en PATH. En este equipo se verificó Temurin OpenJDK 21.0.12.1. Si la sesión se abrió antes de instalar Java y `java -version` todavía no lo encuentra, actualice el PATH de esa sesión desde el `JAVA_HOME` instalado o reinicie la aplicación/terminal para heredar las variables nuevas. Ejecute:

```powershell
npm run test:emulator
npm run emulators
```

`test:emulator` arranca exclusivamente Firestore, ejecuta las suites transaccionales y lo detiene al terminar. Las suites sólo corren con `FIRESTORE_EMULATOR_HOST` y proyecto fijo `demo-trade-functions`; nunca usan Firestore de producción ni envían órdenes a Bybit. En el emulador de Functions, un POST con `X-Emulator-Auth: local-development` permite pruebas sólo si `FUNCTIONS_EMULATOR=true` y el proyecto empieza `demo-`. No es un bypass desplegable. El `.env` preexistente se conserva sin modificaciones; únicamente el diagnóstico privado `check:bybit` lo lee por petición del operador. Antes de arrancar también Functions revise su configuración local, pues esa CLI sí puede cargar archivos `.env`.

## Preparar despliegue privado

Los comandos de esta sección son explícitos: preparar archivos no crea recursos ni despliega. Seleccione un proyecto Firebase con Firestore creado y facturación habilitada; active Cloud Functions/Run, Cloud Build, Artifact Registry y Firestore. Para el despliegue inicial en dry_run basta una cuenta de ejecución con acceso a Firestore y otra identidad autorizada a invocar la función:

```powershell
gcloud iam service-accounts create btc-runtime --project YOUR_PROJECT
gcloud iam service-accounts create btc-scheduler --project YOUR_PROJECT
gcloud projects add-iam-policy-binding YOUR_PROJECT --member serviceAccount:btc-runtime@YOUR_PROJECT.iam.gserviceaccount.com --role roles/datastore.user
```

No ejecute `firebase deploy` desde la raíz que contiene el `.env` privado. Firebase CLI puede cargar las variables dotenv aunque el archivo esté excluido del paquete mediante `ignore`. El preparador crea una carpeta nueva bajo `.local/cloud-deploy`, copia exclusivamente código compilado productivo y configuración permitida, y genera un `.env` propio sin secretos. No lee, sobrescribe ni copia el `.env` privado. La carpeta recibe una junction local de `node_modules` para el descubrimiento de funciones; esa junction está excluida de la subida y Cloud Build instala desde el lockfile.

```powershell
npm run typecheck
npm run build
node --import tsx scripts/prepare-cloud-deploy.ts --project YOUR_PROJECT --region southamerica-east1
# Opcional: --bls-contact EMAIL_O_URL_HTTPS añade contacto al User-Agent del robot BLS.
# Utilice exactamente el deploymentScript devuelto por el preparador.
& 'C:\trade-functions\.local\cloud-deploy\YOUR_STAGING_DIRECTORY\deploy.ps1'
```

El comando directo `node --import tsx` evita que el launcher `npm.ps1` consuma flags. El `deploy.ps1` generado carga únicamente sus variables permitidas en el proceso, cambia al staging y llama a Firebase con proyecto, selector y modo no interactivo fijos. Después concede `roles/run.invoker` exclusivamente a `btc-scheduler` sobre el servicio de esta función. Ese binding debe reaplicarse en cada despliegue porque `invoker:private` restablece la política de invocación; el script falla explícitamente si no puede restaurarlo. El éxito de Firebase y gcloud se decide por su código de salida, de modo que capturar la salida en Windows PowerShell 5.1 no convierte mensajes informativos de stderr en un fallo. Con el Scheduler activo, pause el job durante la publicación y reanúdelo tras verificar, para no recibir 403 transitorios mientras IAM se propaga. No concede acceso anónimo ni crea jobs. Un bloque `finally` restaura las variables previas y la ubicación, también si falla el despliegue. No lee ningún `.env`.

Firebase CLI filtra el entorno del subproceso de descubrimiento: las variables del proceso padre por sí solas no llegan a la evaluación de exports. Por eso `package.main` del staging apunta a `deployment-bootstrap.cjs`, que fija dentro del proceso la configuración generada antes de importar el código compilado. Así el manifiesto incluye región e identidad de ejecución correctas sin depender del momento en que la CLI cargue dotenv. Este artefacto es exclusivamente dry_run: ni siquiera una variable `TRADING_MODE=live` heredada activa operaciones; cambiar la configuración requiere preparar y revisar otro artefacto.

El selector incluye un codebase por región, por ejemplo `functions:btc-strategy-southamerica-east1:runBtcNfpEtfBybitV1`; esto permite verificar una región nueva antes de retirar explícitamente la anterior. Desplegar sólo por nombre de función puede devolver `No function matches given --only filters`. El paquete conserva JavaScript compilado y desactiva la compilación automática con `gcp-build` vacío; no depende de fuentes TypeScript ausentes en la subida. `engines.npm=11.13.0` fija el resolvedor verificado localmente y en la preparación: npm 10.9.4 interpreta de forma incompatible el override de `uuid` y falla al instalar este lockfile; no se elimina el override ni se degrada `uuid` para resolverlo. Google Buildpacks admite esta selección mediante [el campo engines.npm](https://docs.cloud.google.com/docs/buildpacks/nodejs?hl=en).

La configuración generada fija `TRADING_MODE=dry_run`, `BYBIT_ENVIRONMENT=mainnet`, `ALLOW_NEW_ENTRIES=false` y `PUBLIC_DATA_ENABLED=true`. Sólo despliega `runBtcNfpEtfBybitV1`, privada. Por defecto no monta secretos; `--credential-binding mainnet` monta el par de Secret Manager y `--reconcile-queue btc-reconcile` configura la cola creada mediante `infra/configure-reconciliation.ps1`. Ninguna opción activa trading ni crea infraestructura por sí misma. `RUNTIME_SERVICE_ACCOUNT` identifica a `btc-runtime`; `SCHEDULER_SERVICE_ACCOUNT` autoriza la identidad `btc-scheduler`, que usa el job de evaluación. `RUN_FUNCTION_URL` fija la audiencia OIDC exacta. Además del IAM privado, el handler verifica issuer, audiencia, email verificado y allowlist. Conceda `roles/run.invoker` a esa identidad sobre el servicio desplegado y compruebe las respuestas autenticadas según [la guía cloud](infra/deployment.md).

### Scheduler de evaluación en dry_run

```powershell
./infra/configure-evaluation-scheduler.ps1 -ProjectId YOUR_PROJECT -Region southamerica-east1 -Apply
```

Crea o actualiza únicamente `btc-nfp-etf-five-minutes`: `*/5 * * * *` UTC, `POST {"kind":"evaluate"}` y OIDC con `btc-scheduler` y audiencia exacta `RUN_FUNCTION_URL`. Antes comprueba que la función desplegada sea privada, dry_run, mainnet, con `ALLOW_NEW_ENTRIES=false` y sin secretos. No crea cola, ingesta ni job de recuperación. `.local/verify-scheduler-run.ps1` contrasta una ejecución real con el estado del job, el log de Cloud Run y la evaluación persistida para esa hora programada exacta. Detalles en [la guía cloud](infra/deployment.md#cloud-scheduler-en-dry_run).

### Configuración operativa completa

La ingesta, Secret Manager, el job de recuperación y Tasks pertenecen a una configuración operativa adicional. La ingesta requiere su cuenta `btc-ingestor`, `INGESTOR_SERVICE_ACCOUNTS`, `INGEST_FUNCTION_URL` y un despliegue explícito separado. Antes de usar el siguiente script, deben existir ambas funciones privadas y las identidades correspondientes:

```powershell
./infra/configure-scheduler.ps1 -ProjectId YOUR_PROJECT -Region southamerica-east1 -RunUrl https://YOUR_RUN_URL -IngestUrl https://YOUR_INGEST_URL -Apply
```

El script crea cola y jobs activos con OIDC, cada cinco minutos para evaluar y cada minuto para recuperar conciliación, además de bindings específicos. No forma parte de la preparación ni del despliegue inicial y no se ha ejecutado. Si ya existen recursos, use `gcloud ... update` para esos recursos: `create` falla explícitamente, no borra ni reemplaza infraestructura. El job dry_run usa el mismo nombre de evaluación, de modo que este script no puede añadir una segunda evaluación por frontera; actualice o elimine deliberadamente ese job antes. Los cuerpos JSON se pasan desde archivos porque PowerShell 5.1 elimina las comillas internas de los argumentos nativos. La SA runtime necesita también ver la cola y crear tareas; el script limita dichos roles a esa cola, y `iam.serviceAccountUser` a la SA de OIDC. Verifique que Scheduler/Tasks tengan sus service agents administrados habilitados. La SA ingestor sólo invoca la función de ingesta; no necesita escritura directa en Firestore. Ninguna función se publica para `allUsers`.

Referencias de infraestructura verificadas: [HTTP gen2](https://firebase.google.com/docs/functions/http-events), [runtime Node 22](https://firebase.google.com/docs/functions/manage-functions), [OIDC Scheduler y roles/run.invoker](https://docs.cloud.google.com/scheduler/docs/http-target-auth), [Cloud Tasks HTTP](https://docs.cloud.google.com/tasks/docs/creating-http-target-tasks), [Secret Manager](https://firebase.google.com/docs/functions/config-env).

## Activar testnet y posteriormente live

1. Prepare una subcuenta dedicada: ONE_WAY, margen aislado consultable en account/info, buy/sell leverage=1. El bot no modifica modos globales ni aumenta apalancamiento. La clave necesita lectura y trading, sin retiro; configure UID esperado y confirme dedicación.
2. Testnet: `TRADING_MODE=testnet`, `BYBIT_ENVIRONMENT=testnet`, secretos testnet, UID testnet. Complete las fuentes con información verificable; el runtime de producción nunca importa fixtures. Use la suite opcional del ejecutor siguiendo su README para comprobar la combinación Limit IOC + TP/SL Full Market LastPrice y protección de fills parciales.
3. La constancia de compatibilidad testnet es opcional; su ausencia ya no bloquea live. Conserve evidencia si se realiza esa prueba y no marque verificaciones que no se hayan observado. Si Bybit rechaza la combinación inicial, no hay entrada desprotegida alternativa. La suite opcional no falsifica una prueba de fill parcial cuando el exchange ejecuta todo.
4. Revise fuentes requeridas, costes, evento y configuración; sesiones/fondos sólo corresponden a la estrategia original. `demo`, `validationStatus` y `sourcesValidated` son metadatos auditables y no constituyen requisitos de entrada. Mantenga su valor real y las fechas originales del escenario. Los controles de procedencia verificable, datos no sintéticos, vigencia y riesgo siguen activos.
5. En el proyecto/subcuenta mainnet separado: configure `TRADING_MODE=live`, `BYBIT_ENVIRONMENT=mainnet`, UID, secretos mainnet, cola y `DEDICATED_ACCOUNT_CONFIRMED=true`; registre fuentes externas sólo si utiliza la estrategia original. `ALLOW_NEW_ENTRIES=false` mantiene las entradas pausadas. Su activación es independiente de cargar las claves y desplegar estos cambios.

Lea también [el ejecutor y su verificación operativa](packages/execution/bybit/README.md) y [las decisiones de ingeniería del escenario](scenarios/README.md). Las suites automáticas por defecto usan clientes simulados y no llaman a mainnet. Una cuenta incompatible, mínimos que superen 100 USD, saldo insuficiente, posición/órdenes ajenas o datos inválidos bloquean la entrada explícitamente.

## Límites de lo verificado

**Actualización del 2 de octubre de 2026, 03:14-03:35 UTC.** El 403 de BLS se diagnosticó desde Cloud Build en `southamerica-east1`. Con el User-Agent genérico `node`, calendario, comunicado e iCalendar devolvían 403 de Akamai. El feed Atom y la API sí respondían. Con un User-Agent declarado de robot, las páginas oficiales respondieron 200. Tras desplegar ese cambio con el preparador y su `deploy.ps1`, la verificación autenticada devolvió HTTP 200 y `NO_TRADE / WAITING_FOR_NFP`, sin `providerErrors`, con calendario BLS de septiembre a las 12:30 UTC, cotización, FX y persistencia. El reporte de septiembre aún no existía, por lo que `employment=null` es el resultado correcto. Cloud Scheduler entregó invocaciones OIDC reales con HTTP 200 y su evaluación quedó persistida para la hora programada exacta.

Los parsers se contrastaron con documentos reales, sin persistirlos ni generar decisiones. El comunicado vigente de agosto produjo NFP 162,000 y desempleo 4.1%, iguales al titular y a la diferencia de niveles de la API. Los doce comunicados archivados de agosto de 2025 a agosto de 2026 coincidieron con sus titulares. Esa prueba reveló que los comunicados hasta abril de 2026 usan `--` en el título. El parser acepta ahora uno o dos guiones y sigue rechazando otras estructuras. La suite ordinaria terminó con **336 pruebas aprobadas y 12 omitidas**, más **11 de emulador aprobadas**: 347 casos distintos. Typecheck, build y schemas aprobaron.

La detección real del reporte de septiembre ocurrirá después de las 12:30 UTC del 2 de octubre y no se ha observado todavía. Hasta entonces no está demostrado que su redacción sea compatible; si no lo fuera, el parser fallará de forma cerrada con `PROVIDER_FAILURE`. No se añadió contacto BLS porque el operador no lo ha proporcionado; BLS se reserva bloquear robots sin contacto. El escenario sigue demo/UNVALIDATED, vence a las 21:41 UTC y no se envió ninguna orden.

Verificación realizada el 1 de octubre de 2026, hora de Ciudad de México, en este workspace: `npm run typecheck`, `npm test`, `npm run build` y `npm run schemas` aprobados. Se verificaron **337 casos distintos: 326 pruebas locales y 11 contra el emulador real de Firestore**, ejecutadas en suites separadas. La prueba opcional de Bybit testnet sigue pendiente. Las pruebas locales incluyen 60 del motor de empleo observado, integración con el ejecutor y aislamiento de la ingesta externa. `npm run check:public` comprobó lecturas reales sin claves: Bybit testnet devolvió cotización/libro, BLS confirmó el calendario y devolvió ausencia para el reporte de septiembre aún no publicado, y Kraken devolvió un trade USD/USDT con timestamp. Los dos exports HTTP compilados se cargaron correctamente. El último `npm audit` reportó cero vulnerabilidades; no se agregaron dependencias para esta variante. Los tres nuevos comandos de fixtures produjeron LONG/DRY_RUN, SHORT/DRY_RUN y NO_TRADE/SCENARIO_EXPIRED; el ejemplo LONG original también continúa funcionando. El nominal planificado de los ejemplos públicos es 92.4935 y 93.5 USD, respectivamente, por redondeo a pasos BTC sintéticos.

`npm run test:emulator` se ejecutó correctamente con Temurin OpenJDK 21.0.12.1: **11 pruebas aprobadas en dos archivos**, salida 0 y cierre automático del emulador. Se comprobaron bloqueo y fencing, evaluación inmutable, recuperación de decisiones canónicas, evidencia y revisiones atómicas, concurrencia de datos públicos, rechazo de revisiones contradictorias y conservación de la primera detección BLS. Las pruebas utilizan únicamente el proyecto local `demo-trade-functions`; no se usaron credenciales privadas ni se enviaron órdenes. `npm run typecheck` volvió a aprobar tras añadir la suite de persistencia pública.

Las pruebas locales y del emulador validan contratos, simulaciones y transacciones de persistencia; no reemplazan las pruebas operativas con Bybit testnet ni un despliegue cloud. La compatibilidad de protección inicial y parcial sólo se considera verificada con evidencia real, aunque la constancia ya no sea un requisito de entrada. No se hizo backtest ni se afirma rentabilidad. El registro demo permanece UNVALIDATED.

Se mantiene un override acotado de `uuid` >=11.1.1 para `gaxios@6.7.1`, dependencia transitiva del módulo opcional Storage de Firebase Admin, para excluir versiones con aviso de seguridad. El consumidor utiliza la API compatible `v4`; las versiones efectivas están fijadas por `package-lock.json`.


La comprobación privada de mainnet autorizada por el operador se realizó únicamente con solicitudes GET de identidad, cuenta, cartera USDT, posiciones y órdenes. No se enviaron órdenes ni se modificó la cuenta. Esta lectura detectó y corrigió un error del cliente: `/v5/account/info` puede omitir el timestamp `time` del sobre; su ausencia se admite y un valor presente sigue validándose como número, conforme al [ejemplo oficial de Bybit](https://bybit-exchange.github.io/docs/v5/account/account-info). Se añadieron cuatro regresiones sintéticas y la suite ordinaria terminó con 322 pruebas aprobadas; las 11 de emulador se ejecutaron previamente en su suite específica y la opcional testnet sigue sin ejecutarse por decisión del operador. Compilación y comprobación de tipos aprobadas.
