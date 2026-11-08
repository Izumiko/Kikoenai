// @ts-nocheck
// knex client backed by node:sqlite's built-in DatabaseSync.
//
// knex has no node:sqlite dialect, so this reuses the better-sqlite3 dialect
// (same sqlite3 query/schema compilers and transaction handling) and swaps only
// the driver layer. The connection options reproduce the native sqlite3
// module's defaults, which node:sqlite flips: foreign key constraints are ON by
// default there, and double-quoted string literals are rejected.
import { DatabaseSync } from 'node:sqlite';
import Client_BetterSQLite3 from 'knex/lib/dialects/better-sqlite3/index.js';

// node:sqlite returns rows with a null prototype; everything downstream expects
// plain objects (e.g. `row.hasOwnProperty(...)` in route code).
function toPlainRow(row) {
  return { ...row };
}

class Client_NodeSQLite extends Client_BetterSQLite3 {
  _driver() {
    // There is no driver package to load: node:sqlite is a built-in module.
    return { DatabaseSync };
  }

  // The default mode for the sqlite3 module was READWRITE | CREATE; only the
  // filename is required here, so an explicit readOnly opt-out is all that is
  // needed. `enableForeignKeyConstraints` must stay off to match sqlite3, but
  // knexfile's afterCreate turns the pragma on for the app connection.
  async acquireRawConnection() {
    const options = this.connectionSettings.options || {};

    return new DatabaseSync(this.connectionSettings.filename, {
      readOnly: !!(options.readonly || options.readOnly),
      enableForeignKeyConstraints: false,
      enableDoubleQuotedStringLiterals: true,
    });
  }

  async destroyRawConnection(connection) {
    return connection.close();
  }

  async _query(connection, obj) {
    if (!obj.sql) throw new Error('The query is empty');

    if (!connection) {
      throw new Error('No connection provided');
    }

    const statement = connection.prepare(obj.sql);
    const bindings = this._formatBindings(obj.bindings);

    // StatementSync has no `reader` flag (better-sqlite3 does): a statement
    // returns rows exactly when it declares result columns.
    if (statement.columns().length > 0) {
      obj.response = statement.all(...bindings).map(toPlainRow);
      return obj;
    }

    const response = statement.run(...bindings);
    obj.response = response;
    // lastInsertRowid is a bigint for large ids; sqlite3 always returned a
    // number and knex's processResponse hands lastID straight to the caller.
    obj.context = {
      lastID: Number(response.lastInsertRowid),
      changes: Number(response.changes),
    };

    return obj;
  }
}

Object.assign(Client_NodeSQLite.prototype, {
  // The "dialect", for reference.
  driverName: 'node-sqlite',
});

export default Client_NodeSQLite;
