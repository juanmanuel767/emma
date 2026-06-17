import fs from 'node:fs';
import { resolve } from 'node:path';
import cp from 'node:child_process';

/**
 * Guard de runtime contra exfiltración de secretos.
 *
 * El análisis ESTÁTICO de la forja es evadible (el modelo puede construir la ruta `.env`
 * por concatenación, p.ej. `'.e'+'nv'`, o nombres ofuscados). La única defensa a prueba de
 * evasión es interceptar el ACCESO real: parcheamos `fs` y `child_process` para que NINGÚN
 * código del proceso del agente —incluidas las herramientas forjadas— pueda leer archivos
 * secreto ni volcar variables de entorno, sin importar cómo se haya construido la cadena.
 *
 * Se instala una sola vez, lo antes posible en el arranque. Emma ya tiene sus claves en
 * process.env (cargadas por dotenv al inicio); el guard solo bloquea LECTURAS posteriores
 * de rutas/comandos sensibles, así que no rompe el funcionamiento legítimo.
 */

export const SECURITY_BLOCK = 'EMMA_SECURITY_BLOCK';

// Rutas cuyo contenido es secreto. Se evalúa sobre la ruta REAL pasada a fs (ya resuelta),
// por lo que cualquier ofuscación de la cadena de origen es irrelevante.
const SECRET_PATH_RE =
  /(^|[/\\])\.env(\.[\w-]+)?$|(^|[/\\])\.env$|\.(pem|key|p12|pfx)$|(^|[/\\])(id_rsa|id_ed25519|id_dsa|credentials|\.npmrc|\.pgpass|\.netrc)$|[/\\]etc[/\\](shadow|passwd|sudoers)$|(^|[/\\])\.ssh[/\\]/i;

// Comandos que vuelcan el entorno (donde viven todas las claves del agente).
const ENV_DUMP_CMD_RE = /^(env|printenv|set|declare|export)$/i;

function pathLooksSecret(p: unknown): boolean {
  if (typeof p !== 'string' || !p) return false;
  if (SECRET_PATH_RE.test(p)) return true;
  try {
    return SECRET_PATH_RE.test(resolve(p));
  } catch {
    return false;
  }
}

function denyPath(p: unknown): Error {
  return new Error(`${SECURITY_BLOCK}: acceso denegado a archivo sensible (${String(p).slice(0, 80)})`);
}

function denyCmd(c: unknown): Error {
  return new Error(`${SECURITY_BLOCK}: comando denegado por política de seguridad (${String(c).slice(0, 60)})`);
}

function commandIsSecret(command: string, args: readonly string[] = []): boolean {
  const base = (command.split(/[/\\]/).pop() ?? command).trim();
  if (ENV_DUMP_CMD_RE.test(base)) return true;
  if (pathLooksSecret(command)) return true;
  // El comando completo puede venir en una sola cadena (shell:true): inspeccionarla.
  if (/\b(env|printenv)\b/.test(command) && !command.includes('=')) return true;
  return args.some((a) => pathLooksSecret(a)) || pathLooksSecret(`${command} ${args.join(' ')}`);
}

let installed = false;

export function installRuntimeSecretGuard(): void {
  if (installed) return;
  installed = true;

  // ── fs: lecturas ────────────────────────────────────────────────────────────
  const wrapPathFn = <T extends (...a: any[]) => any>(orig: T): T =>
    function (this: unknown, ...args: Parameters<T>): ReturnType<T> {
      if (pathLooksSecret(args[0])) throw denyPath(args[0]);
      return orig.apply(this, args);
    } as T;

  fs.readFileSync = wrapPathFn(fs.readFileSync.bind(fs)) as typeof fs.readFileSync;
  fs.createReadStream = wrapPathFn(fs.createReadStream.bind(fs)) as typeof fs.createReadStream;
  fs.openSync = wrapPathFn(fs.openSync.bind(fs)) as typeof fs.openSync;

  // fs.readFile / fs.open son callback-based: rechazar vía callback, no throw síncrono.
  const origReadFile = fs.readFile.bind(fs);
  fs.readFile = function (this: unknown, ...args: any[]): void {
    if (pathLooksSecret(args[0])) {
      const cb = args[args.length - 1];
      if (typeof cb === 'function') return void cb(denyPath(args[0]));
      throw denyPath(args[0]);
    }
    return (origReadFile as any).apply(this, args);
  } as typeof fs.readFile;

  // fs.promises.readFile / .open (lo que usan las herramientas forjadas con import()).
  const p = fs.promises;
  const origPReadFile = p.readFile.bind(p);
  p.readFile = ((...args: any[]) =>
    pathLooksSecret(args[0]) ? Promise.reject(denyPath(args[0])) : (origPReadFile as any)(...args)) as typeof p.readFile;
  const origPOpen = p.open.bind(p);
  p.open = ((...args: any[]) =>
    pathLooksSecret(args[0]) ? Promise.reject(denyPath(args[0])) : (origPOpen as any)(...args)) as typeof p.open;

  // ── child_process: volcado de entorno / lectura de secretos por shell ─────────
  const wrapSpawn = <T extends (...a: any[]) => any>(orig: T): T =>
    function (this: unknown, ...args: any[]): ReturnType<T> {
      const command = String(args[0] ?? '');
      const maybeArgs = Array.isArray(args[1]) ? (args[1] as string[]) : [];
      if (commandIsSecret(command, maybeArgs)) throw denyCmd(command);
      return orig.apply(this, args);
    } as T;
  cp.spawn = wrapSpawn(cp.spawn.bind(cp)) as typeof cp.spawn;
  cp.spawnSync = wrapSpawn(cp.spawnSync.bind(cp)) as typeof cp.spawnSync;
  cp.execSync = wrapSpawn(cp.execSync.bind(cp)) as typeof cp.execSync;
  cp.execFileSync = wrapSpawn(cp.execFileSync.bind(cp)) as typeof cp.execFileSync;

  // exec / execFile son callback-based.
  const wrapExec = <T extends (...a: any[]) => any>(orig: T): T =>
    function (this: unknown, ...args: any[]): ReturnType<T> {
      const command = String(args[0] ?? '');
      const maybeArgs = Array.isArray(args[1]) ? (args[1] as string[]) : [];
      if (commandIsSecret(command, maybeArgs)) {
        const cb = args.find((a) => typeof a === 'function');
        if (cb) return void (cb as (e: Error) => void)(denyCmd(command)) as ReturnType<T>;
        throw denyCmd(command);
      }
      return orig.apply(this, args);
    } as T;
  cp.exec = wrapExec(cp.exec.bind(cp)) as typeof cp.exec;
  cp.execFile = wrapExec(cp.execFile.bind(cp)) as typeof cp.execFile;
}
