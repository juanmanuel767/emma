import { z } from 'zod';
import type { ISkill } from '../types.js';
import type { ITool, ToolContext, ToolResult } from '@emma/tools';

const timezoneSchema = z.object({
  timezone: z.string().optional().describe('IANA timezone, e.g. America/Mexico_City'),
  format: z.enum(['iso', 'locale', 'unix']).default('locale'),
});

const datetimeTool: ITool = {
  name: 'get_datetime',
  description: 'Get the current date and time. Use this when asked about the current time, date, day of the week, or timezone.',
  inputSchema: timezoneSchema,
  async execute(input: z.infer<typeof timezoneSchema>, _ctx: ToolContext): Promise<ToolResult> {
    try {
      const now = new Date();
      const tz = input.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

      let result: string;
      if (input.format === 'iso') {
        result = now.toISOString();
      } else if (input.format === 'unix') {
        result = String(Math.floor(now.getTime() / 1000));
      } else {
        result = now.toLocaleString('es-ES', {
          timeZone: tz,
          weekday: 'long',
          year: 'numeric',
          month: 'long',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        });
      }

      return { success: true, data: { datetime: result, timezone: tz } };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },
};

export const DatetimeSkill: ISkill = {
  name: 'datetime',
  version: '1.0.0',
  description: 'Date and time utilities — get current time, timezone info, and date formatting.',
  tools: [datetimeTool],
};
