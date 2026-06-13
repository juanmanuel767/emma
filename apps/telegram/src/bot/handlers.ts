import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { readFile, stat } from 'fs/promises';
import { spawnSync, spawn } from 'child_process';
import type { Bot, Context } from 'grammy';
import { InputFile } from 'grammy';
import type { GatewayClient } from '../infrastructure/GatewayClient.js';
import { createLogger } from '@emma/shared/logger';

const logger = createLogger('telegram-handlers');

const sessionMap = new Map<number, string>();
const SCREENSHOT_PATH = '/tmp/emma/screenshot.png';
const ENV_PATH = new URL('../../../../.env', import.meta.url).pathname;
const EMMA_DIR = '/home/user/jarvis/emma';

export interface HandlerOptions {
  botToken: string;
  groqApiKey?: string;
}

// ── Provider key patterns ──────────────────────────────────────────────────────
interface ProviderConfig {
  name: string;
  re: RegExp;
  envKey: string;
  model: string;
  label: string;
}

// ── Email app-password pattern ────────────────────────────────────────────────
// Gmail App Passwords are 16 chars with spaces: "xxxx xxxx xxxx xxxx" or without spaces
const EMAIL_APPPASSWORD_RE = /\b([a-z]{4} [a-z]{4} [a-z]{4} [a-z]{4}|[a-z]{16})\b/i;

// Order matters: openrouter (sk-or-) must be checked before the generic openai sk- pattern
const PROVIDERS: ProviderConfig[] = [
  { name: 'groq',       re: /gsk_[A-Za-z0-9_]{20,}/,                envKey: 'GROQ_API_KEY',       model: 'qwen/qwen3-32b',    label: 'Groq (Llama / Qwen)' },
  { name: 'anthropic',  re: /sk-ant-[A-Za-z0-9_-]{20,}/,            envKey: 'ANTHROPIC_API_KEY',  model: 'claude-sonnet-4-6', label: 'Anthropic (Claude)'  },
  { name: 'openrouter', re: /sk-or-[A-Za-z0-9_-]{20,}/,             envKey: 'OPENROUTER_API_KEY', model: '',                  label: 'OpenRouter (modelos gratis)' },
  { name: 'openai',     re: /sk-(?!ant-|or-)[A-Za-z0-9_-]{20,}/,    envKey: 'OPENAI_API_KEY',     model: 'gpt-4o',            label: 'OpenAI (GPT-4o)'     },
];

function detectProvider(text: string): { provider: ProviderConfig; key: string } | null {
  for (const p of PROVIDERS) {
    const m = text.match(p.re);
    if (m) return { provider: p, key: m[0] };
  }
  return null;
}

function updateEnv(envKey: string, value: string, extras?: Record<string, string>): void {
  let content = readFileSync(ENV_PATH, 'utf8');
  content = content.replace(new RegExp(`^${envKey}=.*`, 'm'), `${envKey}=${value}`);
  if (extras) {
    for (const [k, v] of Object.entries(extras)) {
      if (content.match(new RegExp(`^${k}=`, 'm'))) {
        content = content.replace(new RegExp(`^${k}=.*`, 'm'), `${k}=${v}`);
      }
    }
  }
  writeFileSync(ENV_PATH, content, 'utf8');
}

function restartAgent(): void {
  spawnSync('pkill', ['-f', 'apps/agent/dist/index.js'], { timeout: 3000 });
  setTimeout(() => {
    const child = spawn(
      process.execPath,
      ['--env-file=/home/user/jarvis/emma/.env', 'apps/agent/dist/index.js'],
      { cwd: EMMA_DIR, detached: true, stdio: 'ignore' },
    );
    child.unref();
  }, 1500);
}

// ── TTS local (Piper) — Emma responde por voz cuando le hablan por voz ─────────
const OWNER_CHAT_FILE = `${homedir()}/.emma/owner-chat.json`;
let _ownerChatSaved: number | null = null;
function rememberOwnerChat(chatId: number): void {
  if (_ownerChatSaved === chatId) return;
  _ownerChatSaved = chatId;
  try {
    mkdirSync(`${homedir()}/.emma`, { recursive: true });
    writeFileSync(OWNER_CHAT_FILE, JSON.stringify({ chatId, updatedAt: new Date().toISOString() }));
  } catch { /* no bloquear el mensaje por esto */ }
}

const PIPER_BIN = `${homedir()}/.emma/piper/piper/piper`;
const PIPER_MODEL = `${homedir()}/.emma/piper/voices/es_ES-sharvard-medium.onnx`;

/** Limpia markdown/emojis para que el TTS no lea símbolos. */
function cleanForTts(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' código omitido ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/[*_#>~|]/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' enlace ')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1500);
}

/** Sintetiza con Piper (voz femenina es_ES) y convierte a OGG/Opus para nota de voz nativa. */
async function synthesizeVoiceReply(text: string): Promise<string | null> {
  if (!existsSync(PIPER_BIN) || !existsSync(PIPER_MODEL)) return null;
  const clean = cleanForTts(text);
  if (!clean) return null;

  const base = `/tmp/emma/reply-${Date.now()}`;
  try {
    mkdirSync('/tmp/emma', { recursive: true });
    await new Promise<void>((resolve, reject) => {
      const p = spawn(PIPER_BIN, ['--model', PIPER_MODEL, '--speaker', '1', '--output_file', `${base}.wav`]);
      p.on('error', reject);
      p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`piper exit ${code}`))));
      p.stdin.on('error', () => {});
      p.stdin.write(clean);
      p.stdin.end();
    });
    if (!existsSync(`${base}.wav`)) return null;
    const ogg = await toVoiceOgg(`${base}.wav`);
    return ogg ?? `${base}.wav`;
  } catch (err) {
    logger.warn({ err }, 'TTS synthesis failed');
    return null;
  }
}

/** WAV/MP3 → OGG Opus (replyWithVoice exige Opus para nota de voz nativa). */
async function toVoiceOgg(inputPath: string): Promise<string | null> {
  const out = inputPath.replace(/\.\w+$/, '.ogg');
  if (inputPath === out) return inputPath;
  try {
    await new Promise<void>((resolve, reject) => {
      const p = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-i', inputPath, '-c:a', 'libopus', '-b:a', '32k', '-ar', '48000', out]);
      p.on('error', reject);
      p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`))));
    });
    return out;
  } catch (err) {
    logger.warn({ err, inputPath }, 'ffmpeg ogg conversion failed');
    return null;
  }
}

// ── Whisper transcription ──────────────────────────────────────────────────────
async function transcribeVoice(
  audioBuffer: Buffer,
  filename: string,
  groqApiKey: string,
): Promise<string> {
  const form = new FormData();
  form.append('file', new Blob([audioBuffer], { type: 'audio/ogg' }), filename);
  form.append('model', 'whisper-large-v3-turbo');
  // Let Whisper auto-detect the language for multilingual support

  const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${groqApiKey}` },
    body: form,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Whisper error ${res.status}: ${err}`);
  }

  const data = await res.json() as { text: string };
  return data.text.trim();
}

// ── Screenshot helper ──────────────────────────────────────────────────────────
async function getRecentScreenshot(withinMs = 60_000): Promise<Buffer | null> {
  if (!existsSync(SCREENSHOT_PATH)) return null;
  try {
    const s = await stat(SCREENSHOT_PATH);
    if (Date.now() - s.mtimeMs < withinMs) return await readFile(SCREENSHOT_PATH);
  } catch { /* ignore */ }
  return null;
}

const TOOL_LABELS: Record<string, string> = {
  browser: 'navegador',
  get_weather: 'clima',
  execute_command: 'terminal',
  file_system: 'archivos',
  http_get: 'HTTP',
  calculate: 'cálculo',
  get_system_info: 'sistema',
  save_note: 'notas',
  forge_tool: 'forjando herramienta',
};

const PROVIDER_NAMES: Record<string, string> = {
  groq: 'Groq',
  anthropic: 'Claude (Anthropic)',
  openai: 'OpenAI',
  ollama: 'Ollama (local)',
};

function providerDisplay(name?: string): string {
  if (!name) return 'desconocido';
  if (name.startsWith('openrouter:')) {
    return name.slice('openrouter:'.length).replace(':free', ' (free)');
  }
  return PROVIDER_NAMES[name] ?? name;
}

// ── Shared message processor ───────────────────────────────────────────────────
async function processMessage(
  ctx: Context,
  gateway: GatewayClient,
  userMessage: string,
  chatId: number,
  userId: string,
  isVoice = false,
) {
  let sessionId = sessionMap.get(chatId);
  if (!sessionId) {
    sessionId = `tg-${chatId}-${Date.now()}`;
    sessionMap.set(chatId, sessionId);
  }

  // Persistir el chat del señor para que Emma pueda escribirle de forma proactiva
  // (informe matutino, vigías…). Se escribe una sola vez por arranque.
  rememberOwnerChat(chatId);

  // Show what we understood if voice
  const thinking = await ctx.reply(isVoice ? `🎙️ _"${userMessage}"_\n\n...` : '...', {
    parse_mode: isVoice ? 'Markdown' : undefined,
  });

  let responseText = '';
  let lastUpdate = Date.now();
  let screenshotUsed = false;
  const mediaFiles = new Set<string>();
  const UPDATE_INTERVAL_MS = 1_500;

  const lc = userMessage.toLowerCase();
  if (lc.includes('captura') || lc.includes('screenshot') || lc.includes('foto de')) {
    screenshotUsed = true;
  }

  try {
    for await (const event of gateway.streamChat({ sessionId, userId, message: userMessage })) {
      if (event.type === 'text_delta' && event.text) {
        responseText += event.text;
        const now = Date.now();
        if (now - lastUpdate > UPDATE_INTERVAL_MS && responseText) {
          lastUpdate = now;
          const display = isVoice ? `🎙️ _"${userMessage}"_\n\n${responseText}` : responseText;
          try { await ctx.api.editMessageText(chatId, thinking.message_id, display, { parse_mode: 'Markdown' }); } catch { /* ignore */ }
        }
      } else if (event.type === 'tool_start' && event.toolName) {
        const label = TOOL_LABELS[event.toolName] ?? event.toolName;
        if (!responseText) {
          const display = isVoice
            ? `🎙️ _"${userMessage}"_\n\n🔧 Usando herramienta: ${label}...`
            : `🔧 Usando herramienta: ${label}...`;
          try { await ctx.api.editMessageText(chatId, thinking.message_id, display, { parse_mode: 'Markdown' }); } catch { /* ignore */ }
        }
        if (event.toolName === 'browser') screenshotUsed = true;
      } else if (event.type === 'tool_end' && event.toolResult) {
        // Detectar archivos de medios que una herramienta (forjada o no) haya generado
        for (const m of event.toolResult.matchAll(/\/tmp\/emma\/[\w./-]+\.(wav|mp3|ogg|oga|jpg|jpeg|png|mp4)/gi)) {
          mediaFiles.add(m[0]);
        }
      } else if (event.type === 'provider_switched') {
        const from = providerDisplay(event.fromProvider);
        const to   = providerDisplay(event.toProvider);
        const slowNote = event.toProvider === 'ollama'
          ? '\n\n🐢 _Modo local: la respuesta puede tardar 1–2 minutos, señor. Las cuotas cloud se renuevan a las 19:00._'
          : '';
        await ctx.reply(`⚠️ Tokens agotados en *${from}*, señor.\nCambiando automáticamente a *${to}*.${slowNote}`, { parse_mode: 'Markdown' });
      }
    }

    if (screenshotUsed) {
      const imgBuf = await getRecentScreenshot();
      if (imgBuf) {
        await ctx.replyWithPhoto(new InputFile(imgBuf, 'screenshot.png'), { caption: '📸 Captura de pantalla' });
      }
    }

    // Entregar archivos de medios producidos por herramientas (audio TTS, fotos de cámara, etc.)
    let audioDelivered = false;
    for (const filePath of mediaFiles) {
      if (!existsSync(filePath)) continue;
      try {
        const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
        if (['wav', 'mp3', 'ogg', 'oga'].includes(ext)) {
          // Convertir a OGG Opus para que llegue como nota de voz nativa
          const voicePath = ['ogg', 'oga'].includes(ext) ? filePath : ((await toVoiceOgg(filePath)) ?? filePath);
          const file = new InputFile(voicePath);
          await ctx.replyWithVoice(file).catch(() => ctx.replyWithAudio(new InputFile(filePath)));
          audioDelivered = true;
        } else if (['jpg', 'jpeg', 'png'].includes(ext)) {
          await ctx.replyWithPhoto(new InputFile(filePath));
        } else if (ext === 'mp4') {
          await ctx.replyWithVideo(new InputFile(filePath));
        }
      } catch (err) {
        logger.warn({ err, filePath }, 'Failed to deliver media file');
      }
    }

    // Si el señor habló por voz, Emma responde SIEMPRE por voz (salvo que una
    // herramienta ya haya generado audio en este turno)
    let voiceSent = false;
    if (isVoice && responseText && !audioDelivered) {
      const voicePath = await synthesizeVoiceReply(responseText);
      if (voicePath) {
        voiceSent = await ctx.replyWithVoice(new InputFile(voicePath))
          .then(() => true)
          .catch(() =>
            ctx.replyWithAudio(new InputFile(voicePath)).then(() => true).catch(() => false),
          );
      }
    }

    // Texto final: si la respuesta ya salió en audio, dejar solo la transcripción;
    // el texto completo solo se muestra como respaldo si la voz falló
    if (isVoice && (voiceSent || audioDelivered)) {
      await ctx.api.editMessageText(chatId, thinking.message_id, `🎙️ _"${userMessage}"_`, { parse_mode: 'Markdown' }).catch(() => null);
    } else if (responseText) {
      const finalDisplay = isVoice ? `🎙️ _"${userMessage}"_\n\n${responseText}` : responseText;
      await ctx.api.editMessageText(chatId, thinking.message_id, finalDisplay, { parse_mode: 'Markdown' }).catch(async () => {
        // If Markdown fails, fallback to plain text
        await ctx.api.editMessageText(chatId, thinking.message_id, responseText).catch(() => null);
      });
    } else {
      await ctx.api.deleteMessage(chatId, thinking.message_id).catch(() => null);
    }
  } catch (err) {
    logger.error({ err, chatId }, 'Error processing message');
    try {
      await ctx.api.editMessageText(chatId, thinking.message_id, '❌ Error al procesar tu mensaje.');
    } catch {
      await ctx.reply('❌ Error al procesar tu mensaje.');
    }
  }
}

// ── Handler registration ───────────────────────────────────────────────────────
export function registerHandlers(bot: Bot<Context>, gateway: GatewayClient, opts: HandlerOptions) {
  const { botToken, groqApiKey } = opts;

  bot.command('start', async (ctx) => {
    await ctx.reply(
      '¡Hola! Soy *Emma*, tu asistente de IA personal.\n\n' +
      'Puedes escribirme o *enviarme un mensaje de voz* 🎙️\n\n' +
      'Comandos:\n/new — Nueva conversación\n/help — Ayuda',
      { parse_mode: 'Markdown' },
    );
  });

  bot.command('new', async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId) sessionMap.delete(chatId);
    await ctx.reply('Nueva conversación iniciada.');
  });

  bot.command('help', async (ctx) => {
    await ctx.reply(
      '🤖 *Emma — Guía rápida*\n\n' +
      '*Entrada:*\n• Texto ✍️\n• Mensaje de voz 🎙️ (transcripción automática)\n\n' +
      '*Proveedores soportados:*\n' +
      '• `gsk_...` → Groq\n• `sk-ant-...` → Claude\n• `sk-or-...` → OpenRouter (modelos gratis)\n• `sk-...` → OpenAI\n• _(sin clave)_ → Ollama\n\n' +
      'Envía la clave directamente para activarla.\n\n' +
      '*Modelos:*\n/models — Ver cadena de fallback y modelos gratis\n/model `<n>` — Cambiar el modelo activo',
      { parse_mode: 'Markdown' },
    );
  });

  // ── Model selection ───────────────────────────────────────────────────────────
  // chatId → ids in the order they were displayed by /models
  const modelChoices = new Map<number, string[]>();

  bot.command('models', async (ctx) => {
    try {
      const info = await gateway.getModels();
      const choices: string[] = [];
      let text = '🧠 *Cadena de fallback:*\n';
      for (const p of info.providers) {
        choices.push(p.name);
        const status = p.active ? ' ✅' : p.exhausted ? ' ⏳ (agotado)' : '';
        text += `${choices.length}. ${providerDisplay(p.name)}${status}\n`;
      }
      const inChain = new Set(info.providers.map((p) => p.name.replace(/^openrouter:/, '')));
      const available = info.catalog.filter((m) => !inChain.has(m.id));
      if (available.length > 0) {
        text += '\n🆓 *Modelos gratis (OpenRouter):*\n';
        for (const m of available.slice(0, 15)) {
          choices.push(m.id);
          text += `${choices.length}. ${m.name} · ${Math.round(m.contextLength / 1024)}k ctx\n`;
        }
      }
      text += '\nUse /model `<número>` para activar uno, señor.';
      modelChoices.set(ctx.chat.id, choices);
      await ctx.reply(text, { parse_mode: 'Markdown' });
    } catch (err) {
      logger.error({ err }, 'Failed to fetch models');
      await ctx.reply('❌ No pude consultar los modelos. ¿Está el agente en marcha?');
    }
  });

  bot.command('model', async (ctx) => {
    const arg = (ctx.match ?? '').trim();
    if (!arg) {
      await ctx.reply('Indique el número o id del modelo, señor. Ejemplo: /model 2\nVea la lista con /models');
      return;
    }
    const choices = modelChoices.get(ctx.chat.id) ?? [];
    const num = Number(arg);
    const target = Number.isInteger(num) && num >= 1 && num <= choices.length
      ? choices[num - 1]!
      : arg;
    try {
      const result = await gateway.selectModel(target);
      await ctx.reply(`✅ Modelo activo: *${providerDisplay(result.current)}*`, { parse_mode: 'Markdown' });
    } catch (err) {
      await ctx.reply(`❌ ${(err as Error).message}`);
    }
  });

  // ── Voice messages ────────────────────────────────────────────────────────────
  bot.on('message:voice', async (ctx) => {
    const chatId = ctx.chat.id;
    const userId = String(ctx.from?.id ?? chatId);

    if (!groqApiKey) {
      await ctx.reply('⚠️ No hay clave Groq configurada para transcripción de voz, señor. Envía una clave `gsk_...` para activarlo.', { parse_mode: 'Markdown' });
      return;
    }

    const statusMsg = await ctx.reply('🎙️ Transcribiendo audio...');

    try {
      // Download voice file from Telegram
      const fileId = ctx.message.voice.file_id;
      const file = await ctx.api.getFile(fileId);
      const fileUrl = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;

      const audioRes = await fetch(fileUrl);
      if (!audioRes.ok) throw new Error(`Failed to download voice: ${audioRes.status}`);
      const audioBuffer = Buffer.from(await audioRes.arrayBuffer());

      // Transcribe with Groq Whisper
      const transcription = await transcribeVoice(audioBuffer, 'voice.ogg', groqApiKey);

      if (!transcription) {
        await ctx.api.editMessageText(chatId, statusMsg.message_id, '⚠️ No pude entender el audio, señor.');
        return;
      }

      logger.info({ transcription }, 'Voice transcribed');

      // Delete status message and process as normal message
      await ctx.api.deleteMessage(chatId, statusMsg.message_id).catch(() => null);
      await processMessage(ctx, gateway, transcription, chatId, userId, true);

    } catch (err) {
      logger.error({ err }, 'Voice processing error');
      await ctx.api.editMessageText(chatId, statusMsg.message_id, '❌ Error al procesar el mensaje de voz.').catch(() => null);
    }
  });

  // ── Audio files (video notes, audio) ─────────────────────────────────────────
  bot.on('message:audio', async (ctx) => {
    const chatId = ctx.chat.id;
    const userId = String(ctx.from?.id ?? chatId);

    if (!groqApiKey) {
      await ctx.reply('⚠️ No hay clave Groq para transcripción de audio.');
      return;
    }

    const statusMsg = await ctx.reply('🎵 Transcribiendo audio...');
    try {
      const fileId = ctx.message.audio.file_id;
      const file = await ctx.api.getFile(fileId);
      const fileUrl = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
      const audioRes = await fetch(fileUrl);
      const audioBuffer = Buffer.from(await audioRes.arrayBuffer());
      const mimeType = ctx.message.audio.mime_type ?? 'audio/mpeg';
      const ext = mimeType.split('/')[1] ?? 'mp3';

      const transcription = await transcribeVoice(audioBuffer, `audio.${ext}`, groqApiKey);
      await ctx.api.deleteMessage(chatId, statusMsg.message_id).catch(() => null);

      if (transcription) {
        await processMessage(ctx, gateway, transcription, chatId, userId, true);
      } else {
        await ctx.reply('⚠️ No pude transcribir el audio.');
      }
    } catch (err) {
      logger.error({ err }, 'Audio processing error');
      await ctx.api.editMessageText(chatId, statusMsg.message_id, '❌ Error al procesar el audio.').catch(() => null);
    }
  });

  // ── Photos ────────────────────────────────────────────────────────────────────
  // Se descarga la foto a /tmp/emma/ y se pasa la ruta al agente; el agente usa
  // (o forja) una herramienta de visión local (moondream en Ollama) para verla.
  bot.on('message:photo', async (ctx) => {
    const chatId = ctx.chat.id;
    const userId = String(ctx.from?.id ?? chatId);

    const statusMsg = await ctx.reply('👁 Recibiendo imagen...');
    try {
      // Last entry = highest resolution
      const photos = ctx.message.photo;
      const fileId = photos[photos.length - 1]?.file_id;
      if (!fileId) throw new Error('No photo file_id');

      const file = await ctx.api.getFile(fileId);
      const fileUrl = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
      const imgRes = await fetch(fileUrl);
      if (!imgRes.ok) throw new Error(`Failed to download photo: ${imgRes.status}`);
      const imgBuffer = Buffer.from(await imgRes.arrayBuffer());

      mkdirSync('/tmp/emma', { recursive: true });
      const imgPath = `/tmp/emma/photo-${Date.now()}.jpg`;
      writeFileSync(imgPath, imgBuffer);

      const caption = ctx.message.caption?.trim();
      const userMessage = `${caption ?? '¿Qué ves en esta imagen? Descríbela.'}\n[imagen adjunta guardada en: ${imgPath}]`;

      await ctx.api.deleteMessage(chatId, statusMsg.message_id).catch(() => null);
      await processMessage(ctx, gateway, userMessage, chatId, userId, false);
    } catch (err) {
      logger.error({ err }, 'Photo processing error');
      await ctx.api.editMessageText(chatId, statusMsg.message_id, '❌ Error al procesar la imagen.').catch(() => null);
    }
  });

  // ── Text messages ─────────────────────────────────────────────────────────────
  bot.on('message:text', async (ctx) => {
    const chatId = ctx.chat.id;
    const userId = String(ctx.from?.id ?? chatId);
    const userMessage = ctx.message.text;

    // Email setup — detect any email address in the message
    const emailSetupMatch = userMessage.match(/([\w.+-]+@[\w.-]+\.\w+)/);
    if (emailSetupMatch) {
      const emailAddr = emailSetupMatch[1] ?? '';
      // Save email address but NOT the password (it may be the real account password)
      updateEnv('EMAIL_USER', emailAddr);
      await ctx.reply(
        `📧 Correo *${emailAddr}* registrado, señor.\n\n` +
        `⚠️ *Importante:* No necesito su contraseña de Gmail normal.\n` +
        `Necesito una *Contraseña de Aplicación* (código de 16 letras generado por Google).\n\n` +
        `*Cómo obtenerla:*\n` +
        `1. Vaya a → myaccount.google.com/apppasswords\n` +
        `2. En "Seleccionar app" elija *"Correo"*\n` +
        `3. En "Seleccionar dispositivo" elija *"Otro"* → escriba "Emma"\n` +
        `4. Pulse *Generar*\n` +
        `5. Envíeme el código de 16 letras (ej: \`abcd efgh ijkl mnop\`)\n\n` +
        `_Su contraseña de Gmail real nunca se guarda aquí._`,
        { parse_mode: 'Markdown' },
      );
      return;
    }

    // Gmail App Password (16 lowercase letters, optionally spaced in groups of 4)
    const appPwMatch = userMessage.match(/^([a-z]{4} [a-z]{4} [a-z]{4} [a-z]{4}|[a-z]{16})$/i);
    if (appPwMatch) {
      const appPassword = (appPwMatch[1] ?? '').replace(/\s/g, '');
      updateEnv('EMAIL_PASSWORD', appPassword);
      restartAgent();
      await ctx.reply(
        `🔐 Contraseña de aplicación guardada, señor.\n` +
        `El agente reiniciará en ~5 segundos.\n\n` +
        `Después puede pedirme:\n` +
        `• _"Muéstrame mis últimos correos"_\n` +
        `• _"¿Tengo emails de trabajo?"_\n` +
        `• _"Envía un correo a X"_`,
        { parse_mode: 'Markdown' },
      );
      return;
    }

    // Integraciones no-LLM detectadas en el chat (se interceptan ANTES de llegar al modelo)
    const ghMatch = userMessage.match(/\b(ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/);
    if (ghMatch) {
      await ctx.reply('🔑 Token de *GitHub* detectado, señor. Lo guardo de forma segura, sin que pase por ningún modelo.', { parse_mode: 'Markdown' });
      try {
        updateEnv('GH_TOKEN', ghMatch[0]);
        restartAgent();
        await ctx.reply('✅ *GitHub* conectado. Le recomiendo regenerar este token si lo pegó antes en un chat.', { parse_mode: 'Markdown' });
      } catch {
        await ctx.reply('❌ Error al guardar el token de GitHub.');
      }
      return;
    }

    // API key rotation
    const detected = detectProvider(userMessage);
    if (detected) {
      const { provider, key } = detected;
      await ctx.reply(`🔑 Clave de *${provider.label}* detectada, señor. Actualizando...`, { parse_mode: 'Markdown' });
      try {
        updateEnv(provider.envKey, key, provider.name === 'groq' ? { GROQ_MODEL: provider.model } : undefined);
        restartAgent();
        await ctx.reply(`✅ *${provider.label}* activado.\nAgente listo en ~5 segundos.`, { parse_mode: 'Markdown' });
      } catch (err) {
        logger.error({ err }, 'Failed to rotate API key');
        await ctx.reply('❌ Error al actualizar la clave.');
      }
      return;
    }

    await processMessage(ctx, gateway, userMessage, chatId, userId, false);
  });
}
