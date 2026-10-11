# ==============================================================================
# SALIDAS (OUTPUTS) - INFORMACIÓN DE CONEXIÓN, GESTIÓN MÓVIL Y COSTOS
# ==============================================================================

output "instance_name" {
  description = "Nombre de la instancia de desarrollo en Google Cloud."
  value       = google_compute_instance.dev_host.name
}

output "instance_zone" {
  description = "Zona de Google Cloud donde reside la instancia."
  value       = google_compute_instance.dev_host.zone
}

output "instance_machine_type" {
  description = "Tipo de máquina configurada (vCPU y RAM)."
  value       = google_compute_instance.dev_host.machine_type
}

output "instance_external_ip" {
  description = "Dirección IP pública efímera asignada dinámicamente cuando la VM está encendida ($0 mientras esté apagada)."
  value       = try(google_compute_instance.dev_host.network_interface[0].access_config[0].nat_ip, "Sin IP publica asignada")
}

output "workspace_directories" {
  description = "Carpetas creadas automáticamente en el home de la máquina en cada encendido."
  value = [
    "~/trade-functions",
    "~/btc-research"
  ]
}

output "gcloud_start_command" {
  description = "Comando rápido para encender la VM desde la terminal de tu laptop o gcloud móvil."
  value       = "gcloud compute instances start ${google_compute_instance.dev_host.name} --zone ${google_compute_instance.dev_host.zone} --project ${var.project_id}"
}

output "gcloud_stop_command" {
  description = "Comando rápido para apagar la VM y congelar los cargos de cómputo a $0."
  value       = "gcloud compute instances stop ${google_compute_instance.dev_host.name} --zone ${google_compute_instance.dev_host.zone} --project ${var.project_id}"
}

output "ssh_connection_command" {
  description = "Comando para conectarte por SSH a la VM mediante Google Cloud OS Login."
  value       = "gcloud compute ssh ${google_compute_instance.dev_host.name} --zone ${google_compute_instance.dev_host.zone} --project ${var.project_id}"
}

output "ssh_iap_tunnel_command" {
  description = "Comando para conectar vía IAP (sin necesidad de IP pública ni abrir puertos de internet)."
  value       = "gcloud compute ssh ${google_compute_instance.dev_host.name} --zone ${google_compute_instance.dev_host.zone} --project ${var.project_id} --tunnel-through-iap"
}

output "antigravity_cli_attach_command" {
  description = "Comando universal para retomar la sesión persistente de Antigravity CLI (compatible con OS Login y socket compartido)."
  value       = "agy-attach"
}

output "cost_projection" {
  description = "Resumen de costos estimados dinámicos para control presupuestario según la configuración elegida."
  value = {
    region                   = var.region
    machine_type             = var.machine_type
    disk_size_gb             = var.disk_size_gb
    fixed_monthly_disk_usd   = tonumber(format("%.2f", var.disk_size_gb * (startswith(var.region, "southamerica") ? 0.15 : 0.10)))
    hourly_compute_usd       = var.machine_type == "e2-medium" ? (startswith(var.region, "southamerica") ? 0.0503 : 0.0335) : (startswith(var.region, "southamerica") ? 0.1005 : 0.0670)
    hourly_ephemeral_ip_usd  = var.enable_public_ip ? 0.0050 : 0.0000
    hourly_running_total_usd = tonumber(format("%.4f", (var.machine_type == "e2-medium" ? (startswith(var.region, "southamerica") ? 0.0503 : 0.0335) : (startswith(var.region, "southamerica") ? 0.1005 : 0.0670)) + (var.enable_public_ip ? 0.0050 : 0.0000)))
    hourly_stopped_usd       = 0.0000
    estimated_60h_mo_usd     = tonumber(format("%.2f", (var.disk_size_gb * (startswith(var.region, "southamerica") ? 0.15 : 0.10)) + (((var.machine_type == "e2-medium" ? (startswith(var.region, "southamerica") ? 0.0503 : 0.0335) : (startswith(var.region, "southamerica") ? 0.1005 : 0.0670)) + (var.enable_public_ip ? 0.0050 : 0.0000)) * 60)))
    continuous_24x7_mo_usd   = tonumber(format("%.2f", (var.disk_size_gb * (startswith(var.region, "southamerica") ? 0.15 : 0.10)) + (((var.machine_type == "e2-medium" ? (startswith(var.region, "southamerica") ? 0.0503 : 0.0335) : (startswith(var.region, "southamerica") ? 0.1005 : 0.0670)) + (var.enable_public_ip ? 0.0050 : 0.0000)) * 730)))
  }
}
