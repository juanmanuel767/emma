<div align="center">

# 🐝 EMMA

### Tu asistente personal de IA — privado, local y con voluntad propia

*Una plataforma de agentes inteligentes al estilo JARVIS: habla, ve, recuerda, actúa y se mejora a sí misma.*

[![TypeScript](https://img.shields.io/badge/TypeScript-monorepo-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/Node-20+-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-workspace-F69220?logo=pnpm&logoColor=white)](https://pnpm.io/)
[![License](https://img.shields.io/badge/license-Propietaria-red.svg)](LICENSE)

</div>

---

## ✨ ¿Qué es Emma?

**Emma** es un asistente personal de inteligencia artificial que corre **en tu propia máquina**. No es un chatbot más: es una plataforma de agentes con interfaces de **Telegram** y **web**, memoria que aprende de ti, voz natural, visión, y la capacidad de **fabricarse sus propias herramientas** cuando le falta una.

Inspirada en JARVIS, te trata con cortesía, se anticipa a tus necesidades y mantiene tus datos donde deben estar: contigo.

## 🚀 Características

- 🧠 **Memoria que aprende** — recuerda tus preferencias, personas y proyectos entre conversaciones (pgvector + perfil persistente).
- 💬 **Doble interfaz** — chatea por **Telegram** o por la **web**, con streaming en tiempo real.
- 🗣️ **Voz natural** — responde con voz (Piper TTS) y entiende notas de voz (Whisper).
- 👁️ **Visión** — analiza imágenes y puede ver por la cámara.
- 📱 **WhatsApp** — lee y responde tus chats bajo demanda, te avisa de mensajes importantes y filtra el ruido.
- ⚡ **Motor multi-proveedor con failover** — encadena modelos gratuitos (Groq, OpenRouter, OpenCode Zen, Ollama) y enruta las tareas difíciles a Claude si tienes clave. Si uno cae, sigue con el siguiente — nunca se rompe.
- 🛠️ **Auto-mejora** — cuando le pides algo para lo que no tiene herramienta, **se la forja en caliente** y la usa al instante.
- 🛡️ **Ciberseguridad defensiva** — detecta phishing, audita sistemas, verifica brechas de contraseñas e **inspecciona skills de terceros antes de instalarlas**.
- 📅 **Proactividad** — informe matutino automático con tu correo, agenda y clima.
- 🔧 **Autogestión** — se reinicia, revisa su estado y diagnostica sus propios servicios desde el chat.

## 🏗️ Arquitectura

```
web / telegram  ──▶  gateway (:3000, SSE)  ──▶  agent (:3001)  ──▶  LLMProviderManager  ──▶  proveedor LLM
                                                      │
                                          memoria (pgvector) · skills · tools
```

Monorepo pnpm con capas hexagonales (`domain` → `application` → `infrastructure` → `interface`):

| Workspace | Rol |
|-----------|-----|
| `apps/agent` | El cerebro: bucle ReAct, memoria, forja de herramientas |
| `apps/gateway` | Proxy SSE + API REST + onboarding |
| `apps/telegram` | Bot de Telegram (grammY) |
| `apps/web` | Interfaz web (React 19 + Vite + Tailwind) |
| `packages/memory` | Memoria semántica (Drizzle + pgvector + embeddings) |
| `packages/skills` | Forja de habilidades en runtime |
| `packages/tools` | Herramientas de sistema (comandos, email, navegador, archivos) |

## ⚙️ Instalación

### 🟢 Funciona sin ninguna clave

Emma usa **Ollama** (modelos de IA locales y gratuitos) por defecto. **No necesitas registrarte ni configurar nada.** El instalador lo prepara todo:

```bash
./install.sh
```

Esto instala Ollama, descarga el modelo, levanta Postgres + Redis, crea tu `.env` y arranca Emma. Abre **http://localhost:5173** y ya puedes hablar con ella. 🎉

### Instalación manual

```bash
pnpm install
docker compose -f docker-compose.dev.yml up -d
ollama pull llama3.2:latest        # cerebro local gratuito
cp .env.example .env               # ya viene listo para Ollama
pnpm build && pnpm dev
```

> 💡 **¿Quieres más velocidad?** Añade una clave gratuita de Groq, OpenRouter u OpenCode (opcional) — desde la web o pegándola en el chat, y Emma se configura sola sin que pase por ningún modelo. Pero **sin claves también funciona.**

## 🔑 Configuración

Las claves van en `.env` (copia `.env.example`). Casi todas son **opcionales** — Emma funciona con modelos gratuitos por defecto:

- `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `OPENCODE_API_KEY` — modelos LLM gratuitos
- `ANTHROPIC_API_KEY` — Claude para tareas difíciles (opcional)
- `TELEGRAM_BOT_TOKEN` — bot de Telegram
- `EMAIL_USER` / `EMAIL_PASSWORD` — correo (App Password de Gmail)
- `DATABASE_URL`, `REDIS_URL` — infraestructura

## 📜 Licencia y propiedad

**© 2026 Juan Manuel Peralta Chacón — Todos los derechos reservados.**

Este proyecto es **propietario**. Emma es propiedad exclusiva de su autor.
**No** está permitido copiar, usar, modificar ni distribuir este software sin
autorización previa y por escrito del autor. Consulta el archivo [LICENSE](LICENSE).

Para solicitar permiso de uso: peraltachaconjuanmanuel5@gmail.com

---

<div align="center">

*"Buenos días, señor. Todos los sistemas operativos. ¿En qué puedo asistirle?"* 🐝

</div>
