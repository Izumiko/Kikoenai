import type { Knex } from 'knex';

/**
 * Fanza work ids lose their underscore: `d_215444` → `d215444`.
 *
 * The search syntax added in this release reads an unquoted `_` as a space
 * (`circle:underscore_name`), which made the stored spelling impossible to
 * type as a plain search term. `d215444` is now the canonical id everywhere in
 * the app — database, API, URLs, frontend. Fanza's own form survives only
 * where it is somebody else's format: DMM URLs, and the cover/image file names
 * already on disk (which is why this migration touches no files).
 *
 * Old `/work/d_215444` URLs keep working: the work-id validators sanitize the
 * underscore away on every route (see routes/utils/validate.js).
 */

// Every column holding a work id. t_work.id is the PK the rest point at.
const WORK_ID_COLUMNS = [
  ['t_work', 'id'],
  ['r_tag_work', 'work_id'],
  ['r_va_work', 'work_id'],
  ['r_illustrator_work', 'work_id'],
  ['r_script_writer_work', 'work_id'],
  ['r_series_work', 'work_id'],
  ['r_author_work', 'work_id'],
  ['t_review', 'work_id'],
  ['t_play_history', 'work_id'],
  ['t_track_progress', 'work_id'],
  ['t_dlsite_review', 'work_id'],
];

/**
 * @param {import('knex').Knex} knex
 * @param {String} from - prefix to strip ('d_' or 'd')
 * @param {String} to - prefix to write in its place
 */
const reprefix = async (knex: Knex, from: string, to: string): Promise<void> => {
  // Foreign keys are ON in the app's knex config; t_work.id has to move before
  // the rows referencing it, and both halves have to land in one transaction.
  await knex.raw('PRAGMA foreign_keys=off');
  try {
    await knex.transaction(async (trx) => {
      for (const [table, column] of WORK_ID_COLUMNS) {
        if (!(await trx.schema.hasTable(table))) continue;
        // whereRaw rather than `.where(raw, value)`: both compile to the same
        // SQL and bindings (verified), but knex's typings stop accepting a raw
        // update value after the Raw-first `.where` overload.
        const updated = await trx(table)
          .whereRaw('substr(??, 1, ?) = ?', [column, from.length, from])
          .update({ [column]: trx.raw("? || substr(??, ?)", [to, column, from.length + 1]) });
        if (updated) console.log(`  ${table}.${column}: ${updated} Fanza id(s) rewritten`);
      }
    });
  } finally {
    await knex.raw('PRAGMA foreign_keys=on');
  }
};

export const up = (knex: Knex): Promise<void> => reprefix(knex, 'd_', 'd');

export const down = (knex: Knex): Promise<void> => reprefix(knex, 'd', 'd_');
