# ==============================================================================
# VARIABLES DE CONFIGURACIÓN - INFRAESTRUCTURA VM DE DESARROLLO (OPCIÓN A)
# ==============================================================================

variable "project_id" {
  description = "ID del proyecto de Google Cloud donde residen las funciones y recursos de trading."
  type        = string
  default     = "trade-functions-20261001"
}

# ------------------------------------------------------------------------------
# COSTO DE REGIÓN:
# us-central1 (Iowa):
#   - e2-standard-2: ~$0.0670 / hora (~$48.91 / mes 24/7).
#   - pd-balanced: ~$0.1000 / GB / mes ($5.00 / mes para 50 GB).
# southamerica-east1 (São Paulo - donde corren las Cloud Functions):
#   - e2-standard-2: ~$0.1005 / hora (~$73.37 / mes 24/7, ~50% más costoso).
#   - pd-balanced: ~$0.1500 / GB / mes ($7.50 / mes para 50 GB).
# RECOMENDACIÓN: Usar us-central1 para la máquina de desarrollo ahorra ~35-50% en cómputo,
# mientras que las Cloud Functions de ejecución rápida permanecen en São Paulo.
# ------------------------------------------------------------------------------
variable "region" {
  description = "Región de GCP donde se desplegará la VM de desarrollo."
  type        = string
  default     = "us-central1"
}

variable "zone" {
  description = "Zona específica dentro de la región para la VM."
  type        = string
  default     = "us-central1-a"
}

variable "instance_name" {
  description = "Nombre visible de la instancia Compute Engine en la consola y app móvil de GCP."
  type        = string
  default     = "trade-dev-host"
}

# ------------------------------------------------------------------------------
# COSTO DE TIPO DE MÁQUINA (CÓMPUTO vCPU + RAM):
# - e2-standard-2 (2 vCPU, 8 GB RAM):
#     * VM ENCENDIDA: ~$0.067 USD por hora (~$1.61 USD/día si está 24h encendida).
#     * VM APAGADA:   $0.00 USD por hora. El cargo de vCPU y RAM se detiene al 100%.
# - e2-medium (2 vCPU compartida/burstable, 4 GB RAM) - alternativa económica:
#     * VM ENCENDIDA: ~$0.0335 USD por hora (~$0.80 USD/día si está 24h encendida).
#     * VM APAGADA:   $0.00 USD por hora.
# ------------------------------------------------------------------------------
variable "machine_type" {
  description = "Tipo de máquina GCP. Recomendado: 'e2-standard-2' para compilar TypeScript y ejecutar tests holgadamente; 'e2-medium' para presupuesto mínimo."
  type        = string
  default     = "e2-standard-2"
}

# ------------------------------------------------------------------------------
# COSTO DE DISCO PERSISTENTE (ALMACENAMIENTO):
# - Tipo pd-balanced (SSD equilibrado):
#     * Tasa mensual en us-central1: ~$0.10 USD por GB al mes.
#     * Disco de 50 GB: 50 * $0.10 = $5.00 USD por mes (~$0.164 USD al día).
#     * ¡ATENCIÓN CRÍTICA!: El disco persistente almacena tu código, repositorios y node_modules.
#       Por tanto, SE COBRA CONTINUAMENTE TANTO SI LA VM ESTÁ ENCENDIDA COMO SI ESTÁ APAGADA.
#       Costo fijo mensual del disco: ~$5.00 USD.
# ------------------------------------------------------------------------------
variable "disk_size_gb" {
  description = "Tamaño en GB del disco de arranque persistente (pd-balanced). Se cobra fijo incluso con la VM apagada (~$0.10/GB/mes)."
  type        = number
  default     = 50
}

variable "disk_type" {
  description = "Tipo de disco persistente. 'pd-balanced' ofrece rendimiento SSD a costo reducido ($0.10/GB/mes)."
  type        = string
  default     = "pd-balanced"
}

variable "boot_image" {
  description = "Imagen del sistema operativo base (Ubuntu 24.04 LTS amd64)."
  type        = string
  default     = "ubuntu-os-cloud/ubuntu-2404-lts-amd64"
}

variable "network" {
  description = "Red VPC donde se conectará la VM (generalmente 'default')."
  type        = string
  default     = "default"
}

variable "subnetwork" {
  description = "Subred VPC específica (opcional, null usa la subred por defecto de la zona)."
  type        = string
  default     = null
}

# ------------------------------------------------------------------------------
# COSTO DE DIRECCIÓN IP PÚBLICA (EFÍMERA vs ESTÁTICA):
# - IP Externa Efímera (enable_public_ip = true sin reservar dirección estática):
#     * VM ENCENDIDA: ~$0.005 USD por hora en uso (~$0.12 USD/día si está 24h).
#     * VM APAGADA:   $0.00 USD por hora. Google libera la IP efímera al apagar la VM,
#       evitando cargos cuando no se usa. Al encenderla nuevamente, se le asigna una nueva IP.
# - IP Externa Estática Reservada (NO RECOMENDADA PARA ON-DEMAND):
#     * Google penaliza las IPs estáticas NO asignadas o apagadas cobrando $0.010 USD por hora (~$7.30 USD/mes).
#     * Por eso usamos IP Efímera: costo $0.00 mientras la VM esté apagada.
# ------------------------------------------------------------------------------
variable "enable_public_ip" {
  description = "Asignar IP pública efímera a la VM. Solo se cobra mientras la VM está encendida ($0.005/h) y es $0 cuando está apagada."
  type        = bool
  default     = true
}

variable "dev_username" {
  description = "Nombre del usuario Linux principal que ejecutará Antigravity CLI y alojará las carpetas ~/trade-functions y ~/btc-research."
  type        = string
  default     = "developer"
}

variable "allowed_ssh_cidrs" {
  description = "Rangos CIDR autorizados para conectar por SSH directo puerto 22 (por defecto 0.0.0.0/0; para máxima seguridad puede restringirse a la IP de tu hogar o usar Google Cloud IAP / Tailscale)."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}
