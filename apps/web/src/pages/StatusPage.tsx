import { useCallback, useEffect, useState } from 'react';
import { fetchHealth, fetchModels, type ModelsInfo } from '../services/api.js';

function Dot({ ok }: { ok: boolean }) {
  return <span className={`w-2.5 h-2.5 rounded-full inline-block ${ok ? 'bg-emerald-500' : 'bg-red-500'}`} />;
}

export function StatusPage() {
  const [health, setHealth] = useState<{ gateway: boolean; agent: boolean } | null>(null);
  const [models, setModels] = useState<ModelsInfo | null>(null);
  const [checkedAt, setCheckedAt] = useState<string>('');

  const refresh = useCallback(async () => {
    setHealth(await fetchHealth());
    try { setModels(await fetchModels()); } catch { setModels(null); }
    setCheckedAt(new Date().toLocaleTimeString());
  }, []);

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(interval);
  }, [refresh]);

  const rows = [
    { label: 'Gateway', ok: health?.gateway ?? false, detail: ':3000' },
    { label: 'Agente', ok: health?.agent ?? false, detail: ':3001' },
  ];

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="font-mono text-lg text-gray-100">Estado</h1>
          <p className="text-xs text-gray-500 mt-1">Salud de los servicios de Emma.</p>
        </div>
        <span className="text-[10px] font-mono text-gray-600">última comprobación: {checkedAt}</span>
      </div>

      <div className="rounded-lg border border-ink-700 divide-y divide-ink-700 bg-ink-900">
        {rows.map((r) => (
          <div key={r.label} className="flex items-center gap-3 px-4 py-3">
            <Dot ok={r.ok} />
            <span className="text-sm text-gray-200 flex-1">{r.label}</span>
            <span className="font-mono text-xs text-gray-600">{r.detail}</span>
            <span className={`font-mono text-xs ${r.ok ? 'text-emerald-400' : 'text-red-400'}`}>
              {r.ok ? 'OK' : 'CAÍDO'}
            </span>
          </div>
        ))}
        <div className="flex items-center gap-3 px-4 py-3">
          <Dot ok={!!models} />
          <span className="text-sm text-gray-200 flex-1">Modelo activo</span>
          <span className="font-mono text-xs text-bee-glow truncate max-w-64">
            {models?.current?.replace('openrouter:', '') ?? '—'}
          </span>
        </div>
      </div>

      {models && (
        <div className="text-[11px] font-mono text-gray-500">
          {models.providers.length} proveedores en cadena · {models.catalog.length} modelos gratis disponibles
        </div>
      )}
    </div>
  );
}
