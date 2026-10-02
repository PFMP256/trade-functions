# Escenario fechado y supuestos del motor

## Variante predeterminada: empleo observado con fuentes públicas

`btc-nfp-public-2026-10-02.demo.json` selecciona `btc-strategy-nfp-observed-v1` y el escenario `btc-nfp-public-2026-10-02`. BLS aporta el calendario, NFP y desempleo; Bybit aporta cotización/libro del entorno de ejecución; Kraken aporta USD por USDT. No requiere carga manual, consenso, salarios, Treasury, ETF ni calendario de sesiones bursátiles.

Las condiciones macro son LONG cuando desempleo >=4.2% y SHORT cuando NFP >150,000. Ambas verdaderas bloquean por conflicto; ambas falsas bloquean por falta de condición. La ausencia de cualquiera de los dos datos también bloquea, porque impide descartar un conflicto. No se transforma el consenso histórico de 90,000 en un umbral verificado. Los valores 4.2 y 150,000 son parámetros heredados del escenario, sin afirmar capacidad predictiva.

Espera exactamente 15 minutos desde la primera detección persistida del reporte correcto. No se presenta esa espera como confirmación del bono ni del precio. Una revisión posterior mantiene el inicio de esa espera y tiene su propia disponibilidad. Sólo usa información conocida al evaluar, con periodo, unidades y revisión coherentes.

Mantiene la vigencia original sin renovarla: del 1 de octubre de 2026 a las 21:41 UTC al 2 de octubre a las 21:41 UTC. Mantiene TP/SL, RR >=1.5 neto de costes, nominal <=100 USD y 1x. El preset es **demo, UNVALIDATED y dry_run**; las tarifas y financiación siguen siendo supuestos sintéticos pendientes de revisión. La nueva identidad distingue sus reglas y auditoría de la estrategia original; no hereda una validación de rendimiento.

`publicDemoScenarioConfig()` carga la variante pública. `demoScenarioConfig()` sigue cargando la estrategia original, que se describe a continuación. El runtime usa la variante pública cuando no se proporciona una ruta; un `SCENARIO_CONFIG_PATH` explícito prevalece.

## Estrategia original NFP + Treasury + ETF

`btc-nfp-2026-10-02.demo.json` es un preset **demo, UNVALIDATED**, con datos de mercado aún no validados. La ventana `2026-10-01T21:41:00Z` a `2026-10-02T21:41:00Z` es una decisión de ingeniería de 24 horas a partir del precio citado (84,480.81 USD, 17:41 ET), no una fecha comprobada de publicación del análisis. Ese precio histórico no participa en el dimensionamiento ni sustituye el libro actual.

El [calendario oficial BLS de octubre de 2026](https://www.bls.gov/schedule/2026/10_sched.htm), consultado el 1 de octubre de 2026, enumera Employment Situation de septiembre para el 2 de octubre a las 08:30 Eastern Time. Las zonas IANA convierten ese horario en 12:30 UTC y 06:30 America/Mexico_City. El snapshot incorpora un calendario actualizado; si BLS cambia la programación, el motor utiliza ese calendario. Alcanzar la hora programada nunca prueba que se publicó un resultado.

La configuración mantiene los umbrales y TP/SL proporcionados. El consenso de 90,000 solo existe como dato **sintético** en los fixtures; el consenso operativo se obtiene y congela antes del evento, con su propia procedencia. Los resultados de empleo incluyen periodo, serie, unidad, fecha efectiva de publicación y revisión. Se rechazan datos/revisiones que aún no se conocían al evaluar. `publishedAt` puede ser `null`; no se inventa una publicación ausente.

Las decisiones añadidas son explícitas:

- “Salarios sorprenden al alza” significa AHE mensual actual estrictamente mayor que el consenso mensual de la misma serie.
- “Se mantiene” y “rompe” requieren al menos cuatro observaciones intradía del Treasury nominal a diez años, estrictamente posteriores al reporte, que cubran 15 minutos, separadas por no más de seis minutos y todas del mismo lado del umbral. No hace falta un cruce previo. La última observación debe seguir vigente. Pueden configurarse ventana, cantidad mínima y separación.
- La política inicial `BLOCK` bloquea condiciones macro LONG y SHORT verdaderas a la vez. `REQUIRE_UNIQUE_DIRECTION` es una alternativa explícita que exige una única dirección completa; no cambia los predicados ni convierte valores desconocidos en falsos. La falta de cualquier dato laboral crítico sigue bloqueando.
- ETF positivo significa neto mayor que cero de la última sesión ya cerrada; negativo significa menor que cero, y cero es neutral. No exige varias sesiones. El calendario contempla sesiones y cierres, incluidos festivos y cierres adelantados. No se retrocede a un reporte anterior cuando falta el reporte requerido.
- El reporte ETF debe cubrir exactamente sus fondos esperados, sin duplicados ni valores desconocidos, y su suma debe coincidir con el total. El output informa cobertura efectiva, aunque el proveedor marque `complete=true`. La normalización de millones de USD corresponde al adaptador. Un guion no se convierte en cero por defecto.
- Los ETFs de la sesión previa filtran una señal posterior al NFP; no se presentan como respuesta de los ETFs al NFP del día corriente.
- Los TTL iniciales de cotización y USD/USDT son 60 segundos; el del bono es cinco minutos y el del calendario del evento 24 horas. Son supuestos de ingeniería. NFP y ETF se validan por evento y sesión, no por un TTL diario genérico.
- Las cotizaciones son ask para LONG y bid para SHORT. Los precios se convierten con USD por 1 USDT. El RR previo del motor usa esos precios; el ejecutor vuelve a obtener instrumento/libro y recalcula con el peor límite permitido y TP/SL cuantizados. El helper redondea TP y SL hacia adentro: nunca aleja un stop para fabricar RR.
- El spread y el deslizamiento de entrada ya representados por el precio no se agregan otra vez a los costes. Se estiman comisiones de entrada y salida, deslizamiento de salida y financiación para cada recorrido. Todos los costes son obligatorios, incluida financiación; los importes demo no son tarifas verificadas.
- El RR neto debe ser al menos 1.5 y el beneficio/pérdida netos deben ser positivos. Cambiar el mínimo por debajo de 1.5 invalida la configuración.
- Una señal vence en el menor plazo entre fin del escenario, próxima frontera del Scheduler y vigencia de cotización, FX, bono y calendario. El Scheduler opera por fronteras UTC de cinco minutos; una invocación tardía no obtiene cinco minutos adicionales.

`evaluateScenario(snapshot, config, now)` es puro: no tiene red, Firebase, reloj interno, env, ni mutaciones del snapshot. El resultado incluye hashes canónicos de configuración/snapshot y un identificador reproducible para los mismos datos y tiempo inyectado. `decision` y estado de ejecución son distintos; este módulo no declara fills ni posiciones planas. Las pruebas sintéticas verifican implementación, no rentabilidad.

Los fixtures se regeneran con `npx tsx fixtures/write.ts`. Son inequívocamente sintéticos, sus fuentes usan `example.invalid`, y tanto el snapshot como cada procedencia conservan esa marca. Ninguno puede generar una señal live.
