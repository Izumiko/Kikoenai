import fs from 'fs';
import path from 'path';
import knexLib from 'knex';
import type { Knex } from 'knex';
import { config } from '../config.ts';
import * as knexfile from './knexfile.ts';
import { makeQueries } from './queries.ts';

const databaseExist = fs.existsSync(path.join(config.databaseFolderDir, 'db.sqlite3'));

// knex 操作数据库
const connEnv = process.env.KNEX_ENV || process.env.NODE_ENV || 'development';
// Keyed by environment name; an unknown one stays undefined and knex then
// reports the missing `client`, exactly as the CommonJS version did.
const conn = (knexfile as Record<string, Knex.Config | undefined>)[connEnv];
const knex = knexLib(conn as Knex.Config);

const queries = makeQueries(knex);

// The query functions are created at runtime by makeQueries, so they cannot be
// static named exports. The merged object is the default export, exactly as the
// CommonJS export object of `{ knex, databaseExist, ...queries }` was; callers
// read `db.getWorks(...)` off it.
const db = { knex, databaseExist, ...queries };

export default db;
export { knex, databaseExist };
