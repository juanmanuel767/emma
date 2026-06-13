import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema/index.js';
export function createDb(databaseUrl) {
    const pool = new Pool({ connectionString: databaseUrl });
    return drizzle(pool, { schema });
}
//# sourceMappingURL=db.js.map