#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Emma AI — Installation Script
# Installs all dependencies, sets up infrastructure, and starts all services.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

EMMA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log_info()  { echo -e "${CYAN}[emma]${NC} $*"; }
log_ok()    { echo -e "${GREEN}[✓]${NC} $*"; }
log_warn()  { echo -e "${YELLOW}[!]${NC} $*"; }
log_error() { echo -e "${RED}[✗]${NC} $*" >&2; }

# ── 1. Node.js 20+ ────────────────────────────────────────────────────────────
log_info "Checking Node.js..."

NEED_NODE=false
if command -v node &>/dev/null; then
  NODE_VERSION=$(node --version | sed 's/v//' | cut -d. -f1)
  if [ "$NODE_VERSION" -ge 20 ]; then
    log_ok "Node.js $(node --version) already installed"
  else
    log_warn "Node.js $(node --version) is too old — need 20+. Installing via nvm..."
    NEED_NODE=true
  fi
else
  log_warn "Node.js not found — installing via nvm..."
  NEED_NODE=true
fi

if [ "$NEED_NODE" = true ]; then
  # Install nvm if not present
  if ! command -v nvm &>/dev/null && [ ! -f "$HOME/.nvm/nvm.sh" ]; then
    log_info "Installing nvm..."
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
  fi
  # shellcheck disable=SC1090
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"
  nvm install 20
  nvm use 20
  nvm alias default 20
  log_ok "Node.js $(node --version) installed via nvm"
fi

# ── 2. pnpm ──────────────────────────────────────────────────────────────────
log_info "Checking pnpm..."
if command -v pnpm &>/dev/null; then
  log_ok "pnpm $(pnpm --version) already installed"
else
  log_info "Installing pnpm..."
  npm install -g pnpm
  log_ok "pnpm $(pnpm --version) installed"
fi

# ── 3. Docker ─────────────────────────────────────────────────────────────────
log_info "Checking Docker..."
if command -v docker &>/dev/null; then
  log_ok "Docker $(docker --version | cut -d' ' -f3 | tr -d ',') already installed"
else
  log_warn "Docker not found — installing..."
  if command -v apt-get &>/dev/null; then
    sudo apt-get update -qq
    sudo apt-get install -y -qq ca-certificates curl gnupg
    sudo install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    sudo chmod a+r /etc/apt/keyrings/docker.gpg
    # shellcheck disable=SC1091
    . /etc/os-release
    echo \
      "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
      $VERSION_CODENAME stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
    sudo apt-get update -qq
    sudo apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin
    sudo usermod -aG docker "$USER"
    log_ok "Docker installed. Note: you may need to log out and back in for group changes to take effect."
  else
    log_error "Auto-install only supports apt-based systems. Please install Docker manually: https://docs.docker.com/get-docker/"
    exit 1
  fi
fi

# Docker Compose (v2 plugin)
if ! docker compose version &>/dev/null 2>&1; then
  if command -v docker-compose &>/dev/null; then
    log_warn "Using legacy docker-compose — docker compose v2 plugin is preferred"
    DOCKER_COMPOSE="docker-compose"
  else
    log_error "docker compose / docker-compose not found. Please install Docker Compose v2."
    exit 1
  fi
else
  DOCKER_COMPOSE="docker compose"
  log_ok "Docker Compose $(docker compose version --short) available"
fi

# ── 4. Ollama ─────────────────────────────────────────────────────────────────
log_info "Checking Ollama..."
if command -v ollama &>/dev/null; then
  log_ok "Ollama already installed"
else
  log_info "Installing Ollama..."
  curl -fsSL https://ollama.ai/install.sh | sh
  log_ok "Ollama installed"
fi

# Start Ollama server in background if not running
if ! curl -s http://localhost:11434/api/version &>/dev/null; then
  log_info "Starting Ollama server..."
  ollama serve &>/tmp/ollama.log &
  OLLAMA_PID=$!
  log_info "Waiting for Ollama to start..."
  for i in $(seq 1 15); do
    if curl -s http://localhost:11434/api/version &>/dev/null; then
      log_ok "Ollama server running (PID $OLLAMA_PID)"
      break
    fi
    sleep 2
  done
fi

# ── 5. Pull Ollama model ───────────────────────────────────────────────────────
log_info "Pulling Ollama model llama3.2:latest..."
ollama pull llama3.2:latest
log_ok "llama3.2:latest pulled"

# ── 6. Install npm dependencies and build ─────────────────────────────────────
log_info "Installing npm dependencies..."
cd "$EMMA_DIR"

# Create .env from template on first install (keys are configured later via the web UI)
if [ ! -f "$EMMA_DIR/.env" ] && [ -f "$EMMA_DIR/.env.example" ]; then
  cp "$EMMA_DIR/.env.example" "$EMMA_DIR/.env"
  JWT_SECRET=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
  sed -i "s/^JWT_SECRET=.*/JWT_SECRET=$JWT_SECRET/" "$EMMA_DIR/.env"
  log_ok ".env created from template (JWT secret generated)"
fi

pnpm install
log_ok "Dependencies installed"

log_info "Building all packages..."
pnpm build
log_ok "Build complete"

# ── 7. Start Docker infrastructure (postgres + redis) ─────────────────────────
log_info "Starting Docker infrastructure (PostgreSQL + Redis)..."
cd "$EMMA_DIR"

COMPOSE_FILE="docker-compose.yml"
if [ -f "docker-compose.dev.yml" ]; then
  COMPOSE_FILE="docker-compose.dev.yml"
fi

$DOCKER_COMPOSE -f "$COMPOSE_FILE" up -d --remove-orphans
log_info "Waiting for PostgreSQL to be ready..."
for i in $(seq 1 30); do
  if $DOCKER_COMPOSE -f "$COMPOSE_FILE" exec -T postgres pg_isready -U emma &>/dev/null 2>&1; then
    log_ok "PostgreSQL ready"
    break
  fi
  sleep 2
done

log_ok "Infrastructure running"

# ── 8. Start Emma services ────────────────────────────────────────────────────
log_info "Starting Emma services..."

# Kill any existing Emma processes
pkill -f "apps/agent/dist/index.js" 2>/dev/null || true
pkill -f "apps/gateway/dist/index.js" 2>/dev/null || true
pkill -f "apps/telegram/dist/index.js" 2>/dev/null || true
sleep 2

mkdir -p /tmp/emma

log_info "Starting Gateway (port 3000)..."
node --env-file="$EMMA_DIR/.env" "$EMMA_DIR/apps/gateway/dist/index.js" \
  >/tmp/emma/gateway.log 2>&1 &
GATEWAY_PID=$!
sleep 2

log_info "Starting Agent (port 3001)..."
node --env-file="$EMMA_DIR/.env" "$EMMA_DIR/apps/agent/dist/index.js" \
  >/tmp/emma/agent.log 2>&1 &
AGENT_PID=$!
sleep 3

log_info "Starting Telegram bot..."
node --env-file="$EMMA_DIR/.env" "$EMMA_DIR/apps/telegram/dist/index.js" \
  >/tmp/emma/telegram.log 2>&1 &
TELEGRAM_PID=$!
sleep 2

log_info "Starting Web UI (port 5173)..."
(cd "$EMMA_DIR/apps/web" && nohup pnpm dev >/tmp/emma/web.log 2>&1 &)
sleep 3

# Verify services are up
SERVICES_OK=true
if ! curl -s http://localhost:3001/health &>/dev/null; then
  log_warn "Agent health check failed — check /tmp/emma/agent.log"
  SERVICES_OK=false
fi
if ! curl -s http://localhost:3000/health &>/dev/null; then
  log_warn "Gateway health check failed — check /tmp/emma/gateway.log"
  SERVICES_OK=false
fi

if [ "$SERVICES_OK" = true ]; then
  log_ok "All services running"
fi

# ── 9. Open the web onboarding ────────────────────────────────────────────────
WEB_URL="http://localhost:5173"
if command -v xdg-open &>/dev/null; then
  xdg-open "$WEB_URL" >/dev/null 2>&1 || true
elif command -v open &>/dev/null; then
  open "$WEB_URL" >/dev/null 2>&1 || true
fi

# ── 10. Post-install instructions ────────────────────────────────────────────
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  Emma AI — Installation Complete${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "  Services running:"
echo "    Web UI   → $WEB_URL"
echo "    Gateway  → http://localhost:3000"
echo "    Agent    → http://localhost:3001"
echo ""
echo "  Logs: /tmp/emma/{web,gateway,agent,telegram}.log"
echo ""
echo -e "${YELLOW}  Next steps:${NC}"
echo ""
echo "  1. The web UI should have opened in your browser: $WEB_URL"
echo "  2. Go to the «Integraciones» page and add your API keys:"
echo "     - OpenRouter or Groq (free LLM) — required to chat"
echo "     - Telegram bot token — to chat from your phone"
echo "     - Voyage AI, Gmail — optional extras"
echo "  3. Affected services restart automatically when you save a key."
echo "  4. Without any key, Emma falls back to local Ollama."
echo ""
echo -e "${CYAN}  Everything is stored locally in ${EMMA_DIR}/.env${NC}"
echo ""
