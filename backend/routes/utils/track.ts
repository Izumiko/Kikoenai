import fs from 'fs';
import path from 'path';
import type { Request, Response } from 'express';
import { config } from '../../config.ts';
import type { RootFolder } from '../../types/config.ts';
import type { Track } from '../../types/track.ts';
import db from '../../database/db.ts';
import { listWorkTracks, overlayDir } from '../../filesystem/workFiles.ts';
import { supportedSubtitleExtList } from '../../filesystem/utils.ts';

// The only rows whose bytes might live in the overlay. '.txt' is included
// because a text/plain ASR answer is saved as one (asr.js).
const OVERLAY_EXT: string[] = [...supportedSubtitleExtList, '.txt'];

/** The t_work columns a media request needs to find the work's listing. */
interface TrackWork {
  root_folder: string;
  dir: string;
  files_indexed_at: string | null;
}

/** Everything a media route needs about one resolved track. */
interface ResolvedTrack {
  work: TrackWork;
  rootFolder: RootFolder;
  workDir: string;
  tracks: Track[];
  track: Track;
  fullPath: string;
}

/**
 * The work folder first, the overlay second -- which is also the "library copy
 * wins" rule. Only subtitle rows can miss, so audio pays no extra stat.
 */
const trackPath = (workId: string, workDir: string, track: Track): string => {
  const inLibrary = path.join(workDir, track.shortFilePath);
  if (!OVERLAY_EXT.includes(track.ext) || fs.existsSync(inLibrary)) return inLibrary;
  return path.join(overlayDir(workId), track.shortFilePath);
};

/**
 * Legacy positional-index handle.
 *
 * A tracked file always carries a supported extension, so its relPath always
 * contains a '.'. A single path segment of pure digits therefore cannot be a
 * real relPath -- it is the positional index that play-history queues written
 * before migration 20260912000000 still carry, and those rows are stored user
 * data that cannot be refetched.
 */
const legacyIndex = (segments: string[]): number | null => (
  segments.length === 1 && /^\d+$/.test(segments[0]) ? Number(segments[0]) : null
);

/**
 * Resolve the `*path` of a media route to one track of a work.
 *
 * @returns {Promise<{work, rootFolder, workDir, tracks, track, fullPath}|null>}
 */
const resolveTrack = async (req: Request, res: Response): Promise<ResolvedTrack | null> => {
  // A named (non-wildcard) route param is a single string at runtime; Express
  // 5's types also allow an array for repeatable params.
  const workId = req.params.id as string;
  const work: TrackWork | undefined = await db.knex('t_work')
    .select('root_folder', 'dir', 'files_indexed_at')
    .where('id', '=', workId)
    .first();
  if (!work) {
    res.status(404).send({ error: `"${workId}" does not exist.` });
    return null;
  }

  const rootFolder: RootFolder | undefined = config.rootFolders.find((folder) => folder.name === work.root_folder);
  if (!rootFolder) {
    res.status(500).send({ error: `Directory "${work.root_folder}" not found, please try restarting the server or rescanning.` });
    return null;
  }

  const workDir = path.join(rootFolder.path, work.dir);
  const tracks = await listWorkTracks(workId, workDir, { indexedAt: work.files_indexed_at });

  // Express 5 hands a `*path` back as an array of already-decoded segments.
  const segments: string[] = ([] as string[]).concat(req.params.path || []);
  const index = legacyIndex(segments);
  const track = index === null
    ? tracks.find((t) => t.shortFilePath === segments.join('/'))
    : tracks[index];
  if (!track) {
    res.status(404).send({ error: 'Track not found.' });
    return null;
  }

  return { work, rootFolder, workDir, tracks, track, fullPath: trackPath(workId, workDir, track) };
};

export { resolveTrack, legacyIndex };
