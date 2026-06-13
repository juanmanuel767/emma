import { useState } from 'react';
import { Sidebar, type Page } from './components/Sidebar.js';
import { ChatPage } from './pages/ChatPage.js';
import { HistoryPage } from './pages/HistoryPage.js';
import { ModelsPage } from './pages/ModelsPage.js';
import { SkillsPage } from './pages/SkillsPage.js';
import { IntegrationsPage } from './pages/IntegrationsPage.js';
import { StatusPage } from './pages/StatusPage.js';

export function App() {
  const [page, setPage] = useState<Page>('chat');

  return (
    <div className="flex h-screen bg-ink-950 text-gray-100">
      <Sidebar page={page} onNavigate={setPage} />
      <main className="flex-1 flex flex-col min-w-0">
        {page === 'chat' && <ChatPage />}
        {page === 'history' && <HistoryPage />}
        {page === 'models' && <ModelsPage />}
        {page === 'skills' && <SkillsPage />}
        {page === 'integrations' && <IntegrationsPage />}
        {page === 'status' && <StatusPage />}
      </main>
    </div>
  );
}
