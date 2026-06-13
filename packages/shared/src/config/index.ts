import { z, ZodType, ZodTypeDef } from 'zod';

// ZodSchema<T> constrains input=T=output, which breaks schemas with .default()/.optional().
// ZodType<T, D, unknown> only constrains the output type, which is what we need.
export function loadConfig<T>(
  schema: ZodType<T, ZodTypeDef, unknown>,
  source: NodeJS.ProcessEnv = process.env,
): T {
  const result = schema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return result.data;
}

export const baseEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
});

export type BaseEnv = z.infer<typeof baseEnvSchema>;

export { z };
