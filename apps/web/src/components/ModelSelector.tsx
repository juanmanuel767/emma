import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchModels, selectModel, type ModelsInfo } from '../services/api.js';

function shortLabel(providerName: string, model?: string): string {
  if (providerName.startsWith('openrouter:')) {
    return providerName.slice('openrouter:'.length).replace(':free', ' (free)');
  }
  return model ? `${providerName} · ${model}` : providerName;
}

export function ModelSelector() {
  const [info, setInfo] = useState<ModelsInfo | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    try {
      setInfo(await fetchModels());
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(interval);
  }, [refresh]);

  useEffect(() => {
    const onClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  const handleSelect = async (model: string) => {
    setBusy(true);
    try {
      await selectModel(model);
      await refresh();
      setOpen(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const active = info?.providers.find((p) => p.active);
  const activeIds = new Set(
    (info?.providers ?? []).map((p) => p.name.replace(/^openrouter:/, '')),
  );

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        className="flex items-center gap-2 text-xs text-gray-300 hover:text-gray-100 transition-colors px-2 py-1 rounded border border-gray-700 hover:border-gray-500 max-w-64"
        title={error ?? 'Seleccionar modelo'}
      >
        <span className={`w-2 h-2 rounded-full shrink-0 ${error ? 'bg-red-500' : 'bg-green-500'}`} />
        <span className="truncate">
          {active ? shortLabel(active.name, active.model) : 'Modelos...'}
        </span>
        <span className="text-gray-500">▾</span>
      </button>

      {open && info && (
        <div className="absolute right-0 mt-1 w-80 max-h-96 overflow-y-auto bg-gray-900 border border-gray-700 rounded-lg shadow-xl z-50">
          <div className="px-3 py-2 text-[10px] uppercase tracking-wider text-gray-500 border-b border-gray-800">
            Cadena de fallback activa
          </div>
          {info.providers.map((p) => (
            <button
              key={p.name}
              onClick={() => void handleSelect(p.name)}
              disabled={busy}
              className={`w-full text-left px-3 py-2 text-xs hover:bg-gray-800 transition-colors flex items-center gap-2 ${
                p.active ? 'text-bee-glow' : p.exhausted ? 'text-gray-600' : 'text-gray-300'
              }`}
            >
              <span className="text-gray-600 font-mono w-4 shrink-0">{p.priority + 1}.</span>
              <span className="truncate flex-1">{shortLabel(p.name, p.model)}</span>
              {p.active && <span className="text-[10px] text-bee-glow shrink-0">activo</span>}
              {p.exhausted && <span className="text-[10px] text-yellow-600 shrink-0">agotado</span>}
            </button>
          ))}

          <div className="px-3 py-2 text-[10px] uppercase tracking-wider text-gray-500 border-y border-gray-800">
            Modelos gratis (OpenRouter)
          </div>
          {info.catalog
            .filter((m) => !activeIds.has(m.id))
            .map((m) => (
              <button
                key={m.id}
                onClick={() => void handleSelect(m.id)}
                disabled={busy}
                className="w-full text-left px-3 py-2 text-xs text-gray-300 hover:bg-gray-800 transition-colors"
              >
                <div className="truncate">{m.name}</div>
                <div className="text-[10px] text-gray-600 truncate font-mono">
                  {m.id} · {Math.round(m.contextLength / 1024)}k ctx
                </div>
              </button>
            ))}
        </div>
      )}
    </div>
  );
}
