import { mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { createLogger } from '@emma/shared/logger';
import type { ITool } from '@emma/tools';
import type { ISkill } from '../types.js';
import type { SkillRegistry } from '../SkillRegistry.js';

const logger = createLogger('ForgeSkill');

// ── Code post-processor ───────────────────────────────────────────────────────
/**
 * Rewrites inner named function declarations to const arrow functions.
 *
 * Handles patterns like:
 *   async function doWork(x) { ... }   →  const doWork = async (x) => { ... }
 *         function helper(x) { ... }   →  const helper = (x) => { ... }
 *
 * This prevents the LLM's common mistake of defining a helper function
 * that it never calls (because only the function body is executed).
 */
function rewriteInnerFunctions(code: string): { code: string; rewrote: string[] } {
  const rewrote: string[] = [];

  // Match top-level (non-indented) named function declarations
  // Pattern: optional 'async', 'function', name, params, body
  const fnDeclPattern = /^([ \t]*)(async\s+)?function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*(\([^)]*\))\s*\{/gm;

  const result = code.replace(fnDeclPattern, (match, indent, asyncKw, name, params) => {
    rewrote.push(name);
    const asyncStr = asyncKw ? 'async ' : '';
    return `${indent}const ${name} = ${asyncStr}${params} => {`;
  });

  return { code: result, rewrote };
}

/**
 * Diagnose syntax errors with friendly messages.
 * Returns a human-readable error string or null if code is valid.
 */
function diagnoseSyntaxError(code: string, err: unknown): string {
  const raw = String(err);

  // Extract line number if available
  const lineMatch = raw.match(/line (\d+)/i) ?? raw.match(/:(\d+):/);
  const lineNum = lineMatch?.[1] != null ? parseInt(lineMatch[1]!, 10) : null;

  let hint = '';
  if (lineNum) {
    const lines = code.split('\n');
    const lineContent = (lines[lineNum - 1] ?? '').trim();
    hint = `\n  Line ${lineNum}: ${lineContent}`;
  }

  // Common error patterns with targeted advice
  if (raw.includes('Unexpected token')) {
    const tokenMatch = raw.match(/Unexpected token '([^']+)'/);
    const token = tokenMatch?.[1] ?? '';
    if (token === '}' || token === ')' || token === ']') {
      hint += '\n  Hint: Mismatched bracket/brace — check that all { } ( ) are balanced.';
    } else if (token === 'import') {
      hint += '\n  Hint: Use "await import(\'module\')" not top-level import statements.';
    }
  } else if (raw.includes('await is only valid')) {
    hint += '\n  Hint: "await" can only be used inside an async function. Wrap your code in: const result = await (async () => { ... })();';
  } else if (raw.includes('Identifier') && raw.includes('already been declared')) {
    hint += '\n  Hint: Duplicate variable name. Rename one of the variables.';
  }

  return `Syntax error in forged code: ${raw}${hint}\n\nFix the code and call forge_tool again.`;
}

/**
 * Attempt to execute the code with a dummy input to catch runtime errors early.
 * Returns null on success or an error string.
 */
async function testRunCode(code: string): Promise<string | null> {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
    ...args: string[]
  ) => (...a: unknown[]) => Promise<unknown>;

  const fn = new AsyncFunction('input', 'ctx', code);
  const dummyInput = {};
  const dummyCtx = { sessionId: '__test__', conversationId: '__test__', permissions: [], signal: new AbortController().signal };

  try {
    const result = await Promise.race([
      fn(dummyInput, dummyCtx),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Test-run timed out after 10s')), 10_000),
      ),
    ]);

    // Validate the result shape
    if (result && typeof result === 'object') {
      const r = result as Record<string, unknown>;
      if (!('success' in r)) {
        return 'Test-run warning: return value is missing "success" field. Return { success: boolean, data?: any, error?: string }.';
      }
    }
    return null;
  } catch (err) {
    const msg = String(err);
    // Some errors are expected for dummy inputs (e.g. missing required fields hitting fetch)
    // Only fail hard on TypeError/ReferenceError which indicate real bugs
    if (
      msg.includes('ReferenceError') ||
      (msg.includes('TypeError') && !msg.includes('fetch') && !msg.includes('network') && !msg.includes('undefined'))
    ) {
      return `Test-run runtime error: ${msg}\nThis likely indicates a bug in the code. Fix it before saving.`;
    }
    // fetch/network errors are expected in test mode — that's fine
    return null;
  }
}

export function createForgeSkill(registry: SkillRegistry, dataDir: string): ISkill {
  const skillsDir = join(dataDir, 'skills');

  const forgeTool: ITool = {
    name: 'forge_tool',
    description: `Create a new persistent tool when existing tools cannot complete a task.
Write JavaScript (ESM) code that runs in Node.js. The tool is saved to disk and loaded immediately — no restart needed.
After forging, use the new tool right away to complete the original task.`,

    inputSchema: z.object({
      skill_name: z.string()
        .regex(/^[a-z][a-z0-9-]*$/)
        .describe('Skill name in kebab-case (e.g. "weather-api", "currency-converter")'),
      tool_name: z.string()
        .regex(/^[a-z][a-z0-9_]*$/)
        .describe('Tool function name in snake_case (e.g. "get_weather", "convert_currency")'),
      description: z.string().describe('What this tool does — be specific'),
      parameters: z.preprocess(
        (v) => (typeof v === 'string' ? (() => { try { return JSON.parse(v); } catch { return {}; } })() : v),
        z.record(z.unknown()),
      ).describe(
        'JSON Schema object (NOT a string) for tool inputs. Example: { "type": "object", "properties": { "city": { "type": "string" } }, "required": ["city"] }. Pass {} if no parameters needed.',
      ),
      code: z.string().describe(
        `Async JavaScript statements — the BODY of an async function. Rules:
1. Write INLINE statements. DO NOT define named inner functions — they won't be called.
   (If you must use helpers, assign them to const: const helper = (x) => { ... })
2. Use global fetch() for HTTP — never import node:undici.
3. Must have a top-level return { success: boolean, data?: any, error?: string }
4. Can use: const { readFile } = await import('node:fs/promises')

CORRECT example:
  const res = await fetch('https://api.example.com/data?q=' + input.query);
  const json = await res.json();
  return { success: true, data: json };

WRONG (inner function never called!):
  async function doWork() { ... }  ← will be auto-fixed, but result may surprise you`,
      ),
      test_run: z.boolean().optional().default(true).describe(
        'Whether to do a quick test-run of the code before saving (default: true). Set to false to skip validation.',
      ),
    }),

    execute: async (input) => {
      const { skill_name, tool_name, description, parameters, code: rawCode, test_run } = input as {
        skill_name: string;
        tool_name: string;
        description: string;
        parameters: Record<string, unknown>;
        code: string;
        test_run: boolean;
      };

      try {
        // Step 1: Rewrite inner function declarations to arrow functions
        const { code, rewrote } = rewriteInnerFunctions(rawCode);
        if (rewrote.length > 0) {
          logger.info({ functions: rewrote, skill: skill_name }, 'Auto-fixed inner function declarations to const arrows');
        }

        // Step 2: Syntax-check using AsyncFunction so 'await' is valid
        const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => (...a: unknown[]) => Promise<unknown>;
        try {
          new AsyncFunction('input', 'ctx', code);
        } catch (syntaxErr) {
          return {
            success: false,
            error: diagnoseSyntaxError(code, syntaxErr),
          };
        }

        // Step 3: Guard — code must have a return statement somewhere
        if (!/\breturn\b/.test(code)) {
          return {
            success: false,
            error: [
              'Code must have a "return { success: boolean, data: ... }" statement.',
              'Write inline statements — do NOT define inner functions that you never call.',
              '',
              'Example fix:',
              '  const res = await fetch("https://api.example.com/data");',
              '  return { success: true, data: await res.json() };',
            ].join('\n'),
          };
        }

        // Step 4: Optional test-run to catch runtime errors early
        if (test_run !== false) {
          const testError = await testRunCode(code);
          if (testError && testError.includes('Test-run runtime error')) {
            return {
              success: false,
              error: [
                testError,
                '',
                rewrote.length > 0
                  ? `Note: ${rewrote.length} inner function(s) were auto-rewritten to arrow functions: ${rewrote.join(', ')}`
                  : '',
              ].filter(Boolean).join('\n'),
            };
          }
          if (testError) {
            // Non-fatal warning — log it but proceed
            logger.warn({ skill: skill_name, warning: testError }, 'Test-run warning (non-fatal)');
          }
        }

        // Step 5: Write skill to disk
        const skillDir = join(skillsDir, skill_name);
        await mkdir(skillDir, { recursive: true });

        await writeFile(
          join(skillDir, 'skill.json'),
          JSON.stringify(
            {
              name: skill_name,
              version: '1.0.0',
              description,
              author: 'emma-ai',
              entry: 'index.mjs',
              createdAt: new Date().toISOString(),
            },
            null,
            2,
          ),
        );

        const moduleSource = buildModuleSource(skill_name, tool_name, description, parameters, code);
        await writeFile(join(skillDir, 'index.mjs'), moduleSource);

        // Step 6: Hot-reload so the tool is available immediately
        const { added, updated } = await registry.hotReload();
        const action = updated.includes(skill_name) ? 'updated' : 'created';

        logger.info({ skill: skill_name, tool: tool_name, action }, 'Tool forged and loaded');

        const notes: string[] = [];
        if (rewrote.length > 0) {
          notes.push(`Auto-fixed: ${rewrote.length} inner function declaration(s) rewritten to const arrow functions (${rewrote.join(', ')})`);
        }

        return {
          success: true,
          data: [
            `Tool '${tool_name}' has been ${action} and is now available. You can call it immediately.`,
            ...notes,
          ].join('\n'),
        };
      } catch (err) {
        logger.error({ err }, 'forge_tool failed');
        return {
          success: false,
          error: `forge_tool internal error: ${String(err)}. Check the code and try again.`,
        };
      }
    },
  };

  const listForgedTool: ITool = {
    name: 'list_forged_tools',
    description: 'List all tools you have previously created with forge_tool',
    inputSchema: z.object({}),

    execute: async () => {
      try {
        let entries: string[] = [];
        try {
          entries = await readdir(skillsDir);
        } catch {
          return { success: true, data: 'No forged tools yet.' };
        }

        const lines: string[] = [];
        for (const dir of entries) {
          try {
            const raw = await readFile(join(skillsDir, dir, 'skill.json'), 'utf-8');
            const m = JSON.parse(raw) as { name: string; description: string; createdAt?: string };
            const date = m.createdAt ? m.createdAt.substring(0, 10) : 'unknown';
            lines.push(`- ${m.name}: ${m.description} (forged: ${date})`);
          } catch {
            /* skip invalid entries */
          }
        }

        return {
          success: true,
          data: lines.length > 0 ? lines.join('\n') : 'No forged tools yet.',
        };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    },
  };

  return {
    name: 'tool-forge',
    version: '1.0.0',
    description: 'Meta-skill: Emma can create new persistent tools on demand when existing tools are insufficient.',
    author: 'emma-core',
    tools: [forgeTool, listForgedTool],
  };
}

function buildModuleSource(
  skillName: string,
  toolName: string,
  description: string,
  parameters: unknown,
  code: string,
): string {
  const ts = new Date().toISOString();
  const descJson = JSON.stringify(description);
  const paramsJson = JSON.stringify(parameters, null, 4);
  // Indent each line of user code by 8 spaces for readability
  const indentedCode = code
    .split('\n')
    .map((l) => (l.trim() ? `        ${l}` : ''))
    .join('\n');

  return `// Auto-forged by Emma — ${ts}
// Skill: ${skillName} | Tool: ${toolName}
export default {
  name: '${skillName}',
  version: '1.0.0',
  description: ${descJson},
  author: 'emma-ai',
  tools: [
    {
      name: '${toolName}',
      description: ${descJson},
      parameters: ${paramsJson},
      execute: async (input, ctx) => {
${indentedCode}
      }
    }
  ]
};
`;
}
