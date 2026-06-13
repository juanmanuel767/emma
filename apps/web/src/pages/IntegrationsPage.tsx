import { useCallback, useEffect, useState } from 'react';
import { fetchSettings, saveSettings, type Integration } from '../services/api.js';

export function IntegrationsPage() {
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await fetchSettings();
      setIntegrations(data.integrations);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const pendingLlm = integrations.length > 0 && !integrations.some(
    (i) => ['openrouter', 'groq', 'anthropic', 'openai'].includes(i.id) && i.configured,
  );

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      <div>
        <h1 className="font-mono text-lg text-gray-100">Integraciones</h1>
        <p className="text-xs text-gray-500 mt-1">
          Configure aquí sus claves de API. Se guardan en el .env local y el servicio afectado se
          reinicia automáticamente — nada sale de esta máquina.
        </p>
      </div>

      {pendingLlm && (
        <div className="px-3 py-2 text-xs text-bee bg-bee/10 border border-bee/40 rounded">
          Para empezar, configure al menos un proveedor LLM (OpenRouter o Groq son gratuitos).
          Sin clave, Emma usará Ollama local si está disponible.
        </div>
      )}

      {error && (
        <div className="px-3 py-2 text-xs text-red-300 bg-red-900/30 border border-red-700 rounded">
          {error}
        </div>
      )}

      <div className="grid gap-4 max-w-2xl">
        {integrations.map((integration) => (
          <IntegrationCard key={integration.id} integration={integration} onSaved={refresh} />
        ))}
      </div>
    </div>
  );
}

function IntegrationCard({
  integration,
  onSaved,
}: {
  integration: Integration;
  onSaved: () => Promise<void>;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'warn' | 'error'; text: string } | null>(null);

  const dirty = Object.values(drafts).some((v) => v.trim() !== '');

  const handleSave = async () => {
    const values = Object.fromEntries(
      Object.entries(drafts).filter(([, v]) => v.trim() !== ''),
    );
    if (Object.keys(values).length === 0) return;
    setBusy(true);
    setNotice(null);
    try {
      const res = await saveSettings(values);
      setDrafts({});
      setNotice(
        res.warnings.length > 0
          ? { kind: 'warn', text: res.warnings.join(' ') }
          : {
              kind: 'ok',
              text:
                res.restarted.length > 0
                  ? `Guardado — reiniciando: ${res.restarted.join(', ')}.`
                  : 'Guardado.',
            },
      );
      await onSaved();
    } catch (err) {
      setNotice({ kind: 'error', text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-ink-900 border border-ink-700 rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span
            className={`inline-block w-2 h-2 rounded-full ${
              integration.configured ? 'bg-emerald-400' : 'bg-gray-600'
            }`}
          />
          <span className="font-mono text-sm text-gray-100">{integration.label}</span>
          {integration.configured && (
            <span className="text-[10px] font-mono text-emerald-400 uppercase">configurada</span>
          )}
        </div>
        <a
          href={integration.helpUrl}
          target="_blank"
          rel="noreferrer"
          className="text-[11px] text-bee hover:underline"
        >
          obtener clave ↗
        </a>
      </div>

      <p className="text-xs text-gray-500">{integration.description}</p>

      <div className="space-y-2">
        {integration.fields.map((field) => (
          <div key={field.envKey} className="flex items-center gap-2">
            <label className="w-44 shrink-0 text-[11px] font-mono text-gray-400">
              {field.label}
            </label>
            <input
              type={field.secret ? 'password' : 'text'}
              value={drafts[field.envKey] ?? ''}
              onChange={(e) =>
                setDrafts((d) => ({ ...d, [field.envKey]: e.target.value }))
              }
              placeholder={field.value ?? field.placeholder}
              autoComplete="off"
              className="flex-1 px-2 py-1.5 text-xs font-mono bg-ink-950 border border-ink-700 rounded
                         text-gray-200 placeholder-gray-600 focus:outline-none focus:border-bee"
            />
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between">
        <span
          className={`text-[11px] ${
            notice?.kind === 'ok'
              ? 'text-emerald-400'
              : notice?.kind === 'warn'
                ? 'text-bee'
                : 'text-red-400'
          }`}
        >
          {notice?.text ?? ''}
        </span>
        <button
          onClick={() => void handleSave()}
          disabled={!dirty || busy}
          className="px-3 py-1.5 text-xs font-mono rounded border border-bee/50 text-bee
                     hover:bg-bee/10 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          {busy ? 'guardando…' : 'guardar'}
        </button>
      </div>
    </div>
  );
}
