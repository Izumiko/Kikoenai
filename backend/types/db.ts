/*
 * Row shapes of the SQLite tables in database/schema.ts.
 *
 * These describe what knex hands back for one row: columns SQLite has no
 * runtime type for (booleans, dates) arrive as whatever was written, so the
 * scalar unions stay honest instead of pretending a `boolean` column always
 * reads back as a boolean.
 *
 * Only the tables the query layer actually returns are declared here. A row of
 * a `*_work` join table carries just its two foreign keys.
 */

/** SQLite's BOOLEAN storage: the app writes booleans, knex reads 0/1 back. */
export type SqliteBoolean = boolean | number;

/** SQLite DATETIME columns are TEXT (`YYYY-MM-DD HH:MM:SS`, UTC). */
export type SqliteTimestamp = string;

/** A row of one of the label tables. All label ids are name-based UUIDs. */
export interface LabelRow {
  id: string;
  name: string;
}

export interface CircleRow extends LabelRow {}
export interface TagRow extends LabelRow {}
export interface VaRow extends LabelRow {}
export interface IllustratorRow extends LabelRow {}
export interface ScriptWriterRow extends LabelRow {}
export interface SeriesRow extends LabelRow {}
export interface AuthorRow extends LabelRow {}

/** One row of a `r_<label>_work` join table. */
export interface LabelWorkRow {
  work_id: string;
}

export interface TagWorkRow extends LabelWorkRow {
  tag_id: string;
}
export interface VaWorkRow extends LabelWorkRow {
  va_id: string;
}
export interface IllustratorWorkRow extends LabelWorkRow {
  illustrator_id: string;
}
export interface ScriptWriterWorkRow extends LabelWorkRow {
  script_writer_id: string;
}
export interface SeriesWorkRow extends LabelWorkRow {
  series_id: string;
}
export interface AuthorWorkRow extends LabelWorkRow {
  author_id: string;
}

export interface WorkRow {
  /** DLsite id (RJ-padded) or Fanza id (`d215444`); TEXT since migration 20260802000000. */
  id: string;
  created_at: SqliteTimestamp;
  updated_at: SqliteTimestamp;
  root_folder: string;
  dir: string;
  title: string;
  circle_id: string;
  nsfw: SqliteBoolean | null;
  release: string | null;
  dl_count: number | null;
  price: number | null;
  review_count: number | null;
  rate_count: number | null;
  rate_average_2dp: number | null;
  rate_count_detail: string | null;
  rank: string | null;
  description: string | null;
  description_parts: string | null;
  sample_images: string | null;
  files_indexed_at: SqliteTimestamp | null;
}

/** The columns a works listing selects from t_work, plus the circle name it joins. */
export interface WorkListRow {
  id: string;
  created_at: SqliteTimestamp;
  updated_at: SqliteTimestamp;
  title: string;
  circle_id: string;
  /** t_circle.name, joined by the listing queries. */
  name: string;
  nsfw: SqliteBoolean | null;
  release: string | null;
  dl_count: number | null;
  price: number | null;
  review_count: number | null;
  rate_count: number | null;
  rate_average_2dp: number | null;
  rate_count_detail: string | null;
  rank: string | null;
}

/** The user's own state for a work, when a listing asks for it. */
export interface ReviewUserStateRow {
  work_id: string;
  userRating: number | null;
  review_text: string | null;
  progress: string | null;
  updated_at: SqliteTimestamp;
  user_name: string;
}

/** A joined playback-state row: the stored JSON plus its columns. */
export interface PlayStateRow {
  work_id?: string;
  id?: string;
  state?: string | null;
}

export interface HistoryRow {
  user_name: string;
  work_id: string;
  /** JSON blob: the client's playback state (queue, index, position). */
  state: string;
  created_at: SqliteTimestamp;
  updated_at: SqliteTimestamp;
}

export interface UserRow {
  name: string;
  password: string;
  /** 'administrator' | 'user' | 'guest'. */
  group: string;
}

export interface ReviewRow {
  user_name: string;
  work_id: string;
  rating: number | null;
  review_text: string | null;
  created_at: SqliteTimestamp;
  updated_at: SqliteTimestamp;
  progress: string | null;
}

export interface TrackProgressRow {
  user_name: string;
  work_id: string;
  /** Work-relative path of the file (`Track.shortFilePath`). */
  track_key: string;
  seconds: number;
  completed: SqliteBoolean;
  created_at: SqliteTimestamp;
  updated_at: SqliteTimestamp;
}

export interface WorkFileRow {
  work_id: string;
  /** Forward-slash path relative to the work folder. */
  rel_path: string;
  duration: number | null;
  mtime: number | null;
  track_title: string | null;
}

export interface DlsiteReviewRow {
  /** DLsite's own member_review_id. */
  id: string;
  work_id: string;
  reviewer_id: string | null;
  reviewer_name: string | null;
  rate: number | null;
  review_title: string | null;
  review_text: string | null;
  spoiler: SqliteBoolean | null;
  recommend: SqliteBoolean | null;
  is_purchased: SqliteBoolean | null;
  good_review: number | null;
  bad_review: number | null;
  /** JSON: `[{id, name}]` — the genres the reviewer picked. */
  genres: string | null;
  entry_date: string | null;
  regist_date: string | null;
  created_at: SqliteTimestamp;
  updated_at: SqliteTimestamp;
}

export interface SessionRow {
  /** sha256 of the session secret, never the secret itself. */
  id: string;
  user_name: string;
  /** Epoch milliseconds. */
  expires_at: number;
  created_at: SqliteTimestamp;
  updated_at: SqliteTimestamp;
}
