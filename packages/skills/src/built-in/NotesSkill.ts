import { z } from 'zod';
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ISkill, SkillActivationContext } from '../types.js';
import type { ITool, ToolContext, ToolResult } from '@emma/tools';

let notesDir = join(homedir(), '.emma', 'notes');

const saveSchema = z.object({
  title: z.string().min(1).describe('Note title (used as filename)'),
  content: z.string().min(1).describe('Note content in plain text or markdown'),
  append: z.coerce.boolean().default(false).describe('If true, append to existing note instead of overwriting'),
});

const readSchema = z.object({
  title: z.string().min(1).describe('Title of the note to read'),
});

const listSchema = z.object({
  filter: z.string().optional().describe('Optional keyword to filter notes by title'),
});

const saveNoteTool: ITool = {
  name: 'save_note',
  description: 'Save or update a personal note. Notes persist across sessions. Use for remembering information, todos, or any text the user wants to keep.',
  inputSchema: saveSchema,
  async execute(input: z.infer<typeof saveSchema>, _ctx: ToolContext): Promise<ToolResult> {
    try {
      await mkdir(notesDir, { recursive: true });
      const filename = input.title.replace(/[^a-zA-Z0-9_\-. ]/g, '_') + '.md';
      const filepath = join(notesDir, filename);

      if (input.append) {
        let existing = '';
        try { existing = await readFile(filepath, 'utf-8'); } catch {}
        await writeFile(filepath, existing + '\n\n' + input.content, 'utf-8');
      } else {
        await writeFile(filepath, `# ${input.title}\n\n${input.content}`, 'utf-8');
      }

      return { success: true, data: { title: input.title, path: filepath } };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },
};

const readNoteTool: ITool = {
  name: 'read_note',
  description: 'Read a saved note by title.',
  inputSchema: readSchema,
  async execute(input: z.infer<typeof readSchema>, _ctx: ToolContext): Promise<ToolResult> {
    try {
      const filename = input.title.replace(/[^a-zA-Z0-9_\-. ]/g, '_') + '.md';
      const filepath = join(notesDir, filename);
      const content = await readFile(filepath, 'utf-8');
      return { success: true, data: { title: input.title, content } };
    } catch {
      return { success: false, error: `Note '${input.title}' not found` };
    }
  },
};

const listNotesTool: ITool = {
  name: 'list_notes',
  description: 'List all saved notes, optionally filtered by keyword.',
  inputSchema: listSchema,
  async execute(input: z.infer<typeof listSchema>, _ctx: ToolContext): Promise<ToolResult> {
    try {
      await mkdir(notesDir, { recursive: true });
      const files = await readdir(notesDir);
      let notes = files
        .filter((f) => f.endsWith('.md'))
        .map((f) => f.replace(/\.md$/, ''));

      if (input.filter) {
        const kw = input.filter.toLowerCase();
        notes = notes.filter((n) => n.toLowerCase().includes(kw));
      }

      return { success: true, data: { notes, count: notes.length } };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },
};

export const NotesSkill: ISkill = {
  name: 'notes',
  version: '1.0.0',
  description: 'Personal notes manager — save, read, and list markdown notes that persist across sessions.',
  tools: [saveNoteTool, readNoteTool, listNotesTool],
  async activate(ctx: SkillActivationContext) {
    notesDir = join(ctx.dataDir, 'notes');
    await mkdir(notesDir, { recursive: true });
  },
};
