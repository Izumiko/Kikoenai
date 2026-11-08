/*
 * knex's better-sqlite3 dialect is a deep import (`knex/lib/.../index.js`) with
 * no type declarations of its own.
 *
 * database/node-sqlite-client.ts extends that dialect to run on node:sqlite
 * instead of the native better-sqlite3 module, so this declares exactly the
 * surface it touches -- the base client plus the driver hooks it overrides.
 * Everything else comes from knex's own `Knex.Client` type.
 */
declare module 'knex/lib/dialects/better-sqlite3/index.js' {
  import type { Knex } from 'knex';
  import type { SQLInputValue } from 'node:sqlite';

  /** The connection options this app sets; knex reads them off the knexfile. */
  interface NodeSqliteConnectionOptions {
    readonly?: boolean;
    readOnly?: boolean;
  }

  interface NodeSqliteConnectionSettings {
    filename: string;
    options?: NodeSqliteConnectionOptions;
  }

  /**
   * The query object knex passes to `Client#_query`. Only the fields this app
   * reads or writes are declared; knex fills in the rest.
   */
  interface KnexQueryObject {
    sql?: string;
    bindings?: SQLInputValue[];
    response?: unknown;
    context?: { lastID?: number; changes?: number };
  }

  export default class Client_BetterSQLite3 extends Knex.Client {
    connectionSettings: NodeSqliteConnectionSettings;
    /** Has the dialect's bindings -> SQLite values conversion. */
    _formatBindings(bindings?: SQLInputValue[]): SQLInputValue[];
  }
}
