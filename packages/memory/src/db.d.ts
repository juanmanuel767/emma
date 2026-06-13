import { Pool } from 'pg';
import * as schema from './schema/index.js';
export declare function createDb(databaseUrl: string): import("drizzle-orm/node-postgres").NodePgDatabase<typeof schema> & {
    $client: Pool;
};
export type Database = ReturnType<typeof createDb>;
//# sourceMappingURL=db.d.ts.map