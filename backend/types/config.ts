/*
 * The shape of config.json and of the live `config` object exported by
 * config.ts.
 *
 * Its only job is to make the two agree: `defaultConfig` is annotated with
 * `Config`, so a key added there without a matching declaration here is a
 * compile error, and every field the rest of the backend reads is typed.
 */

/** One library root folder, as configured in the admin panel. */
export interface RootFolder {
  name: string;
  path: string;
}

export interface Config {
  version: string;
  production: boolean;
  dbBusyTimeout: number;
  maxParallelism: number;
  rootFolders: RootFolder[];
  skipWorkExtras: boolean;
  coverFolderDir: string;
  imageFolderDir: string;
  databaseFolderDir: string;
  coverUseDefaultPath: boolean;
  imageUseDefaultPath: boolean;
  dbUseDefaultPath: boolean;
  voiceWorkDefaultPath: string;
  auth: boolean;
  md5secret: string;
  jwtsecret: string;
  expiresIn: number;
  scannerMaxRecursionDepth: number;
  pageSize: number;
  retry: number;
  dlsiteTimeout: number;
  hvdbTimeout: number;
  fanzaTimeout: number;
  retryDelay: number;
  httpProxyHost: string;
  httpProxyPort: number;
  listenPort: number;
  basePath: string;
  blockRemoteConnection: boolean;
  allowedHosts: string[];
  behindProxy: boolean;
  httpsEnabled: boolean;
  httpsPrivateKey: string;
  httpsCert: string;
  httpsPort: number;
  skipCleanup: boolean;
  enableGzip: boolean;
  rewindSeekTime: number;
  forwardSeekTime: number;
  offloadMedia: boolean;
  offloadStreamPath: string;
  offloadDownloadPath: string;
  enableTranscoding: boolean;
  transcodeBitrate: string;
  transcodeMaxConcurrent: number;
  transcodeCacheDir: string;
  transcodeUseDefaultPath: boolean;
  lyricFolderDir: string;
  lyricUseDefaultPath: boolean;
}
