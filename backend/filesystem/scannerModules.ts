import fs from 'fs';
import path from 'path';
import type { Knex } from 'knex';
import LimitPromise from '../lib/limit-promise.ts'; // 限制并发数量

import axios from '../scraper/axios.ts'; // 数据请求
import { scrapeWorkMetadataFromDLsite, scrapeWorkMetadataFromDLsiteJson, scrapeDynamicWorkMetadataFromDLsite, scrapeCoverIdForTranslatedWorkFromDLsite } from '../scraper/dlsite.ts';
import { scrapeWorkMetadataFromFanza } from '../scraper/fanza.ts';
import { isFanzaId, isBooksId, fanzaCid, workno } from '../work-id.ts';
import { scrapeWorkMetadataFromAsmrOne } from '../scraper/asmrOne.ts';
import db from '../database/db.ts';
import { createSchema } from '../database/schema.ts';
import { getFolderList, deleteCoverImageFromDisk, saveCoverImageToDisk, coverFileName, formatID, deleteWorkImagesFromDisk } from './utils.ts';
import * as workExtras from './workExtras.ts';
import * as scanLog from './scanLog.ts';
import { rescanWorkFiles } from './workFiles.ts';
import { md5 } from '../auth/utils.ts';
import { nameToUUID } from '../scraper/utils.ts';

import { config } from '../config.ts';
import { updateLock } from '../upgrade.ts';
import type { FolderEntry } from './utils.ts';
import type { AsmrOneCoverUrls, CoverUrls, WorkMetadata } from '../types/scraper.ts';
import type { ScanCommand, ScanEvent, ScanInitState, ScanLogEntry, ScanLogLevel, ScanResultEntry, ScanTask, ScanTaskResult } from '../types/scan-events.ts';

/** What `processFolder` reports for one work folder. */
type FolderResult = 'added' | 'failed' | 'skipped';

/** What `refreshWorks` reports for one work. */
type RefreshResult = 'updated' | 'failed';

/** A scrape as the scanner writes it: the work's location added, plus the ASMR.one cover URLs. */
type ScannerWorkMetadata = WorkMetadata & AsmrOneCoverUrls;

/**
 * A scrape with the location added, as `insertWorkMetadata` requires it. The
 * two fields are assigned just before each insert; the assertion at the call
 * site is only needed because TypeScript narrows property accesses, not the
 * object that carries them.
 */
type InsertableWorkMetadata = WorkMetadata & Required<Pick<WorkMetadata, 'rootFolderName' | 'dir'>>;

/** The counters `performScan` reports. */
interface ScanCounts {
  added: number;
  failed: number;
  skipped: number;
  updated: number;
}

/** The counters `refreshWorks` reports. */
interface RefreshCounts {
  updated: number;
  failed: number;
}

/** The `t_work` columns a work-file scan needs. */
interface WorkFileScanRow {
  id: string;
  root_folder: string;
  dir: string;
}

/**
 * The flags `updateMetadata` accepts. `updater.ts` builds this object from its
 * command-line flags, and the flags select which scraper runs.
 */
export interface UpdateMetadataOptions {
  refreshAll?: boolean;
  includeNSFW?: boolean;
  includeTags?: boolean;
  includeVA?: boolean;
  includeIllustrator?: boolean;
  includeScriptWriter?: boolean;
  includeSeries?: boolean;
  includeAuthor?: boolean;
  includeDescription?: boolean;
  includeImages?: boolean;
  includeReviews?: boolean;
}

/** A callback `process.send` calls once the message left the process. */
type SendCallback = (error: Error | null) => void;

/**
 * Send one event to the parent over the fork IPC channel.
 *
 * `process.send` is read at call time rather than captured: the scanner scripts
 * always run forked, but this module is also imported directly (tests, and
 * `npm run scan`), and tests replace `process.send` to capture what is emitted.
 */
const send = (message: ScanEvent, callback?: SendCallback): void => {
  if (callback) process.send!(message, callback);
  else process.send!(message);
};

/** Stand-in used when this module is not running in a forked child. */
const fallbackSend = (message: ScanEvent, callback?: SendCallback): boolean => {
  if (typeof callback === 'function') callback(null);
  return true;
};

process.send = process.send ?? (fallbackSend as NonNullable<typeof process.send>);

// uncapped record goes to the log file instead.
const MAX_MAIN_LOGS = 500;
const MAX_TASK_LOGS = 200;
const MAX_FAILED_TASKS = 200;
const MAX_RESULTS = 500;

const tasks: ScanTask[] = [];
const failedTasks: ScanTask[] = [];
const mainLogs: ScanLogEntry[] = [];
const results: ScanResultEntry[] = [];

const push = <T>(array: T[], entry: T, max: number): void => {
  array.push(entry);
  if (array.length > max) array.splice(0, array.length - max);
};

const LOG = {
  finish(message: string): Promise<void> {
    console.log(` * ${message}`);
    scanLog.write('info', message);
    return new Promise<void>((resolve) => {
      send({ event: 'SCAN_FINISHED', payload: { message } }, () => resolve());
    });
  },

  // Names the log file in the run's first line, so the page tells the user
  // where the untruncated version lives.
  open(runName: string): void {
    const filePath = scanLog.open(runName);
    if (filePath) this.main.info(`日志文件: ${filePath}`);
  },

  main: {
    __internal__(level: ScanLogLevel, message: string): void {
      console[level]("main log", message);
      scanLog.write(level, message);

      const entry: ScanLogEntry = { level, message };
      push(mainLogs, entry, MAX_MAIN_LOGS);
      send({ event: 'SCAN_MAIN_LOG', payload: { entry } });
    },
    log(msg: string): void { // default log at level info
      this.__internal__("info", msg);
    },
    debug(msg: string): void {
      this.__internal__("debug", msg);
    },
    info(msg: string): void {
      this.__internal__("info", msg);
    },
    error(msg: string): void {
      this.__internal__("error", msg);
    },
    warn(msg: string): void {
      this.__internal__("warn", msg);
    }
  },
  result: {
    add(rjcode: string, result: ScanTaskResult, count: number): void {
      const entry: ScanResultEntry = { rjcode, result, count };
      push(results, entry, MAX_RESULTS);
      send({ event: 'SCAN_RESULT', payload: { result: entry } });
    }
  },
  task: {
    // 添加作品专门的log记录
    add(taskId: string): void { // taskId == rjcode or cid, e.g. "443322" or "01134321" or "d215444"
      console.assert(typeof(taskId) === "string" && (taskId.length === 6 || taskId.length === 8 || isFanzaId(taskId) || isBooksId(taskId)));
      tasks.push({
        rjcode: taskId,
        result: null,
        logs: []
      });
      send({ event: 'SCAN_TASK_ADD', payload: { rjcode: taskId } });
    },

    // 移除作品的专属log，如果该作品的对应任务失败，则发送相应的失败消息
    remove(taskId: string, result: ScanTaskResult): void {
      const index = tasks.findIndex(task => task.rjcode === taskId);
      if (index == -1) {
        // 当前任务并没有被添加，则跳过remove操作
        return;
      }

      const removedTask = tasks[index];
      removedTask.result = result;
      tasks.splice(index, 1);
      send({ event: 'SCAN_TASK_REMOVE', payload: { rjcode: taskId, result } });

      if (removedTask.result === 'failed') {
        push(failedTasks, removedTask, MAX_FAILED_TASKS);
        send({ event: 'SCAN_FAILED_TASK', payload: { task: removedTask } });
      }
    },
    __internal_task__(taskId: string, level: ScanLogLevel, msg: string): void {
      console.assert(typeof(taskId) === "string" && (taskId.length === 6 || taskId.length === 8 || isFanzaId(taskId) || isBooksId(taskId)));
      console[level](`task[${workno(taskId)}] log`, msg);
      scanLog.write(level, msg, workno(taskId));

      const task = tasks.find(task => task.rjcode === taskId);
      if (task) {
        const entry: ScanLogEntry = { level, message: msg };
        push(task.logs, entry, MAX_TASK_LOGS);
        send({ event: 'SCAN_TASK_LOG', payload: { rjcode: taskId, entry } });
      }
    },
    log(taskId: string, msg: string): void { // default log at level info
      this.__internal_task__(taskId, "info", msg);
    },
    debug(taskId: string, msg: string): void {
      this.__internal_task__(taskId, "debug", msg);
    },
    info(taskId: string, msg: string): void {
      this.__internal_task__(taskId, "info", msg);
    },
    error(taskId: string, msg: string): void {
      this.__internal_task__(taskId, "error", msg);
    },
    warn(taskId: string, msg: string): void {
      this.__internal_task__(taskId, "warn", msg);
    }

  },
};

process.on('message', (m: ScanCommand) => {
  if (m.emit === 'SCAN_INIT_STATE') {
    const payload: ScanInitState = {
      tasks,
      failedTasks,
      mainLogs,
      results
    };
    send({
      event: 'SCAN_INIT_STATE',
      payload
    });
  } else if (m.exit) {
    LOG.main.error(' ! 终止扫描进程.');
    process.exit(1);
  }
});

process.on('disconnect', () => process.exit(1));


// One folder per work id, keeping the last copy found, so no two folders race to
// insert the same work. duplicateSet maps each duplicated id to the other copies.
function uniqueFolderListSeparate (folders: FolderEntry[]): { uniqueList: FolderEntry[]; duplicateSet: Record<string, FolderEntry[]> } {
  const byId = new Map<string, FolderEntry[]>();
  for (const folder of folders) {
    const copies = byId.get(folder.id);
    if (copies) copies.push(folder);
    else byId.set(folder.id, [folder]);
  }

  const uniqueList: FolderEntry[] = [];
  const duplicateSet: Record<string, FolderEntry[]> = {};
  for (const [id, copies] of byId) {
    uniqueList.push(copies[copies.length - 1]);
    if (copies.length > 1) duplicateSet[id] = copies.slice(0, -1);
  }
  return { uniqueList, duplicateSet };
}

/**
 * 从 DLsite 或 Fanza 抓取该音声的元数据，并保存到数据库，
 * 返回一个 Promise 对象，处理结果: the inserted metadata object, or 'failed'
 * (callers need metadata.coverUrls for the cover download)
 * @param {string} id work id (e.g. '123456', 'd215444')
 * @param {string} rootFolderName 根文件夹别名
 * @param {string} dir 音声文件夹相对路径
 */
async function getMetadata(id: string, rootFolderName: string, dir: string): Promise<ScannerWorkMetadata | 'failed'> {
  const isFanza = isFanzaId(id);

  if (isFanza) {
    LOG.task.info(id, '从 Fanza (DMM) 抓取元数据...');
    let metadata: ScannerWorkMetadata | null = null;

    try {
      metadata = await scrapeWorkMetadataFromFanza(id);
    } catch(error) {
      LOG.task.warn(id, `Fanza获取元数据失败: ${(error as Error).message}`);
    }

    if (metadata === null) {
      LOG.task.error(id, `元数据获取失败`);
      return 'failed';
    }

    // 将抓取到的元数据插入到数据库
    LOG.task.info(id, '元数据抓取成功，准备添加到数据库...');
    metadata.rootFolderName = rootFolderName;
    metadata.dir = dir;

    try {
      await db.insertWorkMetadata(metadata as InsertableWorkMetadata);
    } catch(error) {
      LOG.task.error(id, `元数据添加失败: ${(error as Error).message}`);
      return 'failed';
    }

    LOG.task.info(id, '元数据成功添加到数据库.');
    // Return the metadata object (processFolder needs metadata.coverUrls for
    // the cover download); callers only check for 'failed'.
    return metadata;
  }

  // DLsite branch
  const rjcode = formatID(id); // zero-pad to 6 digits

  LOG.task.info(rjcode, '从 DLSite 抓取元数据...');
      
  let metadata: ScannerWorkMetadata | null = null;

  try {
    metadata = await scrapeWorkMetadataFromDLsite(id); // 抓取该音声的元数据
  } catch(error) {
    LOG.task.warn(rjcode, `DLSite获取元数据失败: ${(error as Error).message}`);
  }

  if (metadata === null) {
    try {
      metadata = await scrapeWorkMetadataFromAsmrOne(id); // 抓取该音声的元数据
    } catch(error) {
      LOG.task.warn(rjcode, `AsmrOne获取元数据失败: ${(error as Error).message}`);
    }
  }

  if (metadata === null) {
    try {
      metadata = await scrapeWorkMetadataFromDLsiteJson(id); // 抓取该音声的元数据
    } catch(error) {
      LOG.task.warn(rjcode, `DLSite json api获取元数据失败: ${(error as Error).message}`);
    }
  }

  if (metadata === null) {
    LOG.task.error(rjcode, `元数据获取失败`);
    return 'failed';
  }

  // 将抓取到的元数据插入到数据库
  LOG.task.info(rjcode, '元数据抓取成功，准备添加到数据库...');
  
  metadata.rootFolderName = rootFolderName;
  metadata.dir = dir;

  try {
    await db.insertWorkMetadata(metadata as InsertableWorkMetadata);
  } catch(error) {
    LOG.task.error(rjcode, `元数据添加失败: ${(error as Error).message}`);
    return 'failed';
  }

  LOG.task.info(rjcode, '元数据成功添加到数据库.');

  // Only ASMR.one returns cover URLs. Expose them as coverUrls so
  // getCoverImageForTranslated can use them as a last resort when no DLsite
  // URL works, without paying for a second ASMR.one request.
  if (metadata && (metadata.mainCoverUrl || metadata.samCoverUrl || metadata.thumbnailCoverUrl)) {
    metadata.coverUrls = {
      main: metadata.mainCoverUrl,
      sam: metadata.samCoverUrl,
      '240x240': metadata.thumbnailCoverUrl,
    };
  }
  return metadata;
}


/**
 * 从 DLsite 下载封面图片，处理翻译作品本身没有封面的情况，并保存到 Images 文件夹，
 * 返回一个 Promise 对象，处理结果: 'added' 'failed' 'skipped' return skipped means work do not have cover in dlsite by default
 *
 * Each type is tried against DLsite first — the real URL parsed from the work
 * page, then the guessed path — and only falls back to the ASMR.one cover
 * proxy when DLsite yields nothing. The guessed path 404s for translated and
 * newer works, whose covers live under the original work id.
 * @param {number} id work id
 * @param {Array} types img types: ['main', 'sam', 'sam@2x', 'sam@3x', '240x240', '360x360']
 * @param {Object} [asmrOneCoverUrls] cover urls already known from an ASMR.one metadata scrape
 */
async function getCoverImageForTranslated(id: string, types: string[], asmrOneCoverUrls?: CoverUrls | null): Promise<'added' | 'failed' | 'skipped'> {
  const rjcode = formatID(id); // zero-pad to 6/8 digits
  let coverFromId = rjcode; // 默认就使用原始的作品id
  let isNoImgMain = false;
  let realCoverUrls: CoverUrls = {};

  try {
    // 抓取一次网页，检查当前作品封面到底使用的哪一个id
    // 因为有些翻译作品id自身没有封面文件，而是使用原版日文作品id对应的封面
    const tryScrapResult = await scrapeCoverIdForTranslatedWorkFromDLsite(rjcode);
    coverFromId = tryScrapResult.coverFromId;
    isNoImgMain = tryScrapResult.isNoImgMain;
    // Modern translated works carry the real cover URLs on a
    // <translation-product-slider> (see dlsite.js); prefer them over the guess.
    realCoverUrls = tryScrapResult.coverUrls || {};
    if (coverFromId != rjcode) {
      LOG.task.info(rjcode, `当前作品${workno(rjcode)}似乎不包含封面资源，例如一些翻译作品。从 DLsite 对应的原始作品${workno(coverFromId)}下载封面...`);
    }
  } catch (err) {
    LOG.task.error(rjcode, `在获取真实的封面id（适配那些翻译作品的封面问题） 过程中出错: ${(err as Error).message}`);
  }

  LOG.task.info(rjcode, `从 DLsite 下载封面...`);
  let failedTypes = await downloadCovers(id, types, (type) => [
    realCoverUrls[type as keyof CoverUrls],
    guessDLsiteCoverUrl(coverFromId, type),
  ]);

  if (failedTypes.length) {
    const urls = await getAsmrOneCoverUrls(id, asmrOneCoverUrls);
    if (urls) {
      LOG.task.info(rjcode, `DLsite 封面下载失败，尝试从 ASMR.one 下载...`);
      failedTypes = await downloadCovers(id, failedTypes, (type) => [urls[type as keyof CoverUrls]]);
    }
  }

  if (!failedTypes.length) {
    return 'added';
  }

  if (isNoImgMain) {
    LOG.main.warn(`${workno(rjcode)} 作品本身在DlSite上没有封面图片，无法抓取封面`);
    return 'skipped';
  }

  return 'failed';
}

/**
 * Cover URLs from ASMR.one's cover proxy, reusing the ones a metadata scrape
 * already returned when available.
 * @param {number} id work id
 * @param {Object} [known] map of type -> url from a previous ASMR.one scrape
 * @returns {Promise<Object|null>} map of type -> url, or null when unavailable
 */
async function getAsmrOneCoverUrls(id: string, known?: CoverUrls | null): Promise<CoverUrls | null> {
  if (known && (known.main || known.sam || known['240x240'])) {
    return known;
  }

  try {
    const meta = await scrapeWorkMetadataFromAsmrOne(id);
    return {
      main: meta.mainCoverUrl,
      sam: meta.samCoverUrl,
      '240x240': meta.thumbnailCoverUrl,
    };
  } catch (err) {
    LOG.task.warn(formatID(id), `尝试从 ASMR.one 获取封面 URL 失败: ${(err as Error).message}`);
    return null;
  }
}

/**
 * DLsite stores covers in a folder named after the work id rounded up to the
 * next thousand — a guess, since only the work page holds the real URL.
 * @param {number} cover_from_id download cover from work id, since some translated work are using non-translated work's cover resource
 * @param {String} type img type
 * @returns {String} guessed cover URL
 */
function guessDLsiteCoverUrl(cover_from_id: string, type: string): string {
  // The books floor keeps its assets under work/books/BJ..., the doujin floor
  // under work/doujin/RJ...; the bucket rule is the same on both.
  const books = isBooksId(cover_from_id);
  const floor = books ? 'books' : 'doujin';
  const codeFor = (num: number): string => workno(books ? `BJ${formatID(num)}` : formatID(num));

  const n = parseInt(String(cover_from_id).replace(/\D/g, ''), 10);
  const id2 = (n % 1000 === 0) ? n : Math.floor(n / 1000) * 1000 + 1000;

  return (type === '240x240' || type === '360x360')
    ? `https://img.dlsite.jp/resize/images2/work/${floor}/${codeFor(id2)}/${codeFor(n)}_img_main_${type}.jpg`
    : `https://img.dlsite.jp/modpub/images2/work/${floor}/${codeFor(id2)}/${codeFor(n)}_img_${type}.jpg`;
}

/**
 * Download one cover image per type, saving it to the Images 文件夹. Each
 * type falls through its candidate URLs until one downloads, so a source that
 * only knows some of the types does not defeat the others.
 * @param {number} cover_for_id download cover for this work id
 * @param {Array} types img types: ['main', 'sam', 'sam@2x', 'sam@3x', '240x240', '360x360']
 * @param {Function} candidatesFor type => candidate URLs, tried in order (falsy entries skipped)
 * @returns {Promise<Array>} the types that could not be downloaded
 */
async function downloadCovers(
  cover_for_id: string,
  types: string[],
  candidatesFor: (type: string) => Array<string | null | undefined>,
): Promise<string[]> {
  const cover_for_rjcode = formatID(cover_for_id);
  const results = await Promise.all(types.map(async (type): Promise<string | null> => {
    for (const url of candidatesFor(type).filter((url): url is string => Boolean(url))) {
      try {
        const imageRes = await axios.retryGet<NodeJS.ReadableStream>(url, { responseType: "stream", retry: {} });
        await saveCoverImageToDisk(imageRes.data, cover_for_rjcode, type);
        LOG.task.info(cover_for_rjcode, `封面 ${coverFileName(cover_for_rjcode, type)} 下载成功.`);
        return null;
      } catch (err) {
        LOG.task.warn(cover_for_rjcode, `在下载封面 ${coverFileName(cover_for_rjcode, type)} 过程中出错: ${(err as Error).message} (URL: ${url})`);
      }
    }
    return type;
  }));

  return results.filter((type): type is string => Boolean(type));
}

/**
 * Download cover images from Fanza (DMM) for a Fanza work.
 * @param {String} id Work id (e.g. 'd215444')
 * @param {Array} types img types: ['main', 'sam', '240x240']
 * @param {Object} [coverUrls] URLs scraped from the work page ({ main, sam }).
 *        The asset path segment varies by content type (digital/doujin,
 *        digital/cg_game, ...), so prefer these over the guessed fallback.
 * @returns {Promise<String>} 'added' or 'failed'
 */
async function getFanzaCoverImage(id: string, types: string[], coverUrls?: CoverUrls | null): Promise<'added' | 'failed'> {
  const cid = fanzaCid(id);
  if (!coverUrls) {
    try {
      const metadata = await scrapeWorkMetadataFromFanza(id);
      coverUrls = metadata.coverUrls;
    } catch (err) {
      LOG.task.warn(id, `重新抓取 Fanza 页面以获取封面 URL 失败: ${(err as Error).message}，将尝试推测的封面 URL`);
    }
  }
  // Fallback only: wrong for works whose assets are not under digital/doujin.
  // Fanza doujin only serves pl/pr cover variants (no ps), and pl == pr.
  const mainUrl = (coverUrls && coverUrls.main) || `https://doujin-assets.dmm.co.jp/digital/doujin/${cid}/${cid}pl.jpg`;
  const samUrl = (coverUrls && coverUrls.sam) || `https://doujin-assets.dmm.co.jp/digital/doujin/${cid}/${cid}pl.jpg`;
  LOG.task.info(id, `从 Fanza 下载封面...`);
  const results = await Promise.all(types.map(async (type) => {
    let url;
    if (type === 'main') {
      url = mainUrl;
    } else if (type === 'sam' || type === '240x240') {
      url = samUrl;
    } else {
      return 'failed';
    }

    try {
      const imageRes = await axios.retryGet<NodeJS.ReadableStream>(url, { responseType: "stream", retry: {} });
      // DMM serves a 302 to a now_printing.jpg placeholder for nonexistent
      // cover variants (axios follows it silently). Never save that as a cover.
      const finalUrl = imageRes.request && imageRes.request.res && imageRes.request.res.responseUrl;
      if (finalUrl && finalUrl.includes('now_printing')) {
        LOG.task.warn(id, `封面 ${coverFileName(id, type)} 不存在（FANZA 返回了占位图，URL: ${url}）`);
        return 'failed';
      }
      await saveCoverImageToDisk(imageRes.data, id, type);
      LOG.task.info(id, `封面 ${coverFileName(id, type)} 下载成功.`);
      return 'added';
    } catch(err) {
      LOG.task.warn(id, `在下载封面 ${coverFileName(id, type)} 过程中出错: ${(err as Error).message} (URL: ${url})`);
      return 'failed';
    }
  }));

  return results.includes("failed") 
      ? "failed" 
      : "added";
}

// Route workExtras' output through the scanner's task log so image and review
// progress shows up in the Scanner page like every other per-work message.
const extrasLogger: workExtras.WorkExtrasLogger = {
  info: (id, message) => LOG.task.info(id, message),
  warn: (id, message) => LOG.task.warn(id, message),
};

const saveWorkImages = (id: string, metadata: ScannerWorkMetadata) => workExtras.saveWorkImages(id, metadata, extrasLogger);
const saveWorkReviews = (id: string) => workExtras.saveWorkReviews(id, extrasLogger);

/**
 * 获取音声元数据，获取音声封面图片，
 * 返回一个 Promise 对象，处理结果: 'added', 'skipped' or 'failed'
 * @param {string} folder 音声文件夹对象 { relativePath: '相对路径', rootFolderName: '根文件夹别名', id: '音声ID' }
 */
async function processFolder(folder: FolderEntry): Promise<FolderResult> {
  const res = await db.knex('t_work')
    .select('id')
    .where('id', '=', folder.id)
    .count()
    .first();

  const workId = folder.id;
  const isFanza = isFanzaId(workId);
  const coverTypes = ['main', 'sam', '240x240'];
  // The count query always returns one row; the assertion only states that.
  const count = res!['count(*)'];

  let coverResult: 'unknown' | 'added' | 'failed' | 'skipped' = "unknown";

  if (count) { // 查询数据库，检查是否已经写入该音声的元数据
    // 已经成功写入元数据
    // 检查音声封面图片是否缺失
    const lostCoverTypes: string[] = [];
    coverTypes.forEach(type => {
      const coverPath = path.join(config.coverFolderDir, coverFileName(workId, type));
      if (!fs.existsSync(coverPath)) {
        lostCoverTypes.push(type);
      }
    });
    
    if (lostCoverTypes.length) {
      LOG.task.add(workId);
      LOG.task.info(workId, '封面图片缺失，重新下载封面图片...');

      if (isFanza) {
        coverResult = await getFanzaCoverImage(workId, lostCoverTypes);
      } else {
        coverResult = await getCoverImageForTranslated(workId, lostCoverTypes);
      }
      if (coverResult === 'failed') {
        LOG.task.error(workId, `该作品已存在于数据库中，但封面图片下载失败。缺失的封面类型: ${lostCoverTypes.join(', ')}`);
      }
    } else {
      coverResult = 'skipped';
    }
  } else {
    LOG.task.add(workId);
    LOG.task.info(workId, `发现新文件夹: "${folder.absolutePath}"`);

    const result = await getMetadata(workId, folder.rootFolderName, folder.relativePath); // 获取元数据

    // 如果获取元数据失败，跳过封面图片下载
    if (result === 'failed') {
      return 'failed';
    }

    LOG.task.info(workId, `扫描音频文件时长`);
    await rescanWorkFiles(workId, folder.absolutePath);
    
    // 不要在乎图片是否下载成功，dlsite上一些老作品已经没有图片了，会下载失败
    // 只要元数据插入成功就行
    if (isFanza) {
      // result is the inserted metadata object for Fanza works
      coverResult = await getFanzaCoverImage(workId, coverTypes, result.coverUrls);
    } else {
      coverResult = await getCoverImageForTranslated(workId, coverTypes, result && result.coverUrls);
      if (!workExtras.skipWorkExtras()) {
        await saveWorkImages(workId, result);
        await saveWorkReviews(workId);
      }
    }
  }

  // 到这一步其实都已经插入了元数据
  // 最后根据coverResult，判断任务是否成功，
  // coverResult： “added" 成功添加封面，"skipped" 作品在dlsite无封面（但是元数据插入成功），"failed" dlsite有封面但还是下载封面失败
  switch(coverResult) {
    case 'skipped': return count ? 'skipped' : 'added';// dlsite没封面，也没办法了，如果是新添加的作品，则认为成功，如果是重新扫描的作品，则认为跳过
    case 'added': return 'added';

    case 'failed': 
    default: return 'failed';
  }
}

const MAX = config.maxParallelism; // 并发请求上限
const limitP = new LimitPromise(MAX); // 核心控制器
/**
 * 限制 processFolder 并发数量，
 * 使用控制器包装 processFolder 方法，实际上是将请求函数递交给控制器处理
 */
async function processFolderLimited(folder: FolderEntry): Promise<FolderResult> {
  return await limitP.call(processFolder, folder);
}

/**
 * 清理本地不再存在的音声: 将其元数据从数据库中移除，并删除其封面图片
 */
async function performCleanup() {
  const trxProvider = db.knex.transactionProvider();
  const trx = await trxProvider();
  const works = await trx('t_work').select('id', 'root_folder', 'dir');

  await Promise.all(works.map(async (work) => {
    // 检查每个音声的根文件夹或本地路径是否仍然存在
    const rootFolder = config.rootFolders.find(rootFolder => rootFolder.name === work.root_folder);
    if (rootFolder && fs.existsSync(path.join(rootFolder.path, work.dir))) {
      // 仍然存在，则不做清理
      return;
    }

    await db.removeWork(work.id, trxProvider); // 将其数据项从数据库中移除
    try {
      // 然后删除其封面图片和抓取到的作品图片
      await deleteCoverImageFromDisk(work.id);
      await deleteWorkImagesFromDisk(work.id);
    } catch(err) {
      if (err && (err as NodeJS.ErrnoException).code !== 'ENOENT') { 
          LOG.main.error(`[${work.id}] 在删除封面过程中出错: ${(err as Error).message}`);
      }
    }
  }));

  trx.commit();
}

// 尝试创建数据库
async function tryCreateDatabase(): Promise<void> {
  try {
    await createSchema();
  } catch(err) {
    LOG.main.error(`在构建数据库结构过程中出错: ${(err as Error).message}`);
    console.error((err as Error).stack);
    process.exit(1);
  }
}

// 尝试创建管理员账号，如果已存在则忽略
// 如果发生其他异常则直接杀死本进程
async function tryCreateAdminUser() {
  try { // 创建内置的管理员账号
    await db.createUser({
      name: 'admin',
      password: md5('admin'),
      group: 'administrator'
    });
  } catch(err) {
    if ((err as Error).message.indexOf('已存在') === -1) {
      LOG.main.error(`在创建 admin 账号时出错: ${(err as Error).message}`);
      process.exit(1);
    }
  }
}

// 修复以往的数据库问题，老逻辑了，不太清楚具体修复的问题是什么，先放在这里
// 成功返回true，失败返回false
async function fixVADatabase(): Promise<boolean> {
  // Fix hash collision bug in t_va
  // Scan to repopulate the Voice Actor data for those problematic works
  // かの仔 and こっこ
  let success = true;
  if (updateLock.isLockFilePresent && updateLock.lockFileConfig.fixVA) {
    LOG.main.log('开始进行声优元数据修复，需要联网');
    try {
      await fixVoiceActorBug();
      updateLock.removeLockFile();
      LOG.main.log('完成元数据修复');
    } catch (err) {
      LOG.main.error((err as Error).toString());
      success = false;
    }
  }
  return success;
}

// 尝试清理不存在的数据，该阶段可能会根据用户配置跳过
// 如果清理过程中发生一场则杀死该进程
async function tryCleanupStage(): Promise<void> {
  if (config.skipCleanup) {
    LOG.main.info('跳过清理“不存在的音声数据”');
  } else {
    try {
      LOG.main.info('清理本地不再存在的音声的数据与封面图片...');
      await performCleanup();
      LOG.main.info('清理完成. 现在开始扫描...');
    } catch(err) {
      LOG.main.error(`在执行清理过程中出错: ${(err as Error).message}`);
      process.exit(1);
    }
  }
}

// 尝试扫描所有媒体库的文件夹
// 返回扫描得到的work的文件夹
async function tryScanRootFolders(): Promise<FolderEntry[]> {
  let folderList: FolderEntry[] = [];
  try {
    for (const rootFolder of config.rootFolders) {
      for await (const folder of getFolderList(rootFolder, '', 0, LOG.main)) {
        folderList.push(folder);
      }
    }
    LOG.main.info(`共找到 ${folderList.length} 个音声文件夹.`);
  } catch (err) {
    LOG.main.error(`在扫描根文件夹的过程中出错: ${(err as Error).message}`);
    process.exit(1);
  }

  return folderList;
}

// 并行处理这些文件夹
// 返回总的处理结果，表明处理的数量
// {
//   added: 0, // 添加的文件夹数量
//   failed: 0, // 失败
//   skipped: 0, // 跳过
//   updated: 0, // 更新
// };
async function tryProcessFolderListParallel(folderList: FolderEntry[]): Promise<ScanCounts> {
  const counts: ScanCounts = {
    added: 0,
    failed: 0,
    skipped: 0,
    updated: 0
  };

  try {
    // 去重，避免在之后的并行处理文件夹过程中，出现对数据库同时写入同一条记录的错误
    const { uniqueList: uniqueFolderList, duplicateSet} = uniqueFolderListSeparate(folderList);
    const duplicateNum = folderList.length - uniqueFolderList.length;

    if (duplicateNum) {
      LOG.main.info(`发现 ${duplicateNum} 个重复的音声文件夹.`);
      
      for (const key in duplicateSet) {
        // duplicateSet中并不包含存在于uniqueFolderList中的文件夹，
        // 将unique和duplicate重复的选项添加回duplicateSet，方便用户观察那些文件夹是重复的
        const addedFolder = uniqueFolderList.find(folder => folder.id === key);
        duplicateSet[key].push(addedFolder!); // 最后一项为是被添加到数据库中的音声文件夹，将其一同展示给用户

        LOG.main.info(`[${key}] 存在多个文件夹:`);

        // 打印音声文件夹的绝对路径
        duplicateSet[key].forEach((folder) => {
          const rootFolder = config.rootFolders.find(rootFolder => rootFolder.name === folder.rootFolderName);
          const absolutePath = path.join(rootFolder!.path, folder.relativePath);
          LOG.main.info(`--> ${absolutePath}`);
        });
      }
    }

    counts.skipped += duplicateNum;

    await Promise.all(uniqueFolderList.map(async (folder) => {
      const result = await processFolderLimited(folder);
      counts[result] += 1;

      const displayId = folder.id;
        switch(result) {
          case 'added': LOG.task.info(displayId, `添加成功! Added: ${counts.added}`); break;
          case 'failed': LOG.task.error(displayId, `添加失败! Failed: ${counts.failed}`); break;
          default: break;
        }
        LOG.task.remove(displayId, result);
        if (result !== 'skipped') LOG.result.add(displayId, result, counts[result]);
    }));

  } catch (err) {
    LOG.main.error(`在并行处理音声文件夹过程中出错: ${(err as Error).message}`);
    console.error((err as Error).stack);
    process.exit(1);
  }

  return counts;
}

/**
 * 执行扫描
 * createCoverFolder => createSchema => cleanup => getAllFolderList => processAllFolder
 */
async function performScan(): Promise<void> {
  LOG.open('scan');

  if (!fs.existsSync(config.coverFolderDir)) {
    try {
      fs.mkdirSync(config.coverFolderDir, { recursive: true });
    } catch(err) {
      LOG.main.error(`在创建存放音声封面图片的文件夹时出错: ${(err as Error).message}`);
      process.exit(1);
    }
  }

  if (!fs.existsSync(config.imageFolderDir)) {
    try {
      fs.mkdirSync(config.imageFolderDir, { recursive: true });
    } catch(err) {
      LOG.main.error(`在创建存放作品图片的文件夹时出错: ${(err as Error).message}`);
      process.exit(1);
    }
  }

  await tryCreateDatabase();
  await tryCreateAdminUser();

  const fixVADatabaseSuccess = await fixVADatabase();
  await tryCleanupStage();

  const folderList = await tryScanRootFolders();
  const folderResult = await tryProcessFolderListParallel(folderList);

  const message = folderResult.updated ?  `扫描完成: 更新 ${folderResult.updated} 个，新增 ${folderResult.added} 个，跳过 ${folderResult.skipped} 个，失败 ${folderResult.failed} 个.` : `扫描完成: 新增 ${folderResult.added} 个，跳过 ${folderResult.skipped} 个，失败 ${folderResult.failed} 个.`;
  await LOG.finish(message);

  db.knex.destroy();
  if (!fixVADatabaseSuccess) {
    process.exit(1);
  }
  process.exit(0);
}

/**
 * 更新音声的动态元数据
 * @param {string} id work id (e.g. '123456', 'd215444')
 * @param {options = {}} options includeVA, includeTags, refreshAll, etc.
 */
async function updateMetadata(id: string, options: UpdateMetadataOptions = {}): Promise<RefreshResult> {
  const isFanza = isFanzaId(id);

  let scrapeProcessor: () => Promise<WorkMetadata>;
  if (isFanza) {
    // Fanza: only static scraping is available
    scrapeProcessor = () => scrapeWorkMetadataFromFanza(id);
  } else if (options.includeVA || options.includeTags || options.includeNSFW || options.includeIllustrator || options.includeScriptWriter || options.includeSeries || options.includeAuthor || options.includeDescription || options.includeImages || options.refreshAll) {
    // static + dynamic
    scrapeProcessor = () => scrapeWorkMetadataFromDLsite(id);
  } else {
    // The dynamic-only scrape returns the counters alone, which is all
    // updateWorkMetadata reads unless one of the flags above asked for labels;
    // that branch chose the static processor instead.
    scrapeProcessor = () => scrapeDynamicWorkMetadataFromDLsite(id) as Promise<WorkMetadata>;
  }

  const displayId = isFanza ? id : formatID(id);
  LOG.task.add(displayId);

  try {
    const metadata = await scrapeProcessor();
    // 将抓取到的元数据插入到数据库
    LOG.task.log(displayId, `元数据抓取成功，准备更新元数据...`);
    metadata.id = id;

    await db.updateWorkMetadata(metadata, options);

    // Downloading images and paginating reviews costs extra requests per work,
    // so neither rides along with refreshAll — ask for them explicitly.
    if (options.includeImages) {
      await saveWorkImages(id, metadata);
    }
    if (options.includeReviews) {
      await saveWorkReviews(id);
    }

    LOG.task.log(displayId, `元数据更新成功`);
    return 'updated';
  } catch(err) {
    LOG.task.error(displayId, `在抓取元数据过程中出错: ${err}`);
    console.error((err as Error).stack);
    return 'failed';
  }
}

// `options` has always defaulted to null and been handed straight to
// updateMetadata, which reads the flags off it; updater.ts always passes an
// object, so the assertion states the assumption the body already makes.
const updateMetadataLimited = (id: string, options: UpdateMetadataOptions | null = null) =>
  limitP.call(updateMetadata, id, options as UpdateMetadataOptions);
const updateVoiceActorLimited = (id: string) => limitP.call(updateMetadata, id, { includeVA: true });

 
async function performUpdate(options: UpdateMetadataOptions | null = null): Promise<void> {
  LOG.open('update');
  const baseQuery = db.knex('t_work').select('id');
  const processor = (id: string) => updateMetadataLimited(id, options);

  const counts = await refreshWorks(baseQuery, 'id', processor);

  const message = `扫描完成: 更新 ${counts.updated} 个，失败 ${counts.failed} 个.`;
  await LOG.finish(message);
  db.knex.destroy();
  if (counts.failed) process.exit(1);
}

async function fixVoiceActorBug(): Promise<RefreshCounts> {
  const baseQuery = db.knex('r_va_work').select('va_id', 'work_id');
  const filter = (query: typeof baseQuery) => query.where('va_id', nameToUUID('かの仔')).orWhere('va_id', nameToUUID('こっこ'));
  const processor = (id: string) => updateVoiceActorLimited(id);
  return await refreshWorks(filter(baseQuery), 'work_id', processor);
}

async function refreshWorks(
  query: Knex.QueryBuilder,
  idColumnName: string,
  processor: (id: string) => Promise<RefreshResult>,
): Promise<RefreshCounts> {
  const works = await query;
  LOG.main.info(`共 ${works.length} 个作品. 开始刷新`);

  const counts: RefreshCounts = {
    updated: 0,
    failed: 0,
  }; 

  await Promise.all(works.map(async (work: Record<string, string>) => {
    const workid = work[idColumnName];
    const displayId = isFanzaId(workid) ? workid : formatID(workid);
    
    const result = (await processor(workid)) === 'failed'
    ? 'failed'
    : 'updated';

    counts[result]++;
    LOG.task.remove(displayId, result);
    LOG.result.add(displayId, result, counts[result]);
  }));

  LOG.main.log(`完成元数据更新 ${counts.updated} 个，失败 ${counts.failed} 个.`);
  return counts;
}

// Re-index one work's folder: its file listing and audio durations.
async function scanWorkFile(work: WorkFileScanRow, index: number, total: number): Promise<'updated' | 'skipped' | 'failed'> {
  const displayId = isFanzaId(work.id) ? work.id : formatID(work.id);

  LOG.main.info(`扫描进度：${index+1}/${total}`);

  try {
    const rootFolder = config.rootFolders.find(rootFolder => rootFolder.name === work.root_folder);
    if (!rootFolder) return "skipped";
    const absoluteWorkDir = path.join(rootFolder.path, work.dir);

    await rescanWorkFiles(work.id, absoluteWorkDir);

    return "updated";
  } catch(error) {
    LOG.main.error(`[${displayId}] Failed to scan work files: ${error}`);
    console.error((error as Error).stack);
    return "failed";
  }
}
const scanWorkFileLimited = (work: WorkFileScanRow, index: number, total: number) =>
  limitP.call(scanWorkFile, work, index, total);
async function performWorkFileScan(): Promise<void> {
  LOG.open('files');
  LOG.main.info(`扫描本地文件开始`);
  const works: WorkFileScanRow[] = await db.knex('t_work').select('id', "root_folder", "dir");
  LOG.main.info(`总计 ${works.length} 个作品`);

  const results = await Promise.all(works.map((work, index) => scanWorkFileLimited(work, index, works.length)));

  const counts = results.reduce((acc, x) => ( acc[x]++, acc ), {
    updated: 0,
    skipped: 0,
    failed: 0,
  });

  const message = `扫描完成: 更新 ${counts.updated} 个，失败 ${counts.failed} 个，跳过 ${counts.skipped} 个.`;
  await LOG.finish(message);
  db.knex.destroy();
  if (counts.failed) process.exit(1);
  process.exit(0);
}

export { performScan, performUpdate, performWorkFileScan, LOG };