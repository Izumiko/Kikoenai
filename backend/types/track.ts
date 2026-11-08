/*
 * One entry of a work's file listing.
 *
 * Both producers of a listing -- `getTrackList` (a filesystem walk) and
 * `listWorkTracks`/`shapeRows` (the `t_work_file` rows) -- shape their entries
 * this way, and the route helpers that resolve a media request consume them.
 */

export interface Track {
  /** File name without the directory part. */
  title: string;
  /** Forward-slash relative directory, or null for the work's root. */
  subtitle: string | null;
  ext: string;
  /** `${workId}/${relPath}` -- the file's identity across the app. */
  trackId: string;
  /** Forward-slash path relative to the work folder -- the DB key. */
  shortFilePath: string;
  /** Absolute path on disk; stripped from listings that go to a client. */
  fullPath?: string;
  /** Audio only: probe result, undefined when it could not be probed. */
  duration?: number;
  /** Audio only: file mtime in ms, the invalidation key for `duration`. */
  mtime?: number;
  /** Audio only: display title from `t_work_file.track_title`. */
  trackTitle?: string;
}

/**
 * A track as `getTrackList` produces it: a walk of the disk, so the absolute
 * path is always set. `probeAudioDurations` stats it, and `indexWorkFiles`
 * hands the walk to the database layer.
 */
export type WalkedTrack = Track & { fullPath: string };
