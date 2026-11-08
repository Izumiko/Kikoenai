// Freeze the config file, for CLI scripts.
//
// config.ts writes config/config.json at module-init time unless
// FREEZE_CONFIG_FILE is set -- but ESM evaluates every import of a module
// before any of its own statements, so a script cannot set the flag itself and
// have it apply. Import this module FIRST instead:
//
//   import './freeze-config.ts';
//   import db from '../database/db.ts';
//
// dependencies are evaluated in import-declaration order, so the flag is in
// place before config.ts runs. Same flag the test suite sets (see
// backend/test/setup-env.ts).
process.env.FREEZE_CONFIG_FILE = process.env.FREEZE_CONFIG_FILE || '1';
