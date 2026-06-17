import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchModels,
  selectModel,
  fetchInstalledModels,
  fetchRecommendedModels,
  pullModel,
  deleteModel,
  type ModelsInfo,
  type ProviderCatalog,
  type InstalledModel,
  type RecommendedModel,
  type PullProgress,
} from '../services/api.js';

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

      {/* Gestor de modelos locales (Ollama) */}
      <ModelManagerSection />

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

function fmtBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 GB';
  const gb = bytes / 1e9;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${(bytes / 1e6).toFixed(0)} MB`;
}

// Estado de descarga por modelo
type PullState = { progress: PullProgress | null; ctrl: AbortController };

function ModelManagerSection() {
  const [recommended, setRecommended] = useState<RecommendedModel[]>([]);
  const [installed, setInstalled] = useState<InstalledModel[]>([]);
  const [hardware, setHardware] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pulls, setPulls] = useState<Record<string, PullState>>({});
  const pullsRef = useRef(pulls);
  pullsRef.current = pulls;

  const load = useCallback(async () => {
    try {
      const [rec, inst] = await Promise.all([fetchRecommendedModels(), fetchInstalledModels()]);
      setRecommended(rec.models);
      setHardware(rec.hardware);
      setInstalled(inst);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const install = useCallback(
    async (name: string) => {
      const ctrl = new AbortController();
      setPulls((p) => ({ ...p, [name]: { progress: null, ctrl } }));
      try {
        await pullModel(
          name,
          (progress) => setPulls((p) => (p[name] ? { ...p, [name]: { ...p[name]!, progress } } : p)),
          ctrl.signal,
        );
        await load();
      } catch (err) {
        if ((err as Error).name !== 'AbortError') setError((err as Error).message);
      } finally {
        setPulls((p) => {
          const { [name]: _removed, ...rest } = p;
          return rest;
        });
      }
    },
    [load],
  );

  const cancel = useCallback((name: string) => {
    pullsRef.current[name]?.ctrl.abort();
  }, []);

  const remove = useCallback(
    async (name: string) => {
      if (!confirm(`¿Eliminar el modelo "${name}" del disco?`)) return;
      try {
        await deleteModel(name);
        await load();
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [load],
  );

  // Modelos instalados que NO están en la lista de recomendados (para no duplicar)
  const recIds = useMemo(
    () => new Set(recommended.flatMap((r) => [r.id, `${r.id}:latest`])),
    [recommended],
  );
  const otherInstalled = useMemo(
    () => installed.filter((m) => !recIds.has(m.name)),
    [installed, recIds],
  );

  return (
    <section className="space-y-3">
      <div>
        <h2 className="font-mono text-xs uppercase tracking-widest text-gray-500">
          Gestor de Modelos · locales (Ollama)
        </h2>
        <p className="text-[11px] text-gray-600 mt-1">
          Instale, actualice o elimine modelos locales. Funcionan sin clave ni internet; la
          velocidad depende de su hardware.
        </p>
        {hardware && (
          <div className="mt-2 inline-flex items-center gap-2 px-3 py-1 rounded border border-ink-700 bg-ink-950">
            <span className="inline-block w-2 h-2 rounded-full bg-bee" />
            <span className="font-mono text-[11px] text-gray-400">Tu equipo: {hardware}</span>
          </div>
        )}
      </div>

      {error && (
        <div className="px-3 py-2 text-xs text-red-300 bg-red-900/30 border border-red-700 rounded">
          {error}
        </div>
      )}

      <div className="grid gap-2 sm:grid-cols-2">
        {recommended.map((m) => {
          const pull = pulls[m.id];
          const sizeBytes = installed.find((i) => i.name === m.id || i.name === `${m.id}:latest`)?.sizeBytes;
          return (
            <div
              key={m.id}
              className="rounded-lg border border-ink-700 bg-ink-900 p-3 flex flex-col gap-2"
            >
              <div className="flex items-start gap-2">
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-gray-100 truncate">{m.label}</div>
                  <div className="text-[10px] font-mono text-gray-600">{m.id}</div>
                </div>
                {m.installed ? (
                  <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-emerald-900/40 text-emerald-400 border border-emerald-800 shrink-0">
                    INSTALADO
                  </span>
                ) : (
                  <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-ink-800 text-gray-500 border border-ink-700 shrink-0">
                    {m.role}
                  </span>
                )}
              </div>

              <div className="flex gap-4 text-[10px] font-mono text-gray-500 items-center">
                <span>{m.installed && sizeBytes ? fmtBytes(sizeBytes) : `~${m.sizeGB} GB`}</span>
                <span>RAM ≥ {m.minRamGB} GB</span>
                <span className="text-gray-600">ollama</span>
                {!m.fits ? (
                  <span className="text-[9px] px-1.5 py-0.5 rounded bg-red-900/40 text-red-400 border border-red-800">
                    Requiere más RAM
                  </span>
                ) : m.heavy ? (
                  <span className="text-[9px] px-1.5 py-0.5 rounded bg-yellow-900/30 text-yellow-500 border border-yellow-800">
                    lento en tu CPU
                  </span>
                ) : (
                  <span className="text-[9px] px-1.5 py-0.5 rounded bg-emerald-900/40 text-emerald-400 border border-emerald-800">
                    apto
                  </span>
                )}
              </div>

              {pull ? (
                <div className="space-y-1">
                  <div className="h-2 rounded bg-ink-800 overflow-hidden">
                    <div
                      className="h-full bg-bee transition-all duration-300"
                      style={{ width: `${pull.progress?.percent ?? 0}%` }}
                    />
                  </div>
                  <div className="flex justify-between text-[10px] font-mono text-gray-500">
                    <span className="truncate">{pull.progress?.status ?? 'iniciando…'}</span>
                    <span className="shrink-0 ml-2">
                      {pull.progress?.percent != null ? `${pull.progress.percent}%` : ''}
                      {pull.progress && pull.progress.total > 0
                        ? ` · ${fmtBytes(pull.progress.completed)}/${fmtBytes(pull.progress.total)}`
                        : ''}
                    </span>
                  </div>
                  <button
                    onClick={() => cancel(m.id)}
                    className="text-[10px] font-mono px-2 py-1 rounded border border-ink-700 text-gray-500 hover:border-red-700 hover:text-red-400 transition-colors"
                  >
                    cancelar
                  </button>
                </div>
              ) : (
                <div className="flex gap-2">
                  <button
                    onClick={() => void install(m.id)}
                    disabled={!m.fits && !m.installed}
                    title={!m.fits && !m.installed ? 'Tu equipo no tiene RAM suficiente' : ''}
                    className="flex-1 text-xs font-mono px-3 py-1.5 rounded border border-ink-700 text-gray-300 hover:border-bee hover:text-bee-glow transition-colors disabled:opacity-40 disabled:hover:border-ink-700 disabled:hover:text-gray-300"
                  >
                    {m.installed ? 'Actualizar' : 'Instalar'}
                  </button>
                  {m.installed && (
                    <button
                      onClick={() => void remove(m.id)}
                      className="text-xs font-mono px-3 py-1.5 rounded border border-ink-700 text-gray-500 hover:border-red-700 hover:text-red-400 transition-colors"
                    >
                      Eliminar
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {otherInstalled.length > 0 && (
        <div className="space-y-1">
          <h3 className="font-mono text-[10px] uppercase tracking-widest text-gray-600 mt-2">
            Otros instalados
          </h3>
          <div className="rounded-lg border border-ink-700 bg-ink-900 divide-y divide-ink-800">
            {otherInstalled.map((m) => (
              <div key={m.name} className="flex items-center gap-3 px-4 py-2">
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-gray-200 truncate">{m.name}</div>
                  <div className="text-[10px] font-mono text-gray-600">
                    {m.paramSize ?? ''} {m.quant ? `· ${m.quant}` : ''}
                  </div>
                </div>
                <span className="text-[10px] font-mono text-gray-500 shrink-0">{m.size}</span>
                <button
                  onClick={() => void remove(m.name)}
                  className="text-[10px] font-mono px-2 py-1 rounded border border-ink-700 text-gray-500 hover:border-red-700 hover:text-red-400 transition-colors shrink-0"
                >
                  Eliminar
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
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
