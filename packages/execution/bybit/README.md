# Ejecutor Bybit V5

`BybitExecutor` implementa ejecución mainnet y testnet. Se verificaron consultas privadas GET de identidad, cuenta, saldo, posiciones y órdenes en mainnet mediante el diagnóstico aislado `scripts/check-bybit-account.ts`, por petición del operador. No se ejecutaron órdenes ni conciliación con esas credenciales. El estado inicial sigue siendo **UNVALIDATED**. Las pruebas verifican comportamiento del software, no rentabilidad.

## Contrato con la aplicación

La aplicación llama `reconcile()` **antes** de cargar proveedores macro, y luego `execute(ExecutionRequest)`. Ambos retornan `ExecutionResultSchema`. `decision` permanece independiente del estado de ejecución. Un resultado `PROTECTED` requiere fills, posición atribuible y los dos stops nativos comprobados; una aceptación HTTP nunca equivale a ejecución.

`ExecutorStore` debe adquirir un lease por `environment:uid:BTCUSDT`, comprobar propietario, fence y vencimiento en cada transacción, guardar una intención única por escenario y persistir `nextReconcileAtUtc` antes de volver. No debe llamar al exchange dentro de una transacción. El host debe programar conciliación durable pronta antes de los efectos externos y mantener una recuperación periódica para tareas perdidas. El lease mínimo es 240 segundos, mayor que el timeout HTTP de 180 segundos del host. Cada mutación externa comprueba el lease y exige al menos 10 segundos restantes; cada llamada Bybit tiene timeout de como máximo 5 segundos.

Las etiquetas `demo`, `validationStatus` y `sourcesValidated` permanecen en la auditoría, pero ya no bloquean por sí mismas una entrada live. Los motores siguen verificando las fuentes concretas, su procedencia, vigencia, conflictos y riesgo. Los datos sintéticos siguen bloqueados: `DEMO_NOT_LIVE` en los motores y `LIVE_SYNTHETIC_INPUT` en el ejecutor. La ausencia de una constancia histórica de testnet tampoco bloquea; la confirmación de los TP/SL de cada posición sigue siendo obligatoria.

La intención pasa a `SUBMITTING` antes de enviar. Después de un crash o respuesta ambigua, se investiga el mismo `orderLinkId` mediante órdenes recientes, historial, fills y posición. Nunca se vuelve a enviar la entrada. Una ausencia temporal permanece `UNKNOWN`, incluso si la posición parece plana. Una intención `PREPARED` abandonada se consume como cancelada, conservando el máximo de una intención por escenario. Los cierres ambiguos tampoco se reenvían a ciegas; un nuevo intento de cierre solo procede cuando el anterior tiene un resultado terminal explícito. Si un proceso muere reteniendo el lease, otro trabajador puede necesitar esperar hasta 240 segundos para adquirirlo: el objetivo de 15 segundos de protección es un plazo operativo con el runtime disponible, no una garantía durante fallos de infraestructura. Las tareas que encuentran el lease ocupado reciben HTTP 503 y reintentan.

`testing.ts` contiene exclusivamente cliente sintético, reloj y persistencia en memoria para pruebas/CLI; el runtime desplegado importa `BybitClient` y persistencia Firestore. `dry_run` consulta solo información pública del exchange, calcula el payload y no escribe ni consulta endpoints privados. Para pausar nuevas entradas manteniendo gestión de posiciones, se conserva `testnet`/`live` con `allowNewEntries=false`.

## Preparación explícita de cuenta

Utilizar una cuenta o subcuenta dedicada. Configurar manualmente en Bybit **ISOLATED**, **ONE_WAY**, apalancamiento Buy/Sell **1x** y clave con lectura/trading sin retiro. Configurar el UID esperado y `dedicatedAccountConfirmed=true`. El runtime comprueba UID mediante `/v5/user/query-api`, margen actual mediante `/v5/account/info.marginMode`, y `positionIdx=0`/leverage mediante posiciones. No usa `tradeMode` obsoleto ni cambia modos globales. Rechaza posición u órdenes ajenas antes de entrar.

El saldo aislado disponible en USDT se calcula con la fórmula documentada por Bybit: `walletBalance - totalPositionIM - totalOrderIM - locked - bonus`. No se usa `totalAvailableBalance` de margen cruzado. El requisito suma nominal 1x y reserva de costes. Los secretos solo entran por constructor desde Secret Manager; el cliente nunca devuelve ni registra headers, secretos ni mensajes arbitrarios del exchange. Los hosts están fijados a `api.bybit.com` o `api-testnet.bybit.com`; redirecciones HTTP están deshabilitadas.

## Precio, tamaño y protección

Los filtros del instrumento se consultan en cada entrada. El precio límite Buy redondea hacia abajo y Sell hacia arriba para no ampliar el límite de deslizamiento. El dimensionamiento usa `max(ask, límite)`, redondea cantidad BTC hacia abajo y nunca multiplica 100 USD por el apalancamiento. FX USD/USDT debe existir, estar verificado y vigente. El libro y FX se revalidan después de persistir `SUBMITTING`; si envejecieron, se cancela la intención sin enviar. TP y SL se convierten y cuantizan hacia dentro usando el mismo cálculo de riesgo que el motor.

La orden inicial es `Limit/IOC`, TP/SL `Full/Market`, triggers `LastPrice`. La verificación consulta los dos stops vinculados por `parentOrderLinkId`, tipo, trigger, modo y cantidad junto con la posición. La reparación usa `trading-stop` sobre exposición atribuida. El plazo inicial de protección es de 15 segundos desde la preparación de la entrada; una protección perdida posteriormente conduce al cierre en la siguiente conciliación. Un fallo de red puede impedir observar o cerrar dentro del plazo: queda persistido para reintentos, nunca se declara plano por timeout.

El registro preserva fills, comisiones por moneda y nominal real de entrada. Se repite RR con precio medio y, de forma conservadora, la mayor comisión de entrada entre estimada y realizada. Una comisión en moneda desconocida o distinta de USDT impide verificar RR y causa cierre completo de exposición propia. El funding futuro continúa siendo un supuesto explícito, no un hecho conocido.

Exceso de nominal de entrada sobre 100 USD más precisión monetaria: cancela remanentes y reduce el exceso en pasos BTC; si los mínimos impiden una reducción válida, cierra toda la posición propia. RR inválido y vencimiento siempre tienen prioridad y cierran todo. No se rebalancean ganancias posteriores por mark price. Dos observaciones planas separadas por al menos dos segundos, más evidencia terminal de la entrada, confirman `CLOSED`; solo entonces se limpian órdenes residuales propias.

La atribución compara volumen neto de ejecuciones propias, dirección y precio medio con la posición, y detecta ejecuciones/órdenes ajenas. Cambios manuales incompatibles producen `OWNERSHIP_CONFLICT`, bloquean entradas y evitan manipular volumen ajeno. Esta política depende de una cuenta dedicada y de la consistencia de los datos del exchange. Se rechaza historial de más de 90 días y paginación de más de 50 páginas por consulta para impedir lecturas truncadas silenciosas; una incidencia tan prolongada exige revisión operativa.

## Pruebas y verificación testnet opcional

```powershell
npx vitest run packages/execution/bybit
```

La suite ordinaria usa exclusivamente respuestas HTTP/cliente sintéticos, incluso al comprobar la configuración de mainnet. `testnet.optional.test.ts` está deshabilitada por defecto. Para ejecutarla, preparar cuenta **testnet** aislada 1x sin posición/órdenes, e inyectar mediante el entorno (no un archivo `.env`):

* `RUN_BYBIT_TESTNET_TESTS=true`
* `TESTNET_ORDER_TEST_APPROVED=true`
* `BYBIT_TESTNET_API_KEY`, `BYBIT_TESTNET_API_SECRET`, `BYBIT_TESTNET_ACCOUNT_UID`
* `BYBIT_TESTNET_PROBE_SCENARIO_ID=testnet-<identificador-estable-del-intento>`

```powershell
npx vitest run packages/execution/bybit/testnet.optional.test.ts
```

Esta prueba puede abrir una posición de hasta 100 USD nominales **solo en testnet**. Verifica protección inicial antes de cualquier reparación y ejecuta cierre reduceOnly en `finally`. Guarda intención y evidencia sin secretos en `.local/bybit-testnet/`. Si se interrumpe, conservar el journal y reutilizar el mismo escenario para conciliar; si queda un `.lock` de proceso muerto, retirarlo únicamente tras comprobar que no hay otra prueba ejecutándose. No borrar el journal para permitir otra entrada.

Un fill completo no demuestra protección de fills parciales. La evidencia escribe `partialFillProtectionConfirmed=false` salvo que haya observado realmente un parcial protegido. La constancia `compatibilityAttestation` es opcional y se conserva como registro; su ausencia ya no impide live. No cambiar sus campos a `true` sin haber observado esos resultados. Si testnet rechaza la combinación, la entrada permanece rechazada sin alternativa desprotegida. Retirar este requisito no certifica compatibilidad ni rentabilidad: el ejecutor confirma los TP/SL sobre los fills reales y mantiene el cierre de emergencia cuando no puede confirmar la protección.

## Documentación primaria comprobada

Consultada el 1 de octubre de 2026:

* [Bybit autenticación V5](https://bybit-exchange.github.io/docs/v5/guide): HMAC, timestamp y ventana de recepción.
* [Instrumentos](https://bybit-exchange.github.io/docs/v5/market/instrument): filtros dinámicos de precio/cantidad y máximos.
* [Crear órdenes](https://bybit-exchange.github.io/docs/v5/order/create-order): IOC, TP/SL Full Market, `reduceOnly`, límite de 36 caracteres y aceptación asíncrona.
* [Órdenes recientes](https://bybit-exchange.github.io/docs/v5/order/open-order), [historial](https://bybit-exchange.github.io/docs/v5/order/order-list), [ejecuciones](https://bybit-exchange.github.io/docs/v5/order/execution): paginación, recuperación tras vaciado de caché y `parentOrderLinkId`.
* [Posiciones](https://bybit-exchange.github.io/docs/v5/position), [Trading Stop](https://bybit-exchange.github.io/docs/v5/position/trading-stop): modo y protección nativa de posición completa.
* [Información de cuenta](https://bybit-exchange.github.io/docs/v5/account/account-info), [clave API](https://bybit-exchange.github.io/docs/v5/user/apikey-info), [saldo](https://bybit-exchange.github.io/docs/v5/account/wallet-balance): UID, permisos, margen y fórmula de saldo aislado.

Las consultas privadas y la compatibilidad efectiva de una cuenta determinada no se pueden certificar leyendo documentación. El código falla de forma conservadora ante esquemas/capacidades no verificables. Una parada prolongada del runtime mantiene TP/SL nativos pero retrasa el cierre temporal al vencimiento; la frecuencia normal del Scheduler añade hasta cinco minutos, más demoras/fallos de infraestructura. Las tareas de conciliación reducen ese intervalo mientras la infraestructura está disponible.
