import { useEffect, useState } from 'react';
import { fetchModels } from '../services/api.js';

export type Page = 'chat' | 'history' | 'models' | 'skills' | 'integrations' | 'status';

const NAV_ITEMS: Array<{ id: Page; label: string; icon: string }> = [
  { id: 'chat', label: 'Chat', icon: '💬' },
  { id: 'history', label: 'Historial', icon: '📜' },
  { id: 'models', label: 'Modelos', icon: '🧠' },
  { id: 'skills', label: 'Skills', icon: '🛠' },
  { id: 'integrations', label: 'Integraciones', icon: '🔌' },
  { id: 'status', label: 'Estado', icon: '📡' },
];

export function Sidebar({ page, onNavigate }: { page: Page; onNavigate: (p: Page) => void }) {
  const [currentModel, setCurrentModel] = useState<string | null>(null);
  const [online, setOnline] = useState(false);

  useEffect(() => {
    const poll = async () => {
      try {
        const info = await fetchModels();
        setCurrentModel(info.current);
        setOnline(true);
      } catch {
        setOnline(false);
      }
    };
    void poll();
    const interval = setInterval(() => void poll(), 20_000);
    return () => clearInterval(interval);
  }, []);

  return (
    <aside className="w-52 shrink-0 flex flex-col bg-ink-900 border-r border-ink-700">
      {/* Brand */}
      <div className="px-4 py-4 border-b border-ink-700">
        <div className="flex items-center gap-2">
          <span className="text-bee text-2xl leading-none">🐝</span>
          <span className="font-mono font-bold tracking-widest text-gray-100">EMMA</span>
        </div>
        <div className="mt-1 text-[10px] font-mono text-gray-500 uppercase tracking-wider">
          personal agent
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 py-2">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.id}
            onClick={() => onNavigate(item.id)}
            className={`w-full flex items-center gap-3 px-4 py-2.5 text-sm font-mono transition-colors border-l-2 ${
              page === item.id
                ? 'border-bee bg-ink-800 text-bee-glow'
                : 'border-transparent text-gray-400 hover:text-gray-200 hover:bg-ink-850'
            }`}
          >
            <span className="text-base">{item.icon}</span>
            {item.label}
          </button>
        ))}
      </nav>

      {/* Footer: connection + model */}
      <div className="px-4 py-3 border-t border-ink-700 space-y-1">
        <div className="flex items-center gap-2 text-[11px] font-mono">
          <span className={`w-2 h-2 rounded-full ${online ? 'bg-emerald-500' : 'bg-red-500'}`} />
          <span className={online ? 'text-emerald-400' : 'text-red-400'}>
            {online ? 'conectada' : 'sin conexión'}
          </span>
        </div>
        {currentModel && (
          <div className="text-[10px] font-mono text-gray-500 truncate" title={currentModel}>
            {currentModel.replace('openrouter:', '').replace(':free', ' ·free')}
          </div>
        )}
      </div>
    </aside>
  );
}
