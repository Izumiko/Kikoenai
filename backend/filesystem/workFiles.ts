/*
 * A work's file listing, read from the database rather than the disk.
 */

import fs from 'fs';
import path from 'path';
import { orderBy } from 'natural-orderby';
import db from '../database/db.ts';
import { config } from '../config.ts';
import { getTrackList, probeAudioDurations, supportedMediaExtList } from './utils.ts';
import type { KnownProbe } from './utils.ts';
import type { Track, WalkedTrack } from '../types/track.ts';
import type { WorkFileRow } from '../types/db.ts';

/**
 * The slice of the database the listing uses. Every entry point takes one, so
 * tests can inject an in-memory knex -- the same convention the scripts use.
 */
export type WorkFilesDb = Pick<typeof db, 'knex' | 'getWorkFiles' | 'replaceWorkFiles'>;

/** A `t_work_file` row as the listing reads it. */
type WorkFileSelectRow = Pick<WorkFileRow, 'rel_path' | 'duration' | 'mtime' | 'track_title'>;

/** A shaped row before the absolute path is stripped from it. */
type ShapedTrack = Track & { fullPath?: string };

/**
 * Generated subtitles that could not be written next to the audio. Mirrors the
 * work folder's layout, so one relPath addresses a file in either place.
 */
const overlayDir = (workId: string): string => path.join(config.lyricFolderDir, String(workId));

/**
 * Fold the overlay into a walk of the work folder, at index time rather than
 * per request -- t_work_file exists so serving a work walks no directory. The
 * only reader that knows the overlay exists is routes/utils/track.js.
 *
 * A file in both places collapses to the library's copy: rel_path is the
 * primary key, and a hand-made sidecar should beat a generated one.
 */
const mergeOverlay = async (workId: string, walked: WalkedTrack[]): Promise<WalkedTrack[]> => {
  const dir = overlayDir(workId);
  if (!fs.existsSync(dir)) return walked;

  const overlaid = await getTrackList(workId, dir);
  const inLibrary = new Set(walked.map((track) => track.shortFilePath));
  return walked.concat(overlaid.filter((track) => !inLibrary.has(track.shortFilePath)));
};

/**
 * Turn stored rows into the same track objects getTrackList returns for a walk,
 * in the same order. t_work_file is the only other source of a track list, and
 * every caller expects one object type.
 */
const rowsToTracks = (workId: string, workDir: string, rows: WorkFileSelectRow[]): Track[] => {
  const tracks: ShapedTrack[] = rows.map((row) => {
    const relPath = row.rel_path;
    const dirName = path.dirname(relPath);
    return {
      title: path.basename(relPath),
      subtitle: dirName === '.' ? null : dirName,
      ext: path.extname(relPath).toLowerCase(),
      shortFilePath: relPath,
      trackId: `${workId}/${relPath}`,
      duration: row.duration === null ? undefined : row.duration,
      trackTitle: row.track_title || undefined,
      mtime: row.mtime === null ? undefined : row.mtime,
      fullPath: path.join(workDir, relPath),
    };
  });

  // The same comparator getTrackList uses.
  const sorted = orderBy(tracks, [v => v.subtitle, v => v.title, v => v.ext]);

  // getTrackList only attaches duration/trackTitle to audio, and callers read
  // `undefined` as "unknown". Mirror that rather than exposing them on a .jpg.
  for (const file of sorted) {
    if (!supportedMediaExtList.includes(file.ext)) {
      delete file.duration;
      delete file.trackTitle;
    }
    delete file.fullPath;
  }
  return sorted;
};

/**
 * Walk the work folder and replace its rows. Preserves durations and track
 * titles for files that are still there.
 * @returns {Promise<Array>} the track list, as listWorkTracks returns.
 */
async function indexWorkFiles (workId: string, workDir: string, tracks?: WalkedTrack[], dbApi: WorkFilesDb = db): Promise<Track[]> {
  const walked = await mergeOverlay(workId, tracks || await getTrackList(workId, workDir));
  const existing = await dbApi.getWorkFiles(workId);
  const byRelPath = new Map(existing.map((row) => [row.rel_path, row]));

  const rows = walked.map((track) => {
    const kept = byRelPath.get(track.shortFilePath);
    return {
      work_id: String(workId),
      rel_path: track.shortFilePath,
      // A plain walk carries no duration -- only a scan probes -- so keep what the
      // row already had. Losing it would mean an ffprobe per file to get it back.
      duration: track.duration ?? kept?.duration ?? null,
      mtime: track.mtime ?? kept?.mtime ?? null,
      track_title: track.trackTitle ?? kept?.track_title ?? null,
    };
  });

  await dbApi.replaceWorkFiles(workId, rows);
  return rowsToTracks(workId, workDir, rows);
}

/**
 * A work's tracks, from the database.
 */
async function listWorkTracks (workId: string, workDir: string, { indexedAt, dbApi = db }: { indexedAt?: string | null; dbApi?: WorkFilesDb } = {}): Promise<Track[]> {
  if (indexedAt === undefined) {
    const work = await dbApi.knex('t_work').select('files_indexed_at').where('id', workId).first();
    indexedAt = work ? work.files_indexed_at : null;
  }
  if (!indexedAt) {
    // One walk, no probing: ffprobe belongs to the scan paths, not to a request.
    // Durations already in the rows are carried forward by indexWorkFiles.
    return indexWorkFiles(workId, workDir, undefined, dbApi);
  }
  return rowsToTracks(workId, workDir, await dbApi.getWorkFiles(workId));
}

/**
 * @returns {Promise<Array>} the track list
 */
async function rescanWorkFiles (workId: string, workDir: string, dbApi: WorkFilesDb = db): Promise<Track[]> {
  const existing = await dbApi.getWorkFiles(workId);
  const known = new Map<string, KnownProbe>(existing.map((row) => [
    row.rel_path,
    { duration: row.duration ?? undefined, mtime: row.mtime ?? undefined },
  ]));

  const tracks = await getTrackList(workId, workDir);
  await probeAudioDurations(workId, tracks, known);
  return indexWorkFiles(workId, workDir, tracks, dbApi);
}

export { listWorkTracks, indexWorkFiles, rescanWorkFiles, rowsToTracks, overlayDir };
