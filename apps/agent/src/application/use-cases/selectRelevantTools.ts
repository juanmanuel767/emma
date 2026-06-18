import type { LLMTool } from '@emma/core/ports';

// Maps tool names to keywords that indicate relevance
const TOOL_KEYWORDS: Record<string, string[]> = {
  calculate: ['calcula', 'calcul', 'cuánto', 'cuanto', 'suma', 'resta', 'multiplica', 'divide', '%', 'porcentaje', 'math', 'número', 'numero', 'operación'],
  get_datetime: ['hora', 'tiempo', 'fecha', 'hoy', 'día', 'time', 'date', 'cuando', 'ahora', 'now', 'today'],
  save_note: ['nota', 'note', 'guarda', 'save', 'apunta', 'escribe', 'write', 'anota'],
  read_note: ['nota', 'note', 'lee', 'read', 'muestra', 'show', 'ver nota'],
  list_notes: ['notas', 'notes', 'lista', 'list', 'mis notas'],
  add_reminder: ['recordatorio', 'reminder', 'recuerda', 'remember', 'tarea', 'task', 'pendiente', 'agenda'],
  list_reminders: ['recordatorio', 'reminder', 'tareas', 'tasks', 'pendiente', 'lista', 'list'],
  complete_reminder: ['hecho', 'done', 'completar', 'complete', 'terminé', 'finish'],
  http_get: ['api', 'fetch', 'url', 'http', 'request', 'endpoint', 'get'],
  http_post: ['api', 'post', 'envía', 'send', 'request', 'endpoint'],
  get_system_info: ['sistema', 'system', 'cpu', 'ram', 'memoria', 'memory', 'disco', 'disk', 'proceso', 'process', 'uptime', 'hardware'],
  execute_command: ['comando', 'command', 'bash', 'shell', 'terminal', 'ejecuta', 'run', 'script'],
  file_system: ['archivo', 'file', 'directorio', 'directory', 'carpeta', 'folder', 'read', 'write', 'lee', 'escribe'],
  monitor_page: ['monitor', 'monitorea', 'monitorear', 'vigila', 'vigilar', 'cambios', 'cambio', 'avísame', 'avisame', 'avisa', 'alerta', 'alértame', 'novedad', 'novedades', 'revisa la página', 'pendiente', 'actualización', 'actualizacion', 'se actualiza'],
  browser: ['navega', 'navegador', 'browse', 'browser', 'screenshot', 'captura', 'click', 'web', 'página', 'page', 'url', 'sitio', 'scrape', 'extrae', 'extrae texto', 'formulario', 'form'],
  web_search: ['busca', 'search', 'google', 'noticia', 'news', 'encuentra', 'find', 'internet'],
  email: ['email', 'correo', 'mail', 'mensaje', 'envía', 'envia', 'inbox', 'bandeja', 'gmail', 'lee correo', 'leer correo', 'escribir correo', 'responde correo'],
  check_password_breach: ['contraseña', 'password', 'clave', 'brecha', 'filtrada', 'filtración', 'comprometida', 'pwned', 'hackeada', 'segura', 'leak'],
  check_ssl_cert: ['certificado', 'certificate', 'ssl', 'tls', 'https', 'caducado', 'vencido', 'expira'],
  analyze_url: ['url', 'enlace', 'link', 'phishing', 'estafa', 'sospechoso', 'fraude', 'malicioso', 'abrir enlace', 'es seguro'],
  audit_system_security: ['auditoría', 'auditar', 'seguridad', 'security', 'puertos', 'firewall', 'cortafuegos', 'vulnerabilidad', 'hardening', 'protegido', 'intrusión', 'login fallido'],
  analyze_email_headers: ['cabeceras', 'headers', 'spoofing', 'suplantación', 'spf', 'dkim', 'dmarc', 'remitente falso', 'correo falso'],
  generate_secure_password: ['genera contraseña', 'generar contraseña', 'nueva contraseña', 'passphrase', 'contraseña segura', 'crear clave'],
  check_host_reputation: ['reputación', 'dns', 'dominio', 'ip', 'investigar', 'whois', 'geolocaliza', 'legitimo', 'legítimo'],
  run_security_tool: ['nmap', 'nikto', 'whatweb', 'sqlmap', 'gobuster', 'sslscan', 'masscan', 'nuclei', 'httpx', 'subfinder', 'trivy', 'lynis', 'escanea', 'escaneo', 'escanear', 'scan', 'puerto', 'puertos', 'vulnerabilidad', 'vulnerabilidades', 'pentest', 'fingerprint', 'recon', 'subdominios', 'analiza web', 'auditar web'],
  ensure_security_tool: ['instala', 'instalar', 'descarga', 'descargar', 'herramienta'],
  list_security_tools: ['herramientas de seguridad', 'qué herramientas', 'que herramientas', 'catálogo', 'catalogo', 'arsenal'],
  forget_fact: ['olvida', 'olvídalo', 'olvidalo', 'olvídate', 'olvidate', 'borra de mi perfil', 'borra que', 'ya no vivo', 'ya no', 'elimina de mi perfil', 'no recuerdes', 'deja de recordar', 'equivocado', 'corrige', 'ya no me gusta'],
  list_known_facts: ['qué sabes de mí', 'que sabes de mi', 'qué sabes de mi', 'qué recuerdas', 'que recuerdas', 'qué recuerdas de mí', 'mi perfil', 'de dónde sabes', 'de donde sabes', 'cómo sabes', 'como sabes', 'qué tienes de mí', 'que tienes de mi', 'mis datos'],
};

// Domain keywords matched against the TOOL's name/description (not per tool name),
// so dynamically forged tools (speak_text, take_photo, …) still get selected.
const DOMAIN_KEYWORDS: Array<{ toolPattern: RegExp; keywords: string[] }> = [
  { toolPattern: /speak|tts|voice|voz|audio|say/i, keywords: ['habla', 'hablar', 'háblame', 'hablame', 'voz', 'dime', 'audio', 'speak', 'voice', 'pronuncia', 'escuchar', 'oír', 'oir'] },
  { toolPattern: /photo|camera|cam\b|foto|imagen|image|vision/i, keywords: ['foto', 'cámara', 'camara', 'mira', 'mírame', 'mirame', 'ves', 'verme', 'véme', 'veme', 'me ves', 'puedes ver', 'qué ves', 'que ves', 'obsérvame', 'observame', 'photo', 'picture', 'webcam', 'captura', 'imagen', 'image', 'describe'] },
  { toolPattern: /weather|clima/i, keywords: ['clima', 'lluvia', 'temperatura', 'weather', 'pronóstico', 'pronostico'] },
  { toolPattern: /bitcoin|crypto/i, keywords: ['bitcoin', 'btc', 'crypto', 'cripto', 'cotiza'] },
  { toolPattern: /currency|convert/i, keywords: ['divisa', 'moneda', 'dólar', 'dolar', 'euro', 'convierte', 'cambio', 'currency'] },
  { toolPattern: /whats|wasa|wassa|guasa|wsp|wpp/i, keywords: ['whatsapp', 'whatsap', 'whatssap', 'wasap', 'wasa', 'wassap', 'guasap', 'guasab', 'wsp', 'wpp', 'whats', 'mensaje', 'mensajes', 'chat', 'chats', 'contacto', 'grupo', 'escríbele', 'escribele', 'respóndele', 'respondele', 'dile a', 'conecta', 'conéctate', 'conectate', 'conetate', 'conectame', 'conéctame', 'conectarte', 'conectar', 'vincula', 'vincular', 'vinculame'] },
  // Auto-respuesta on/off por orden natural: activarla ("responde por mí a X") y, sobre todo,
  // DETENERLA con frases sueltas ("deténgase", "ya no", "para") — clave para que pueda apagarla rápido.
  { toolPattern: /whatsapp_(automate|unautomate|list_automated)/i, keywords: ['automatiza', 'automatices', 'automatizar', 'automatízate', 'responde por mí', 'responde por mi', 'responde tú', 'responde tu', 'contesta por mí', 'contesta por mi', 'responde automáticamente', 'responde automaticamente', 'hazte pasar', 'auto-respuesta', 'autorespuesta', 'deja de responder', 'dejes de responder', 'deja de contestar', 'no respondas', 'ya no respondas', 'ya no', 'no más', 'no mas', 'deténte', 'detente', 'detenle', 'detenlo', 'detén', 'deten', 'deténgase', 'detengase', 'para', 'pará', 'detener', 'desautomatiza', 'desactiva', 'apaga', 'quién está automatizado', 'quien esta automatizado', 'a quién respondes', 'a quien respondes'] },
  { toolPattern: /skill|clawhub|openclaw|audit/i, keywords: ['skill', 'skills', 'clawhub', 'openclaw', 'install', 'instala', 'instalar', 'audita', 'auditar', 'auditoria', 'auditoría', 'analiza', 'segura', 'maliciosa', 'vulnerable', 'nexo-brain'] },
  { toolPattern: /emma_(status|restart|logs|doctor)/i, keywords: ['estado', 'estás', 'estas', 'sistemas', 'servicios', 'reinicia', 'reiníciate', 'reiniciate', 'reiníciese', 'reiniciar', 'colgado', 'colgada', 'logs', 'registros', 'diagnostica', 'diagnóstico', 'diagnostico', 'doctor', 'revísate', 'revisate', 'a fondo', 'chequeo', 'checkup', 'salud', 'operativa', 'operativos', 'autodiagnóstico', 'autodiagnostico'] },
  { toolPattern: /publish_to_github|git-publish/i, keywords: ['sube', 'subir', 'publica', 'publicar', 'repositorio', 'repo', 'github', 'codigo', 'código', 'descargar', 'descarguen', 'readme'] },
  { toolPattern: /facebook/i, keywords: ['facebook', 'fb', 'postea', 'postear', 'publica en facebook', 'página', 'pagina', 'fanpage', 'fan page', 'muro'] },
  // Scheduler (cron). Sus descripciones están en inglés, así que las palabras en español no
  // hacían overlap y cancel_task/list_scheduled_tasks no llegaban al modelo.
  { toolPattern: /schedule_task|cancel_task|list_scheduled_tasks/i, keywords: ['programa', 'programar', 'programada', 'programadas', 'agenda', 'agendar', 'automatiza', 'automatizar', 'automática', 'automatica', 'automatización', 'automatizacion', 'tarea', 'tareas', 'cron', 'recurrente', 'periódica', 'periodica', 'cancela', 'cancelar', 'cancélala', 'cancelala', 'detén', 'deten', 'detener'] },
];

// Generic fallback: overlap between message words and the tool's own name/description
// words. Covers forged tools that match no keyword map at all.
function genericScore(lowerMessage: string, tool: LLMTool): number {
  const toolWords = new Set(
    `${tool.name.replace(/[_-]/g, ' ')} ${tool.description ?? ''}`
      .toLowerCase()
      .split(/[^a-záéíóúüñ0-9]+/)
      .filter((w) => w.length >= 4),
  );
  const msgWords = lowerMessage.split(/[^a-záéíóúüñ0-9]+/).filter((w) => w.length >= 4);
  let hits = 0;
  for (const mw of msgWords) {
    for (const tw of toolWords) {
      if (tw.startsWith(mw) || mw.startsWith(tw)) {
        hits += 1;
        break;
      }
    }
  }
  return hits;
}

// Always include these tools regardless.
// forge_tool/list_forged_tools must always be present so Emma can self-improve
// whenever the user asks for a capability no existing tool provides.
const ALWAYS_INCLUDE = new Set(['calculate', 'get_datetime', 'email', 'forge_tool', 'list_forged_tools', 'set_owner_profile', 'whatsapp_connect', 'whatsapp_status']);

// Max tools to send to the LLM (keep low to stay within free tier token limits)
const MAX_TOOLS_LOCAL = 6;
const MAX_TOOLS_CLOUD = 10;

export function selectRelevantTools(
  message: string,
  allTools: LLMTool[],
  maxTools: number = MAX_TOOLS_CLOUD,
): LLMTool[] {
  // If we can fit all tools, skip scoring entirely
  if (allTools.length <= maxTools) return allTools;

  const lower = message.toLowerCase();

  const scored = allTools.map((tool) => {
    if (ALWAYS_INCLUDE.has(tool.name)) return { tool, score: 1000 };

    // If user explicitly mentions the tool name, prioritize it
    if (lower.includes(tool.name.replace(/_/g, ' ')) || lower.includes(tool.name)) {
      return { tool, score: 999 };
    }

    const keywords = TOOL_KEYWORDS[tool.name];
    if (keywords) {
      const score = keywords.reduce((acc, kw) => acc + (lower.includes(kw) ? 1 : 0), 0);
      return { tool, score };
    }

    // Tools without a hardcoded entry (e.g. forged): domain keywords + word overlap
    const toolText = `${tool.name} ${tool.description ?? ''}`;
    let score = 0;
    for (const domain of DOMAIN_KEYWORDS) {
      if (domain.toolPattern.test(toolText)) {
        score += domain.keywords.reduce((acc, kw) => acc + (lower.includes(kw) ? 2 : 0), 0);
      }
    }
    score += genericScore(lower, tool);
    return { tool, score };
  });

  const sorted = scored.sort((a, b) => b.score - a.score);
  return sorted.slice(0, maxTools).map((s) => s.tool);
}

export { MAX_TOOLS_LOCAL, MAX_TOOLS_CLOUD };
