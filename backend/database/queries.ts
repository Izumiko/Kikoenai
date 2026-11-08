import crypto from 'crypto';
import type { Knex } from 'knex';
import { nameToUUID } from '../scraper/utils.ts';
import { canonicalizeTagName } from '../scraper/tag-aliases.ts';
import { canonicalizeVaName } from '../scraper/va-aliases.ts';
import { parseSearchQuery, RELATION_FIELDS } from './search-query.ts';
import type { SearchTerm } from './search-query.ts';
import { collectWorkImages } from '../filesystem/utils.ts';
import type {
  DescriptionPart,
  DlsiteReview,
  LabelInput,
  ReviewGenre,
  SampleImage,
  WorkMetadata,
} from '../types/scraper.ts';
import type {
  AuthorWorkRow,
  DlsiteReviewRow,
  HistoryRow,
  IllustratorWorkRow,
  PlayStateRow,
  ReviewUserStateRow,
  ScriptWriterWorkRow,
  SeriesWorkRow,
  TagWorkRow,
  TrackProgressRow,
  VaWorkRow,
  WorkFileRow,
  WorkListRow,
  WorkRow,
} from '../types/db.ts';

/** A label reference as it is stored inside the *Obj JSON columns. */
interface LabelRef {
  id: string;
  name: string;
}

/** One row of a batch-fetched label relation: the work it belongs to plus the label. */
interface RelationNameRow {
  work_id: string;
  id: string;
  name: string;
}

/** A play-history row joined onto a work row. */
interface HistoryJoinRow extends Pick<HistoryRow, 'work_id' | 'state'> {
  play_updated_at: string;
}

/** A works listing row joined with its circle name. */
interface HistoryListRow extends WorkListRow {
  state: string | null;
  play_updated_at: string;
  progress: string | null;
}

/** A works row with every relation assembled into a JSON string. */
interface AssembledWorkRow extends WorkListRow {
  circleObj: string;
  tagObj: string;
  vaObj: string;
  illustratorObj: string;
  scriptWriterObj: string;
  seriesObj: string;
  userRating?: number | null;
  review_text?: string | null;
  progress?: string | null;
  user_name?: string;
  /** Play history: the stored state JSON, after progress seconds were merged in. */
  state?: string | null;
  play_updated_at?: string;
}

/** The *Obj columns `pushDeduped` may write. */
type RelationObjectKey = 'tagObj' | 'vaObj' | 'illustratorObj' | 'scriptWriterObj' | 'seriesObj';

/** The client's stored playback state (`t_play_history.state`, JSON). */
interface PlaybackState {
  queue?: Array<{ trackId?: string }>;
  index?: number;
  seconds?: number;
  secondsObservedAt?: string;
  [key: string]: unknown;
}

/** One row of t_track_progress as the progress projections read it. */
type TrackProgressSelectRow = Pick<TrackProgressRow, 'work_id' | 'track_key' | 'seconds' | 'completed' | 'updated_at'>;

/** One entry of the map `trackProgressFor` returns. */
interface TrackProgressHit {
  seconds: number;
  completed: boolean;
  observedAt: string;
}

/** The flags `updateWorkMetadata` accepts. */
interface UpdateWorkMetadataOptions {
  includeVA?: boolean;
  includeIllustrator?: boolean;
  includeScriptWriter?: boolean;
  includeAuthor?: boolean;
  includeSeries?: boolean;
  includeTags?: boolean;
  includeNSFW?: boolean;
  includeDescription?: boolean;
  refreshAll?: boolean;
  purgeTags?: boolean;
}

/** The body of an admin metadata edit (PUT /api/work/:id). */
interface EditWorkMetadataInput {
  title?: string;
  nsfw?: boolean | number;
  release?: string | null;
  /** Circle name; resolved or created. */
  circle: string;
  tags: LabelInput[];
  vas: LabelInput[];
  illustrators: LabelInput[];
  scriptWriters: LabelInput[];
  series?: LabelInput | null;
}

/** Shared options of the works-listing queries. */
interface WorksQueryOptions {
  username?: string;
  nsfw?: number;
  order?: string;
  sort?: string;
  limit?: number;
  offset?: number;
  seed?: number;
}

interface WorksFilterQueryOptions extends WorksQueryOptions {
  filter?: string;
}

/** Options of getWorksWithReviews. */
interface WorksWithReviewsOptions {
  username?: string;
  limit?: number;
  offset?: number;
  orderBy?: string;
  sortOption?: string;
  filter?: string;
}

/** Options of getPlayHistory. */
interface PlayHistoryQueryOptions {
  username?: string;
  sortOption?: string;
  limit?: number;
  excludeFinished?: string;
  offset?: number;
}

/** A `t_work_file` row as it is written back. */
interface WorkFileWriteRow {
  work_id: string;
  rel_path: string;
  duration?: number | null;
  mtime?: number | null;
  track_title?: string | null;
}

/** A user row as the user queries take it. */
interface UserInput {
  name: string;
  password: string;
  group: string;
}

/** A knex transaction provider, as some helpers pass one in. */
type TrxProvider = () => Promise<Knex.Transaction>;

/**
 * Format ID: pad DLsite numeric ids to RJ form (6 or 8 digits).
 * For string inputs (already in final form), pass through.
 */
function formatID(id: string | number): string {
  if (typeof id === 'string') return id;
  const n = parseInt(String(id), 10);
  return (n >= 1000000) ? `0${n}`.slice(-8) : `000000${n}`.slice(-6);
}

/**
 * Read one of the JSON-encoded t_work columns, tolerating null and garbage.
 * The caller names the column's stored shape; the parse itself is unchecked.
 */
function parseJsonColumn<T>(value: string | null | undefined, fallback: T = [] as T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/**
 * Factory that binds every DB query function to a specific knex instance.
 * Functions are copied verbatim from the original singleton-bound versions in
 * db.js so the generated SQL is byte-identical.
 * The returned object's type is inferred, so db.ts can spread it.
 */
const makeQueries = (knex: Knex) => {
  /**
   * @param nsfw 0所有年龄分级，1仅全年龄，2仅十八禁
   */
  function nsfwFilter<TRecord extends {} = any, TResult = any>(
    nsfw: number,
    knexQuery: Knex.QueryBuilder<TRecord, TResult>,
  ): Knex.QueryBuilder<TRecord, TResult> {
    switch(nsfw) {
      case 1: return knexQuery.where('nsfw', '=', false); // 全年龄
      case 2: return knexQuery.where('nsfw', '=', true); // 仅R18
      default: return knexQuery; // 无年龄限制
    }
  }


  /**
   * Setter for track progress
   * @returns `${workId}\u0000${relPath}` -> {seconds, completed, observedAt}
   */
  const trackProgressFor = async (
    username: string,
    { workId, relPaths }: { workId?: string; relPaths?: string[] } = {},
  ): Promise<Map<string, TrackProgressHit>> => {
    const byKey = new Map<string, TrackProgressHit>();
    if (relPaths && !relPaths.length) return byKey;

    let query = knex('t_track_progress')
      .select('work_id', 'track_key', 'seconds', 'completed', 'updated_at')
      .where('user_name', username);
    if (workId !== undefined) query = query.andWhere('work_id', String(workId));
    if (relPaths) query = query.whereIn('track_key', relPaths);

    const rows: TrackProgressSelectRow[] = await query;
    for (const row of rows) {
      byKey.set(`${row.work_id}\u0000${row.track_key}`, {
        seconds: row.seconds,
        completed: !!row.completed,
        observedAt: row.updated_at,
      });
    }
    return byKey;
  };

  const applyTrackProgressSeconds = async (username: string, rows: PlayStateRow[]): Promise<void> => {
    const progressKey = (workId: string, trackKey: string): string => `${workId}\u0000${trackKey}`;
    const parsed: Array<{ row: PlayStateRow; state: PlaybackState; relPath: string; key: string }> = [];
    for (const row of rows) {
      if (!row.state) continue;
      const workId = row.work_id !== undefined ? row.work_id : row.id;
      if (workId === undefined) continue;
      let state: PlaybackState;
      try {
        state = JSON.parse(row.state);
      } catch {
        continue;
      }
      // `index` may be absent in a stored row; the original lookup was
      // `queue[undefined]`, which is undefined as well.
      const trackId = state.queue && state.index !== undefined && state.queue[state.index] && state.queue[state.index].trackId;
      // A trackId is `workId/relPath`; track_key holds the relPath alone.
      const relPath = trackId && trackId.startsWith(`${workId}/`)
        ? trackId.slice(String(workId).length + 1)
        : null;
      if (relPath) parsed.push({ row, state, relPath, key: progressKey(workId, relPath) });
    }
    if (!parsed.length) return;

    const byKey = await trackProgressFor(username, { relPaths: parsed.map((p) => p.relPath) });

    for (const p of parsed) {
      const hit = byKey.get(p.key);
      if (!hit) continue;
      p.state.seconds = hit.seconds;
      // The client needs this to tell whether its own local row is newer.
      p.state.secondsObservedAt = hit.observedAt;
      p.row.state = JSON.stringify(p.state);
    }
  };

  /**
   * Shared helper: batch-fetch static relations (tags, vas, illustrators,
   * script_writers, series) and optional user state for a set of work IDs,
   * then assemble into the JSON-string *Obj shape that normalize() expects.
   *
   * @param coreRows - Rows from t_work ⋈ t_circle with core fields.
   * @param opts.reviewFields - also fetch review_text/progress/updated_at/user_name
   * @param opts.historyFields - also fetch state/play_updated_at
   * @returns Assembled rows with *Obj JSON-string fields.
   */
  async function assembleWorks(
    coreRows: WorkListRow[],
    { username = 'admin', reviewFields = false, historyFields = false }: {
      username?: string;
      reviewFields?: boolean;
      historyFields?: boolean;
    } = {},
  ): Promise<AssembledWorkRow[]> {
    if (coreRows.length === 0) return [];

    const ids = coreRows.map(r => r.id);

    // Batch-fetch static relations
    const [tagRows, vaRows, illusRows, swRows, seriesRows, reviewRows, historyRows]: [
      RelationNameRow[],
      RelationNameRow[],
      RelationNameRow[],
      RelationNameRow[],
      RelationNameRow[],
      ReviewUserStateRow[],
      HistoryJoinRow[],
    ] = await Promise.all([
      knex('r_tag_work').join('t_tag', 't_tag.id', 'r_tag_work.tag_id')
        .select('r_tag_work.work_id', 'r_tag_work.tag_id as id', 't_tag.name').whereIn('r_tag_work.work_id', ids),
      knex('r_va_work').join('t_va', 't_va.id', 'r_va_work.va_id')
        .select('r_va_work.work_id', 'r_va_work.va_id as id', 't_va.name').whereIn('r_va_work.work_id', ids),
      knex('r_illustrator_work').join('t_illustrator', 't_illustrator.id', 'r_illustrator_work.illustrator_id')
        .select('r_illustrator_work.work_id', 'r_illustrator_work.illustrator_id as id', 't_illustrator.name').whereIn('r_illustrator_work.work_id', ids),
      knex('r_script_writer_work').join('t_script_writer', 't_script_writer.id', 'r_script_writer_work.script_writer_id')
        .select('r_script_writer_work.work_id', 'r_script_writer_work.script_writer_id as id', 't_script_writer.name').whereIn('r_script_writer_work.work_id', ids),
      knex('r_series_work').join('t_series', 't_series.id', 'r_series_work.series_id')
        .select('r_series_work.work_id', 'r_series_work.series_id as id', 't_series.name').whereIn('r_series_work.work_id', ids),
      // User state — review (only if requested)
      reviewFields
        ? knex('t_review').select('work_id', 'rating as userRating', 'review_text', 'progress',
            knex.raw("strftime('%Y-%m-%d %H-%M-%S', updated_at, 'localtime') AS updated_at"), 'user_name')
            .where('user_name', username).whereIn('work_id', ids)
        : Promise.resolve([]),
      // Play history (only if requested)
      historyFields
        ? knex('t_play_history').select('work_id', 'state', 'updated_at as play_updated_at')
            .where('user_name', username).whereIn('work_id', ids)
        : Promise.resolve([]),
    ]);

    // Build a Map from id -> assembled row
    const byId = new Map<string, AssembledWorkRow>();
    for (const row of coreRows) {
      // The *Obj columns are added just below; the row itself is a listing row.
      const a = { ...row } as AssembledWorkRow;
      a.circleObj = JSON.stringify({ id: row.circle_id, name: row.name });
      a.tagObj = JSON.stringify({ tags: [] });
      a.vaObj = JSON.stringify({ vas: [] });
      a.illustratorObj = JSON.stringify({ illustrators: [] });
      a.scriptWriterObj = JSON.stringify({ scriptWriters: [] });
      a.seriesObj = JSON.stringify({ series: [] });
      byId.set(a.id, a);
    }

    // Helper: push a relation item into a work's *Obj array, deduping by id
    const pushDeduped = (workId: string, objKey: RelationObjectKey, subKey: string, item: LabelRef): void => {
      const w = byId.get(workId);
      if (!w) return;
      const arr = JSON.parse(w[objKey])[subKey];
      // Dedupe by id (mimics json_group_array(DISTINCT ...))
      if (!arr.some((existing: LabelRef) => existing.id === item.id)) {
        arr.push(item);
      }
      w[objKey] = JSON.stringify({ [subKey]: arr });
    };

    for (const t of tagRows) pushDeduped(t.work_id, 'tagObj', 'tags', { id: t.id, name: t.name });
    for (const v of vaRows) pushDeduped(v.work_id, 'vaObj', 'vas', { id: v.id, name: v.name });
    for (const it of illusRows) pushDeduped(it.work_id, 'illustratorObj', 'illustrators', { id: it.id, name: it.name });
    for (const sw of swRows) pushDeduped(sw.work_id, 'scriptWriterObj', 'scriptWriters', { id: sw.id, name: sw.name });
    for (const se of seriesRows) pushDeduped(se.work_id, 'seriesObj', 'series', { id: se.id, name: se.name });

    // Apply user state fields (if any)
    if (reviewFields) {
      for (const r of reviewRows) {
        const w = byId.get(r.work_id);
        if (!w) continue;
        w.userRating = r.userRating;
        w.review_text = r.review_text;
        w.progress = r.progress;
        w.updated_at = r.updated_at;
        w.user_name = r.user_name;
      }
    }
    if (historyFields) {
      await applyTrackProgressSeconds(username, historyRows);
      for (const h of historyRows) {
        const w = byId.get(h.work_id);
        if (!w) continue;
        w.state = h.state;
        w.play_updated_at = h.play_updated_at;
      }
    }

    // Return in the same order as coreRows
    return coreRows.map(r => byId.get(r.id)!);
  }

  /**
   * Unified label resolver: resolve or create a label by name using nameToUUID.
   * Works for all label tables: t_circle, t_tag, t_va, t_illustrator, t_script_writer, t_series.
   * @returns UUID id
   */
  const resolveLabel = async (trx: Knex.Transaction, tableName: string, name: string): Promise<string> => {
    const id = nameToUUID(name);
    await trx.raw('INSERT OR IGNORE INTO ??(id, name) VALUES (?, ?)', [tableName, id, name]);
    return id;
  };

  // Tag-specific resolver: canonicalizes the scraped name (new → old) before
  // UUID resolution so a DLsite rename folds onto the existing t_tag row
  // instead of splitting into two. See scraper/tag-aliases.json.
  const resolveTagLabel = async (trx: Knex.Transaction, name: string): Promise<string> =>
    resolveLabel(trx, 't_tag', canonicalizeTagName(name));

  // VA-specific resolver: canonicalizes the scraped name (variant → canonical)
  // so a VA registered under several spellings folds onto one t_va row.
  // See scraper/va-aliases.json.
  const resolveVaLabel = async (trx: Knex.Transaction, name: string): Promise<string> =>
    resolveLabel(trx, 't_va', canonicalizeVaName(name));

  /**
   * Takes a work metadata object and inserts it into the database.
   *
   * The scanner adds the location before inserting, and both columns are NOT
   * NULL in `t_work`, so the signature requires them rather than leaving the
   * scanner to remember.
   */
  const insertWorkMetadata = async (
    work: WorkMetadata & Required<Pick<WorkMetadata, 'rootFolderName' | 'dir'>>,
  ) => knex.transaction(async (trx) => {
    // Resolve circle UUID by name. A page with no circle leaves the name
    // undefined, which nameToUUID then rejects — unchanged upstream behaviour;
    // the assertion only states what the DB contract already assumes.
    const circleId = await resolveLabel(trx, 't_circle', work.circle.name!);

    await trx('t_work')
      .insert({
        id: work.id,
        root_folder: work.rootFolderName,
        dir: work.dir,
        title: work.title,
        circle_id: circleId,
        nsfw: work.nsfw,
        release: work.release,
        dl_count: work.dl_count,
        price: work.price,
        review_count: work.review_count,
        rate_count: work.rate_count,
        rate_average_2dp: work.rate_average_2dp,
        rate_count_detail: JSON.stringify(work.rate_count_detail),
        rank: work.rank ? JSON.stringify(work.rank) : null,
        description: work.description || null,
        description_parts: work.descriptionParts ? JSON.stringify(work.descriptionParts) : null,
        sample_images: work.sampleImages ? JSON.stringify(work.sampleImages) : null,
      });

    // Tags (canonicalized: a renamed DLsite tag folds onto the old-name row)
    for (const tag of work.tags) {
      const tagId = await resolveTagLabel(trx, tag.name);
      await trx.raw('INSERT OR IGNORE INTO r_tag_work(tag_id, work_id) VALUES (?, ?)', [tagId, work.id]);
    }

    // VAs
    for (const va of work.vas) {
      const vaId = await resolveVaLabel(trx, va.name);
      await trx.raw('INSERT OR IGNORE INTO r_va_work(va_id, work_id) VALUES (?, ?)', [vaId, work.id]);
    }

    // Illustrators
    if (work.illustrators) {
      for (const illus of work.illustrators) {
        const illusId = await resolveLabel(trx, 't_illustrator', illus.name);
        await trx.raw('INSERT OR IGNORE INTO r_illustrator_work(illustrator_id, work_id) VALUES (?, ?)', [illusId, work.id]);
      }
    }

    // Script writers
    if (work.scriptWriters) {
      for (const sw of work.scriptWriters) {
        const swId = await resolveLabel(trx, 't_script_writer', sw.name);
        await trx.raw('INSERT OR IGNORE INTO r_script_writer_work(script_writer_id, work_id) VALUES (?, ?)', [swId, work.id]);
      }
    }

    // Authors (作者) — rarely set, and never alongside a VA/illustrator breakdown
    if (work.authors) {
      for (const author of work.authors) {
        const authorId = await resolveLabel(trx, 't_author', author.name);
        await trx.raw('INSERT OR IGNORE INTO r_author_work(author_id, work_id) VALUES (?, ?)', [authorId, work.id]);
      }
    }

    // Series
    if (work.series && work.series.name) {
      const seriesId = await resolveLabel(trx, 't_series', work.series.name);
      await trx.raw('INSERT OR IGNORE INTO r_series_work(series_id, work_id) VALUES (?, ?)', [seriesId, work.id]);
    }
  });

  /**
   * Update work's metadata
   */
  const updateWorkMetadata = (work: WorkMetadata, options: UpdateWorkMetadataOptions = {}) => knex.transaction(async (trx) => {
    await trx('t_work')
      .where('id', '=', work.id)
      .update({
        dl_count: work.dl_count,
        price: work.price,
        review_count: work.review_count,
        rate_count: work.rate_count,
        rate_average_2dp: work.rate_average_2dp,
        rate_count_detail: JSON.stringify(work.rate_count_detail),
        rank: work.rank ? JSON.stringify(work.rank) : null,
      });

    // VA: delete only when includeVA flag explicitly set; insert always if includeVA or refreshAll
    if (options.includeVA) {
      await trx('r_va_work').where('work_id', work.id).del();
    }
    if (options.includeVA || options.refreshAll) {
      for (const va of work.vas) {
        const vaId = await resolveVaLabel(trx, va.name);
        await trx.raw('INSERT OR IGNORE INTO r_va_work(va_id, work_id) VALUES (?, ?)', [vaId, work.id]);
      }
    }
    // Illustrator: delete only when includeIllustrator flag explicitly set; insert always if includeIllustrator or refreshAll
    if (options.includeIllustrator) {
      await trx('r_illustrator_work').where('work_id', work.id).del();
    }
    if (options.includeIllustrator || options.refreshAll) {
      if (work.illustrators) {
        for (const illustrator of work.illustrators) {
          const illusId = await resolveLabel(trx, 't_illustrator', illustrator.name);
          await trx.raw('INSERT OR IGNORE INTO r_illustrator_work(illustrator_id, work_id) VALUES (?, ?)', [illusId, work.id]);
        }
      }
    }
    // ScriptWriter: delete only when includeScriptWriter flag explicitly set; insert always if includeScriptWriter or refreshAll
    if (options.includeScriptWriter) {
      await trx('r_script_writer_work').where('work_id', work.id).del();
    }
    if (options.includeScriptWriter || options.refreshAll) {
      if (work.scriptWriters) {
        for (const sw of work.scriptWriters) {
          const swId = await resolveLabel(trx, 't_script_writer', sw.name);
          await trx.raw('INSERT OR IGNORE INTO r_script_writer_work(script_writer_id, work_id) VALUES (?, ?)', [swId, work.id]);
        }
      }
    }
    // Author: delete only when includeAuthor flag explicitly set; insert always if includeAuthor or refreshAll
    if (options.includeAuthor) {
      await trx('r_author_work').where('work_id', work.id).del();
    }
    if (options.includeAuthor || options.refreshAll) {
      if (work.authors) {
        for (const author of work.authors) {
          const authorId = await resolveLabel(trx, 't_author', author.name);
          await trx.raw('INSERT OR IGNORE INTO r_author_work(author_id, work_id) VALUES (?, ?)', [authorId, work.id]);
        }
      }
    }
    // Series: delete only when includeSeries flag explicitly set; insert always if includeSeries or refreshAll
    if (options.includeSeries) {
      await trx('r_series_work').where('work_id', work.id).del();
    }
    if (options.includeSeries || options.refreshAll) {
      if (work.series && work.series.name) {
        const seriesId = await resolveLabel(trx, 't_series', work.series.name);
        await trx.raw('INSERT OR IGNORE INTO r_series_work(series_id, work_id) VALUES (?, ?)', [seriesId, work.id]);
      }
    }
    if (options.includeTags || options.refreshAll) {
      if (options.purgeTags) {
        await trx('r_tag_work').where('work_id', work.id).del();
      }
      for (const tag of work.tags) {
        const tagId = await resolveTagLabel(trx, tag.name);
        await trx.raw('INSERT OR IGNORE INTO r_tag_work(tag_id, work_id) VALUES (?, ?)', [tagId, work.id]);
      }
    }

    // Fix a bug caused by DLsite changes
    if (options.includeNSFW) {
      await trx('t_work')
      .where('id', '=', work.id)
      .update({
        nsfw: work.nsfw
      });
    }

    // Description and sample image list: the description is overwritten
    // The image list is merged instead
    if (options.includeDescription || options.refreshAll) {
      const patch: Record<string, unknown> = {};
      if (work.description) patch.description = work.description;
      if (work.descriptionParts && work.descriptionParts.length) {
        patch.description_parts = JSON.stringify(work.descriptionParts);
      }
      if (work.sampleImages && work.sampleImages.length) {
        // Rebuilt from the fresh scrape, but every `file` already on disk is
        // carried over
        const stored = await trx('t_work').select('sample_images').where('id', work.id).first();
        const fileByUrl: Record<string, string> = {};
        for (const image of parseJsonColumn<SampleImage[]>(stored && stored.sample_images)) {
          if (image && image.url && image.file) fileByUrl[image.url] = image.file;
        }
        patch.sample_images = JSON.stringify(collectWorkImages(work).map((image: SampleImage) => ({
          ...image,
          file: fileByUrl[image.url] || null,
        })));
      }
      if (Object.keys(patch).length) {
        await trx('t_work').where('id', work.id).update(patch);
      }
    }

    if (options.refreshAll) {
      // Gap-fill: only update title/nsfw/release if the current value is empty/null
      const cur: Pick<WorkRow, 'title' | 'nsfw' | 'release'> = await trx('t_work').select('title', 'nsfw', 'release').where('id', work.id).first();
      const patch: Record<string, unknown> = {};
      if (!cur.title && work.title) patch.title = work.title;
      if (cur.nsfw == null && work.nsfw != null) patch.nsfw = work.nsfw;
      if (!cur.release && work.release) patch.release = work.release;
      if (Object.keys(patch).length) {
        await trx('t_work').where('id', work.id).update(patch);
      }
    }
  });

  /**
   * Manually edit a work's descriptive metadata (full replace semantics).
   * Runs in one transaction. Updates t_work, resolves-or-creates labels,
   * replaces relational links, and cleans up orphaned labels.
   * @param workId
   * @param data
   * @returns
   */
  const editWorkMetadata = async (workId: string, data: EditWorkMetadataInput): Promise<void> => knex.transaction(async (trx) => {
    // 1. Update t_work core fields
    const patch: Record<string, unknown> = {};
    if (data.title !== undefined) patch.title = data.title;
    if (data.nsfw !== undefined) patch.nsfw = data.nsfw;
    if (data.release !== undefined) patch.release = data.release;
    if (Object.keys(patch).length) {
      await trx('t_work').where('id', workId).update(patch);
    }

    // 2. Circle
    const prevWork: Pick<WorkRow, 'circle_id'> = await trx('t_work').select('circle_id').where('id', workId).first();
    const prevCircleId = prevWork ? prevWork.circle_id : null;
    const newCircleId = await resolveLabel(trx, 't_circle', data.circle);
    await trx('t_work').where('id', workId).update({ circle_id: newCircleId });

    // 3. Tags
    const prevTagRows: Array<{ tag_id: string }> = await trx('r_tag_work').select('tag_id').where('work_id', workId);
    const prevTagIds = prevTagRows.map(r => r.tag_id);
    await trx('r_tag_work').where('work_id', workId).del();
    const newTagIds: string[] = [];
    for (const tag of data.tags) {
      const id = await resolveTagLabel(trx, tag.name);
      newTagIds.push(id);
      await trx.raw('INSERT OR IGNORE INTO r_tag_work(tag_id, work_id) VALUES (?, ?)', [id, workId]);
    }
    const removedTagIds = prevTagIds.filter(id => !newTagIds.includes(id));

    // 4. VAs
    const prevVaRows: Array<{ va_id: string }> = await trx('r_va_work').select('va_id').where('work_id', workId);
    const prevVaIds = prevVaRows.map(r => r.va_id);
    await trx('r_va_work').where('work_id', workId).del();
    const newVaIds: string[] = [];
    for (const va of data.vas) {
      const id = await resolveVaLabel(trx, va.name);
      newVaIds.push(id);
      await trx.raw('INSERT OR IGNORE INTO r_va_work(va_id, work_id) VALUES (?, ?)', [id, workId]);
    }
    const removedVaIds = prevVaIds.filter(id => !newVaIds.includes(id));

    // 5. Illustrators
    const prevIllustratorRows: Array<{ illustrator_id: string }> = await trx('r_illustrator_work').select('illustrator_id').where('work_id', workId);
    const prevIllustratorIds = prevIllustratorRows.map(r => r.illustrator_id);
    await trx('r_illustrator_work').where('work_id', workId).del();
    const newIllustratorIds: string[] = [];
    for (const illus of data.illustrators) {
      const id = await resolveLabel(trx, 't_illustrator', illus.name);
      newIllustratorIds.push(id);
      await trx.raw('INSERT OR IGNORE INTO r_illustrator_work(illustrator_id, work_id) VALUES (?, ?)', [id, workId]);
    }
    const removedIllustratorIds = prevIllustratorIds.filter(id => !newIllustratorIds.includes(id));

    // 6. Script writers
    const prevSwRows: Array<{ script_writer_id: string }> = await trx('r_script_writer_work').select('script_writer_id').where('work_id', workId);
    const prevSwIds = prevSwRows.map(r => r.script_writer_id);
    await trx('r_script_writer_work').where('work_id', workId).del();
    const newSwIds: string[] = [];
    for (const sw of data.scriptWriters) {
      const id = await resolveLabel(trx, 't_script_writer', sw.name);
      newSwIds.push(id);
      await trx.raw('INSERT OR IGNORE INTO r_script_writer_work(script_writer_id, work_id) VALUES (?, ?)', [id, workId]);
    }
    const removedSwIds = prevSwIds.filter(id => !newSwIds.includes(id));

    // 7. Series
    const prevSeriesRows: Array<{ series_id: string }> = await trx('r_series_work').select('series_id').where('work_id', workId);
    const prevSeriesIds = prevSeriesRows.map(r => r.series_id);
    await trx('r_series_work').where('work_id', workId).del();
    let removedSeriesIds = prevSeriesIds;
    if (data.series && data.series.name) {
      const id = await resolveLabel(trx, 't_series', data.series.name);
      await trx.raw('INSERT OR IGNORE INTO r_series_work(series_id, work_id) VALUES (?, ?)', [id, workId]);
      removedSeriesIds = prevSeriesIds.filter(sid => sid !== id);
    }

    // 8. Cleanup orphans
    const trxProvider: TrxProvider = () => Promise.resolve(trx);
    await cleanupOrphans(
      trxProvider,
      prevCircleId,
      removedTagIds,
      removedVaIds,
      removedIllustratorIds,
      removedSwIds,
      removedSeriesIds,
    );
  });

  /**
   * Fetches metadata for a specific work id.
   * Returns an Array of length 1 (compatible with normalize()).
   * @param id Work identifier.
   * @param username 'admin' or other usernames for current user
   */
  const getWorkMetadata = async (id: string, username: string): Promise<AssembledWorkRow[]> => {
    const row = await knex('t_work')
      .join('t_circle', 't_circle.id', 't_work.circle_id')
      .select(
        't_work.id', 't_work.created_at', 't_work.updated_at',
        't_work.title', 't_work.circle_id', 't_circle.name',
        't_work.nsfw', 't_work.release',
        't_work.dl_count', 't_work.price', 't_work.review_count',
        't_work.rate_count', 't_work.rate_average_2dp',
        't_work.rate_count_detail', 't_work.rank')
      .where('t_work.id', id)
      .first();

    if (!row) throw new Error(`There is no work with id ${id} in the database.`);

    const assembled = await assembleWorks([row as WorkListRow], { username, reviewFields: true, historyFields: true });
    return assembled;
  };

  /**
   * Tests if the given circle, tags, VAs, illustrators, script writers and series are orphans and if so, removes them.
   * @param trxProvider Knex transaction provider.
   * @param circle Circle id to check.
   * @param tags Array of tag ids to check.
   * @param vas Array of VA ids to check.
   * @param illustrators Array of illustrator ids to check.
   * @param scriptWriters Array of script writer ids to check.
   * @param series Array of series ids to check.
   * @param authors Array of author ids to check.
   */
  const cleanupOrphans = async (
    trxProvider: TrxProvider,
    circle: string | null,
    tags: string[],
    vas: string[],
    illustrators: string[] = [],
    scriptWriters: string[] = [],
    series: string[] = [],
    authors: string[] = [],
  ): Promise<void> => {
    const trx = await trxProvider();
    const getCount = (tableName: string, colName: string, colValue: string | null): Promise<number> => new Promise<number>((resolveCount, rejectCount) => {
      trx(tableName)
        .select(colName)
        .where(colName, '=', colValue)
        .count()
        .first()
        .then(res => res!['count(*)'] as number)
        .then(count => resolveCount(count))
        .catch(err => rejectCount(err));
    });

    // A mix of promises and (thenable) knex builders, awaited together below.
    const promises: Array<Promise<unknown> | Knex.QueryBuilder> = [];
    promises.push(new Promise<void>((resolveCircle, rejectCircle) => {
      getCount('t_work', 'circle_id', circle)
        .then((count) => {
          if (count === 0) {
            trx('t_circle')
              .del()
              .where('id', '=', circle)
              .then(() => resolveCircle())
              .catch(err => rejectCircle(err));
          } else {
            resolveCircle();
          }
        });
    }));

    for (let i = 0; i < tags.length; i += 1) {
      const tag = tags[i];
      const count = await getCount('r_tag_work', 'tag_id', tag);

      if (count === 0) {
        promises.push(
          trx('t_tag')
            .delete()
            .where('id', '=', tag),
        );
      }
    }

    for (let i = 0; i < vas.length; i += 1) {
      const va = vas[i];
      const count = await getCount('r_va_work', 'va_id', va);

      if (count === 0) {
        promises.push(
          trx('t_va')
            .delete()
            .where('id', '=', va),
        );
      }
    }

    for (let i = 0; i < illustrators.length; i += 1) {
      const illustrator = illustrators[i];
      const count = await getCount('r_illustrator_work', 'illustrator_id', illustrator);

      if (count === 0) {
        promises.push(
          trx('t_illustrator')
            .delete()
            .where('id', '=', illustrator),
        );
      }
    }

    for (let i = 0; i < scriptWriters.length; i += 1) {
      const sw = scriptWriters[i];
      const count = await getCount('r_script_writer_work', 'script_writer_id', sw);

      if (count === 0) {
        promises.push(
          trx('t_script_writer')
            .delete()
            .where('id', '=', sw),
        );
      }
    }

    for (let i = 0; i < series.length; i += 1) {
      const s = series[i];
      const count = await getCount('r_series_work', 'series_id', s);

      if (count === 0) {
        promises.push(
          trx('t_series')
            .delete()
            .where('id', '=', s),
        );
      }
    }

    for (let i = 0; i < authors.length; i += 1) {
      const a = authors[i];
      const count = await getCount('r_author_work', 'author_id', a);

      if (count === 0) {
        promises.push(
          trx('t_author')
            .delete()
            .where('id', '=', a),
        );
      }
    }

    await Promise.all(promises);
  };

  /**
   * Removes a work and then its orphaned circles, tags & VAs from the database.
   * @param id Work id.
   */
  const removeWork = async (id: string, trxProvider: TrxProvider): Promise<void> => {
    const trx = await trxProvider();
    // Save circle, tags, VAs, illustrators, script writers and series to array for later testing
      const circle: Pick<WorkRow, 'circle_id'> = await trx('t_work').select('circle_id').where('id', '=', id).first();
      const tags: Array<Pick<TagWorkRow, 'tag_id'>> = await trx('r_tag_work').select('tag_id').where('work_id', '=', id);
      const vas: Array<Pick<VaWorkRow, 'va_id'>> = await trx('r_va_work').select('va_id').where('work_id', '=', id);
      const illustrators: Array<Pick<IllustratorWorkRow, 'illustrator_id'>> = await trx('r_illustrator_work').select('illustrator_id').where('work_id', '=', id);
      const scriptWriters: Array<Pick<ScriptWriterWorkRow, 'script_writer_id'>> = await trx('r_script_writer_work').select('script_writer_id').where('work_id', '=', id);
      const series: Array<Pick<SeriesWorkRow, 'series_id'>> = await trx('r_series_work').select('series_id').where('work_id', '=', id);
      const authors: Array<Pick<AuthorWorkRow, 'author_id'>> = await trx('r_author_work').select('author_id').where('work_id', '=', id);

      await trx('t_play_history').del().where('work_id', '=', id);
      await trx('r_tag_work').del().where('work_id', '=', id);
      await trx('r_va_work').del().where('work_id', '=', id);
      await trx('r_illustrator_work').del().where('work_id', '=', id);
      await trx('r_script_writer_work').del().where('work_id', '=', id);
      await trx('r_series_work').del().where('work_id', '=', id);
      await trx('r_author_work').del().where('work_id', '=', id);
      await trx('t_dlsite_review').del().where('work_id', '=', id);
      await trx('t_review').del().where('work_id', '=', id);
      await trx('t_work').del().where('id', '=', id);
      await cleanupOrphans(
        trxProvider,
        circle.circle_id,
        tags.map(tag => tag.tag_id),
        vas.map(va => va.va_id),
        illustrators.map(i => i.illustrator_id),
        scriptWriters.map(s => s.script_writer_id),
        series.map(s => s.series_id),
        authors.map(a => a.author_id),
      );
  };

  /**
   * Returns a page of the whole library. Label filtering goes through
   * getWorksByFilter, which is the only filter mechanism.
   * @param opts.order - sort column; 'rating' for userRating; 'random'/'betterRandom'
   * @param opts.limit - page size; omit for all rows
   * @param opts.seed - shuffle seed for random order
   */
  const getWorksBy = async ({
    username = '', nsfw = 0, order = 'release', sort = 'desc', limit, offset, seed,
  }: WorksQueryOptions = {}): Promise<{ works: AssembledWorkRow[]; totalCount: Array<{ count: number }> }> => {
    // Build the core query (t_work ⋈ t_circle)
    let coreQ = knex('t_work')
      .join('t_circle', 't_circle.id', 't_work.circle_id')
      .select(
        't_work.id', 't_work.created_at', 't_work.updated_at',
        't_work.title', 't_work.circle_id', 't_circle.name',
        't_work.nsfw', 't_work.release',
        't_work.dl_count', 't_work.price', 't_work.review_count',
        't_work.rate_count', 't_work.rate_average_2dp',
        't_work.rate_count_detail', 't_work.rank');

    // Apply nsfw filter
    coreQ = nsfwFilter(nsfw, coreQ);

    // Compute totalCount (SQLite returns COUNT() as a number; knex's type
    // covers drivers that hand back a string)
    const countRow = await coreQ.clone().count('t_work.id as count').first();
    const totalCount = [{ count: countRow ? countRow.count as number : 0 }];

    // Handle special order modes
    let works: AssembledWorkRow[] = [];
    if (order === 'random') {
      const seedVal = seed || 7;
      const rows = await coreQ.clone()
        .orderBy(knex.raw('t_work.id % ?', seedVal))
        .limit(limit!)
        .offset(offset || 0);
      works = await assembleWorks(rows, { username });
    } else if (order === 'betterRandom') {
      const rows = await coreQ.clone()
        .orderBy(knex.raw('random()'))
        .limit(1);
      works = await assembleWorks(rows, { username });
    } else {
      // Standard ordering — may need userrate for 'rating' order
      let orderedQ = coreQ.clone();
      if (order === 'rating') {
        // LEFT JOIN userrate so unrated works still appear (with null rating)
        const userrateSub = knex('t_review')
          .select('work_id', 'rating as userRating')
          .where('user_name', username)
          .as('userrate');
        orderedQ = orderedQ
          .leftJoin(userrateSub, 'userrate.work_id', 't_work.id')
          .select('userrate.userRating')
          .orderBy('userRating', sort);
      } else {
        orderedQ = orderedQ.orderBy(`t_work.${order}`, sort);
      }
      orderedQ = orderedQ.orderBy([{ column: 't_work.release', order: 'desc' }, { column: 't_work.id', order: 'desc' }]);

      if (limit != null) {
        orderedQ = orderedQ.limit(limit).offset(offset || 0);
      }

      const rows = await orderedQ;

      // If we ordered by rating, userRating is already on the rows; assembleWorks passes it through
      works = await assembleWorks(rows, { username });

      // If userRating was selected via LEFT JOIN, it's already on the rows
      if (order !== 'rating') {
        // Batch-fetch user ratings for the page
        const ids = works.map(w => w.id);
        if (ids.length > 0) {
          const ratings: Array<{ work_id: string; userRating: number | null }> = await knex('t_review')
            .select('work_id', 'rating as userRating')
            .where('user_name', username)
            .whereIn('work_id', ids);
          const ratingMap = new Map(ratings.map(r => [r.work_id, r.userRating]));
          for (const w of works) {
            w.userRating = ratingMap.get(w.id) || null;
          }
        }
      }
    }

    return { works, totalCount };
  };

  /**
   * 根据关键字查询音声 (async, paged).
   * @param {Object} opts
   * @param {String} opts.filter
   * @param {String} [opts.username='admin']
   * @param {Number} [opts.nsfw=0]
   * @param {String} [opts.order='release']
   * @param {String} [opts.sort='desc']
   * @param {Number} [opts.limit]
   * @param {Number} [opts.offset]
   * @param {Number} [opts.seed]
   * @returns {Promise<{works: Object[], totalCount: Array<{count: number}>}>}
   */
  /**
   * Subquery selecting the ids of the labels in `table` whose name matches the
   * term. LIKE (not '=') even for an anchored term, so that matching stays
   * ASCII-case-insensitive the way substring matching already is.
   * @param table - 't_circle' | 't_tag' | ...
   */
  const labelIdsMatching = (table: string, term: Pick<SearchTerm, 'value' | 'exact'>) => knex(table).select('id')
    .where('name', 'like', term.exact ? term.value : `%${term.value}%`);

  /**
   * Restrict to one work id when the text looks like a Fanza cid or a DLsite
   * code (RJ123456 / BJ123456 / bare digits).
   *
   * A Fanza cid may be typed with or without the underscore — `d215444` is the
   * form to prefer in a search, since an unquoted `_` stands for a space (see
   * search-query.js) — and both canonicalize to the stored `d_215444`. The
   * underscore-free spelling is only recognised as a whole term, or a title
   * token such as `CD2` would be read as a work code; the underscore form
   * still matches as a substring, the way it always did (`d_215444.zip`). BJ
   * is checked before the bare-digit RJ fallback: the prefix is part of the
   * stored id and must not be discarded.
   * @returns whether a code was recognised (and a clause applied).
   */
  const applyWorkIdText = (qb: Knex.QueryBuilder, text: string): boolean => {
    const fanzaMatch = text.match(/^d_?(\d+)$/i) || text.match(/d_(\d+)/i);
    const booksMatch = text.match(/bj(\d{6,8})/i);
    const rjMatch = text.match(/(?:rj)?(\d{6,8})/i);
    if (fanzaMatch) {
      qb.where('t_work.id', '=', `d${fanzaMatch[1]}`);
    } else if (booksMatch) {
      qb.where('t_work.id', '=', `BJ${formatID(parseInt(booksMatch[1], 10))}`);
    } else if (rjMatch) {
      qb.where('t_work.id', '=', formatID(parseInt(rjMatch[1], 10)));
    } else {
      return false;
    }
    return true;
  };

  /**
   * Apply one parsed search term (see database/search-query.js) as a clause on
   * `qb`. Negation is handled by the caller, which wraps this in whereNot.
   * @param qb
   * @param term
   */
  const applySearchTerm = (qb: Knex.QueryBuilder, term: SearchTerm): void => {
    // A null field is the free-text term; it has no relation to look up.
    const relation = term.field === null ? undefined : RELATION_FIELDS[term.field];
    if (relation) {
      qb.whereIn('t_work.id', knex(relation.relTable).select('work_id')
        .whereIn(relation.key, labelIdsMatching(relation.nameTable, term)));
      return;
    }
    if (term.field === 'circle') {
      qb.whereIn('t_work.circle_id', labelIdsMatching('t_circle', term));
      return;
    }
    if (term.field === 'title') {
      qb.where('t_work.title', 'like', term.exact ? term.value : `%${term.value}%`);
      return;
    }
    if (term.field === 'id') {
      if (!applyWorkIdText(qb, term.raw)) qb.where('t_work.id', 'like', `%${term.raw}%`);
      return;
    }

    // No namespace: a work code, otherwise every metadata field at once
    if (applyWorkIdText(qb, term.raw)) return;

    const [tags, vas, illustrators, scriptWriters, series, authors] =
      (['tag', 'va', 'illustrator', 'script_writer', 'series', 'author'] as const).map((field) => {
        const rel = RELATION_FIELDS[field]!;
        return knex(rel.relTable).select('work_id')
          .whereIn(rel.key, labelIdsMatching(rel.nameTable, term));
      });

    qb.where('t_work.title', 'like', term.exact ? term.value : `%${term.value}%`)
      .orWhereIn('t_work.circle_id', labelIdsMatching('t_circle', term))
      .orWhereIn('t_work.id', tags.union([vas, illustrators, scriptWriters, series, authors]));
  };

  const getWorksByFilter = async ({
    filter, username = 'admin', nsfw = 0, order = 'release', sort = 'desc', limit, offset, seed,
  }: WorksFilterQueryOptions = {}): Promise<{ works: AssembledWorkRow[]; totalCount: Array<{ count: number }> }> => {
    let coreQ = knex('t_work')
      .join('t_circle', 't_circle.id', 't_work.circle_id')
      .select(
        't_work.id', 't_work.created_at', 't_work.updated_at',
        't_work.title', 't_work.circle_id', 't_circle.name',
        't_work.nsfw', 't_work.release',
        't_work.dl_count', 't_work.price', 't_work.review_count',
        't_work.rate_count', 't_work.rate_average_2dp',
        't_work.rate_count_detail', 't_work.rank');

    // Each parsed term is a separate, parenthesised AND clause, so the nsfw
    // filter below can never be swallowed by an OR group.
    for (const term of parseSearchQuery(filter)) {
      coreQ = term.negate
        ? coreQ.whereNot(function () { applySearchTerm(this, term); })
        : coreQ.where(function () { applySearchTerm(this, term); });
    }

    coreQ = nsfwFilter(nsfw, coreQ);

    const countRow = await coreQ.clone().count('t_work.id as count').first();
    const totalCount = [{ count: countRow ? countRow.count as number : 0 }];

    let works: AssembledWorkRow[] = [];
    if (order === 'random') {
      const seedVal = seed || 7;
      const rows = await coreQ.clone()
        .orderBy(knex.raw('t_work.id % ?', seedVal))
        .limit(limit!)
        .offset(offset || 0);
      works = await assembleWorks(rows, { username });
    } else {
      let orderedQ = coreQ.clone();
      if (order === 'rating') {
        const userrateSub = knex('t_review')
          .select('work_id', 'rating as userRating')
          .where('user_name', username)
          .as('userrate');
        orderedQ = orderedQ
          .leftJoin(userrateSub, 'userrate.work_id', 't_work.id')
          .select('userrate.userRating')
          .orderBy('userRating', sort);
      } else {
        orderedQ = orderedQ.orderBy(`t_work.${order}`, sort);
      }
      orderedQ = orderedQ.orderBy([{ column: 't_work.release', order: 'desc' }, { column: 't_work.id', order: 'desc' }]);

      if (limit != null) {
        orderedQ = orderedQ.limit(limit).offset(offset || 0);
      }

      const rows = await orderedQ;
      works = await assembleWorks(rows, { username });

      // Batch-fetch user ratings if not already joined
      if (order !== 'rating') {
        const ids = works.map(w => w.id);
        if (ids.length > 0) {
          const ratings: Array<{ work_id: string; userRating: number | null }> = await knex('t_review')
            .select('work_id', 'rating as userRating')
            .where('user_name', username)
            .whereIn('work_id', ids);
          const ratingMap = new Map(ratings.map(r => [r.work_id, r.userRating]));
          for (const w of works) {
            w.userRating = ratingMap.get(w.id) || null;
          }
        }
      }
    }

    return { works, totalCount };
  };

  /**
   * 获取所有社团/标签/声优的元数据列表
   * @param field ['circle', 'tag', 'va'] 中的一个
   */
  const getLabels = (field: string) => {
    if (field === 'circle') {
      return knex('t_work')
        .join(`t_${field}`, `${field}_id`, '=', `t_${field}.id`)
        .select(`t_${field}.id`, 'name')
        .groupBy(`${field}_id`)
        .count(`${field}_id as count`);
    } else if (['tag', 'va', 'illustrator', 'script_writer', 'series', 'author'].includes(field)) {
      const tableName = field === 'illustrator' || field === 'script_writer' || field === 'series' ? field : field;
      return knex(`r_${tableName}_work`)
        .join(`t_${tableName}`, `${tableName}_id`, '=', 'id')
        .select('id', 'name')
        .groupBy(`${tableName}_id`)
        .count(`${tableName}_id as count`);
    }
  };

  /**
   * 创建一个新用户
   */
  const createUser = (user: UserInput) => knex.transaction(trx => trx('t_user')
    .where('name', '=', user.name)
    .first()
    .then((res) => {
      if (res) {
        throw new Error(`用户 ${user.name} 已存在.`);
      }
      return trx('t_user')
        .insert(user);
    }));

  /**
   * 更新用户密码
   * @param newPassword new password
   *
   * Only the name is read, so the caller need not hold the other columns --
   * routes/credentials.ts passes `{ name }` from the request body.
   */
  const updateUserPassword = (user: Pick<UserInput, 'name'>, newPassword: string) => knex.transaction(trx => trx('t_user')
    .where('name', '=', user.name)
    .first()
    .then((res) => {
      if (!res) {
        throw new Error('用户名或密码错误.');
      }
      return trx('t_user')
        .where('name', '=', user.name)
        .update({
          password: newPassword
        });
    }));

  /**
   * 重置用户密码为 "password"
   */
  const resetUserPassword = (user: Pick<UserInput, 'name'>) => knex.transaction(trx => trx('t_user')
    .where('name', '=', user.name)
    .first()
    .then((res) => {
      if (!res) {
        throw new Error('用户名错误.');
      }
      return trx('t_user')
        .where('name', '=', user.name)
        .update({
          password: 'password'
        });
    }));

  /**
   * 删除用户
   */
  const deleteUser = (users: Array<Pick<UserInput, 'name'>>) => knex.transaction(trx => trx('t_user')
    .where('name', 'in', users.map(user => user.name))
    .del());

  // 添加星标或评语或进度
  // autoMark: when progressOnly=true, only writes/inserts progress='listened' if the
  // existing progress (if any) is not in the terminal set ('listened','replay','postponed').
  // This prevents auto-marking from overwriting an explicit user state.
  const updateUserReview = async (
    username: string,
    workid: string,
    rating: number | null,
    review_text = '',
    progress: string | null = '',
    starOnly = true,
    progressOnly = false,
    autoMark = false,
  ) => knex.transaction(async(trx) => {
      // UPSERT
      if (starOnly) {
        await trx.raw('UPDATE t_review SET rating = ?, updated_at = CURRENT_TIMESTAMP WHERE user_name = ? AND work_id = ?;', [rating, username, workid]);
        await trx.raw('INSERT OR IGNORE INTO t_review (user_name, work_id, rating) VALUES (?, ?, ?);', [username, workid, rating]);
      } else if (progressOnly && autoMark) {
        // Auto-mark: only write/insert 'listened' if terminal state is not set.
        const existing = await trx.raw('SELECT progress FROM t_review WHERE user_name = ? AND work_id = ?;', [username, workid]);
        const existingProgress = existing[0] ? existing[0].progress : null;
        const terminal = ['listened', 'replay', 'postponed'];
        if (existingProgress && terminal.includes(existingProgress)) {
          // No-op — user has explicitly set a terminal state, do not overwrite.
          return;
        }
        // Fall through to normal progressOnly upsert.
        await trx.raw('UPDATE t_review SET progress = ?, updated_at = CURRENT_TIMESTAMP WHERE user_name = ? AND work_id = ?;', [progress, username, workid]);
        await trx.raw('INSERT OR IGNORE INTO t_review (user_name, work_id, progress) VALUES (?, ?, ?);', [username, workid, progress]);
      } else if (progressOnly) {
        await trx.raw('UPDATE t_review SET progress = ?, updated_at = CURRENT_TIMESTAMP WHERE user_name = ? AND work_id = ?;', [progress, username, workid]);
        await trx.raw('INSERT OR IGNORE INTO t_review (user_name, work_id, progress) VALUES (?, ?, ?);', [username, workid, progress]);
      } else {
        await trx.raw('UPDATE t_review SET rating = ?, review_text = ?, progress = ?, updated_at = CURRENT_TIMESTAMP WHERE user_name = ? AND work_id = ?;', [rating, review_text, progress, username, workid]);
        await trx.raw('INSERT OR IGNORE INTO t_review (user_name, work_id, rating, review_text, progress) VALUES (?, ?, ?, ?, ?);', [username, workid, rating, review_text, progress]);
      }
  });

  // 删除星标、评语及进度
  const deleteUserReview = (username: string, workid: string) => knex.transaction(trx => trx('t_review')
    .where('user_name', '=', username)
    .andWhere('work_id', '=', workid)
    .del());

  // 只清除进度（progress），保留评分与评论。
  // 如果该行除 progress 外没有评分也没有评论（例如仅由自动标记创建的 rating-null 行），
  // 则整行删除，避免留下全 NULL 的空行。
  // 没有对应行时为 no-op。
  const resetUserProgress = async (username: string, workid: string) => knex.transaction(async (trx) => {
    const rows: Array<{ rating: number | null; review_text: string | null }> =
      await trx.raw('SELECT rating, review_text FROM t_review WHERE user_name = ? AND work_id = ?;', [username, workid]);
    const row = rows[0];
    if (!row) return; // 无行可清
    const hasRating = row.rating !== null && row.rating !== undefined;
    const hasReview = row.review_text !== null && row.review_text !== '';
    if (!hasRating && !hasReview) {
      // 没有评分/评论可保留，整行删除
      await trx.raw('DELETE FROM t_review WHERE user_name = ? AND work_id = ?;', [username, workid]);
    } else {
      await trx.raw('UPDATE t_review SET progress = NULL, updated_at = CURRENT_TIMESTAMP WHERE user_name = ? AND work_id = ?;', [username, workid]);
    }
  });

  // 读取星标及评语 + 作品元数据
  const getWorksWithReviews = async ({
    username = '', limit = 1000, offset = 0, orderBy = 'release', sortOption = 'desc', filter,
  }: WorksWithReviewsOptions = {}): Promise<{ works: AssembledWorkRow[]; totalCount: Array<{ count: number }> }> => {
    let coreQ = knex('t_work')
      .join('t_review', function() {
        this.on('t_review.work_id', '=', 't_work.id')
          .andOn('t_review.user_name', '=', knex.raw('?', [username]));
      })
      .join('t_circle', 't_circle.id', 't_work.circle_id')
      .select(
        't_work.id', 't_work.created_at', 't_work.updated_at',
        't_work.title', 't_work.circle_id', 't_circle.name',
        't_work.nsfw', 't_work.release',
        't_work.dl_count', 't_work.price', 't_work.review_count',
        't_work.rate_count', 't_work.rate_average_2dp',
        't_work.rate_count_detail', 't_work.rank',
        't_review.rating as userRating', 't_review.review_text',
        't_review.progress',
        knex.raw("strftime('%Y-%m-%d %H-%M-%S', t_review.updated_at, 'localtime') AS updated_at"),
        't_review.user_name');

    if (filter) {
      coreQ = coreQ.where('t_review.progress', filter);
    }

    // Order by
    // 'userRating' is what the Favourites page sends as its sort option key;
    // 'rating' is the value used elsewhere (e.g. getWorksBy). Treat both as
    // the user's review rating, which lives on t_review (aliased as userRating).
    let orderCol: string;
    if (orderBy === 'rating' || orderBy === 'userRating') {
      orderCol = 't_review.rating';
    } else {
      orderCol = `t_work.${orderBy}`;
    }
    coreQ = coreQ.orderBy(orderCol, sortOption)
      .orderBy([{ column: 't_work.release', order: 'desc' }, { column: 't_work.id', order: 'desc' }]);

    // Compute totalCount
    const countRow = await coreQ.clone().count('t_work.id as count').first();
    const totalCount = [{ count: countRow ? countRow.count as number : 0 }];

    const rows: WorkListRow[] = await coreQ.clone().limit(limit).offset(offset);
    const works = await assembleWorks(rows, { username });

    return {works, totalCount};
  };

  const getPlayHistory = async ({
    username = '', sortOption = 'desc', limit = 1000, offset = 0, excludeFinished = 'listened',
  }: PlayHistoryQueryOptions = {}): Promise<{ works: AssembledWorkRow[]; totalCount: Array<{ count: number }> }> => {
    let coreQ = knex('t_work')
      .join('t_play_history', function() {
        this.on('t_play_history.work_id', '=', 't_work.id')
          .andOn('t_play_history.user_name', '=', knex.raw('?', [username]));
      })
      .join('t_circle', 't_circle.id', 't_work.circle_id')
      .leftJoin('t_review', function() {
        this.on('t_review.work_id', '=', 't_work.id')
          .andOn('t_review.user_name', '=', knex.raw('?', [username]));
      })
      .select(
        't_work.id', 't_work.created_at', 't_work.updated_at',
        't_work.title', 't_work.circle_id', 't_circle.name',
        't_work.nsfw', 't_work.release',
        't_work.dl_count', 't_work.price', 't_work.review_count',
        't_work.rate_count', 't_work.rate_average_2dp',
        't_work.rate_count_detail', 't_work.rank',
        't_play_history.state', 't_play_history.updated_at as play_updated_at',
        't_review.progress')
      .orderBy('t_play_history.updated_at', sortOption);

    if (excludeFinished === 'listened') {
      coreQ = coreQ.where(function() {
        this.whereNull('t_review.progress').orWhere('t_review.progress', '!=', 'listened');
      });
    }

    const countRow = await coreQ.clone().count('t_work.id as count').first();
    const totalCount = [{ count: countRow ? countRow.count as number : 0 }];

    const rows: HistoryListRow[] = await coreQ.clone().limit(limit).offset(offset);
    await applyTrackProgressSeconds(username, rows);
    // No reviewFields: the hide-finished filter is applied server-side above, and
    // t_review.progress is already spread into each work item via the LEFT JOIN
    // select. Passing reviewFields would run an extra t_review query and populate
    // userRating/review_text, which would make star ratings appear in the history
    // list — an unintended UI change.
    const works = await assembleWorks(rows, { username });

    return {works, totalCount};
  };

  const updatePlayHistory = async (username: string, work_id: string, state: string) => knex.transaction(async(trx) => {
    await trx.raw('INSERT OR IGNORE INTO t_play_history (user_name, work_id, state) VALUES (?, ?, ?);', [username, work_id, state]);
    await trx.raw('UPDATE t_play_history SET state = ?, updated_at = CURRENT_TIMESTAMP WHERE user_name = ? AND work_id = ?;', [state, username, work_id]);
  });

  async function deletePlayHistory(username: string, work_id: string): Promise<void> {
    await knex('t_play_history').where('work_id', '=', work_id).where('user_name', '=', username).del();
  }

  const getMetadata = ({field = 'circle', id}: { field?: string; id: string }) => {
    const validFields = ['circle', 'tag', 'va', 'illustrator', 'script_writer', 'series', 'author'];
    if (!validFields.includes(field)) throw new Error('无效的查询域');
    return knex(`t_${field}`)
      .select('*')
      .where('id', '=', id)
      .first();
  };

  /**
   * Reads the scraped work-page extras: description, per-part description
   * structure (incl. the track list) and the sample image list.
   * @returns { description, descriptionParts, sampleImages } or null
   */
  async function getWorkExtras(work_id: string): Promise<{ description: string; descriptionParts: DescriptionPart[]; sampleImages: SampleImage[] } | null> {
    const row = await knex('t_work')
      .select('description', 'description_parts', 'sample_images')
      .where('id', '=', work_id)
      .first();

    if (!row) return null;

    return {
      description: row.description || '',
      descriptionParts: parseJsonColumn<DescriptionPart[]>(row.description_parts),
      sampleImages: parseJsonColumn<SampleImage[]>(row.sample_images),
    };
  }

  /**
   * Overwrites the stored sample image list. Used by the scanner to record
   * which images actually made it to disk (the `file` field).
   * @param work_id
   * @param sampleImages
   */
  async function setWorkSampleImages(work_id: string, sampleImages: SampleImage[]): Promise<void> {
    await knex('t_work')
      .where('id', '=', work_id)
      .update({ sample_images: JSON.stringify(sampleImages || []) });
  }

  /**
   * Replaces every stored DLsite review of a work with the scraped set.
   *
   * Replace rather than merge: DLsite lets reviewers edit and delete, so a
   * merge would keep stale text around forever. Reviews carry no local state,
   * so nothing is lost by rewriting them.
   * @param work_id
   * @param reviews Normalized reviews from scrapeWorkReviewsFromDLsite.
   */
  const replaceWorkDlsiteReviews = async (work_id: string, reviews: DlsiteReview[]) => knex.transaction(async (trx) => {
    await trx('t_dlsite_review').where('work_id', work_id).del();
    if (!reviews || !reviews.length) return;

    const rows = reviews.map(review => ({
      id: review.id,
      work_id,
      reviewer_id: review.reviewerId,
      reviewer_name: review.reviewerName,
      rate: review.rate,
      review_title: review.title,
      review_text: review.text,
      spoiler: review.spoiler,
      recommend: review.recommend,
      is_purchased: review.isPurchased,
      good_review: review.goodReview,
      bad_review: review.badReview,
      genres: JSON.stringify(review.genres || []),
      entry_date: review.entryDate,
      regist_date: review.registDate,
    }));

    // Chunked: SQLite caps a statement at 999 bound parameters by default and
    // a popular work can carry hundreds of reviews.
    await trx.batchInsert('t_dlsite_review', rows, 50);
  });

  /**
   * Reads a work's stored DLsite reviews, newest first.
   * @param work_id
   */
  async function getWorkDlsiteReviews(work_id: string): Promise<Array<Omit<DlsiteReviewRow, 'genres'> & { genres: ReviewGenre[] }>> {
    const rows: DlsiteReviewRow[] = await knex('t_dlsite_review')
      .select('*')
      .where('work_id', '=', work_id)
      .orderBy('regist_date', 'desc');

    return rows.map((row) => {
      let genres: ReviewGenre[] = [];
      try {
        genres = row.genres ? JSON.parse(row.genres) : [];
      } catch {
        genres = [];
      }
      return { ...row, genres };
    });
  }

  // t_work_file: a work's local file tree
  // Written only by the scan paths (see filesystem/workFiles.js).
  const getWorkFiles = async (work_id: string): Promise<Array<Pick<WorkFileRow, 'rel_path' | 'duration' | 'mtime' | 'track_title'>>> => {
    const rows: Array<Pick<WorkFileRow, 'rel_path' | 'duration' | 'mtime' | 'track_title'>> =
      await knex('t_work_file')
        .select('rel_path', 'duration', 'mtime', 'track_title')
        .where('work_id', String(work_id));
    return rows;
  };

  /**
   * Replace a work's file rows and stamp files_indexed_at
   */
  const replaceWorkFiles = async (work_id: string, rows: WorkFileWriteRow[]): Promise<void> => {
    await knex.transaction(async (trx) => {
      await trx('t_work_file').where('work_id', String(work_id)).del();
      // Chunked: SQLite caps bound parameters per statement, and a 472-file
      // work times five columns gets close enough to matter.
      for (let i = 0; i < rows.length; i += 100) {
        await trx('t_work_file').insert(rows.slice(i, i + 100));
      }
      await trx('t_work').where('id', String(work_id)).update({ files_indexed_at: knex.fn.now() });
    });
  };

  /**
   * Set display names on existing rows, by relPath. Used by
   * scripts/extract-track-titles.js -- a targeted update rather than
   * replaceWorkFiles, which would drop rows the extractor never looked at.
   * @param titles { relPath: title }
   * @returns rows actually updated
   */
  const setTrackTitles = async (work_id: string, titles: Record<string, string | null>): Promise<number> => {
    let updated = 0;
    for (const [relPath, title] of Object.entries(titles || {})) {
      updated += await knex('t_work_file')
        .where({ work_id: String(work_id), rel_path: relPath })
        .update({ track_title: title });
    }
    return updated;
  };

  // t_track_progress queries
  const getTrackProgress = async (username: string, work_id: string): Promise<Record<string, TrackProgressHit>> => {
    const byKey = await trackProgressFor(username, { workId: work_id });
    const map: Record<string, TrackProgressHit> = {};
    for (const [key, hit] of byKey) {
      // key is `${workId}\u0000${relPath}`; the client wants it keyed by trackId.
      map[key.replace('\u0000', '/')] = hit;
    }
    return map;
  };

  /**
   * SQLite's own CURRENT_TIMESTAMP format: UTC, second resolution, as text.
   *
   * Changing this to other formats would need a db migration.
   */
  const utcStamp = (ms: number): string => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

  /**
   * Write a track's position, newest observation wins.
   */
  const upsertTrackProgress = async (
    username: string,
    work_id: string,
    track_key: string,
    seconds: number,
    completed: boolean,
    observedAt?: number,
  ): Promise<void> => {
    const stamp = utcStamp(observedAt || Date.now());
    await knex.raw(`
      INSERT INTO t_track_progress (user_name, work_id, track_key, seconds, completed, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_name, work_id, track_key)
      DO UPDATE SET seconds = excluded.seconds, completed = excluded.completed, updated_at = excluded.updated_at
      WHERE excluded.updated_at >= t_track_progress.updated_at
    `, [username, work_id, track_key, seconds, completed, stamp]);
  };

  return {
    nsfwFilter,
    resolveLabel, resolveTagLabel,
    insertWorkMetadata, getWorkMetadata, removeWork, getWorksBy, getWorksByFilter, updateWorkMetadata,
    editWorkMetadata,
    getLabels, getMetadata,
    createUser, updateUserPassword, resetUserPassword, deleteUser,
    getWorksWithReviews, updateUserReview, deleteUserReview, resetUserProgress,
    getPlayHistory, updatePlayHistory, deletePlayHistory,
    getWorkExtras, setWorkSampleImages,
    replaceWorkDlsiteReviews, getWorkDlsiteReviews,
    getTrackProgress, upsertTrackProgress,
    // Exported for the projection-agreement test: it and getTrackProgress are
    // two shapes over trackProgressFor and must never disagree.
    applyTrackProgressSeconds,
    getWorkFiles, replaceWorkFiles, setTrackTitles,
  };
};

export { makeQueries };