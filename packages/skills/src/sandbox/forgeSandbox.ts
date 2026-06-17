import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLogger } from '@emma/shared/logger';

const logger = createLogger('ForgeSandbox');

/**
 * Aislamiento de la forja (Capa 1).
 *
 * Las herramientas forjadas son código que escribió un MODELO. Ejecutarlas en el proceso del
 * agente les da acceso directo a `process.env` (todas las claves) y a `fs`/`child_process`.
 * Aquí se ejecutan en un **subproceso de Node separado** con:
 *   1. El entorno DEPURADO de secretos → `process.env.GROQ_API_KEY` es `undefined` dentro.
 *   2. Un guard de runtime que deniega leer archivos secreto y volcar el entorno.
 *   3. Timeout y captura de resultado por stdout (JSON).
 * Así, aunque el código forjado sea malicioso, no puede ver ni exfiltrar credenciales.
 */

export interface SandboxResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

// Variables de entorno cuyo valor es secreto: se eliminan del subproceso.
const SECRET_ENV_RE = /(API_KEY|TOKEN|SECRET|PASSWORD|PASSWD|DATABASE_URL|PRIVATE_KEY|_KEY|JWT|REDIS_URL)/i;

function scrubbedEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (SECRET_ENV_RE.test(k)) continue;
    out[k] = v;
  }
  // Señal para el código forjado (y para depurar) de que corre aislado.
  out['EMMA_SANDBOX'] = '1';
  return out;
}

// Runner autocontenido (.mjs). Recibe {entryPath, toolName, input, ctx} por stdin, instala el
// guard, IMPORTA EL MÓDULO COMPLETO de la skill por su ruta (así se preservan sus imports y
// helpers de ámbito de módulo — no se rompe ninguna skill) y ejecuta la herramienta pedida con
// un entorno ya depurado de secretos. Emite el resultado por stdout.
const RUNNER_SOURCE = String.raw`
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
// Usar require (CJS) para fs/child_process: así se parchea module.exports ANTES de importar la
// skill, y el namespace ESM que la skill obtenga hereda las funciones YA parcheadas (si se
// importaran como ESM aquí, el namespace congelaría las originales). Se parchean también
// 'node:fs/promises' y 'node:child_process' explícitamente por si la skill los importa directos.
const require = createRequire(import.meta.url);
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const cp = require('node:child_process');
const { resolve } = require('node:path');

const SECRET_PATH_RE = /(^|[/\\])\.env(\.[\w-]+)?$|(^|[/\\])\.env$|\.(pem|key|p12|pfx)$|(^|[/\\])(id_rsa|id_ed25519|id_dsa|credentials|\.npmrc|\.pgpass|\.netrc)$|[/\\]etc[/\\](shadow|passwd|sudoers)$|(^|[/\\])\.ssh[/\\]/i;
const ENV_DUMP_RE = /^(env|printenv|set|declare|export)$/i;
function secretPath(p){ if(typeof p!=='string'||!p) return false; if(SECRET_PATH_RE.test(p)) return true; try { return SECRET_PATH_RE.test(resolve(p)); } catch { return false; } }
function denyP(p){ return new Error('EMMA_SANDBOX_BLOCK: archivo sensible '+String(p).slice(0,80)); }
function denyC(c){ return new Error('EMMA_SANDBOX_BLOCK: comando '+String(c).slice(0,60)); }
const wrapPath = (orig)=>function(...a){ if(secretPath(a[0])) throw denyP(a[0]); return orig.apply(this,a); };
fs.readFileSync = wrapPath(fs.readFileSync.bind(fs));
fs.createReadStream = wrapPath(fs.createReadStream.bind(fs));
fs.openSync = wrapPath(fs.openSync.bind(fs));
const orf = fs.readFile.bind(fs);
fs.readFile = function(...a){ if(secretPath(a[0])){ const cb=a[a.length-1]; if(typeof cb==='function') return void cb(denyP(a[0])); throw denyP(a[0]); } return orf.apply(this,a); };
// Parchear AMBOS: fs.promises y el módulo 'node:fs/promises' (objetos distintos en Node).
for (const pr of [fs.promises, fsp]) {
  if (!pr || pr.__emmaPatched) continue;
  const oprf = pr.readFile.bind(pr);
  pr.readFile = (...a)=> secretPath(a[0]) ? Promise.reject(denyP(a[0])) : oprf(...a);
  const opro = pr.open.bind(pr);
  pr.open = (...a)=> secretPath(a[0]) ? Promise.reject(denyP(a[0])) : opro(...a);
  try { Object.defineProperty(pr, '__emmaPatched', { value: true, enumerable: false }); } catch {}
}
function cmdSecret(command, args=[]){ const base=(String(command).split(/[/\\]/).pop()||command).trim(); if(ENV_DUMP_RE.test(base)) return true; if(secretPath(command)) return true; return args.some(secretPath); }
const wrapSpawn = (orig)=>function(...a){ if(cmdSecret(String(a[0]||''), Array.isArray(a[1])?a[1]:[])) throw denyC(a[0]); return orig.apply(this,a); };
cp.spawn = wrapSpawn(cp.spawn.bind(cp));
cp.spawnSync = wrapSpawn(cp.spawnSync.bind(cp));
cp.execSync = wrapSpawn(cp.execSync.bind(cp));
cp.execFileSync = wrapSpawn(cp.execFileSync.bind(cp));
// IMPORTANTE: preservar el símbolo util.promisify.custom de exec/execFile. Si no, promisify()
// deja de devolver {stdout,stderr} (devuelve solo stdout) y rompe TODA skill que use
// promisify(execFile)/promisify(exec) — p.ej. emma-control, whatsapp, scheduler.
const PC = require('node:util').promisify.custom;
const origExec = cp.exec.bind(cp);
const origExecCustom = cp.exec[PC];
const guardExec = function(...a){ if(cmdSecret(String(a[0]||''))){ const cb=a.find(x=>typeof x==='function'); if(cb) return void cb(denyC(a[0])); throw denyC(a[0]); } return origExec(...a); };
if (origExecCustom) guardExec[PC] = (cmd, opts)=> cmdSecret(String(cmd||'')) ? Promise.reject(denyC(cmd)) : origExecCustom(cmd, opts);
cp.exec = guardExec;
const origExecFile = cp.execFile.bind(cp);
const origExecFileCustom = cp.execFile[PC];
const guardExecFile = function(...a){ if(cmdSecret(String(a[0]||''), Array.isArray(a[1])?a[1]:[])){ const cb=a.find(x=>typeof x==='function'); if(cb) return void cb(denyC(a[0])); throw denyC(a[0]); } return origExecFile(...a); };
if (origExecFileCustom) guardExecFile[PC] = (file, args, opts)=> cmdSecret(String(file||''), Array.isArray(args)?args:[]) ? Promise.reject(denyC(file)) : origExecFileCustom(file, args, opts);
cp.execFile = guardExecFile;

let raw='';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d=> raw+=d);
process.stdin.on('end', async ()=>{
  let res;
  try {
    const { entryPath, toolName, input, ctx } = JSON.parse(raw);
    // Importar el MÓDULO COMPLETO de la skill (con sus imports y helpers de ámbito), ya con el
    // guard instalado. Cache-bust para respetar el hot-reload de la forja.
    const mod = await import(pathToFileURL(entryPath).href + '?v=' + Date.now());
    const def = mod && mod.default ? mod.default : mod;
    const tool = (def.tools || []).find(t => t && t.name === toolName);
    if (!tool || typeof tool.execute !== 'function') throw new Error('herramienta ' + toolName + ' no encontrada en la skill');
    const data = await Promise.race([
      tool.execute(input, ctx),
      new Promise((_, rej)=> setTimeout(()=> rej(new Error('sandbox timeout interno')), 9000)),
    ]);
    res = (data && typeof data==='object' && 'success' in data) ? data : { success: true, data };
  } catch (e) {
    res = { success: false, error: String((e && e.message) || e).slice(0, 300) };
  }
  try { process.stdout.write(JSON.stringify(res)); } catch { process.stdout.write('{"success":false,"error":"resultado no serializable"}'); }
});
`;

let runnerPath: string | null = null;
function ensureRunner(): string {
  if (runnerPath) return runnerPath;
  const dir = join(tmpdir(), 'emma');
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'forge-sandbox-runner.mjs');
  writeFileSync(p, RUNNER_SOURCE, 'utf8');
  runnerPath = p;
  return p;
}

/** Ejecuta una herramienta de una skill forjada (importando su módulo por ruta) en un
 *  subproceso aislado y sin secretos. Preserva imports y helpers de ámbito de la skill. */
export function runForgedInSandbox(
  entryPath: string,
  toolName: string,
  input: unknown,
  ctx: { sessionId?: string; conversationId?: string } | undefined,
  timeoutMs = 10_000,
): Promise<SandboxResult> {
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(process.execPath, [ensureRunner()], {
        env: scrubbedEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      // Si NI SIQUIERA arranca el sandbox, fallar cerrado (no ejecutar en proceso).
      return resolvePromise({ success: false, error: `sandbox no disponible: ${(err as Error).message}` });
    }

    let out = '';
    let errOut = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolvePromise({ success: false, error: `La herramienta excedió ${timeoutMs} ms y fue detenida.` });
    }, timeoutMs);

    child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { errOut += d.toString(); });
    child.on('error', (e: Error) => {
      clearTimeout(timer);
      resolvePromise({ success: false, error: `sandbox falló: ${e.message}` });
    });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        resolvePromise(JSON.parse(out) as SandboxResult);
      } catch {
        if (errOut) logger.warn({ errOut: errOut.slice(0, 200) }, 'Sandbox stderr');
        resolvePromise({ success: false, error: `sandbox sin salida válida: ${(errOut || out || 'vacío').slice(0, 200)}` });
      }
    });

    const payload = JSON.stringify({
      entryPath,
      toolName,
      input,
      ctx: { sessionId: ctx?.sessionId, conversationId: ctx?.conversationId },
    });
    child.stdin.write(payload);
    child.stdin.end();
  });
}
