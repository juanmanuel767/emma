import { useEffect, useState } from 'react';
import { fetchSkills, type SkillsInfo } from '../services/api.js';

export function SkillsPage() {
  const [info, setInfo] = useState<SkillsInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchSkills().then(setInfo).catch((err) => setError((err as Error).message));
  }, []);

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      <div>
        <h1 className="font-mono text-lg text-gray-100">Skills</h1>
        <p className="text-xs text-gray-500 mt-1">
          Capacidades registradas en el agente.
        </p>
      </div>

      {error && (
        <div className="px-3 py-2 text-xs text-red-300 bg-red-900/30 border border-red-700 rounded">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {(info?.tools ?? []).map((t) => (
          <div key={t.name} className="rounded-lg border border-ink-700 bg-ink-900 p-4">
            <div className="font-mono text-sm text-bee-glow">{t.name}</div>
            <div className="text-xs text-gray-400 mt-1">{t.description}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
