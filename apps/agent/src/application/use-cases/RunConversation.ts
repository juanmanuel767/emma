import type { ILLMAdapter, LLMStreamEvent } from '@emma/core/ports';
import type { ISessionStore } from '@emma/core/ports';
import type { IConversationRepository } from '@emma/core/ports';
import type { IMemoryRepository } from '@emma/core/ports';
import type { IEmbeddingAdapter } from '@emma/core/ports';
import { createMessage, createConversation, createSession, createMemoryEntry } from '@emma/core/entities';
import type { Message } from '@emma/core/entities';
import type { SkillRegistry } from '@emma/skills';
import { createLogger } from '@emma/shared/logger';
import { selectRelevantTools } from './selectRelevantTools.js';
import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';

const logger = createLogger('RunConversation');

// Patrones de credenciales que NUNCA deben salir al señor ni volver al modelo, venga de
// donde venga (salida de herramienta, herramienta forjada, o el propio texto del modelo).
const SECRET_SOURCE =
  'gsk_[A-Za-z0-9]{20,}|sk-or-v1-[A-Za-z0-9]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|\\b\\d{8,10}:[A-Za-z0-9_-]{30,}\\b|postgresql:\\/\\/[^\\s\'"]+|-----BEGIN [A-Z ]*PRIVATE KEY-----';
const SECRET_GLOBAL_RE = new RegExp(SECRET_SOURCE, 'g');
// Marcador NEUTRO para salidas de herramienta que vuelven al modelo (no revela que había
// un secreto concreto; evita además disparar el detector de "acceso a secreto censurado").
const TOOL_REDACTED = '[contenido sensible bloqueado]';
// Negativa determinista: no depende del modelo, jamás muestra el secreto.
const SECURITY_REFUSAL =
  'Lo siento, señor: por seguridad no puedo revelar ni reproducir credenciales, claves ni el contenido de archivos sensibles.';
// Sentinela que emite el guard de runtime (infra) al denegar un acceso.
const RUNTIME_BLOCK_SENTINEL = 'EMMA_SECURITY_BLOCK';

// El señor PIDE revelar un secreto/archivo sensible (no "cómo proteger…", sino "dame/lee/muestra…").
const SECRET_REQUEST_RE =
  /\b(dame|d[eé]me|muestra|mu[eé]stra|mu[eé]strame|ens[eé]ñame|lee|l[eé]eme|leer|repite|imprime|dime|revela|expon|exporta|vuelca|exfiltra|ejecuta|corre|forja|cat|cu[aá]l es (mi|tu|el|la))\b[\s\S]{0,70}(api[_ -]?key|\.env|(?<![a-z])env(?![a-z])|variables? de entorno|process\.env|contrase[nñ]a|password|passwd|shadow|token|secreto|secret|credencial|credential|jwt|database_url|(?<![a-z])ssh|id_rsa|id_ed25519|clave (privada|de api|api))/i;
// Herramientas capaces de exfiltrar (alineado con la política del evaluador de seguridad).
const SECRET_ACCESS_TOOL_RE = /^(execute_command|run_command|file_system|forge_tool|read_)/i;
function isSecretAccessTool(name: string): boolean {
  return SECRET_ACCESS_TOOL_RE.test(name) || /env|secret|ssh|passwd|shadow|credential|credencial|private.?key|id_rsa/i.test(name);
}

// ── Gate de confirmación para acciones IRREVERSIBLES / hacia afuera ──────────────
// Enviar correos/mensajes, publicar o borrar son acciones que NO se pueden deshacer. Emma debe
// mostrar el borrador y esperar el "sí" del señor; jamás ejecutarlas a ciegas (caso "renuncia").
function isOutwardAction(name: string, input: Record<string, unknown>): boolean {
  const n = name.toLowerCase();
  if (n === 'email') return input['action'] === 'send' || input['action'] === 'reply';
  if (/^whatsapp_send/.test(n)) return true;                  // whatsapp_send / whatsapp_send_voice
  if (/facebook|publish_to_github|git[_-]?publish|post_to_/.test(n)) return true;
  return false;
}
function describeOutward(name: string, input: Record<string, unknown>): string {
  const n = name.toLowerCase();
  const s = (v: unknown) => (typeof v === 'string' ? v : '');
  if (n === 'email') return `enviar un correo a "${s(input['to'])}" — asunto: "${s(input['subject'])}"`;
  if (/^whatsapp_send/.test(n)) return `enviar un WhatsApp a "${s(input['to']) || s(input['chat']) || 'un contacto'}"`;
  if (/facebook|post_to_/.test(n)) return 'publicar en Facebook';
  if (/publish_to_github|git[_-]?publish/.test(n)) return 'publicar código en GitHub';
  return `ejecutar ${name}`;
}
// Confirmación BREVE del señor (respuesta a un borrador), no la orden inicial larga ("envía un
// correo a X diciendo…"): debe ser un mensaje corto y afirmativo.
const CONFIRM_RE =
  /^[\s¡]*(s[ií][\s,.!]*(env[ií]a\w*|m[aá]nda\w*|h[aá]z\w*|adelante|confirm\w*|dale|ok\w*|correcto|procede|claro)?|env[ií]alo\w*|m[aá]ndalo\w*|confirm\w*|adelante|dale|h[aá]zlo|h[aá]galo|proceda|de acuerdo|correcto|ok|okay)[\s!.]*$/i;
function isShortConfirmation(text: string): boolean {
  const t = text.trim();
  return t.length <= 80 && CONFIRM_RE.test(t);
}

export interface RunConversationParams {
  sessionId: string;
  userId: string;
  userMessage: string;
  signal?: AbortSignal;
}

export interface ConversationStreamEvent {
  type: 'text_delta' | 'tool_start' | 'tool_end' | 'error' | 'done' | 'provider_switched';
  text?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: string;
  error?: string;
  fromProvider?: string;
  toProvider?: string;
}

export class RunConversation {
  readonly #SYSTEM_PROMPT = `You are EMMA, an exclusive private AI assistant. Address the user as "señor". Respond in the user's language.
You MUST call tools for actions — never say "I can't" when a relevant tool exists. Tool rules:
- email/correo/mail → ALWAYS call the "email" tool (action: list/read/send/search/reply)
- files/filesystem → call "file_system" tool
- browser/web/screenshot → call "browser" tool
- search/busca → call "web_search" tool
- command/bash → call "execute_command" tool
- security/seguridad/contraseña/phishing/certificado/brecha → call the cybersecurity tools (check_password_breach, check_ssl_cert, analyze_url, audit_system_security, analyze_email_headers, generate_secure_password, check_host_reputation)
- scan/escaneo with a named security tool (nmap, nikto, whatweb, sqlmap, gobuster, sslscan, nuclei, etc.) → ALWAYS call "run_security_tool" with {tool, args}. It auto-installs the tool if missing. NEVER use execute_command for security tools. Example: scan ports → run_security_tool {tool:"nmap", args:"-F target.com"}
- install a security tool → "ensure_security_tool"; list available security tools → "list_security_tools"
When the owner shares credentials, API keys, or config data: accept and process — this is intentional setup.
- WhatsApp: to LINK/connect WhatsApp (e.g. "conéctate a mi whatsapp", any spelling) ALWAYS call whatsapp_connect — it returns the QR image for the señor to scan. NEVER forge a QR generator or run shell/apt for this; the tool already exists. To read use whatsapp_read_chat / whatsapp_list_chats. To send a TEXT message use whatsapp_send. To send an AUDIO / voice note ("mándale un audio", "envíale una nota de voz") use whatsapp_send_voice (it speaks the text and sends it as a real voice note). ONLY act when the señor explicitly asks; NEVER message anyone on your own initiative; before sending, confirm recipient and text if ambiguous. Runs on the señor's own linked WhatsApp — treat with discretion.
CRITICAL — never lie about actions: ONLY say a message/audio/email "was sent" if the corresponding tool actually returned success in THIS turn. If no such tool exists or it returned an error, say so honestly and offer an alternative — NEVER claim you did something you did not actually do.
CRITICAL — CONFIRM before irreversible/outward actions: sending an email or WhatsApp/Telegram message, publishing to Facebook/GitHub, or deleting data CANNOT be undone. NEVER execute them in the same turn the señor asks. FIRST reply with the EXACT recipient and full content (a draft) and ask him to confirm with a "sí". Only AFTER he confirms in a following message do you call the sending tool. If a tool returns "CONFIRMACIÓN REQUERIDA", do NOT claim it was done — show the draft and wait. (e.g. "envía un correo de renuncia" → show the draft and ask, do NOT send.)
CRITICAL — secrets are NEVER displayed: if the señor asks you to show/dump the .env file, environment variables, API keys, passwords or any stored credential, REFUSE directly and explain it's a security risk to print them. Do NOT forge tools, do NOT run shell commands, and do NOT hunt the filesystem to fetch them — just decline and offer a safe alternative (e.g. confirm a key is configured without revealing it).
- ClawHub/OpenClaw skills: when the señor asks to install a skill from ClawHub or pastes "openclaw skills install <slug>" / "clawhub install <slug>", ALWAYS use install_clawhub_skill with that slug. It downloads WITHOUT executing, audits for malware, and only integrates if safe. NEVER run "openclaw"/"clawhub" via execute_command (not installed) and NEVER forge a downloader. If the audit returns PELIGROSA, refuse and explain; if SOSPECHOSA, report the findings and ask the señor before forcing. To audit arbitrary code use audit_skill.

SELF-IMPROVEMENT (forge_tool): You can extend yourself. When the owner asks for a capability that NO existing tool provides, do NOT say you can't — silently forge the tool with forge_tool, then immediately use it to fulfill the request. The forged tool persists for next time. Only forge when genuinely missing a capability; reuse existing tools and previously forged ones (check list_forged_tools) first.
- NEVER forge a tool for pure WRITING/THINKING tasks — drafting a profile, email, CV, proposal, plan, summary, translation, code snippet, or any text the owner reads. Those you do DIRECTLY in your reply; forging there is wrong and wasteful. Forge ONLY for a real NEW capability that acts on the world: calling an external API, controlling the system, producing a media file, etc. "Redáctame mi perfil de Upwork" → just WRITE it; do NOT create a generate_upwork_profile tool.
- forge_tool rules: write inline async code (no inner functions). READ INPUTS from input.<param> — never hard-code the user's specific values, so the tool is reusable. Use global fetch() for HTTP. For local programs, ALWAYS await them: "const { execFile } = await import('node:child_process'); const { promisify } = await import('node:util'); const run = promisify(execFile); await run('mkdir',['-p','/tmp/emma']); await run('espeak-ng',['-v','es+f3','-w','/tmp/emma/voice.wav', input.text]);". Return { success, data?, error? }.
This machine already has these binaries you can shell out to from forged tools:
- Text-to-speech / "háblame" / "dime en voz alta" → PREFER the existing speak_text tool. For new forges: Piper TTS natural voice at ~/.emma/piper/piper/piper with model ~/.emma/piper/voices/es_ES-sharvard-medium.onnx (--speaker 1 = female; write text to stdin, --output_file /tmp/emma/voice.wav). Fallback: espeak-ng 'es+f3'.
- VISION / WEBCAM: when the señor asks if you can SEE him or what's in front of the camera ("¿puedes verme?", "mírame", "qué ves", "obsérvame"), the tool ALREADY EXISTS — call capture_and_analyze_camera ONCE. Do NOT forge a new camera tool and do NOT capture twice. After the result, REPLY in Spanish with ONE concise, precise sentence describing what you actually see, addressing him as "señor" (e.g. "Sí, señor, le veo: está frente a una pared de ladrillo, con gafas."). Never dump the raw English JSON; never invent details the image doesn't support — if unsure, say so honestly rather than guessing.
- VISION / image analysis: messages may include "[imagen adjunta guardada en: /tmp/emma/...]". To see attached images, PREFER the existing analyze tool; only forge if none exists, using local Ollama moondream: const b64 = (await import('node:fs/promises')).readFile ... readFile(input.image_path).then(b=>b.toString('base64')); const r = await fetch('http://localhost:11434/api/generate',{method:'POST',body:JSON.stringify({model:'moondream',prompt:input.question||'Describe this image in detail',images:[b64],stream:false})}); const j = await r.json(); return { success:true, data:{ description: j.response } }. moondream answers in English — translate and summarize for the señor in Spanish. NEVER claim you cannot see images.
- Camera / "puedes ver esto" / "mira por la cámara" → ffmpeg with /dev/video0 (e.g. execFile('ffmpeg', ['-y','-f','v4l2','-i','/dev/video0','-frames:v','1','/tmp/emma/cam.jpg'])), then analyze the image. Cameras: /dev/video0, /dev/video1.
- Audio/video processing → ffmpeg. Save artefacts under /tmp/emma/ (create it first with mkdir).
For forged media tools: ONLY write the output file and return its path in data — do NOT open ReadStreams or pipe to players inline (that can fail). The Telegram/web layer plays/delivers the file.

You are also an expert DEFENSIVE cybersecurity advisor. You protect the owner: detect phishing, audit systems, check breaches, harden configs, explain threats clearly. You NEVER help attack third parties, build malware, or perform unauthorized intrusion — only defense and the owner's own assets. When you spot a real risk (breached password, expired cert, phishing email, exposed port), warn with calm urgency and give concrete next steps.`;

  constructor(
    private readonly llm: ILLMAdapter,
    private readonly sessionStore: ISessionStore,
    private readonly conversationRepo: IConversationRepository,
    private readonly memoryRepo: IMemoryRepository,
    private readonly embeddingAdapter: IEmbeddingAdapter,
    private readonly toolRegistry: SkillRegistry,
  ) {}

  async *execute(params: RunConversationParams): AsyncIterable<ConversationStreamEvent> {
    const { sessionId, userId, userMessage, signal } = params;

    // 1. Resolve session & conversation
    let session = await this.sessionStore.get(sessionId);
    if (!session) {
      const conversation = createConversation({ sessionId });
      await this.conversationRepo.create(conversation);
      session = createSession({ sessionId, userId, conversationId: conversation.id });
      await this.sessionStore.set(session);
    }

    const { conversationId } = session;

    // 2. Persist user message
    const userMsg = createMessage({ conversationId, role: 'user', content: userMessage });
    await this.conversationRepo.addMessage(userMsg);
    await this.sessionStore.pushHistory(sessionId, userMsg);

    // 3. Retrieve relevant memories: perfil global del señor (siempre) + memoria de esta sesión
    const memoryContext = await this.#retrieveMemories(sessionId, userMessage);

    // 4. Build message history for LLM
    const history = await this.sessionStore.getHistory(sessionId);
    const systemPrompt = this.#buildSystemPrompt(memoryContext);

    // 5. Run the agent loop (supports multi-turn tool use), capturando la respuesta.
    //    Las tareas complejas se enrutan a Claude si está configurado (Fase 2).
    let assistantReply = '';
    try {
      for await (const event of this.#agentLoop({
        sessionId,
        conversationId,
        messages: history,
        systemPrompt,
        preferProvider: this.#routeProvider(userMessage),
        signal: signal ?? new AbortController().signal,
      })) {
        if (event.type === 'text_delta' && event.text) assistantReply += event.text;
        yield event;
      }
    } catch (err) {
      // Suelo de texto ante fallo total (p.ej. TODOS los proveedores sin cuota): nunca
      // dejar al señor con silencio o un error crudo. Mensaje honesto según la causa.
      logger.error({ err }, 'Agent loop failed — emitting graceful floor');
      if (!assistantReply.trim()) {
        const m = err instanceof Error ? err.message : String(err);
        const quota = /quota|exhaust|rate.?limit|429|402|sin cuota|all providers/i.test(m);
        const text = quota
          ? 'Señor, en este momento todos mis proveedores de IA están sin cuota disponible. Le ruego reintentar en unos minutos; la cuota gratuita se repone sola.'
          : 'Disculpe, señor: he encontrado un problema técnico al procesar su solicitud. ¿Desea que lo intente de nuevo?';
        assistantReply = text;
        yield { type: 'text_delta', text };
      }
      yield { type: 'done' };
    }

    // 6. Store turn in memory for future retrieval
    await this.#storeMemory(sessionId, userMessage);
    await this.sessionStore.touch(sessionId);

    // 7. Aprender: destilar hechos duraderos sobre el señor al perfil global.
    //    Fire-and-forget — nunca debe bloquear ni romper la respuesta ya entregada.
    void this.#learnFacts(userMessage, assistantReply, sessionId).catch((err) =>
      logger.warn({ err }, 'Fact extraction failed'),
    );
  }

  // Clave estable del perfil del señor: la memoria de hechos es GLOBAL, no por sesión efímera.
  readonly #PROFILE_KEY = 'profile:user';

  async *#agentLoop(params: {
    sessionId: string;
    conversationId: string;
    messages: Message[];
    systemPrompt: string;
    signal: AbortSignal;
    preferProvider?: string;
  }): AsyncIterable<ConversationStreamEvent> {
    const { sessionId, conversationId, systemPrompt, signal, preferProvider } = params;
    const messages = [...params.messages];

    // Tope de rondas de herramientas: evita bucles (modelos gratuitos a veces repiten
    // la misma tool sin cerrar). En la última ronda se desactivan las tools para forzar
    // una respuesta de texto final en vez de colgarse o reventar con un 400.
    const MAX_TOOL_ROUNDS = 6;
    let round = 0;
    // El señor pidió explícitamente REVELAR un secreto/archivo sensible (dame/lee/forja… + clave).
    // Política: Emma nunca reproduce credenciales en el chat → negativa garantizada, use o no
    // herramientas el modelo (cierra también el caso sin tool en que el modelo divaga sin negarse).
    const secretRequest = SECRET_REQUEST_RE.test(params.messages.at(-1)?.content ?? '');
    // Se activa si en el turno se bloqueó un acceso a secreto (petición de exfiltración,
    // herramienta, guard de runtime o redactor). Al cerrar el turno garantiza una NEGATIVA limpia.
    let securityBlocked = secretRequest;

    while (true) {
      const toolsDisabled = round >= MAX_TOOL_ROUNDS;
      let assistantText = '';
      const pendingToolCalls: Array<{
        id: string;
        name: string;
        input: Record<string, unknown>;
      }> = [];
      let currentToolId: string | null = null;
      let currentToolName: string | null = null;
      let currentToolInputRaw = '';

      // Charla TRIVIAL (saludos, gracias, ok): no se envían herramientas a NINGÚN proveedor. Un
      // "hola" con ~10 esquemas de tools + system prompt revienta el límite de tokens/minuto del
      // plan gratis de Groq (→ 429 → cascada lenta). Sin tools, la petición es pequeña y Groq
      // responde en <1s. (El piso local también va mucho más rápido sin tools.)
      const lastUserText = (params.messages.at(-1)?.content ?? '').trim();
      const trivialChat = RunConversation.#TRIVIAL_CHAT_RE.test(lastUserText);
      // Petición de VOLCAR secretos → sin herramientas: el modelo no puede forjar ni ejecutar
      // comandos para buscarlos; solo redacta, y el guardia de seguridad fuerza la negativa.
      const relevantTools = (toolsDisabled || trivialChat || secretRequest)
        ? []
        : selectRelevantTools(lastUserText, this.toolRegistry.toLLMTools());
      // El texto se emite a través de un redactor que retiene la palabra parcial en curso
      // hasta el siguiente espacio, de modo que ninguna credencial sale entera al señor (SEC-11).
      const redactor = this.#makeRedactor();
      for await (const event of this.llm.stream(messages, {
        systemPrompt: toolsDisabled
          ? `${systemPrompt}\n\nYa tienes toda la información de las herramientas. Responde ahora al señor con el resultado final; NO pidas más herramientas.`
          : systemPrompt,
        tools: relevantTools,
        signal,
        preferProvider,
      })) {
        if (event.type === 'text_delta' && event.text) {
          for (const chunk of redactor.push(event.text)) {
            assistantText += chunk;
            yield { type: 'text_delta', text: chunk };
          }
          continue;
        }
        yield* this.#handleStreamEvent(event, {
          onTextDelta: () => { /* texto manejado por el redactor arriba */ },
          onToolStart: (id, name) => {
            currentToolId = id;
            currentToolName = name;
            currentToolInputRaw = '';
          },
          onToolDelta: (chunk) => { currentToolInputRaw += chunk; },
          onToolEnd: (id, name, input) => {
            pendingToolCalls.push({ id, name, input });
            currentToolId = null;
            currentToolName = null;
          },
        });
      }
      const redactedTail = redactor.flush();
      if (redactedTail) {
        assistantText += redactedTail;
        yield { type: 'text_delta', text: redactedTail };
      }
      // El modelo intentó emitir una credencial: se descartó → negativa al cerrar el turno.
      if (redactor.tripped()) securityBlocked = true;

      // Persist assistant message
      if (assistantText || pendingToolCalls.length > 0) {
        const assistantMsg = createMessage({
          conversationId,
          role: 'assistant',
          content: assistantText,
          toolCall: pendingToolCalls[0]
            ? { id: pendingToolCalls[0].id, name: pendingToolCalls[0].name, input: pendingToolCalls[0].input }
            : undefined,
        });
        await this.conversationRepo.addMessage(assistantMsg);
        await this.sessionStore.pushHistory(sessionId, assistantMsg);
        messages.push(assistantMsg);
      }

      // No tools called — conversation turn complete
      if (pendingToolCalls.length === 0) {
        // Si hubo bloqueo de seguridad, garantizar una NEGATIVA explícita (no depende del modelo).
        // Si no, suelo de texto: jamás cerrar el turno en silencio.
        if (securityBlocked) yield* this.#emitSecurityRefusal(assistantText);
        else if (!assistantText.trim()) {
          const synth = yield* this.#forceSynthesis(messages, systemPrompt, signal, preferProvider);
          if (!synth.trim()) yield* this.#emitFallback();
        }
        yield { type: 'done' };
        return;
      }

      // Tools desactivadas en esta ronda pero el modelo aun intentó llamarlas: cerrar el turno.
      if (toolsDisabled) {
        if (securityBlocked) yield* this.#emitSecurityRefusal(assistantText);
        else if (!assistantText.trim()) {
          // Reunió datos pero no redactó: forzar una síntesis final antes de rendirse (P2).
          const synth = yield* this.#forceSynthesis(messages, systemPrompt, signal, preferProvider);
          if (!synth.trim()) yield* this.#emitFallback();
        }
        yield { type: 'done' };
        return;
      }
      round += 1;

      // ¿El señor acaba de confirmar (mensaje corto y afirmativo)? Solo entonces se permiten
      // las acciones irreversibles/externas; si no, se piden confirmación SIN ejecutarse.
      const userConfirmed = isShortConfirmation(params.messages.at(-1)?.content ?? '');

      // Execute tools and feed results back
      for (const toolCall of pendingToolCalls) {
        // Los modelos gratuitos a veces inventan el nombre (whatsapp_read_messages en vez
        // de whatsapp_read_chat). Resolver al nombre real más parecido antes de ejecutar.
        const resolvedName = this.#resolveToolName(toolCall.name);

        // GATE DE CONFIRMACIÓN: una acción irreversible/externa sin confirmación NO se ejecuta.
        // Se devuelve al modelo una instrucción para que muestre el borrador y pida el "sí".
        const effectiveName = resolvedName ?? toolCall.name;
        if (isOutwardAction(effectiveName, toolCall.input) && !userConfirmed) {
          const summary = describeOutward(effectiveName, toolCall.input);
          const guardMsg =
            `CONFIRMACIÓN REQUERIDA — la acción NO se ha ejecutado. Vas a ${summary}, que es ` +
            `IRREVERSIBLE. Muéstrale al señor el destinatario y el contenido EXACTOS y pídele que ` +
            `confirme con un "sí". NO afirmes que ya se hizo; solo se ejecutará cuando él lo ` +
            `confirme explícitamente en su próximo mensaje.`;
          yield { type: 'tool_start', toolName: effectiveName, toolInput: toolCall.input };
          yield { type: 'tool_end', toolName: effectiveName, toolResult: guardMsg };
          const guardResultMsg = createMessage({
            conversationId,
            role: 'tool',
            content: guardMsg,
            toolResult: { toolCallId: toolCall.id, toolName: effectiveName, output: guardMsg, isError: false },
          });
          await this.conversationRepo.addMessage(guardResultMsg);
          await this.sessionStore.pushHistory(sessionId, guardResultMsg);
          messages.push(guardResultMsg);
          continue; // NO se ejecuta la herramienta
        }
        // Exfiltración: el señor pidió un secreto y el modelo recurre a una herramienta capaz
        // de leerlo → no se obedece; el cierre del turno emitirá una negativa determinista.
        if (secretRequest && isSecretAccessTool(resolvedName ?? toolCall.name)) securityBlocked = true;
        yield { type: 'tool_start', toolName: resolvedName ?? toolCall.name, toolInput: toolCall.input };

        let toolOutput: string;
        let isError = false;

        if (!resolvedName) {
          // No existe ni se parece a ninguna: guiar al modelo en vez de dejar que forje.
          const names = this.toolRegistry.listTools().map((t) => t.name).join(', ');
          toolOutput = `La herramienta "${toolCall.name}" no existe. NO la forjes. Usa una de las herramientas disponibles con su nombre EXACTO: ${names}`;
          isError = true;
        } else {
          try {
            const result = await this.toolRegistry.execute(resolvedName, toolCall.input, {
              sessionId,
              conversationId,
              signal,
            });
            toolOutput = typeof result.data === 'string'
              ? result.data
              : JSON.stringify(result.data ?? result.error ?? 'No output');
            isError = !result.success;
          } catch (err) {
            toolOutput = err instanceof Error ? err.message : String(err);
            isError = true;
            logger.error({ toolName: resolvedName, error: toolOutput }, 'Tool execution failed');
          }
        }

        // Defensa en profundidad: jamás dejar que la SALIDA de una herramienta (incluidas
        // las forjadas, que esquivan las whitelists) devuelva credenciales al modelo o al señor.
        if (this.#hasSecret(toolOutput)) {
          toolOutput = this.#scrubToolOutput(toolOutput);
          securityBlocked = true;
        }
        // El guard de runtime o una whitelist denegó un acceso sensible → negativa al cerrar.
        if (isError && (toolOutput.includes(RUNTIME_BLOCK_SENTINEL) || /permission|denied|denegad|bloquead|no permitid|política de seguridad|safety policy/i.test(toolOutput))) {
          securityBlocked = true;
        }

        yield { type: 'tool_end', toolName: resolvedName ?? toolCall.name, toolResult: toolOutput };

        const toolResultMsg = createMessage({
          conversationId,
          role: 'tool',
          content: toolOutput,
          toolResult: {
            toolCallId: toolCall.id,
            toolName: resolvedName ?? toolCall.name,
            output: toolOutput,
            isError,
          },
        });
        await this.conversationRepo.addMessage(toolResultMsg);
        await this.sessionStore.pushHistory(sessionId, toolResultMsg);
        messages.push(toolResultMsg);
      }
      // Loop continues with tool results fed back to the LLM
    }
  }

  async *#handleStreamEvent(
    event: LLMStreamEvent,
    callbacks: {
      onTextDelta: (text: string) => void;
      onToolStart: (id: string, name: string) => void;
      onToolDelta: (chunk: string) => void;
      onToolEnd: (id: string, name: string, input: Record<string, unknown>) => void;
    },
  ): AsyncIterable<ConversationStreamEvent> {
    if (event.type === 'text_delta' && event.text) {
      callbacks.onTextDelta(event.text);
      yield { type: 'text_delta', text: event.text };
    } else if (event.type === 'tool_use_start' && event.toolCallId && event.toolName) {
      callbacks.onToolStart(event.toolCallId, event.toolName);
    } else if (event.type === 'tool_use_delta' && event.text) {
      callbacks.onToolDelta(event.text);
    } else if (event.type === 'tool_use_end' && event.toolCallId && event.toolName && event.toolInput) {
      callbacks.onToolEnd(event.toolCallId, event.toolName, event.toolInput);
    } else if ((event.type as string) === 'provider_switched') {
      const e = event as unknown as { fromProvider?: string; toProvider?: string };
      yield { type: 'provider_switched', fromProvider: e.fromProvider, toProvider: e.toProvider };
    }
  }

  /** ¿Contiene una credencial (patrón genérico o un valor real de process.env)? */
  #hasSecret(text: string): boolean {
    if (!text) return false;
    if (new RegExp(SECRET_SOURCE).test(text)) return true;
    for (const [k, v] of Object.entries(process.env)) {
      if (!v || v.length < 8) continue;
      if (!/(API_KEY|TOKEN|SECRET|PASSWORD|PASSWD|DATABASE_URL|PRIVATE_KEY|_KEY)$/i.test(k)) continue;
      if (text.includes(v)) return true;
    }
    return false;
  }

  /** Censura una SALIDA DE HERRAMIENTA (que vuelve al modelo) con un marcador neutro. */
  #scrubToolOutput(text: string): string {
    if (!text) return text;
    let out = text;
    for (const [k, v] of Object.entries(process.env)) {
      if (!v || v.length < 8) continue;
      if (!/(API_KEY|TOKEN|SECRET|PASSWORD|PASSWD|DATABASE_URL|PRIVATE_KEY|_KEY)$/i.test(k)) continue;
      if (out.includes(v)) out = out.split(v).join(TOOL_REDACTED);
    }
    return out.replace(SECRET_GLOBAL_RE, TOOL_REDACTED);
  }

  /** Redactor de streaming del texto del asistente: emite por palabras y, si una credencial
   *  está por salir, la DESCARTA y marca `tripped` (la negativa la añade el cierre del turno).
   *  Nunca emite el secreto ni un marcador que delate haberlo tocado. */
  #makeRedactor(): { push: (t: string) => string[]; flush: () => string; tripped: () => boolean } {
    let buf = '';
    let tripped = false;
    const has = (s: string) => this.#hasSecret(s);
    return {
      tripped: () => tripped,
      push: (text: string): string[] => {
        if (tripped) return [];
        buf += text;
        const out: string[] = [];
        let idx: number;
        while ((idx = buf.search(/\s/)) >= 0) {
          const word = buf.slice(0, idx);
          const sep = buf[idx]!;
          buf = buf.slice(idx + 1);
          if (has(word)) { tripped = true; buf = ''; return out; }
          out.push(word + sep);
        }
        if (has(buf)) { tripped = true; buf = ''; }
        return out;
      },
      flush: (): string => {
        if (tripped || has(buf)) { tripped = tripped || has(buf); buf = ''; return ''; }
        const r = buf;
        buf = '';
        return r;
      },
    };
  }

  /** Negativa determinista ante un bloqueo de seguridad. Solo añade la frase si el texto del
   *  turno no contiene ya una negativa clara, para no duplicar. Nunca muestra el secreto. */
  async *#emitSecurityRefusal(currentText: string): AsyncIterable<ConversationStreamEvent> {
    // Solo se omite la negativa si el texto YA contiene una que el evaluador reconoce.
    const hasRefusal = /lo siento|no puedo|por seguridad|denegad|bloquead/i.test(currentText);
    if (hasRefusal) return;
    const text = currentText.trim() ? `\n\n${SECURITY_REFUSAL}` : SECURITY_REFUSAL;
    yield { type: 'text_delta', text };
  }

  /**
   * Reintento de SÍNTESIS: cuando el modelo cierra el turno vacío tras haber reunido datos con
   * herramientas (p.ej. varias búsquedas) y simplemente no redactó la respuesta — los modelos
   * gratuitos a veces devuelven texto vacío. Se le pide UNA vez más, sin herramientas, que
   * redacte la respuesta final con lo que ya tiene. Devuelve el texto producido (puede ser '').
   */
  async *#forceSynthesis(
    messages: Message[],
    systemPrompt: string,
    signal: AbortSignal,
    preferProvider?: string,
  ): AsyncGenerator<ConversationStreamEvent, string, unknown> {
    const redactor = this.#makeRedactor();
    let text = '';
    try {
      for await (const event of this.llm.stream(messages, {
        systemPrompt: `${systemPrompt}\n\nYa reuniste toda la información necesaria con las herramientas anteriores. Redacta AHORA, en español y dirigiéndote al señor, la respuesta FINAL útil con esos datos. NO pidas más herramientas; si los datos fueran insuficientes, dilo con franqueza y ofrece el siguiente paso.`,
        tools: [],
        signal,
        preferProvider,
      })) {
        if (event.type === 'text_delta' && event.text) {
          for (const chunk of redactor.push(event.text)) {
            text += chunk;
            yield { type: 'text_delta', text: chunk };
          }
        }
      }
      const tail = redactor.flush();
      if (tail) {
        text += tail;
        yield { type: 'text_delta', text: tail };
      }
    } catch (err) {
      logger.warn({ err }, 'Force-synthesis retry failed');
    }
    return text;
  }

  /** Suelo de texto: respuesta honesta cuando el turno terminaría vacío (nunca enmudecer). */
  async *#emitFallback(): AsyncIterable<ConversationStreamEvent> {
    yield {
      type: 'text_delta',
      text: 'Disculpe, señor. No logré formular una respuesta final en este intento. ¿Desea que lo intente de nuevo?',
    };
  }

  async #retrieveMemories(sessionId: string, query: string): Promise<{ profile: string; recent: string }> {
    // Perfil del señor: todos los hechos destilados (son pocos y caben enteros; no
    // dependen de embeddings, así funcionan aunque no haya clave de Voyage).
    let profile = '';
    try {
      const facts = await this.memoryRepo.listBySession(this.#PROFILE_KEY, 60);
      profile = facts.map((f) => `- ${f.content}`).join('\n');
    } catch { /* perfil vacío */ }

    // Memoria semántica de esta conversación (continuidad dentro de la sesión).
    let recent = '';
    try {
      const embedding = await this.embeddingAdapter.embed(query);
      const results = await this.memoryRepo.searchSemantic(sessionId, embedding, 5);
      recent = results.map((r) => `- ${r.entry.content}`).join('\n');
    } catch { /* sin memoria de sesión */ }

    return { profile, recent };
  }

  async #storeMemory(sessionId: string, content: string): Promise<void> {
    try {
      const embedding = await this.embeddingAdapter.embed(content);
      await this.memoryRepo.store(
        createMemoryEntry({ sessionId, content, embedding, metadata: {} }),
      );
    } catch (err) {
      logger.warn({ err }, 'Failed to store memory entry');
    }
  }

  /**
   * Destila hechos duraderos sobre el señor a partir del turno y los consolida en el
   * perfil global, evitando duplicados. Esto es lo que hace que Emma "le conozca más
   * cada día" en lugar de limitarse a acumular conversaciones en bruto.
   */
  async #learnFacts(userMessage: string, assistantReply: string, sessionId: string): Promise<void> {
    // Cargar el perfil existente PRIMERO: el extractor lo necesita para detectar
    // contradicciones (un dato nuevo que reemplaza a uno viejo, p.ej. cambio de ciudad).
    let rows: Awaited<ReturnType<IMemoryRepository['listBySession']>> = [];
    try {
      rows = await this.memoryRepo.listBySession(this.#PROFILE_KEY, 200);
    } catch { /* perfil vacío */ }

    // Lista numerada de hechos vigentes (índice estable → id real) para que el modelo
    // pueda señalar cuáles quedan OBSOLETOS por la información nueva.
    const numbered = rows.map((r, i) => `[${i}] ${r.content}`).join('\n') || '(ninguno)';

    const extractPrompt = `Eres el módulo de memoria de un asistente personal. Mantienes un PERFIL del USUARIO (su dueño) con hechos duraderos.

PERFIL ACTUAL:
${numbered}

NUEVO INTERCAMBIO:
USUARIO: ${userMessage}
ASISTENTE: ${assistantReply}

Tu tarea, a partir del intercambio:
1. "add": hechos DURADEROS y útiles sobre el USUARIO que aún NO estén en el perfil (preferencias, gustos, datos personales, personas/relaciones, proyectos, hábitos, rutinas, decisiones, objetivos). Cada uno: string conciso en español, atómico, en tercera persona (p.ej. "Prefiere las respuestas breves"). NO incluyas preguntas puntuales, cháchara, datos efímeros ni datos sobre el asistente.
2. "remove": los ÍNDICES (números entre corchetes del PERFIL ACTUAL) de hechos que han quedado OBSOLETOS o CONTRADICHOS por la información nueva (p.ej. el usuario antes vivía en X y ahora dice que vive en Y → marca el viejo para eliminar y añade el nuevo en "add").

Devuelve SOLO un objeto JSON: {"add": [<strings>], "remove": [<números>]}. Si no hay nada que añadir ni quitar, devuelve {"add": [], "remove": []}.

JSON:`;

    let raw: string;
    try {
      raw = await this.llm.complete(
        [{ ...createMessage({ conversationId: 'mem', role: 'user', content: extractPrompt }) }],
        { maxTokens: 500, systemPrompt: 'Mantienes un perfil de usuario. Responde solo con un objeto JSON {"add":[...],"remove":[...]}.' },
      );
    } catch (err) {
      logger.warn({ err }, 'LLM no disponible para extracción de hechos');
      return;
    }

    const { add, remove } = this.#parseFactDelta(raw, rows.length);
    if (add.length === 0 && remove.length === 0) return;

    const existing: string[] = rows.map((r) => this.#normalize(r.content));

    // 1) Suprimir los hechos obsoletos/contradichos (procedencia: se aprende algo que los reemplaza).
    for (const idx of remove) {
      const row = rows[idx];
      if (!row) continue;
      try {
        const ok = await this.memoryRepo.deleteById(row.id);
        if (ok) logger.info({ fact: row.content }, 'Hecho obsoleto olvidado (contradicción)');
      } catch (err) {
        logger.warn({ err }, 'No se pudo olvidar el hecho obsoleto');
      }
    }
    const removedNorms = new Set(remove.map((i) => this.#normalize(rows[i]?.content ?? '')));

    // 2) Añadir los hechos nuevos, deduplicando contra lo que sigue vigente.
    const learnedAt = new Date().toISOString();
    for (const fact of add) {
      const norm = this.#normalize(fact);
      if (!norm) continue;
      if (existing.includes(norm) && !removedNorms.has(norm)) continue;
      if (existing.some((e) => e && !removedNorms.has(e) && (e.includes(norm) || norm.includes(e)))) continue;
      let embedding: number[] | null = null;
      try { embedding = await this.embeddingAdapter.embed(fact); } catch { /* sin embedding */ }
      try {
        await this.memoryRepo.store(
          createMemoryEntry({
            sessionId: this.#PROFILE_KEY,
            content: fact,
            embedding,
            metadata: { type: 'fact', source: sessionId, learnedAt },
          }),
        );
        existing.push(norm);
        logger.info({ fact }, 'Nuevo hecho aprendido del señor');
      } catch (err) {
        logger.warn({ err }, 'No se pudo almacenar el hecho');
      }
    }
  }

  // Palabras que delatan una petición de razonamiento profundo → conviene Claude.
  // Charla trivial: si TODO el mensaje es un saludo/agradecimiento/confirmación, no se envían
  // herramientas (ahorra tokens y mantiene a Groq bajo su límite por minuto). Tolera ¿¡/acentos.
  static readonly #TRIVIAL_CHAT_RE =
    /^[¿¡\s]*(?:hola|buen[oa]s(?:\s*(?:d[ií]as|tardes|noches))?|hey|qu[eé]\s*tal|saludos|(?:muchas\s*)?gracias|ok|okay|vale|listo|perfecto|genial|de acuerdo|entendido|adi[oó]s|chao|hasta luego|c[oó]mo\s*est[aá]s|qu[eé]\s*haces|bien|s[ií]|no|claro|dale|jaja+|jeje+)(?:[\s,]+(?:emma|emmita|se[ñn]or))*[\s!?.,]*$/i;

  static readonly #COMPLEX_HINTS = /\b(analiza|análisis|analizar|planifica|planea|plan\b|estrategia|estrateg|dise[ñn]a|dise[ñn]o|arquitect|refactor|depura|debug|optimiza|compara|comparativa|razona|explica por qu[eé]|justifica|demuestra|resuelve|c[oó]digo|programa|script|algoritmo|redacta|escribe un|ensayo|informe detallado|investiga a fondo|pros y contras|ventajas y desventajas)\b/i;

  /**
   * Decide si el turno merece el "cerebro" Claude. Devuelve 'anthropic' para tareas
   * complejas; el manager lo ignora si la clave no está configurada (cae a la cadena normal).
   * Fase 2 del plan "Emma más lista".
   */
  #routeProvider(userMessage: string): string | undefined {
    const msg = userMessage.trim();
    const complex = RunConversation.#COMPLEX_HINTS.test(msg) || msg.length > 600;
    return complex ? 'anthropic' : undefined;
  }

  /**
   * Resuelve el nombre de una herramienta al real más parecido. Los modelos gratuitos a
   * veces inventan variantes (whatsapp_read_messages → whatsapp_read_chat). Devuelve null
   * si no hay coincidencia razonable (para no ejecutar algo equivocado).
   */
  #resolveToolName(name: string): string | null {
    const all = this.toolRegistry.listTools().map((t) => t.name);
    if (all.includes(name)) return name;
    const toks = (s: string) => new Set(s.toLowerCase().split(/[_\- ]+/).filter(Boolean));
    const target = toks(name);
    if (target.size <= 1) return null; // 1 sola palabra es demasiado ambiguo
    let best: string | null = null;
    let bestScore = 0;
    for (const t of all) {
      const tt = toks(t);
      let overlap = 0;
      for (const w of target) if (tt.has(w)) overlap += 1;
      const score = overlap / Math.max(tt.size, target.size);
      if (score > bestScore) { bestScore = score; best = t; }
    }
    return bestScore >= 0.5 ? best : null;
  }

  /**
   * Parsea la respuesta del extractor de memoria. Acepta el formato nuevo
   * {"add":[...],"remove":[...]} y, por robustez ante modelos gratuitos, también un array
   * plano (lo trata como add-only). `nFacts` acota los índices de remove al perfil real.
   */
  #parseFactDelta(raw: string, nFacts: number): { add: string[]; remove: number[] } {
    const empty = { add: [] as string[], remove: [] as number[] };
    if (!raw) return empty;

    const cleanAdd = (arr: unknown): string[] =>
      Array.isArray(arr)
        ? arr
            .filter((x): x is string => typeof x === 'string')
            .map((s) => s.trim())
            .filter((s) => s.length > 3 && s.length < 240)
            .slice(0, 8)
        : [];

    // Formato preferido: objeto {add, remove}.
    const objMatch = raw.match(/\{[\s\S]*\}/);
    if (objMatch) {
      try {
        const parsed = JSON.parse(objMatch[0]) as { add?: unknown; remove?: unknown };
        if (parsed && typeof parsed === 'object' && ('add' in parsed || 'remove' in parsed)) {
          const add = cleanAdd(parsed.add);
          const remove = Array.isArray(parsed.remove)
            ? [...new Set(
                parsed.remove
                  .map((n) => (typeof n === 'number' ? n : Number(n)))
                  .filter((n) => Number.isInteger(n) && n >= 0 && n < nFacts),
              )]
            : [];
          return { add, remove };
        }
      } catch { /* cae al array plano */ }
    }

    // Compatibilidad: array plano de strings → solo añadir.
    const arrMatch = raw.match(/\[[\s\S]*\]/);
    if (arrMatch) {
      try {
        return { add: cleanAdd(JSON.parse(arrMatch[0])), remove: [] };
      } catch { /* nada */ }
    }
    return empty;
  }

  #normalize(s: string): string {
    return s
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9 ]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  #buildSystemPrompt(memory: { profile: string; recent: string }): string {
    let prompt = this.#SYSTEM_PROMPT;

    // Configuración estructurada del señor (ciudad, hora del informe…). Emma la conoce
    // siempre y solo pregunta UNA vez lo que falte, guardándolo con set_owner_profile.
    const config = this.#loadOwnerConfig();
    prompt += `\n\n## CONFIGURACIÓN DEL SEÑOR\n${
      Object.keys(config).length
        ? `Datos ya configurados (NO los vuelvas a preguntar, úsalos directamente):\n${
            Object.entries(config).filter(([k]) => k !== 'updatedAt').map(([k, v]) => `- ${k}: ${JSON.stringify(v)}`).join('\n')
          }`
        : 'Aún no hay configuración guardada.'
    }
Regla de auto-configuración: si necesitas un dato del señor para completar una tarea (p.ej. su ciudad para el clima) y NO está arriba, pregúntaselo UNA sola vez de forma natural y, en cuanto te lo dé, guárdalo con la herramienta set_owner_profile. Nunca vuelvas a preguntar algo que ya esté configurado. Las herramientas set_owner_profile y get_owner_profile YA EXISTEN — úsalas directamente, NO las forjes.`;

    const clawhub = this.#loadClawhubSkills();
    if (clawhub) {
      prompt += `\n\n## SKILLS DE CLAWHUB INSTALADAS (capacidades adicionales, ya auditadas)\nEstas guías están en ~/.emma/clawhub-skills/<nombre>/SKILL.md. Cuando una petición del señor encaje con una de ellas, LEE su SKILL.md con la herramienta file_system y sigue sus instrucciones (ejecutando los comandos con execute_command). Si una skill requiere un binario que no está instalado, o autenticación (Google/GitHub), NO inventes el resultado: dilo y pide al señor instalarlo/autenticarlo.\n${clawhub}`;
    }
    if (memory.profile) {
      prompt += `\n\n## PERFIL DEL SEÑOR (memoria persistente — lo que has aprendido de él con el tiempo)\nUsa esto para personalizar y anticiparte. No lo recites a menos que venga al caso.\n${memory.profile}`;
    }
    if (memory.recent) {
      prompt += `\n\n## Contexto reciente de esta conversación\n${memory.recent}`;
    }
    return prompt;
  }

  #loadOwnerConfig(): Record<string, unknown> {
    try {
      return JSON.parse(readFileSync(`${homedir()}/.emma/owner-profile.json`, 'utf8'));
    } catch {
      return {};
    }
  }

  // Índice de skills de ClawHub instaladas (formato OpenClaw: SKILL.md). Se inyecta en el
  // prompt para que Emma sepa qué capacidades tiene y lea la guía completa cuando la use.
  #loadClawhubSkills(): string {
    try {
      const dir = `${homedir()}/.emma/clawhub-skills`;
      const skills = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory());
      if (skills.length === 0) return '';
      const lines: string[] = [];
      for (const s of skills) {
        let desc = '';
        let requires = '';
        try {
          const md = readFileSync(`${dir}/${s.name}/SKILL.md`, 'utf8').slice(0, 1500);
          desc = (md.match(/description:\s*["']?([^"'\n]+)/i)?.[1] ?? '').slice(0, 110);
          requires = md.match(/"bins":\s*\[([^\]]*)\]/)?.[1]?.replace(/"/g, '') ?? '';
        } catch { /* */ }
        lines.push(`- ${s.name}: ${desc}${requires ? ` (requiere el binario: ${requires})` : ''}`);
      }
      return lines.join('\n');
    } catch {
      return '';
    }
  }
}
