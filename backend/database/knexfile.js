const path = require('path');
const { config } = require('../config');
const Client_NodeSQLite = require('./node-sqlite-client');

module.exports = {
  // Default environment
  development: {
    client: Client_NodeSQLite, // 数据库类型
    useNullAsDefault: true,
    connection: { // 连接参数
      filename: path.join(config.databaseFolderDir, 'db.sqlite3'),
    },
    acquireConnectionTimeout: 40000, // 连接计时器
    pool: {
      afterCreate: (conn, done) => {
        // DatabaseSync is synchronous, so no callback chain is needed here.
        try {
          conn.exec('PRAGMA foreign_keys = ON;');
          conn.exec(`PRAGMA busy_timeout = ${config.dbBusyTimeout};`);
          done(null, conn);
        } catch (err) {
          done(err, conn);
        }
      }
    }
  },

  // NODE_ENV=production only toggles config.auth/config.production (see
  // config.js) -- there is no separate production database, so this mirrors
  // `development` exactly.
  production: {
    client: Client_NodeSQLite,
    useNullAsDefault: true,
    connection: {
      filename: path.join(config.databaseFolderDir, 'db.sqlite3'),
    },
    acquireConnectionTimeout: 40000,
    pool: {
      afterCreate: (conn, done) => {
        // DatabaseSync is synchronous, so no callback chain is needed here.
        try {
          conn.exec('PRAGMA foreign_keys = ON;');
          conn.exec(`PRAGMA busy_timeout = ${config.dbBusyTimeout};`);
          done(null, conn);
        } catch (err) {
          done(err, conn);
        }
      }
    }
  },

  // For migration only. Foreign keys are disabled (SQLite default)
  upgrade: {
    client: Client_NodeSQLite,
    connection: {
      filename: path.join(config.databaseFolderDir, 'db.sqlite3')
    },
    migrations: {
      tableName: 'knex_migrations'
    }
  },

  test: {
    client: Client_NodeSQLite,
    connection: {
      filename: path.join(__dirname, '../test/db-test.sqlite3'),
    },
    useNullAsDefault: true,
    migrations: {
      tableName: 'knex_migrations'
    }
  }
};
