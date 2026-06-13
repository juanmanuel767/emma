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
- ClawHub/OpenClaw skills: when the señor asks to install a skill from ClawHub or pastes "openclaw skills install <slug>" / "clawhub install <slug>", ALWAYS use install_clawhub_skill with that slug. It downloads WITHOUT executing, audits for malware, and only integrates if safe. NEVER run "openclaw"/"clawhub" via execute_command (not installed) and NEVER forge a downloader. If the audit returns PELIGROSA, refuse and explain; if SOSPECHOSA, report the findings and ask the señor before forcing. To audit arbitrary code use audit_skill.

SELF-IMPROVEMENT (forge_tool): You can extend yourself. When the owner asks for a capability that NO existing tool provides, do NOT say you can't — silently forge the tool with forge_tool, then immediately use it to fulfill the request. The forged tool persists for next time. Only forge when genuinely missing a capability; reuse existing tools and previously forged ones (check list_forged_tools) first.
- forge_tool rules: write inline async code (no inner functions). READ INPUTS from input.<param> — never hard-code the user's specific values, so the tool is reusable. Use global fetch() for HTTP. For local programs, ALWAYS await them: "const { execFile } = await import('node:child_process'); const { promisify } = await import('node:util'); const run = promisify(execFile); await run('mkdir',['-p','/tmp/emma']); await run('espeak-ng',['-v','es+f3','-w','/tmp/emma/voice.wav', input.text]);". Return { success, data?, error? }.
This machine already has these binaries you can shell out to from forged tools:
- Text-to-speech / "háblame" / "dime en voz alta" → PREFER the existing speak_text tool. For new forges: Piper TTS natural voice at ~/.emma/piper/piper/piper with model ~/.emma/piper/voices/es_ES-sharvard-medium.onnx (--speaker 1 = female; write text to stdin, --output_file /tmp/emma/voice.wav). Fallback: espeak-ng 'es+f3'.
- VISION / image analysis: messages may include "[imagen adjunta guardada en: /tmp/emma/...]". To see images, use (or forge) a tool that reads the file and asks local Ollama moondream: const b64 = (await import('node:fs/promises')).readFile ... readFile(input.image_path).then(b=>b.toString('base64')); const r = await fetch('http://localhost:11434/api/generate',{method:'POST',body:JSON.stringify({model:'moondream',prompt:input.question||'Describe this image in detail',images:[b64],stream:false})}); const j = await r.json(); return { success:true, data:{ description: j.response } }. moondream answers in English — translate for the user. NEVER claim you cannot see images: use/forge the tool.
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

    // 6. Store turn in memory for future retrieval
    await this.#storeMemory(sessionId, userMessage);
    await this.sessionStore.touch(sessionId);

    // 7. Aprender: destilar hechos duraderos sobre el señor al perfil global.
    //    Fire-and-forget — nunca debe bloquear ni romper la respuesta ya entregada.
    void this.#learnFacts(userMessage, assistantReply).catch((err) =>
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

      const relevantTools = toolsDisabled
        ? []
        : selectRelevantTools(params.messages.at(-1)?.content ?? '', this.toolRegistry.toLLMTools());
      for await (const event of this.llm.stream(messages, {
        systemPrompt: toolsDisabled
          ? `${systemPrompt}\n\nYa tienes toda la información de las herramientas. Responde ahora al señor con el resultado final; NO pidas más herramientas.`
          : systemPrompt,
        tools: relevantTools,
        signal,
        preferProvider,
      })) {
        yield* this.#handleStreamEvent(event, {
          onTextDelta: (text) => { assistantText += text; },
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
        yield { type: 'done' };
        return;
      }

      // Tools desactivadas en esta ronda pero el modelo aun intentó llamarlas: cerrar el turno.
      if (toolsDisabled) {
        yield { type: 'done' };
        return;
      }
      round += 1;

      // Execute tools and feed results back
      for (const toolCall of pendingToolCalls) {
        // Los modelos gratuitos a veces inventan el nombre (whatsapp_read_messages en vez
        // de whatsapp_read_chat). Resolver al nombre real más parecido antes de ejecutar.
        const resolvedName = this.#resolveToolName(toolCall.name);
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
  async #learnFacts(userMessage: string, assistantReply: string): Promise<void> {
    const extractPrompt = `Eres el módulo de memoria de un asistente personal. A partir del siguiente intercambio, extrae ÚNICAMENTE hechos DURADEROS y útiles sobre el USUARIO (su dueño): preferencias, gustos, datos personales, personas/relaciones que menciona, proyectos en curso, hábitos, rutinas, decisiones, objetivos. NO extraigas: preguntas puntuales, cháchara, información efímera, ni datos sobre el asistente.
Devuelve SOLO un array JSON de strings concisos en español (cada uno un hecho atómico en tercera persona, p.ej. "Prefiere las respuestas breves"). Si no hay ningún hecho duradero, devuelve [].

USUARIO: ${userMessage}
ASISTENTE: ${assistantReply}

Hechos (JSON):`;

    let raw: string;
    try {
      raw = await this.llm.complete(
        [{ ...createMessage({ conversationId: 'mem', role: 'user', content: extractPrompt }) }],
        { maxTokens: 400, systemPrompt: 'Extrae hechos duraderos. Responde solo con un array JSON válido.' },
      );
    } catch (err) {
      logger.warn({ err }, 'LLM no disponible para extracción de hechos');
      return;
    }

    const facts = this.#parseFacts(raw);
    if (facts.length === 0) return;

    // Deduplicar contra el perfil existente por comparación textual normalizada.
    let existing: string[] = [];
    try {
      const rows = await this.memoryRepo.listBySession(this.#PROFILE_KEY, 200);
      existing = rows.map((r) => this.#normalize(r.content));
    } catch { /* perfil vacío */ }

    for (const fact of facts) {
      const norm = this.#normalize(fact);
      if (!norm || existing.includes(norm)) continue;
      if (existing.some((e) => e.includes(norm) || norm.includes(e))) continue; // solapamiento evidente
      let embedding: number[] | null = null;
      try { embedding = await this.embeddingAdapter.embed(fact); } catch { /* sin embedding */ }
      try {
        await this.memoryRepo.store(
          createMemoryEntry({ sessionId: this.#PROFILE_KEY, content: fact, embedding, metadata: { type: 'fact' } }),
        );
        existing.push(norm);
        logger.info({ fact }, 'Nuevo hecho aprendido del señor');
      } catch (err) {
        logger.warn({ err }, 'No se pudo almacenar el hecho');
      }
    }
  }

  // Palabras que delatan una petición de razonamiento profundo → conviene Claude.
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

  #parseFacts(raw: string): string[] {
    if (!raw) return [];
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) return [];
    try {
      const parsed = JSON.parse(match[0]);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((x): x is string => typeof x === 'string')
        .map((s) => s.trim())
        .filter((s) => s.length > 3 && s.length < 240)
        .slice(0, 8);
    } catch {
      return [];
    }
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
