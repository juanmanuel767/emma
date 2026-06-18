/**
 * Garantiza que el esquema de parámetros de CUALQUIER herramienta sea un JSON Schema válido
 * de tipo objeto antes de enviarlo al proveedor LLM. Una herramienta forjada con un esquema
 * malformado (p.ej. `{ "name": "string" }` sin `type: "object"`) provoca un 400 que tumba el
 * turno entero y, peor, envenena TODAS las peticiones mientras esa herramienta exista. Este
 * saneador es la última línea de defensa: nunca dejamos salir un esquema inválido.
 */
const VALID_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object', 'null']);

export function sanitizeToolSchema(schema: unknown): Record<string, unknown> {
  const empty = { type: 'object', properties: {} as Record<string, unknown> };
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return empty;
  const s = schema as Record<string, unknown>;

  // Ya es un esquema de objeto válido.
  if (s['type'] === 'object' && s['properties'] && typeof s['properties'] === 'object') {
    return s;
  }

  // Tiene properties pero le falta (o está mal) el type → completarlo.
  if (s['properties'] && typeof s['properties'] === 'object') {
    return {
      type: 'object',
      properties: s['properties'],
      ...(Array.isArray(s['required']) ? { required: s['required'] } : {}),
    };
  }

  // Forma abreviada típica de la forja: { campo: "string", otros: "array" } → propiedades reales,
  // así la herramienta sigue siendo USABLE (el modelo puede pasar argumentos), no solo "no rompe".
  const props: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(s)) {
    if (key === 'type' || key === 'required') continue;
    if (typeof val === 'string' && VALID_TYPES.has(val)) props[key] = { type: val };
    else if (val && typeof val === 'object') props[key] = val; // ya es un sub-esquema
  }
  return { type: 'object', properties: props };
}
