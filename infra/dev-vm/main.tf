# ==============================================================================
# INFRAESTRUCTURA COMO CÓDIGO (IaC) - OPCIÓN A: VM ON-DEMAND PARA DESARROLLO Y AGENTE
# ==============================================================================
# PROYECTO: trade-functions (Google Cloud Platform)
# ESTADO: ESTRICTAMENTE DISEÑO / NO EJECUTAR DIRECTAMENTE ('terraform apply' NO DEBE CORRERSE)
#
# RESUMEN EJECUTIVO DE COSTOS ESTIMADOS (us-central1):
# ------------------------------------------------------------------------------
# CONCEPTO                       | EN EJECUCIÓN (RUNNING)  | DETENIDA (STOPPED)
# ------------------------------------------------------------------------------
# 1. Cómputo (e2-standard-2)     | ~$0.0670 USD / hora     | $0.00 USD / hora
# 2. IP Pública Efímera          | ~$0.0050 USD / hora     | $0.00 USD / hora
# 3. Disco Persistente (50GB)    | ~$5.0000 USD / mes      | ~$5.0000 USD / mes (FIJO)
# 4. Tráfico Saliente (Egress)   | ~$0.1200 USD / GB       | $0.00 USD
# ------------------------------------------------------------------------------
# ESTIMACIÓN REAL EN USO TÍPICO (Encendiendo 2 horas al día = 60 horas al mes):
#   - Cómputo (60 hrs * $0.067): ~$4.02 USD
#   - IP Efímera (60 hrs * $0.005): ~$0.30 USD
#   - Disco Persistente 50 GB:     $5.00 USD (fijo mensual)
#   ----------------------------------------------------------------------------
#   TOTAL MENSUAL ESTIMADO:        ~$9.32 USD / mes (Ahorro de ~84% vs 24/7)
#
# SI SE DEJA ENCENDIDA 24/7 (730 horas continuas):
#   - Cómputo (730 hrs * $0.067):  ~$48.91 USD
#   - IP Efímera (730 hrs * $0.005): ~$3.65 USD
#   - Disco Persistente:            $5.00 USD
#   ----------------------------------------------------------------------------
#   TOTAL MENSUAL CONTINUO:        ~$57.56 USD / mes
# ==============================================================================

terraform {
  required_version = ">= 1.5.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
  zone    = var.zone
}

# ==============================================================================
# CUENTA DE SERVICIO DEDICADA PARA LA VM DE DESARROLLO
# ==============================================================================
# COSTO DE ESTE RECURSO: $0.00 USD (Las Cuentas de Servicio en IAM son gratuitas)
# Permite otorgar permisos mínimos de Cloud Logging y Monitoring sin exponer
# credenciales de propietario/editor del proyecto.
# ==============================================================================
resource "google_service_account" "dev_vm_sa" {
  account_id   = "dev-vm-sa"
  display_name = "Dev VM Host Service Account (trade-functions)"
  description  = "Cuenta de servicio dedicada para la VM de desarrollo y agente Antigravity CLI"
}

# Permiso para enviar logs a Cloud Logging (Gratis hasta 50 GB / mes de logs)
resource "google_project_iam_member" "logging_writer" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.dev_vm_sa.email}"
}

# Permiso para registrar métricas básicas de CPU y memoria en Cloud Monitoring (Gratis)
resource "google_project_iam_member" "monitoring_writer" {
  project = var.project_id
  role    = "roles/monitoring.metricWriter"
  member  = "serviceAccount:${google_service_account.dev_vm_sa.email}"
}

# ==============================================================================
# REGLA DE FIREWALL: ACCESO SSH
# ==============================================================================
# COSTO DE ESTE RECURSO: $0.00 USD (Las reglas de firewall en VPC son gratuitas)
# Permite conectar directamente por SSH (puerto 22) o a través del túnel IAP de GCP.
# ==============================================================================
resource "google_compute_firewall" "allow_ssh_dev" {
  name        = "allow-ssh-dev-vm"
  network     = var.network
  description = "Permite acceso SSH al host de desarrollo para terminales moviles y escritorio"

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }

  # Por defecto permite conexión directa. También incluye el rango oficial de Google IAP (35.235.240.0/20)
  source_ranges = distinct(concat(var.allowed_ssh_cidrs, ["35.235.240.0/20"]))
  target_tags   = ["dev-vm"]
}

# ==============================================================================
# INSTANCIA COMPUTE ENGINE: HOST DE DESARROLLO Y AGENTE ANTIGRAVITY
# ==============================================================================
resource "google_compute_instance" "dev_host" {
  name         = var.instance_name
  machine_type = var.machine_type
  zone         = var.zone
  tags         = ["dev-vm"]

  # ----------------------------------------------------------------------------
  # DETALLE DE COSTOS - TIPO DE MÁQUINA (CÓMPUTO vCPU Y MEMORIA):
  # ----------------------------------------------------------------------------
  # * Máquina 'e2-standard-2' (2 vCPUs, 8 GB de RAM):
  #     - ENCENDIDA (RUNNING): ~$0.067011 USD / hora (~$1.61 USD / día).
  #     - APAGADA (TERMINATED): $0.000000 USD / hora.
  # * Alternativa 'e2-medium' (2 vCPUs burstable, 4 GB de RAM):
  #     - ENCENDIDA (RUNNING): ~$0.033506 USD / hora (~$0.80 USD / día).
  #     - APAGADA (TERMINATED): $0.000000 USD / hora.
  # * Nota de ahorro móvil: Al terminar tu sesión de trabajo o agente, apaga la VM
  #   desde la app móvil de Google Cloud en tu teléfono y el costo de cómputo cesa de inmediato.
  # ----------------------------------------------------------------------------

  # ----------------------------------------------------------------------------
  # DETALLE DE COSTOS - DISCO PERSISTENTE DE ARRANQUE (BOOT DISK):
  # ----------------------------------------------------------------------------
  # * Tipo: 'pd-balanced' (Balanced Persistent Disk SSD).
  # * Tamaño: 50 GB.
  # * Tasa en us-central1: ~$0.10 USD por GB al mes.
  # * Costo mensual del disco: 50 GB * $0.10 = $5.00 USD / mes (~$0.164 USD / día).
  # * ¡IMPORTANTE!: Este costo es FIJO y CONTINUO. Se cobra exactamente igual
  #   si la máquina está encendida o apagada, porque los 50 GB de almacenamiento
  #   físico siguen reservados conservando tus archivos ~/trade-functions,
  #   ~/btc-research y dependencias npm intactos.
  # ----------------------------------------------------------------------------
  boot_disk {
    auto_delete = false # Evita borrado accidental de código si la instancia se destruye

    initialize_params {
      image = var.boot_image
      size  = var.disk_size_gb
      type  = var.disk_type
      labels = {
        environment = "dev"
        workload    = "trade-dev-host"
      }
    }
  }

  # ----------------------------------------------------------------------------
  # DETALLE DE COSTOS - RED E IP PÚBLICA:
  # ----------------------------------------------------------------------------
  # * Asignamos una Dirección IP Externa EFÍMERA (no estática):
  #     - ENCENDIDA (RUNNING): ~$0.0050 USD / hora (~$0.12 USD / día).
  #     - APAGADA (TERMINATED): $0.0000 USD / hora. Al apagar la VM, Google libera
  #       la IP efímera hacia su pool global, por lo que NO hay cobros por IP inactiva.
  # * ¿Por qué NO usamos IP Estática Reservada?:
  #     - Google cobra una penalización de $0.010 USD / hora (~$7.30 USD / mes)
  #       por cada IP estática reservada que esté sin usar o asociada a una VM apagada.
  #       Usar IP efímera garantiza pagar $0 cuando la máquina no se usa.
  # * Tráfico de red saliente (Egress a Internet):
  #     - Primer 1 GB / mes es GRATIS. Tráfico adicional: ~$0.12 USD / GB.
  #     - Tráfico de red entrante (Ingress): 100% GRATIS.
  # ----------------------------------------------------------------------------
  network_interface {
    network    = var.network
    subnetwork = var.subnetwork

    dynamic "access_config" {
      for_each = var.enable_public_ip ? [1] : []
      content {
        # Dejar 'nat_ip' nulo asigna automáticamente una IP efímera que se destruye al apagar la VM
      }
    }
  }

  # ----------------------------------------------------------------------------
  # METADATOS Y AUTOMATIZACIÓN DE ARRANQUE:
  # ----------------------------------------------------------------------------
  # * 'enable-oslogin = TRUE': Permite conectar desde la app móvil o terminal sin
  #   tener que lidiar con llaves SSH manuales, usando tu cuenta de Google.
  # * 'startup-script': Script idempotente que se ejecuta en CADA encendido (primer arranque
  #   y cada vez que se presiona "Iniciar" en el teléfono móvil):
  #     1. Crea ~/trade-functions y ~/btc-research.
  #     2. Instala dependencias base (Node.js 22, Git, tmux, Tailscale, gcloud).
  #     3. Activa automáticamente la sesión persistente de Antigravity CLI ('agy') en tmux.
  # ----------------------------------------------------------------------------
  metadata = {
    enable-oslogin = "TRUE"
    startup-script = templatefile("${path.module}/startup.sh", {
      dev_username = var.dev_username
    })
  }

  # Configuración de cuenta de servicio y alcances de API
  service_account {
    email  = google_service_account.dev_vm_sa.email
    scopes = ["cloud-platform"]
  }

  # ----------------------------------------------------------------------------
  # POLÍTICA DE PROGRAMACIÓN (SCHEDULING):
  # Instancia On-Demand estándar (no preemptible / no spot) para asegurar que Google
  # no interrumpa tus ejecuciones de agentes o compilaciones inesperadamente mientras programas.
  # ----------------------------------------------------------------------------
  scheduling {
    preemptible         = false
    automatic_restart   = true
    on_host_maintenance = "MIGRATE"
  }

  lifecycle {
    # Protege contra borrado accidental en comandos genéricos
    prevent_destroy = false
  }
}
