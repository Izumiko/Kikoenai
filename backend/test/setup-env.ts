// Loaded by mocha (see backend/.mocharc.json) before any test module is
// imported: ESM hoists imports, so a test file can no longer set these
// process.env values before config.ts runs its module-init side effects.
// FREEZE_CONFIG_FILE keeps the suite from ever writing a real config.json.
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.FREEZE_CONFIG_FILE = '1';
