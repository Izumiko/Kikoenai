// Side-effect module: loads .env from the current working directory before
// anything reads process.env. This replaces `import 'dotenv/config'`, and it
// has to be the FIRST import of an entry point because ESM evaluates imports
// in source order (hoisting means a statement after the imports would run too
// late for config.ts).
//
// process.loadEnvFile() never overwrites variables that are already set, which
// is dotenv's behaviour too. A missing .env is the normal case (container
// deployments pass environment variables directly), so ENOENT is ignored.

try {
  process.loadEnvFile();
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
}
