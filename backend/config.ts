import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { Config } from './types/config.ts';
import { appDir } from './app-dir.ts';

// path.resolve, never the raw value: a relative KIKO_DATA_DIR leaves every
// derived path relative, which res.sendFile rejects and which resolveDataFolder
// re-joins onto dataRoot on every startup (`data/data/covers`, then deeper,
// since setConfig persists each round). The base is process.cwd().
const dataRoot = path.resolve(process.env.KIKO_DATA_DIR || appDir);
if (process.env.KIKO_DATA_DIR && !path.isAbsolute(process.env.KIKO_DATA_DIR)) {
  console.log(`KIKO_DATA_DIR is relative, resolved to: ${dataRoot}`);
}

if (process.env.IS_DOCKER && dataRoot !== appDir) {
  const legacyDb = path.join(appDir, 'sqlite', 'db.sqlite3');
  const currentDb = path.join(dataRoot, 'sqlite', 'db.sqlite3');
  if (fs.existsSync(legacyDb) && !fs.existsSync(currentDb)) {
    console.warn(` !!! Found a database at ${legacyDb}, but the current data root ${dataRoot} is empty.`);
    console.warn(` !!! Either mount your data into ${dataRoot} (config/ sqlite/ covers/ images/),`);
    console.warn(` !!! or set KIKO_DATA_DIR=${appDir} to keep the previous layout. See README.md.`);
  }
}
const configFolderDir = path.join(dataRoot, 'config');
const configPath = path.join(configFolderDir, 'config.json');
import { normalizeBasePath } from './base-path.ts';
import pjson from './package.json' with { type: 'json' };
import compareVersions from 'compare-versions';

// Before the following version, there is no version tracking
const versionWithoutVerTracking = '0.4.1';
// Before the following version, db path is using the absolute path in databaseFolderDir of config.json
const versionDbRelativePath = '0.5.8';

// Filled in by initConfig()/readConfig() at the bottom of this module, before
// any importer can read it.
let config = {} as Config;

const voiceWorkDefaultPath = (): string => {
  if (process.env.IS_DOCKER) {
    return '/usr/src/kikoeru/VoiceWork';
  } else {
    return path.join(dataRoot, 'VoiceWork');
  }
};

const defaultConfig: Config = {
  version: pjson.version,
  production: process.env.NODE_ENV === 'production' ? true : false,
  dbBusyTimeout: 1000,
  maxParallelism: 8,
  rootFolders: [
    // {
    //   name: '',
    //   path: ''
    // }
  ],
  skipWorkExtras: true, // Skip downloading sample/description images and scraping reviews. NOT the description itself, which is parsed from the page the scanner already fetches and is never gated.
  coverFolderDir: path.join(dataRoot, 'covers'),
  imageFolderDir: path.join(dataRoot, 'images'), // Scraped sample/description images, kept out of the cover cache
  databaseFolderDir: path.join(dataRoot, 'sqlite'),
  coverUseDefaultPath: false, // Ignores coverFolderDir if set to true
  imageUseDefaultPath: false, // Ignores imageFolderDir if set to true
  dbUseDefaultPath: true, // Ignores databaseFolderDir if set to true
  voiceWorkDefaultPath: voiceWorkDefaultPath(),
  auth: process.env.NODE_ENV === 'production' ? true : false,
  md5secret: crypto.randomBytes(32).toString('hex'),
  jwtsecret: crypto.randomBytes(32).toString('hex'),
  expiresIn: 2592000,
  scannerMaxRecursionDepth: 2,
  pageSize: 12,
  retry: 5,
  dlsiteTimeout: 10000,
  hvdbTimeout: 10000,
  fanzaTimeout: 10000,
  retryDelay: 2000,
  httpProxyHost: '',
  httpProxyPort: 0,
  listenPort: 8888,
  basePath: '',
  blockRemoteConnection: false,
  allowedHosts: [],
  behindProxy: false,
  httpsEnabled: false,
  httpsPrivateKey: 'kikoeru.key',
  httpsCert: 'kikoeru.crt',
  httpsPort: 8443,
  skipCleanup: false,
  enableGzip: true,
  rewindSeekTime: 5,
  forwardSeekTime: 30,
  offloadMedia: false,
  offloadStreamPath: '/media/stream/',          // /media/stream/RJ123456/subdirs/track.mp3
  offloadDownloadPath: '/media/download/',      // /media/download/RJ123456/subdirs/track.mp3
  enableTranscoding: true,
  transcodeBitrate: '96k',
  transcodeMaxConcurrent: 1,
  transcodeCacheDir: path.join(dataRoot, 'transcodes'),
  transcodeUseDefaultPath: false, // Ignores transcodeCacheDir if set to true
  // Generated subtitles the library folder would not take (transcribe-work.js).
  lyricFolderDir: path.join(dataRoot, 'lyrics'),
  lyricUseDefaultPath: false, // Ignores lyricFolderDir if set to true
};
const initConfig = (writeConfigToFile: boolean = !process.env.FREEZE_CONFIG_FILE): void => {
  config = Object.assign(config, defaultConfig);
  if (writeConfigToFile) {
    fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, "\t"));
  }
};

const setConfig = (newConfig: Partial<Config>, writeConfigToFile: boolean = !process.env.FREEZE_CONFIG_FILE): void => {
  // Prevent changing some values, overwrite with old ones
  newConfig.production = config.production;
  newConfig.md5secret = config.md5secret;
  newConfig.jwtsecret = config.jwtsecret;

  // Merge config
  config = Object.assign(config, newConfig);
  // Re-resolve after the merge: newConfig carries whatever was on disk or came
  // from the admin panel, which may be relative or pinned to the old data root.
  resolveDataFolders();
  resolveBasePath();
  if (writeConfigToFile) {
    fs.writeFileSync(configPath, JSON.stringify(config, null, "\t"));
  }
};

// True when `dir` is at or below `base`. An absolute result means another
// Windows drive.
const isWithin = (base: string, dir: string): boolean => {
  const relative = path.relative(base, dir);
  return !relative.startsWith('..') && !path.isAbsolute(relative);
};

// Re-root a data folder that an earlier run pinned inside the application
// directory.
const rerootFromAppDir = (dir: string): string => {
  if (dataRoot === appDir) return dir;

  // Checked FIRST, or a data root inside the app directory never settles:
  // `<appDir>/data/covers` looks like a legacy app-dir path to the test below,
  // gets re-rooted to `<appDir>/data/data/covers`, and nests one level deeper
  // on every startup because setConfig persists it.
  if (isWithin(dataRoot, dir)) return dir;

  const relative = path.relative(appDir, dir);
  if (!relative || !isWithin(appDir, dir)) return dir;

  const rerooted = path.join(dataRoot, relative);
  console.log(`Data folder re-rooted: ${dir} -> ${rerooted}`);
  return rerooted;
};

/**
 * Resolve one configurable data folder against the current data root.
 * @param {String} dir Value from config.json (relative or absolute).
 * @param {String} defaultName Folder name used when useDefault is set.
 * @param {Boolean} useDefault Ignore `dir` and use dataRoot/defaultName.
 * @returns {String} Absolute path.
 */
const resolveDataFolder = (dir: string, defaultName: string, useDefault: boolean): string => {
  if (useDefault) return path.join(dataRoot, defaultName);
  if (!dir) return path.join(dataRoot, defaultName);
  if (!path.isAbsolute(dir)) return path.join(dataRoot, dir);
  return rerootFromAppDir(dir);
};

/**
 * Resolve the four configurable data folders in place.
 *
 * Must run after ANY assignment into `config`, not just the initial read.
 */
const resolveDataFolders = (): void => {
  config.coverFolderDir = resolveDataFolder(config.coverFolderDir, 'covers', config.coverUseDefaultPath);
  config.imageFolderDir = resolveDataFolder(config.imageFolderDir, 'images', config.imageUseDefaultPath);
  config.databaseFolderDir = resolveDataFolder(config.databaseFolderDir, 'sqlite', config.dbUseDefaultPath);
  config.transcodeCacheDir = resolveDataFolder(config.transcodeCacheDir, 'transcodes', config.transcodeUseDefaultPath);
  config.lyricFolderDir = resolveDataFolder(config.lyricFolderDir, 'lyrics', config.lyricUseDefaultPath);
};

/**
 * Normalize the URL prefix in place, so every reader can just concatenate it
 * and so the tidied value is what gets written back to config.json.
 * Must run after ANY assignment into `config`, for the same reason
 * resolveDataFolders() does.
 */
const resolveBasePath = (): void => {
  config.basePath = normalizeBasePath(config.basePath);
};

// Copy one value of `defaultConfig` onto a config object read from a file that
// may predate the current version. A plain indexed write cannot express that
// the key narrows the value's type; the keys always come from iterating
// `defaultConfig`, so they are `keyof Config`.
const copyDefault = <K extends keyof Config>(target: Config, key: K): void => {
  target[key] = defaultConfig[key];
};

// Get or use default value
const readConfig = (): void => {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  for (let key in defaultConfig) {
    const configKey = key as keyof Config;
    if (!config.hasOwnProperty(key)) {
      if (configKey === 'version') {
        config.version = versionWithoutVerTracking;
      } else {
        copyDefault(config, configKey);
      }
    }
  }

  // Ignored, not dropped.
  const unknownKeys = Object.keys(config).filter(key => !(key in defaultConfig));
  if (unknownKeys.length) {
    console.log('Unused config keys, ignored:', unknownKeys.join(', '));
  }

  // Data folder paths: relative to dataRoot, or absolute, or forced to the
  // default. `useDefault` wins, then a relative path, then an absolute one.
  resolveDataFolders();
  resolveBasePath();

  if (process.env.NODE_ENV === 'production' || config.production) {
    config.production = true;
  }
};

// Migrate config
const updateConfig = (writeConfigToFile: boolean = !process.env.FREEZE_CONFIG_FILE): void => {
  // Only complete once the key loop below has run.
  const cfg: Config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  let countChanged = 0;
  for (let key in defaultConfig) {
    if (!cfg.hasOwnProperty(key)) {
      console.log('Adding missing config key:', key);
      copyDefault(cfg, key as keyof Config);
      countChanged += 1;
    }
  }

  if (compareVersions.compare(cfg.version, versionDbRelativePath, '<')) {
    console.log('The database location is now the sqlite folder under the data root.');
    console.log('To put it elsewhere, see the 0.6.0-rc.0 release notes.');
  }


  if (countChanged || cfg.version !== pjson.version) {
    cfg.version = pjson.version;
    setConfig(cfg, writeConfigToFile);
  }
};

class publicConfig {
  get rewindSeekTime() {
    return config.rewindSeekTime;
  }
  get forwardSeekTime() {
    return config.forwardSeekTime;
  }
  get enableTranscoding() {
    return config.enableTranscoding;
  }
  // Whether the track-title suggester has an endpoint to call. A boolean, never
  // the settings themselves: the LLM config is env-only (see track-titles.js)
  // precisely so no key can reach a browser, and this must not undo that.
  get llmConfigured() {
    return Boolean(process.env.KIKO_LLM_BASE_URL && process.env.KIKO_LLM_MODEL);
  }
  // A boolean only, so no endpoint or key reaches a browser (see asr.js).
  get asrConfigured() {
    return Boolean(process.env.KIKO_ASR_BASE_URL);
  }
  export() {
    return {
      rewindSeekTime: this.rewindSeekTime,
      forwardSeekTime: this.forwardSeekTime,
      enableTranscoding: this.enableTranscoding,
      llmConfigured: this.llmConfigured,
      asrConfigured: this.asrConfigured,
    };
  }
}

const sharedConfigHandle = new publicConfig();

// This part runs when the module is initialized
// TODO: refactor global side effect
if (!fs.existsSync(configPath)) {
  if (!fs.existsSync(configFolderDir)) {
    try {
      fs.mkdirSync(configFolderDir, { recursive: true });
    } catch(err) {
      console.error(` ! Failed to create the config folder: ${(err as Error).message}`);
    }
  }
  const writeConfigToFile = !process.env.FREEZE_CONFIG_FILE;
  initConfig(writeConfigToFile);
} else {
  readConfig();
}

export { setConfig, updateConfig, config, sharedConfigHandle, configFolderDir, dataRoot };
