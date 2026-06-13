import { z } from 'zod';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ISkill, SkillActivationContext } from '../types.js';
import type { ITool, ToolContext, ToolResult } from '@emma/tools';

interface Reminder {
  id: string;
  title: string;
  notes?: string;
  due?: string;
  done: boolean;
  createdAt: string;
}

let dataDir = join(homedir(), '.emma');
const dbFile = () => join(dataDir, 'reminders.json');

async function loadAll(): Promise<Reminder[]> {
  try {
    const raw = await readFile(dbFile(), 'utf-8');
    return JSON.parse(raw) as Reminder[];
  } catch {
    return [];
  }
}

async function saveAll(items: Reminder[]): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  await writeFile(dbFile(), JSON.stringify(items, null, 2), 'utf-8');
}

const addReminderTool: ITool = {
  name: 'add_reminder',
  description: 'Add a reminder or task. Optionally set a due date.',
  inputSchema: z.object({
    title: z.string().min(1).describe('What to remember'),
    notes: z.string().optional().describe('Additional details'),
    due: z.string().optional().describe('Due date/time in natural language or ISO format'),
  }),
  async execute(input, _ctx: ToolContext): Promise<ToolResult> {
    const items = await loadAll();
    const reminder: Reminder = {
      id: crypto.randomUUID(),
      title: (input as { title: string }).title,
      notes: (input as { notes?: string }).notes,
      due: (input as { due?: string }).due,
      done: false,
      createdAt: new Date().toISOString(),
    };
    items.push(reminder);
    await saveAll(items);
    return { success: true, data: reminder };
  },
};

const listRemindersTool: ITool = {
  name: 'list_reminders',
  description: 'List pending reminders and tasks.',
  inputSchema: z.object({
    show_done: z.coerce.boolean().default(false).describe('Include completed reminders'),
  }),
  async execute(input, _ctx: ToolContext): Promise<ToolResult> {
    const items = await loadAll();
    const filtered = (input as { show_done: boolean }).show_done
      ? items
      : items.filter((r) => !r.done);
    return { success: true, data: { reminders: filtered, count: filtered.length } };
  },
};

const completeReminderTool: ITool = {
  name: 'complete_reminder',
  description: 'Mark a reminder as done by its title or ID.',
  inputSchema: z.object({
    title_or_id: z.string().describe('Title or ID of the reminder to mark done'),
  }),
  async execute(input, _ctx: ToolContext): Promise<ToolResult> {
    const query = (input as { title_or_id: string }).title_or_id.toLowerCase();
    const items = await loadAll();
    const idx = items.findIndex(
      (r) => r.id === query || r.title.toLowerCase().includes(query),
    );
    if (idx === -1) return { success: false, error: `Reminder '${query}' not found` };
    const item = items[idx];
    if (!item) return { success: false, error: 'Reminder not found' };
    item.done = true;
    await saveAll(items);
    return { success: true, data: item };
  },
};

export const RemindersSkill: ISkill = {
  name: 'reminders',
  version: '1.0.0',
  description: 'Personal reminders and task list — add, list, and complete tasks that persist across sessions.',
  tools: [addReminderTool, listRemindersTool, completeReminderTool],
  async activate(ctx: SkillActivationContext) {
    dataDir = ctx.dataDir;
    await mkdir(dataDir, { recursive: true });
  },
};
