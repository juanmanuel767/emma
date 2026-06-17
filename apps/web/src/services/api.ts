export interface StreamEvent {
  type: 'text_delta' | 'tool_start' | 'tool_end' | 'error' | 'done';
  text?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: string;
  error?: string;
  sessionId?: string;
}

const GATEWAY_URL = import.meta.env['VITE_GATEWAY_URL'] ?? 'http://localhost:3000';

export interface FreeModel {
  id: string;
  name: string;
  contextLength: number;
  supportsTools: boolean;
}

export interface ProviderStatus {
  name: string;
  model?: string;
  active: boolean;
  exhausted: boolean;
  priority: number;
}

export interface CatalogModel {
  id: string;
  name: string;
  contextLength: number;
  supportsTools: boolean;
  reasoning: boolean;
  costIn: number | null;
  costOut: number | null;
  free: boolean;
}

export interface ProviderCatalog {
  id: string;
  name: string;
  configured: boolean;
  models: CatalogModel[];
}

export interface ModelsInfo {
  current: string;
  providers: ProviderStatus[];
  catalog: FreeModel[];
  catalogs: ProviderCatalog[];
}

export interface SkillsInfo {
  skills: Array<{ name: string; description?: string }>;
  tools: Array<{ name: string; description: string }>;
}

export async function fetchSkills(): Promise<SkillsInfo> {
  const res = await fetch(`${GATEWAY_URL}/skills`);
  if (!res.ok) throw new Error(`Error ${res.status} al obtener skills`);
  return res.json() as Promise<SkillsInfo>;
}

export async function fetchHealth(): Promise<{ gateway: boolean; agent: boolean }> {
  let gateway = false;
  let agent = false;
  try {
    const res = await fetch(`${GATEWAY_URL}/health`, { signal: AbortSignal.timeout(5000) });
    gateway = res.ok;
    // El gateway solo responde si está vivo; el agente se comprueba vía /models
    const agentRes = await fetch(`${GATEWAY_URL}/models`, { signal: AbortSignal.timeout(5000) });
    agent = agentRes.ok;
  } catch { /* offline */ }
  return { gateway, agent };
}

export async function fetchModels(): Promise<ModelsInfo> {
  const res = await fetch(`${GATEWAY_URL}/models`);
  if (!res.ok) throw new Error(`Error ${res.status} al obtener modelos`);
  return res.json() as Promise<ModelsInfo>;
}

export async function selectModel(model: string): Promise<{ ok: boolean; current: string }> {
  const res = await fetch(`${GATEWAY_URL}/models/select`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model }),
  });
  const body = (await res.json()) as { ok?: boolean; current?: string; error?: string };
  if (!res.ok) throw new Error(body.error ?? `Error ${res.status}`);
  return { ok: body.ok ?? false, current: body.current ?? '' };
}

export interface IntegrationField {
  envKey: string;
  label: string;
  placeholder: string;
  secret: boolean;
  value: string | null;
}

export interface Integration {
  id: string;
  label: string;
  description: string;
  helpUrl: string;
  configured: boolean;
  fields: IntegrationField[];
}

export async function fetchSettings(): Promise<{ integrations: Integration[] }> {
  const res = await fetch(`${GATEWAY_URL}/settings`);
  if (!res.ok) throw new Error(`Error ${res.status} al obtener integraciones`);
  return res.json() as Promise<{ integrations: Integration[] }>;
}

export async function saveSettings(
  values: Record<string, string>,
): Promise<{ ok: boolean; restarted: string[]; warnings: string[] }> {
  const res = await fetch(`${GATEWAY_URL}/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ values }),
  });
  const body = (await res.json()) as {
    ok?: boolean;
    restarted?: string[];
    warnings?: string[];
    error?: string;
  };
  if (!res.ok) throw new Error(body.error ?? `Error ${res.status}`);
  return { ok: body.ok ?? false, restarted: body.restarted ?? [], warnings: body.warnings ?? [] };
}

export interface ConversationSummary {
  id: string;
  sessionId: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  preview: string;
}

export interface ConversationMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  createdAt: string;
  toolCall?: { id: string; name: string; input: Record<string, unknown> };
  toolResult?: { toolCallId: string; toolName: string; output: string; isError?: boolean };
}

export async function fetchConversations(): Promise<ConversationSummary[]> {
  const res = await fetch(`${GATEWAY_URL}/conversations`);
  if (!res.ok) throw new Error(`Error ${res.status} al obtener el historial`);
  const body = (await res.json()) as { conversations: ConversationSummary[] };
  return body.conversations;
}

export async function fetchConversationMessages(
  id: string,
): Promise<{ conversation: ConversationSummary; messages: ConversationMessage[] }> {
  const res = await fetch(`${GATEWAY_URL}/conversations/${encodeURIComponent(id)}/messages`);
  if (!res.ok) throw new Error(`Error ${res.status} al obtener la conversación`);
  return res.json() as Promise<{ conversation: ConversationSummary; messages: ConversationMessage[] }>;
}

// ── Gestor de Modelos (Ollama) ───────────────────────────────────────────────

export interface InstalledModel {
  name: string;
  provider: string;
  sizeBytes: number;
  size: string;
  family: string | null;
  paramSize: string | null;
  quant: string | null;
  modifiedAt: string | null;
}

export interface RecommendedModel {
  id: string;
  label: string;
  sizeGB: number;
  minRamGB: number;
  role: string;
  provider: string;
  installed: boolean;
  fits: boolean;   // la RAM alcanza
  heavy: boolean;  // cabe pero será lento en esta CPU (sin GPU, ≥4 GB)
}

export interface PullProgress {
  status: string;
  completed: number;
  total: number;
  percent: number | null;
}

export async function fetchInstalledModels(): Promise<InstalledModel[]> {
  const res = await fetch(`${GATEWAY_URL}/ollama/installed`);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Error ${res.status}`);
  }
  return ((await res.json()) as { models: InstalledModel[] }).models;
}

export async function fetchRecommendedModels(): Promise<{ hardware: string; models: RecommendedModel[] }> {
  const res = await fetch(`${GATEWAY_URL}/ollama/recommended`);
  if (!res.ok) throw new Error(`Error ${res.status} al obtener recomendados`);
  return (await res.json()) as { hardware: string; models: RecommendedModel[] };
}

export interface OnboardingInfo {
  ollamaAvailable: boolean;
  hardware: string;
  recommended: {
    id: string;
    label: string;
    sizeGB: number;
    minRamGB: number;
    role: string;
    installed: boolean;
  } | null;
}

export async function fetchOnboarding(): Promise<OnboardingInfo> {
  const res = await fetch(`${GATEWAY_URL}/onboarding`);
  if (!res.ok) throw new Error(`Error ${res.status} al obtener onboarding`);
  return (await res.json()) as OnboardingInfo;
}

export async function deleteModel(name: string): Promise<void> {
  const res = await fetch(`${GATEWAY_URL}/ollama/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Error ${res.status}`);
  }
}

/** Instala/actualiza un modelo de Ollama, reportando el progreso de descarga. */
export async function pullModel(
  name: string,
  onProgress: (p: PullProgress) => void,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch(`${GATEWAY_URL}/ollama/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
    signal,
  });
  if (!response.ok || !response.body) throw new Error(`Error ${response.status} al instalar`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let currentEvent = 'message';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.startsWith('event: ')) {
        currentEvent = line.slice(7).trim();
      } else if (line.startsWith('data: ')) {
        const data = JSON.parse(line.slice(6)) as PullProgress & { error?: string };
        if (currentEvent === 'error') throw new Error(data.error ?? 'Error de instalación');
        if (currentEvent === 'done') return;
        if (currentEvent === 'progress') onProgress(data);
      }
    }
  }
}

export async function* streamChat(
  message: string,
  sessionId: string,
  signal: AbortSignal,
): AsyncGenerator<StreamEvent> {
  const response = await fetch(`${GATEWAY_URL}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, sessionId }),
    signal,
  });

  if (!response.ok) {
    throw new Error(`Gateway error: ${response.status}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response stream');

  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            yield JSON.parse(line.slice(6)) as StreamEvent;
          } catch {
            // skip malformed
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
