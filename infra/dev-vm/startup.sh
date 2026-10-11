#!/usr/bin/env bash
# ==============================================================================
# SCRIPT DE INICIALIZACIÓN Y ARRANQUE AUTOMÁTICO (Compute Engine Startup Script)
# ==============================================================================
# Este script se ejecuta con permisos de root en CADA encendido de la máquina virtual
# (tanto en el primer arranque como en cada reanudación desde la consola o app móvil).
# ==============================================================================

set -euo pipefail

LOG_FILE="/var/log/dev-vm-startup.log"
exec > >(tee -a "$LOG_FILE") 2>&1

echo "======================================================================"
echo "[$(date -u --rfc-3339=seconds)] Iniciando secuencia de arranque Dev VM"
echo "======================================================================"

DEV_USER="${dev_username}"
FLAG_FIRST_BOOT="/var/log/dev-vm-initialized.flag"

# ------------------------------------------------------------------------------
# 1. Crear usuario de desarrollo si no existe
# ------------------------------------------------------------------------------
if ! id "$DEV_USER" &>/dev/null; then
    echo "[INFO] Creando usuario del sistema: $DEV_USER"
    useradd -m -s /bin/bash -G sudo "$DEV_USER"
    echo "$DEV_USER ALL=(ALL) NOPASSWD:ALL" > "/etc/sudoers.d/99-$DEV_USER"
    chmod 0440 "/etc/sudoers.d/99-$DEV_USER"
fi

DEV_HOME=$(eval echo "~$DEV_USER")

# ------------------------------------------------------------------------------
# 2. Configurar /etc/skel y /etc/profile.d para usuarios nuevos y existentes
#    (Garantiza compatibilidad total con Google Cloud OS Login y terminales móviles)
# ------------------------------------------------------------------------------
mkdir -p /etc/skel/trade-functions
mkdir -p /etc/skel/btc-research

cat >> /etc/skel/.bashrc << 'SKEL_EOF'

# --- Antigravity Dev Environment Aliases ---
export PATH="$HOME/.npm-global/bin:/usr/local/bin:$PATH"
alias agy-attach="/usr/local/bin/agy-attach"
alias dev="/usr/local/bin/agy-attach"
SKEL_EOF

# Configuración global en /etc/profile.d/ para que cualquier usuario (OS Login / dev)
# tenga acceso inmediato a las carpetas, paths y aliases al abrir sesión SSH.
cat > /etc/profile.d/antigravity.sh << 'PROFILE_EOF'
# Entorno global para Antigravity Dev VM
export PATH="$HOME/.npm-global/bin:/usr/local/bin:$PATH"

alias agy-attach="/usr/local/bin/agy-attach"
alias dev="/usr/local/bin/agy-attach"

# Garantizar existencia de las carpetas de trabajo en el home de la sesión activa
if [ -n "$HOME" ] && [ "$HOME" != "/root" ]; then
    mkdir -p "$HOME/trade-functions" "$HOME/btc-research" 2>/dev/null || true
fi
PROFILE_EOF
chmod 644 /etc/profile.d/antigravity.sh

# ------------------------------------------------------------------------------
# 3. Instalación de Prerrequisitos (Solo se ejecuta en el PRIMER arranque)
# ------------------------------------------------------------------------------
if [ ! -f "$FLAG_FIRST_BOOT" ]; then
    echo "[FASE 1] Primer arranque detectado: Instalando dependencias base..."
    export DEBIAN_FRONTEND=noninteractive

    # Actualización de repositorios y paquetes esenciales
    apt-get update -y
    apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        wget \
        gnupg \
        git \
        tmux \
        htop \
        jq \
        unzip \
        build-essential \
        python3 \
        python3-pip

    # Instalación de Node.js 22 LTS (NodeSource)
    if ! command -v node &>/dev/null || [[ "$(node -v)" != v22* ]]; then
        echo "[INFO] Instalando Node.js 22 LTS..."
        mkdir -p /etc/apt/keyrings
        curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
        echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
        apt-get update -y
        apt-get install -y nodejs
        echo "[INFO] Node.js $(node -v) y npm $(npm -v) instalados exitosamente."
    fi

    # Configuración de directorio global de npm sin sudo para el dev user
    su - "$DEV_USER" -c "mkdir -p ~/.npm-global && npm config set prefix '~/.npm-global'"

    # Instalación de Google Cloud CLI (gcloud) para scripts y automatización en la VM
    if ! command -v gcloud &>/dev/null; then
        echo "[INFO] Instalando Google Cloud CLI..."
        mkdir -p /etc/apt/keyrings
        curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg | gpg --dearmor --yes -o /etc/apt/keyrings/cloud.google.gpg
        echo "deb [signed-by=/etc/apt/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" > /etc/apt/sources.list.d/google-cloud-sdk.list
        apt-get update -y
        apt-get install -y google-cloud-cli || echo "[WARN] google-cloud-cli continuará usando cliente del sistema."
    fi

    # Instalación de Tailscale (red privada segura para conexión desde móvil sin exponer SSH a internet)
    if ! command -v tailscale &>/dev/null; then
        echo "[INFO] Instalando Tailscale..."
        curl -fsSL https://tailscale.com/install.sh | sh || echo "[WARN] Tailscale no pudo descargarse automáticamente."
        systemctl enable --now tailscaled || true
    fi

    # Script lanzador interactivo de Antigravity CLI
    cat > /usr/local/bin/agy-autostart.sh << 'LAUNCHER_EOF'
#!/usr/bin/env bash
# Lanzador interactivo de sesión Antigravity CLI
cd "$HOME/trade-functions" 2>/dev/null || cd "$HOME"

echo "========================================================"
echo "    ANTIGRAVITY CLI - ENTORNO DE TRABAJO ACTIVO         "
echo "========================================================"
echo "Sesión iniciada: $(date)"
echo "Directorio actual: $(pwd)"
echo "--------------------------------------------------------"

if command -v agy &>/dev/null; then
    echo "[INFO] Iniciando Antigravity CLI (agy)..."
    agy || true
elif command -v antigravity &>/dev/null; then
    echo "[INFO] Iniciando Antigravity CLI (antigravity)..."
    antigravity || true
elif [ -f "$HOME/.npm-global/bin/agy" ]; then
    echo "[INFO] Iniciando Antigravity CLI desde ~/.npm-global/bin/agy..."
    "$HOME/.npm-global/bin/agy" || true
else
    echo "[AVISO] El comando 'agy' aún no está instalado en PATH o requiere vinculación inicial."
    echo ""
    echo "Pasos rápidos para activar tu CLI:"
    echo "  1. Si usas paquete npm: npm install -g @google/antigravity (o nombre correspondiente)"
    echo "  2. O copia/enlaza tu binario a /usr/local/bin/agy"
    echo "  3. Para reanudar esta sesión desde tu móvil: agy-attach"
    echo ""
    echo "Carpetas listas para desarrollo:"
    echo "  - ~/trade-functions (Activa)"
    echo "  - ~/btc-research"
    echo "--------------------------------------------------------"
fi

# Mantiene siempre la consola interactiva abierta para evitar que la sesión de tmux termine
exec bash -i
LAUNCHER_EOF
    chmod +x /usr/local/bin/agy-autostart.sh

    # Script conector universal para terminales móviles y SSH (soporta socket compartido y OS Login)
    cat > /usr/local/bin/agy-attach << 'ATTACH_EOF'
#!/usr/bin/env bash
SOCKET="/run/antigravity/tmux.sock"
if [ -S "$SOCKET" ]; then
    exec /usr/bin/tmux -S "$SOCKET" attach-session -t antigravity "$@"
elif /usr/bin/tmux has-session -t antigravity 2>/dev/null; then
    exec /usr/bin/tmux attach-session -t antigravity "$@"
else
    echo "[INFO] No se encontró una sesión activa de Antigravity; iniciando nueva..."
    cd "$HOME/trade-functions" 2>/dev/null || cd "$HOME"
    exec /usr/bin/tmux new-session -s antigravity "/usr/local/bin/agy-autostart.sh"
fi
ATTACH_EOF
    chmod +x /usr/local/bin/agy-attach

    # Crear directorio para socket compartido accesible por cualquier usuario de login
    mkdir -p -m 0777 /run/antigravity

    # Creación del servicio Systemd para mantener la sesión de tmux persistente en cada arranque
    cat > /etc/systemd/system/antigravity.service << SERVICE_EOF
[Unit]
Description=Antigravity CLI Persistent Tmux Session
After=network.target network-online.target
Wants=network-online.target

[Service]
Type=forking
User=${dev_username}
RuntimeDirectory=antigravity
RuntimeDirectoryMode=0777
WorkingDirectory=/home/${dev_username}/trade-functions
Environment=HOME=/home/${dev_username}
Environment=PATH=/home/${dev_username}/.npm-global/bin:/usr/local/bin:/usr/bin:/bin
ExecStartPre=/bin/mkdir -p -m 0777 /run/antigravity
ExecStart=/usr/bin/tmux -S /run/antigravity/tmux.sock new-session -d -s antigravity -c /home/${dev_username}/trade-functions "/usr/local/bin/agy-autostart.sh"
ExecStartPost=/bin/chmod 666 /run/antigravity/tmux.sock
ExecStop=-/usr/bin/tmux -S /run/antigravity/tmux.sock kill-session -t antigravity
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
SERVICE_EOF

    systemctl daemon-reload
    systemctl enable antigravity.service

    touch "$FLAG_FIRST_BOOT"
    echo "[FASE 1] Inicialización base completada con éxito."
fi

# ------------------------------------------------------------------------------
# 4. Tareas Recurrentes: Ejecutadas en CADA ENCENDIDO (Boot / Reanudación)
# ------------------------------------------------------------------------------
echo "[FASE 2] Verificando carpetas y activando Antigravity CLI..."

# Función auxiliar para inicializar las carpetas en el home de un usuario
setup_user_directories() {
    local TARGET_USER="$1"
    local TARGET_HOME
    TARGET_HOME=$(eval echo "~$TARGET_USER")

    if [ -d "$TARGET_HOME" ]; then
        # Crear carpetas requeridas ~/trade-functions y ~/btc-research
        mkdir -p "$TARGET_HOME/trade-functions"
        mkdir -p "$TARGET_HOME/btc-research"

        # Configurar variables de entorno y aliases en .bashrc si no están presentes
        if ! grep -q "agy-attach" "$TARGET_HOME/.bashrc" 2>/dev/null; then
            cat >> "$TARGET_HOME/.bashrc" << 'BASHRC_USER'

# --- Antigravity Dev Environment Aliases ---
export PATH="$HOME/.npm-global/bin:/usr/local/bin:$PATH"
alias agy-attach="/usr/local/bin/agy-attach"
alias dev="/usr/local/bin/agy-attach"
BASHRC_USER
        fi

        # Permisos correctos usando el grupo primario dinámico (evita fallo en usuarios OS Login)
        local PRIMARY_GROUP
        PRIMARY_GROUP=$(id -gn "$TARGET_USER" 2>/dev/null || echo "$TARGET_USER")
        chown -R "$TARGET_USER:$PRIMARY_GROUP" "$TARGET_HOME/trade-functions" "$TARGET_HOME/btc-research" "$TARGET_HOME/.bashrc" 2>/dev/null || true
        echo "[INFO] Carpetas verificadas para usuario: $TARGET_USER"
    fi
}

# Aplicar carpetas al dev_user configurado
setup_user_directories "$DEV_USER"

# Aplicar carpetas también a cualquier usuario que ya exista en /home (ej. usuarios creados por OS Login de Google)
for user_dir in /home/*; do
    if [ -d "$user_dir" ]; then
        u=$(basename "$user_dir")
        if id "$u" &>/dev/null && [ "$u" != "$DEV_USER" ]; then
            setup_user_directories "$u"
        fi
    fi
done

# ------------------------------------------------------------------------------
# 5. Asegurar Activación Automática de Antigravity CLI en Tmux
# ------------------------------------------------------------------------------
echo "[INFO] Asegurando que la sesión tmux 'antigravity' esté activa..."

# Asegurar que el directorio de sockets compartido exista en tmpfs
mkdir -p -m 0777 /run/antigravity

# Verificar y arrancar el servicio systemd si no está activo
if systemctl is-enabled antigravity.service &>/dev/null; then
    if ! systemctl is-active --quiet antigravity.service; then
        echo "[INFO] Iniciando antigravity.service..."
        systemctl start antigravity.service || true
    fi
fi

# Asegurar permisos de lectura/escritura en el socket compartido
if [ -S /run/antigravity/tmux.sock ]; then
    chmod 666 /run/antigravity/tmux.sock 2>/dev/null || true
fi

# Verificación de respaldo directa con tmux bajo DEV_USER usando socket compartido
if ! su - "$DEV_USER" -c "tmux -S /run/antigravity/tmux.sock has-session -t antigravity 2>/dev/null"; then
    echo "[INFO] Sesión de tmux no detectada; lanzándola con socket compartido..."
    su - "$DEV_USER" -c "tmux -S /run/antigravity/tmux.sock new-session -d -s antigravity -c $DEV_HOME/trade-functions '/usr/local/bin/agy-autostart.sh'"
    chmod 666 /run/antigravity/tmux.sock 2>/dev/null || true
fi

echo "======================================================================"
echo "[$(date -u --rfc-3339=seconds)] VM lista. Sesión Antigravity CLI corriendo en tmux."
echo "Para conectarse desde móvil o terminal: agy-attach"
echo "======================================================================"
