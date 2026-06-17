import os from 'node:os';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

// ─────────────────────────────────────────────────────────────────────────────
// Detección de hardware (Fase B). Lógica rescatada con cirugía de la sesión revertida
// (solo el probe, sin la orquestación OLLAMA_FIRST que se descartó). Mide RAM/CPU/GPU
// para que el Gestor de Modelos diga qué modelos soporta el equipo y cuáles serán lentos.
// ─────────────────────────────────────────────────────────────────────────────

export interface Hardware {
  ramTotalGB: number;
  ramAvailGB: number;
  cores: number;
  gpu: { present: boolean; vramGB: number };
}

function probeGpu(): { present: boolean; vramGB: number } {
  try {
    const out = execFileSync('nvidia-smi', ['--query-gpu=memory.total', '--format=csv,noheader,nounits'], {
      timeout: 1500,
      encoding: 'utf8',
    });
    const mb = parseInt(out.trim().split('\n')[0] ?? '0', 10);
    if (mb > 0) return { present: true, vramGB: mb / 1024 };
  } catch {
    /* sin GPU NVIDIA */
  }
  return { present: false, vramGB: 0 };
}

export function probeHardware(): Hardware {
  let ramTotalGB = os.totalmem() / 1e9;
  let ramAvailGB = os.freemem() / 1e9;
  try {
    const mi = readFileSync('/proc/meminfo', 'utf8');
    const total = /MemTotal:\s+(\d+)\s*kB/.exec(mi);
    const avail = /MemAvailable:\s+(\d+)\s*kB/.exec(mi);
    if (total) ramTotalGB = (Number(total[1]) * 1024) / 1e9;
    if (avail) ramAvailGB = (Number(avail[1]) * 1024) / 1e9;
  } catch {
    /* usar os.* */
  }
  return { ramTotalGB, ramAvailGB, cores: os.cpus().length || 1, gpu: probeGpu() };
}

/** Resumen legible: "16 GB RAM · 4 núcleos · sin GPU". */
export function hardwareSummary(hw: Hardware): string {
  const gpu = hw.gpu.present ? `GPU ${hw.gpu.vramGB.toFixed(0)} GB VRAM` : 'sin GPU';
  return `${hw.ramTotalGB.toFixed(0)} GB RAM · ${hw.cores} núcleos · ${gpu}`;
}

/**
 * Evalúa un modelo contra el hardware:
 * - fits:  la RAM total alcanza el mínimo recomendado.
 * - heavy: cabe, pero sin GPU un modelo ≥4 GB va lento (>1 min/respuesta en CPU).
 */
export function evaluateForHardware(
  hw: Hardware,
  model: { minRamGB: number; sizeGB: number },
): { fits: boolean; heavy: boolean } {
  const fits = hw.ramTotalGB >= model.minRamGB;
  const heavy = fits && !hw.gpu.present && model.sizeGB >= 4;
  return { fits, heavy };
}
