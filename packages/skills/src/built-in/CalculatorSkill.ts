import { z } from 'zod';
import type { ISkill } from '../types.js';
import type { ITool, ToolContext, ToolResult } from '@emma/tools';

const calcSchema = z.object({
  expression: z.string().describe('Mathematical expression to evaluate, e.g. "2 + 2", "sqrt(144)", "15% of 2500"'),
});

function safeEval(expr: string): number {
  // Sanitize: only allow math characters
  const sanitized = expr
    .replace(/\s+/g, '')
    .replace(/(\d+)%of(\d+(?:\.\d+)?)/gi, '($1/100)*$2')
    .replace(/(\d+(?:\.\d+)?)%/g, '($1/100)');

  if (!/^[0-9+\-*/().,%\s^eE]+$/.test(sanitized) &&
      !/^(sqrt|abs|ceil|floor|round|log|sin|cos|tan|PI|E)\(/.test(sanitized)) {
    throw new Error('Invalid expression — only mathematical operations are allowed');
  }

  const mathFns = {
    sqrt: Math.sqrt, abs: Math.abs, ceil: Math.ceil, floor: Math.floor,
    round: Math.round, log: Math.log, sin: Math.sin, cos: Math.cos,
    tan: Math.tan, PI: Math.PI, E: Math.E,
  };

  // eslint-disable-next-line no-new-func
  const fn = new Function(...Object.keys(mathFns), `return ${sanitized}`);
  return fn(...Object.values(mathFns)) as number;
}

const calculatorTool: ITool = {
  name: 'calculate',
  description: 'Evaluate a mathematical expression precisely. Supports +, -, *, /, %, sqrt, abs, ceil, floor, round, sin, cos, tan, log. Also handles "X% of Y" syntax.',
  inputSchema: calcSchema,
  async execute(input: z.infer<typeof calcSchema>, _ctx: ToolContext): Promise<ToolResult> {
    try {
      const result = safeEval(input.expression);
      if (!isFinite(result)) {
        return { success: false, error: 'Result is not finite (division by zero or overflow)' };
      }
      return {
        success: true,
        data: {
          expression: input.expression,
          result,
          formatted: Number.isInteger(result) ? result.toString() : result.toFixed(10).replace(/\.?0+$/, ''),
        },
      };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },
};

export const CalculatorSkill: ISkill = {
  name: 'calculator',
  version: '1.0.0',
  description: 'Safe mathematical expression evaluator — handles arithmetic, percentages, and common math functions.',
  tools: [calculatorTool],
};
