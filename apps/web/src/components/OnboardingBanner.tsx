import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchOnboarding,
  pullModel,
  type OnboardingInfo,
  type PullProgress,
} from '../services/api.js';

const DISMISS_KEY = 'emma_onboarded';

function fmtBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 GB';
  const gb = bytes / 1e9;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / 1e6).toFixed(0)} MB`;
}

/**
 * Bienvenida de primer arranque (Fase C). Detecta hardware + Ollama y ofrece instalar,
 * con un clic, el mejor modelo local apto para el equipo. Se oculta tras instalar u omitir.
 * Reutiliza por completo el Gestor de Modelos (Fase A) y la detección de hardware (Fase B).
 */
export function OnboardingBanner() {
  const [info, setInfo] = useState<OnboardingInfo | null>(null);
  // ?welcome=1 fuerza la reaparición de la bienvenida aunque se hubiera omitido antes.
  const [dismissed, setDismissed] = useState(() => {
    if (new URLSearchParams(location.search).has('welcome')) {
      localStorage.removeItem(DISMISS_KEY);
      return false;
    }
    return localStorage.getItem(DISMISS_KEY) === '1';
  });
  const [progress, setProgress] = useState<PullProgress | null>(null);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ctrlRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (dismissed) return;
    void fetchOnboarding()
      .then(setInfo)
      .catch(() => setInfo(null));
  }, [dismissed]);

  const dismiss = useCallback(() => {
    localStorage.setItem(DISMISS_KEY, '1');
    setDismissed(true);
  }, []);

  const install = useCallback(async (name: string) => {
    setInstalling(true);
    setError(null);
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    try {
      await pullModel(name, setProgress, ctrl.signal);
      localStorage.setItem(DISMISS_KEY, '1');
      setDismissed(true);
    } catch (err) {
      if ((err as Error).name !== 'AbortError') setError((err as Error).message);
    } finally {
      setInstalling(false);
      setProgress(null);
    }
  }, []);

  // No mostrar si: ya se descartó, no hay datos, Ollama no está, o ya hay un modelo apto instalado.
  if (dismissed || !info || !info.ollamaAvailable || !info.recommended || info.recommended.installed) {
    return null;
  }

  const rec = info.recommended;

  return (
    <div className="border-b border-ink-700 bg-gradient-to-r from-ink-900 to-ink-950 px-6 py-4">
      <div className="max-w-3xl mx-auto flex flex-col gap-3">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="font-mono text-sm text-bee-glow">Bienvenido a Emma</h2>
            <div className="mt-1.5 space-y-0.5 text-[12px] font-mono text-gray-400">
              <div>✓ Detecté {info.hardware}</div>
              <div>✓ Detecté Ollama</div>
            </div>
          </div>
          {!installing && (
            <button
              onClick={dismiss}
              className="text-[11px] font-mono text-gray-600 hover:text-gray-400 transition-colors"
            >
              ✕
            </button>
          )}
        </div>

        <div className="text-[13px] text-gray-300">
          Modelo recomendado para su equipo:{' '}
          <span className="text-gray-100">{rec.label}</span>{' '}
          <span className="text-[11px] font-mono text-gray-500">
            (~{rec.sizeGB} GB · RAM ≥ {rec.minRamGB} GB · funciona sin clave ni internet)
          </span>
        </div>

        {error && <div className="text-[11px] text-red-400 font-mono">{error}</div>}

        {installing ? (
          <div className="space-y-1">
            <div className="h-2 rounded bg-ink-800 overflow-hidden">
              <div
                className="h-full bg-bee transition-all duration-300"
                style={{ width: `${progress?.percent ?? 0}%` }}
              />
            </div>
            <div className="flex justify-between text-[10px] font-mono text-gray-500">
              <span className="truncate">{progress?.status ?? 'iniciando…'}</span>
              <span className="shrink-0 ml-2">
                {progress?.percent != null ? `${progress.percent}%` : ''}
                {progress && progress.total > 0
                  ? ` · ${fmtBytes(progress.completed)}/${fmtBytes(progress.total)}`
                  : ''}
              </span>
            </div>
            <button
              onClick={() => ctrlRef.current?.abort()}
              className="text-[10px] font-mono px-2 py-1 rounded border border-ink-700 text-gray-500 hover:border-red-700 hover:text-red-400 transition-colors"
            >
              cancelar
            </button>
          </div>
        ) : (
          <div className="flex gap-2">
            <button
              onClick={() => void install(rec.id)}
              className="text-xs font-mono px-4 py-1.5 rounded border border-bee/50 text-bee-glow bg-bee/10 hover:bg-bee/20 transition-colors"
            >
              Instalar
            </button>
            <button
              onClick={dismiss}
              className="text-xs font-mono px-4 py-1.5 rounded border border-ink-700 text-gray-400 hover:border-gray-500 transition-colors"
            >
              Omitir
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
