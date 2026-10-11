# Infraestructura como Código (IaC) - Opción A: VM On-Demand en Google Cloud

Esta solución define mediante **Terraform** una Máquina Virtual en **Google Compute Engine** diseñada para actuar como host remoto de desarrollo y entorno de ejecución del agente **Antigravity CLI**. Está optimizada para encenderse y apagarse bajo demanda desde el teléfono móvil (app de Google Cloud), minimizando costos operativos al congelar el cómputo cuando no esté en uso.

> [!WARNING]
> **REGLA DE SEGURIDAD OPERATIVA:**
> **ESTE CÓDIGO NO DEBE EJECUTARSE AUTOMÁTICAMENTE (`terraform apply`).**
> Utiliza exclusivamente comandos de inspección y validación (`terraform plan`, `terraform validate`).

---

## 1. Tabla de Costos Detallada (Encendido vs Apagado)

A continuación se desglosan todos los conceptos facturables por Google Cloud Platform (estimados en la región `us-central1`):

| Concepto | Recurso / Especificación | Costo con VM ENCENDIDA (Running) | Costo con VM APAGADA (Stopped / Terminated) | Explicación del Cobro |
| :--- | :--- | :--- | :--- | :--- |
| **Cómputo (vCPU y RAM)** | `e2-standard-2` (2 vCPU, 8 GB RAM) | **~$0.0670 USD / hora** (~$1.61 USD / día) | **$0.00 USD / hora** | Al detener la VM, Google desasigna la CPU y RAM físicas; el cobro de cómputo se detiene al 100%. |
| **Cómputo (Alternativa)** | `e2-medium` (2 vCPU, 4 GB RAM) | **~$0.0335 USD / hora** (~$0.80 USD / día) | **$0.00 USD / hora** | Opción más económica si solo se ejecutan tareas livianas de CLI. |
| **Disco Persistente (Boot Disk)** | 50 GB `pd-balanced` (SSD Equilibrado) | **~$5.00 USD / mes** (~$0.164 USD / día) | **~$5.00 USD / mes** (~$0.164 USD / día) | **Costo FIJO y CONTINUO.** El disco mantiene almacenado tu código (`~/trade-functions`), `node_modules` y configuraciones aunque la VM esté apagada. |
| **Dirección IP Externa** | IP Pública Efímera (`access_config`) | **~$0.0050 USD / hora** (~$0.12 USD / día) | **$0.00 USD / hora** | Al apagar la VM, Google libera la IP efímera hacia su pool global. Al encenderla, recibe una nueva IP sin costo de reserva inactiva. |
| **Tráfico Saliente (Egress)** | Internet General | Primer 1 GB/mes GRATIS, luego ~$0.12 / GB | **$0.00 USD** | Solo aplica al transferir datos hacia internet (npm install o git push suelen consumir menos de 1 GB). Tráfico entrante (Ingress) es 100% gratis. |
| **Firewall / Service Account** | IAM y Reglas de VPC | **$0.00 USD** (Gratis) | **$0.00 USD** (Gratis) | Google no cobra por cuentas de servicio ni reglas de firewall básicas. |

### Comparativa de Presupuesto Mensual

* **Uso Inteligente On-Demand (Encendida 2 horas al día = ~60 horas/mes):**
  * Cómputo (`e2-standard-2`): 60 h × $0.0670 = ~$4.02 USD
  * IP Efímera: 60 h × $0.0050 = ~$0.30 USD
  * Disco Persistente 50 GB: $5.00 USD (fijo)
  * **TOTAL ESTIMADO:** **~$9.32 USD / mes** *(~84% de ahorro)*

* **Uso Continuo 24/7 (Dejada encendida todo el mes = ~730 horas):**
  * Cómputo (`e2-standard-2`): 730 h × $0.0670 = ~$48.91 USD
  * IP Efímera: 730 h × $0.0050 = ~$3.65 USD
  * Disco Persistente 50 GB: $5.00 USD
  * **TOTAL ESTIMADO:** **~$57.56 USD / mes**

> **¿Por qué usamos IP Efímera y no IP Estática Reservada?**
> Google Cloud cobra una penalización de **$0.010 USD / hora (~$7.30 USD / mes)** por mantener una dirección IP estática que no esté asignada a una máquina encendida. Al usar IP efímera, el costo de red se reduce a exactamente **$0.00** cada vez que apagas la máquina.

> **¿Por qué `us-central1` y no `southamerica-east1` para la VM?**
> En São Paulo (`southamerica-east1`), el costo de cómputo es aproximadamente **50% más alto** (~$0.1005/h vs ~$0.0670/h). Dado que la VM es para desarrollo interactivo y Firestore está en `us-central1`, ubicar la VM en `us-central1` reduce notablemente el gasto.

---

## 2. Automatización de Arranque (Startup Script)

El archivo [`startup.sh`](file:///c:/trade-functions/infra/dev-vm/startup.sh) se ejecuta con privilegios de `root` en **CADA ENCENDIDO** de la máquina virtual (tanto en el primer aprovisionamiento como en cada inicio posterior desde el celular).

### Qué hace en el primer encendido (Fase 1 - Idempotente):
1. **Herramientas del sistema:** Instala `git`, `tmux`, `curl`, `wget`, `htop`, `jq`, `unzip` y herramientas de compilación (`build-essential`).
2. **Google Cloud CLI:** Instala `google-cloud-cli` para permitir ejecución de comandos de GCP directamente desde la terminal del host.
3. **Node.js 22 LTS:** Configura el repositorio oficial de NodeSource e instala la última versión estable de Node.js 22 y `npm`.
4. **Tailscale:** Instala y habilita el demonio de Tailscale para permitir conectividad VPN directa y segura desde tu teléfono sin necesidad de exponer puertos públicos.
5. **Plantilla de usuarios (`/etc/skel` y `/etc/profile.d`):** Configura `/etc/skel` y un hook global en `/etc/profile.d/antigravity.sh` para que cualquier nuevo usuario que ingrese vía **Google Cloud OS Login** (tu cuenta de Google) herede automáticamente las carpetas `~/trade-functions`, `~/btc-research` y el comando `agy-attach`.
6. **Servicio Systemd de Antigravity con Socket Compartido:** Crea y habilita el servicio persistente `antigravity.service` utilizando un socket compartido en `/run/antigravity/tmux.sock` (permisos 0666), permitiendo que usuarios autenticados vía OS Login o usuario directo se conecten sin colisiones de UID ni errores de permisos.

### Qué hace en CADA encendido posterior (Fase 2 - Recurrente):
1. **Creación y verificación de carpetas:**
   * Garantiza la existencia de:
     * `~/trade-functions`
     * `~/btc-research`
   * Asigna los permisos correctos (`chown -R "$USER:$PRIMARY_GROUP"`) soportando usuarios locales y cuentas dinámicas de Google Cloud OS Login sin errores de grupo inexistente.
2. **Activación automática de Antigravity CLI (`agy`):**
   * Asegura que el socket compartido `/run/antigravity/tmux.sock` esté listo.
   * Inicia o reactiva la sesión de **tmux** en segundo plano con el nombre `antigravity`.
   * En caso de que el comando `agy` ya esté instalado en el sistema, lo arranca de forma inmediata dentro del directorio `~/trade-functions`.
   * Si `agy` termina o si aún requiere vinculación inicial, mantiene una consola `bash` interactiva activa para no cerrar la sesión de tmux.
   * Expone el comando universal:
     ```bash
     agy-attach   # Conecta directamente a la sesión activa desde cualquier usuario
     ```

---

## 3. Instrucciones de Inspección (SIN EJECUTAR)

Para revisar los recursos que crearía Terraform sin aplicar cambios en la nube:

### 1. Inicializar los proveedores de Terraform
```powershell
# Ubícate en el directorio del módulo
cd c:\trade-functions\infra\dev-vm

# Descarga el proveedor de Google (sin crear recursos)
terraform init
```

### 2. Validar la sintaxis y coherencia de las variables
```powershell
terraform validate
```
*(Responde: `Success! The configuration is valid.`)*

### 3. Generar el Plan de Inspección
```powershell
# Visualiza todos los recursos que se generarían sin aplicar ninguno
terraform plan
```

> [!CAUTION]
> **NO EJECUTAR:**
> ```powershell
> terraform apply   # <-- NO EJECUTAR este comando
> ```

---

## 4. Flujo de Trabajo desde el Teléfono Celular

Una vez que decidas desplegar esta infraestructura en el futuro, el flujo diario desde tu teléfono móvil será el siguiente:

```
[Móvil: Google Cloud App]
       │
       ▼ (1 click: "Iniciar Instancia")
[VM GCE trade-dev-host Se Enciende]
       │
       ├─► Startup script verifica ~/trade-functions y ~/btc-research
       ├─► Startup script activa tmux 'antigravity' con socket compartido
       │
       ▼ (Conectas por SSH desde móvil vía Termius / JuiceSSH / Cloud Shell)
$ agy-attach
       │
       ▼
[Estás dentro de la sesión interactiva de Antigravity CLI]
       │
       ▼ (Terminas de trabajar)
[Móvil: Google Cloud App]
       │
       ▼ (1 click: "Detener Instancia")
[VM Apagada: Cómputo e IP = $0.00 / hora]
```

---

## 5. Estructura de Archivos del Módulo

* [`main.tf`](file:///c:/trade-functions/infra/dev-vm/main.tf): Definición de la instancia Compute Engine, disco `pd-balanced`, IP efímera, cuenta de servicio dedicada y regla de firewall con comentarios detallados de costos.
* [`variables.tf`](file:///c:/trade-functions/infra/dev-vm/variables.tf): Parámetros configurables con notas sobre diferencias de tarifas entre regiones y tipos de máquina.
* [`outputs.tf`](file:///c:/trade-functions/infra/dev-vm/outputs.tf): Comandos de conexión SSH, IAP, encendido/apagado por gcloud, IP efímera, conector universal `agy-attach` y proyección dinámica de costos.
* [`startup.sh`](file:///c:/trade-functions/infra/dev-vm/startup.sh): Script de inicialización y activación recurrente de Antigravity CLI en `tmux` con soporte para socket compartido y OS Login.
* [`terraform.tfvars.example`](file:///c:/trade-functions/infra/dev-vm/terraform.tfvars.example): Plantilla de valores de ejemplo para personalización sin alterar el código fuente.
* [`.gitignore`](file:///c:/trade-functions/infra/dev-vm/.gitignore): Excluye caché local de proveedores (`.terraform/`) y archivos de estado sensibles.
