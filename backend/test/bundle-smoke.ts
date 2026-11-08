// Smoke test for the esbuild bundle (scripts/build.ts).
//
// Not part of `npm test`: it runs a full production build and boots the result,
// which takes seconds. Run it with `npm run test:bundle -w backend`.
//
// The built `build/` directory is copied OUTSIDE the repository on purpose: no
// node_modules is reachable from there, so anything the bundle needs at runtime
// has to be inside the deployment directory or the run fails here.
//
// Assertions, in order:
//   - the scanner entry point resolves to the right layout in both run modes
//   - `node app.mjs` boots and /api/health answers 200
//   - the data folders land INSIDE the deployment directory (KIKO_DATA_DIR
//     unset, so dataRoot is appDir -- see app-dir.ts)
//   - knex_migrations keeps the upstream `.js` filenames
//   - the forked scanner runs from the bundle (the child process path in
//     socket.ts is the one that would be wrong in a bundle)
//   - after config.basePath is set in config.json and the app restarted,
//     /kikoeru/api/health answers 200 and the served index.html no longer
//     carries the build-time placeholder prefix

// The build below is fast enough to run once for the whole file; every test
// reads the same deployment directory, in order.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, fork, spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { appDir } from '../app-dir.ts';
import { scannerScriptPath } from '../socket.ts';

const BACKEND_DIR = path.join(import.meta.dirname, '..');
const BUILD_DIR = path.join(BACKEND_DIR, 'build');

/** Entry points the bundle must contain, flat in build/ (see scripts/build.ts). */
const ENTRY_POINTS = [
  'app.mjs',
  'scanner.mjs',
  'updater.mjs',
  'workFileScanner.mjs',
  // The documented maintenance commands: build/ ships without node_modules or
  // .ts sources, so these are the only copies a deployment has.
  'backfill-progress.mjs',
  'import-legacy-history.mjs',
];

/**
 * Runtime state a previously booted build/ directory would already hold. The
 * copy has to start clean: a copied database would make the migration
 * assertion read someone else's schema, and a copied config.json would pin
 * absolute paths to the directory it was copied from.
 */
const RUNTIME_DIRS = ['config', 'sqlite', 'covers', 'images', 'logs', 'transcodes', 'lyrics', 'VoiceWork'];

interface BootedServer {
  child: ChildProcess;
  /** Everything the child has printed so far, for failure messages. */
  output: () => string;
  stop: () => Promise<void>;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

const npmCommand = (): string => (process.platform === 'win32' ? 'npm.cmd' : 'npm');

/**
 * Environment for a child that must behave like a real deployment: a random
 * port, production mode, and none of the test suite's overrides. KIKO_DATA_DIR
 * is deliberately absent -- the point is that data follows the deployment
 * directory.
 */
const deploymentEnv = (port: number): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(port), NODE_ENV: 'production' };
  delete env.KIKO_DATA_DIR;
  delete env.FREEZE_CONFIG_FILE;
  delete env.KNEX_ENV;
  return env;
};

/** Ask the OS for a free port by listening on port 0 and closing again. */
const freePort = async (): Promise<number> => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const address = probe.address();
    if (address === null || typeof address === 'string') {
      probe.close();
      reject(new Error('Could not determine a free port'));
      return;
    }
    const { port } = address;
    probe.close(() => resolve(port));
  });
});

const bootServer = async (deploymentDir: string, port: number): Promise<BootedServer> => {
  const child = spawn(process.execPath, ['app.mjs'], {
    cwd: deploymentDir,
    env: deploymentEnv(port),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => { output += chunk; });
  child.stderr?.on('data', (chunk: string) => { output += chunk; });

  const stop = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 5000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill('SIGTERM');
    });
  };

  return { child, output: () => output, stop };
};

/** Poll `url` until it answers 200, failing fast if the child dies. */
const waitForHealth = async (url: string, server: BootedServer): Promise<void> => {
  const deadline = Date.now() + 60000;
  let lastStatus = 'no response';
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) {
      throw new Error(`The server exited (code ${server.child.exitCode}) before ${url} answered.\n--- output ---\n${server.output()}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      // Read the body so the connection is released instead of left hanging.
      await response.text();
      if (response.status === 200) return;
      lastStatus = String(response.status);
    } catch {
      // Not listening yet.
    }
    await delay(200);
  }
  throw new Error(`Timed out waiting for ${url} (last status: ${lastStatus}).\n--- output ---\n${server.output()}`);
};

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Run an entry point the way an operator would: `node <script>` in the deployment. */
const runInDeployment = (deploymentDir: string, args: string[]): CliResult => {
  const result = spawnSync(process.execPath, args, {
    cwd: deploymentDir,
    env: deploymentEnv(0),
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

/** Fork a bundled scanner script the way socket.ts does, and report its exit. */
const forkScanner = (deploymentDir: string, script: string): Promise<{ code: number | null; output: string }> => new Promise((resolve, reject) => {
  const child = fork(path.join(deploymentDir, script), [], {
    cwd: deploymentDir,
    env: deploymentEnv(0),
    silent: true,
    // fork() inherits the parent's execArgv by default, which here would be
    // this suite's `--import ./test/setup-env.ts` -- a path that does not exist
    // in the deployment directory. The app forks its scanners with no flags.
    execArgv: [],
  });
  let output = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => { output += chunk; });
  child.stderr?.on('data', (chunk: string) => { output += chunk; });

  const timer = setTimeout(() => {
    child.kill('SIGKILL');
    reject(new Error(`Forked ${script} did not exit within 60s.\n--- output ---\n${output}`));
  }, 60000);

  child.on('exit', (code) => {
    clearTimeout(timer);
    resolve({ code, output });
  });
  child.on('error', (err) => {
    clearTimeout(timer);
    reject(err);
  });
});

describe('bundled backend', () => {
  let root: string;
  /** The deployment directory: a copy of build/, outside the repository. */
  let deployment: string;
  let server: BootedServer | null = null;

  before(() => {
    // The documented build command, not the script behind it: this test is
    // what proves `npm run build` produces a deployable directory.
    execFileSync(npmCommand(), ['run', 'build'], {
      cwd: BACKEND_DIR,
      stdio: 'inherit',
      shell: process.platform === 'win32', // .cmd needs a shell to launch
    });

    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiko-bundle-'));
    deployment = path.join(root, 'app');
    fs.cpSync(BUILD_DIR, deployment, { recursive: true });
    for (const dir of RUNTIME_DIRS) {
      fs.rmSync(path.join(deployment, dir), { recursive: true, force: true });
    }
  });

  after(async () => {
    if (server) await server.stop();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  // The fork path is mode-dependent, so pin both layouts. The default argument
  // follows how socket.ts was loaded: this suite runs from the source tree, so
  // it must pick the .ts layout.
  it('resolves the scanner entry point for both run layouts', () => {
    assert.equal(scannerScriptPath('scanner', false), path.join(appDir, 'filesystem', 'scanner.ts'));
    assert.equal(scannerScriptPath('updater', false), path.join(appDir, 'filesystem', 'updater.ts'));
    assert.equal(scannerScriptPath('workFileScanner', false), path.join(appDir, 'filesystem', 'workFileScanner.ts'));

    assert.equal(scannerScriptPath('scanner', true), path.join(appDir, 'scanner.mjs'));
    assert.equal(scannerScriptPath('updater', true), path.join(appDir, 'updater.mjs'));
    assert.equal(scannerScriptPath('workFileScanner', true), path.join(appDir, 'workFileScanner.mjs'));

    // Running this file is a source run, so the default argument picks .ts.
    assert.equal(scannerScriptPath('scanner'), path.join(appDir, 'filesystem', 'scanner.ts'));
  });

  it('boots from a directory with no node_modules and answers /api/health', async () => {
    for (const entry of ENTRY_POINTS) {
      assert.equal(fs.existsSync(path.join(deployment, entry)), true, `build/${entry} should exist`);
    }

    // Guard the premise: if node_modules were reachable anywhere above the
    // deployment, a bundle that forgot a dependency would still boot and this
    // test would prove nothing.
    for (let dir = deployment; ; dir = path.dirname(dir)) {
      assert.equal(fs.existsSync(path.join(dir, 'node_modules')), false,
        `a node_modules is reachable at ${dir}; the deployment must be isolated`);
      if (dir === os.tmpdir() || path.dirname(dir) === dir) break;
    }

    // Copied from static/ by scripts/build.ts; the cover fallback needs it.
    assert.equal(fs.existsSync(path.join(deployment, 'static', 'no-image.jpg')), true);

    // dist/ is copied only when the frontend has been built (scripts/build.ts
    // warns and skips it otherwise). When it exists, the copy must carry it.
    if (fs.existsSync(path.join(BACKEND_DIR, 'dist'))) {
      assert.equal(fs.existsSync(path.join(deployment, 'dist', 'index.html')), true,
        'build/dist should carry the frontend build');
    }

    const port = await freePort();
    server = await bootServer(deployment, port);
    await waitForHealth(`http://127.0.0.1:${port}/api/health`, server);

    // No KIKO_DATA_DIR: the data root is the deployment directory itself.
    assert.equal(fs.existsSync(path.join(deployment, 'sqlite', 'db.sqlite3')), true,
      'the database should be created inside the deployment directory');
    assert.equal(fs.existsSync(path.join(deployment, 'config', 'config.json')), true,
      'config.json should be written inside the deployment directory');
  });

  it('runs the forked scanner from the bundle', async () => {
    // Stop the server first: the scan opens the same database.
    if (server) {
      await server.stop();
      server = null;
    }

    const result = await forkScanner(deployment, 'scanner.mjs');
    assert.equal(result.code, 0, `the forked scanner should exit cleanly.\n--- output ---\n${result.output}`);

    // The scan log is written before anything is scanned, so its presence
    // proves the child got all the way into the scan code.
    const logs = fs.existsSync(path.join(deployment, 'logs'))
      ? fs.readdirSync(path.join(deployment, 'logs'))
      : [];
    assert.equal(logs.some((file) => file.endsWith('.log')), true, `expected a scan log, got ${logs.join(', ')}`);
  });

  // Both scripts gate their main on `import.meta.main` (see their CLI sections).
  // A bundle that moved that code into a shared chunk would leave the gate
  // false: the process would start, do nothing and exit 0. The output is what
  // tells the two apart.
  it('runs the bundled maintenance CLIs', () => {
    const backfill = runInDeployment(deployment, ['backfill-progress.mjs', '--dry-run']);
    assert.equal(backfill.status, 0, `backfill-progress.mjs --dry-run should exit 0.\n--- stdout ---\n${backfill.stdout}\n--- stderr ---\n${backfill.stderr}`);
    assert.match(backfill.stdout, /\[backfill-progress\]/, 'the CLI should have done something, not silently exited');

    // With no argument it can only print its usage and exit 1; a false
    // import.meta.main would exit 0 with no output instead.
    const importer = runInDeployment(deployment, ['import-legacy-history.mjs']);
    assert.equal(importer.status, 1, `import-legacy-history.mjs without an argument should exit 1.\n--- stdout ---\n${importer.stdout}\n--- stderr ---\n${importer.stderr}`);
    assert.match(importer.stderr, /Usage: node \.\/scripts\/import-legacy-history/, 'the usage message should be printed');
  });

  it('keeps the upstream .js migration names in knex_migrations', () => {
    const database = new DatabaseSync(path.join(deployment, 'sqlite', 'db.sqlite3'), { readOnly: true });
    try {
      const names = database.prepare('SELECT name FROM knex_migrations').all().map((row) => String(row.name));
      assert.ok(names.length > 0, 'the schema should have registered its migrations');
      for (const name of names) {
        assert.equal(name.endsWith('.js'), true, `${name} should keep the .js spelling`);
      }
    } finally {
      database.close();
    }
  });

  it('serves under config.basePath after a restart', async () => {
    const configPath = path.join(deployment, 'config', 'config.json');
    const config: Record<string, unknown> = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    config.basePath = '/kikoeru';
    fs.writeFileSync(configPath, JSON.stringify(config, null, '\t'));

    const port = await freePort();
    server = await bootServer(deployment, port);
    await waitForHealth(`http://127.0.0.1:${port}/kikoeru/api/health`, server);

    // The frontend build is optional in a backend-only build (scripts/build.ts
    // warns and skips a missing dist/), so only check the shell when it exists.
    if (fs.existsSync(path.join(deployment, 'dist', 'index.html'))) {
      const response = await fetch(`http://127.0.0.1:${port}/kikoeru/`);
      assert.equal(response.status, 200);
      const html = await response.text();
      // The placeholder prefix is what must be gone. The injected runtime
      // global (`window.__KIKO_BASE__`) contains the bare name by design, so
      // the check is for the placeholder path token, not the identifier.
      assert.equal(html.includes('/__KIKO_BASE__/'), false, 'index.html should carry the real prefix');
      assert.equal(html.includes('window.__KIKO_BASE__'), true, 'index.html should name the prefix to the frontend');
    }
  });
});
