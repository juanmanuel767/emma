import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchModels, selectModel, type ModelsInfo, type ProviderCatalog } from '../services/api.js';

function displayName(name: string, model?: string): string {
  if (name.startsWith('openrouter:')) return name.slice('openrouter:'.length);
  return model ? `${name} · ${model}` : name;
}

function fmtCtx(ctx: number): string {
  if (ctx <= 0) return '—';
  if (ctx >= 1_000_000) return `${(ctx / 1_000_000).toFixed(1)}M ctx`;
  return `${Math.round(ctx / 1024)}k ctx`;
}

function fmtCost(m: { costIn: number | null; costOut: number | null; free: boolean }): string {
  if (m.free) return 'gratis';
  if (m.costIn === null) return '';
  return `$${m.costIn}/M in · $${m.costOut ?? '?'}/M out`;
}

export function ModelsPage() {
  const [info, setInfo] = useState<ModelsInfo | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [openProvider, setOpenProvider] = useState<string | null>(null);

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

  const handleSelect = async (spec: string) => {
    setBusy(spec);
    try {
      await selectModel(spec);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const currentModel = useMemo(() => {
    const active = info?.providers.find((p) => p.active);
    return active?.model ?? null;
  }, [info]);

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      <div>
        <h1 className="font-mono text-lg text-gray-100">Modelos</h1>
        <p className="text-xs text-gray-500 mt-1">
          Catálogo universal de proveedores (vía models.dev, estilo opencode). Si un modelo agota
          sus tokens, Emma salta automáticamente al siguiente de la cadena.
        </p>
      </div>

      {error && (
        <div className="px-3 py-2 text-xs text-red-300 bg-red-900/30 border border-red-700 rounded">
          {error}
        </div>
      )}

      {/* Fallback chain */}
      <section>
        <h2 className="font-mono text-xs uppercase tracking-widest text-gray-500 mb-2">
          Cadena de fallback
        </h2>
        <div className="rounded-lg border border-ink-700 divide-y divide-ink-700 bg-ink-900">
          {(info?.providers ?? []).map((p) => (
            <div key={p.name} className="flex items-center gap-3 px-4 py-3">
              <span className="font-mono text-xs text-gray-600 w-5">{p.priority + 1}</span>
              <div className="flex-1 min-w-0">
                <div className={`text-sm truncate ${p.active ? 'text-bee-glow' : 'text-gray-200'}`}>
                  {displayName(p.name, p.model)}
                </div>
              </div>
              {p.active && (
                <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-bee/15 text-bee-glow border border-bee/40">
                  ACTIVO
                </span>
              )}
              {p.exhausted && (
                <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-yellow-900/30 text-yellow-500 border border-yellow-800">
                  AGOTADO
                </span>
              )}
              {!p.active && (
                <button
                  onClick={() => void handleSelect(p.name)}
                  disabled={busy !== null}
                  className="text-xs font-mono px-3 py-1 rounded border border-ink-700 text-gray-400 hover:border-bee hover:text-bee-glow transition-colors disabled:opacity-50"
                >
                  {busy === p.name ? '...' : 'usar'}
                </button>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* Universal provider catalog */}
      <section className="space-y-3">
        <div className="flex items-center justify-between gap-4">
          <h2 className="font-mono text-xs uppercase tracking-widest text-gray-500">
            Proveedores
          </h2>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar modelo… (ej: mixtral, llama, claude)"
            className="w-72 px-3 py-1.5 text-xs font-mono bg-ink-950 border border-ink-700 rounded
                       text-gray-200 placeholder-gray-600 focus:outline-none focus:border-bee"
          />
        </div>

        {(info?.catalogs ?? []).map((cat) => (
          <ProviderSection
            key={cat.id}
            catalog={cat}
            search={search.toLowerCase()}
            open={openProvider === cat.id || search.length > 1}
            onToggle={() => setOpenProvider(openProvider === cat.id ? null : cat.id)}
            currentModel={currentModel}
            busy={busy}
            onSelect={handleSelect}
          />
        ))}
      </section>
    </div>
  );
}

function ProviderSection({
  catalog,
  search,
  open,
  onToggle,
  currentModel,
  busy,
  onSelect,
}: {
  catalog: ProviderCatalog;
  search: string;
  open: boolean;
  onToggle: () => void;
  currentModel: string | null;
  busy: string | null;
  onSelect: (spec: string) => void;
}) {
  const filtered = useMemo(() => {
    const models = search.length > 1
      ? catalog.models.filter(
          (m) => m.id.toLowerCase().includes(search) || m.name.toLowerCase().includes(search),
        )
      : catalog.models;
    return models.slice(0, 60);
  }, [catalog.models, search]);

  if (search.length > 1 && filtered.length === 0) return null;

  return (
    <div className="rounded-lg border border-ink-700 bg-ink-900 overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-ink-850 transition-colors"
      >
        <span
          className={`inline-block w-2 h-2 rounded-full ${
            catalog.configured ? 'bg-emerald-400' : 'bg-gray-600'
          }`}
        />
        <span className="font-mono text-sm text-gray-100">{catalog.name}</span>
        <span className="text-[10px] font-mono text-gray-600">
          {catalog.models.length} modelos{catalog.configured ? '' : ' · sin clave'}
        </span>
        <span className="ml-auto text-gray-600 text-xs">{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <div className="border-t border-ink-700 divide-y divide-ink-800 max-h-96 overflow-y-auto">
          {filtered.map((m) => {
            const spec = `${catalog.id}:${m.id}`;
            const isCurrent = currentModel === m.id;
            return (
              <div key={m.id} className="flex items-center gap-3 px-4 py-2.5">
                <div className="flex-1 min-w-0">
                  <div className={`text-sm truncate ${isCurrent ? 'text-bee-glow' : 'text-gray-200'}`}>
                    {m.name}
                    {m.free && (
                      <span className="ml-2 text-[9px] font-mono px-1.5 py-0.5 rounded bg-emerald-900/40 text-emerald-400 border border-emerald-800">
                        FREE
                      </span>
                    )}
                    {m.reasoning && (
                      <span className="ml-1 text-[9px] font-mono px-1.5 py-0.5 rounded bg-purple-900/40 text-purple-400 border border-purple-800">
                        razona
                      </span>
                    )}
                  </div>
                  <div className="text-[10px] font-mono text-gray-600 truncate" title={m.id}>
                    {m.id}
                  </div>
                </div>
                <span className="text-[10px] font-mono text-gray-500 shrink-0 hidden sm:block">
                  {fmtCtx(m.contextLength)}
                </span>
                <span className="text-[10px] font-mono text-gray-500 shrink-0 w-32 text-right hidden md:block">
                  {fmtCost(m)}
                </span>
                <button
                  onClick={() => onSelect(spec)}
                  disabled={busy !== null || !catalog.configured}
                  title={catalog.configured ? '' : 'Configure la clave en Integraciones'}
                  className={`text-xs font-mono px-3 py-1 rounded border transition-colors disabled:opacity-40 shrink-0 ${
                    isCurrent
                      ? 'border-bee/60 text-bee-glow bg-bee/10'
                      : 'border-ink-700 text-gray-400 hover:border-bee hover:text-bee-glow'
                  }`}
                >
                  {busy === spec ? '...' : isCurrent ? 'activo' : 'usar'}
                </button>
              </div>
            );
          })}
          {catalog.models.length > filtered.length && search.length <= 1 && (
            <div className="px-4 py-2 text-[10px] font-mono text-gray-600">
              … {catalog.models.length - filtered.length} más — use el buscador
            </div>
          )}
        </div>
      )}
    </div>
  );
}
