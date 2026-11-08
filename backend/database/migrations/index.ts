// @ts-nocheck
// Migration manifest.
//
// knex_migrations rows written by the CommonJS version of this app hold the
// ORIGINAL `.js` filenames, so the manifest reports those names verbatim (see
// database/knex-migrate.ts, which feeds this list to knex as a custom
// migrationSource). The files themselves are `.ts` now; only the reported
// name keeps the old spelling, so an existing database never re-runs a
// migration and upstream databases stay compatible in both directions.
//
// The list is static on purpose: a bundler can inline it (no directory scan at
// runtime), and adding an upstream migration means adding one `.ts` file plus
// one entry here.

import type { Knex } from 'knex';

import * as migration_20210105232420_fix_duplicate_title from './20210105232420_fix_duplicate_title.ts';
import * as migration_20210106013350_create_t_review from './20210106013350_create_t_review.ts';
import * as migration_20210108093032_alter_t_reviews from './20210108093032_alter_t_reviews.ts';
import * as migration_20210115014202_add_on_delete_cascade from './20210115014202_add_on_delete_cascade.ts';
import * as migration_20210206135836_drop_t_favorite from './20210206135836_drop_t_favorite.ts';
import * as migration_20210206141840_drop_not_null_constraints from './20210206141840_drop_not_null_constraints.ts';
import * as migration_20210213224539_alter_t_va from './20210213224539_alter_t_va.ts';
import * as migration_20210213233544_fill_va_uuid from './20210213233544_fill_va_uuid.ts';
import * as migration_20210223200240_drop_not_null_constraints from './20210223200240_drop_not_null_constraints.ts';
import * as migration_20210301141407_fix_title_redundant_chars from './20210301141407_fix_title_redundant_chars.ts';
import * as migration_20210304101412_fix_view_userMetatdata from './20210304101412_fix_view_userMetatdata.ts';
import * as migration_20210305161906_remove_ddl_from_review_api from './20210305161906_remove_ddl_from_review_api.ts';
import * as migration_20210307061415_refactor_queries from './20210307061415_refactor_queries.ts';
import * as migration_20210502081522_remove_obsolete_view from './20210502081522_remove_obsolete_view.ts';
import * as migration_20221231013326_timestamp_for_work from './20221231013326_timestamp_for_work.ts';
import * as migration_20230730170219_play_histroy from './20230730170219_play_histroy.ts';
import * as migration_20231201003918_work_file_memo from './20231201003918_work_file_memo.ts';
import * as migration_20260725000001_remove_lyric_status from './20260725000001_remove_lyric_status.ts';
import * as migration_20260731075621_add_illustrator_script_writer_series from './20260731075621_add_illustrator_script_writer_series.ts';
import * as migration_20260801000000_drop_staticmetadata_view from './20260801000000_drop_staticmetadata_view.ts';
import * as migration_20260802000000_text_ids_and_uuid_labels from './20260802000000_text_ids_and_uuid_labels.ts';
import * as migration_20260803000000_track_progress from './20260803000000_track_progress.ts';
import * as migration_20260804000000_rename_play_histroy_to_history from './20260804000000_rename_play_histroy_to_history.ts';
import * as migration_20260808000000_session_table from './20260808000000_session_table.ts';
import * as migration_20260814000000_merge_va_aliases from './20260814000000_merge_va_aliases.ts';
import * as migration_20260824000000_work_extras from './20260824000000_work_extras.ts';
import * as migration_20260825000000_merge_tag_aliases from './20260825000000_merge_tag_aliases.ts';
import * as migration_20260828000000_canonical_fanza_id from './20260828000000_canonical_fanza_id.ts';
import * as migration_20260831000000_index_label_names from './20260831000000_index_label_names.ts';
import * as migration_20260912000000_relpath_track_keys from './20260912000000_relpath_track_keys.ts';
import * as migration_20260913000000_work_file_table from './20260913000000_work_file_table.ts';
import * as migration_20260914000000_drop_work_memo from './20260914000000_drop_work_memo.ts';
import * as migration_20260915000000_restore_work_circle_fk from './20260915000000_restore_work_circle_fk.ts';
import * as migration_20260915000001_merge_va_aliases_kotone from './20260915000001_merge_va_aliases_kotone.ts';

export type MigrationEntry = {
  name: string;
  up: (knex: Knex) => Promise<unknown>;
  down?: (knex: Knex) => Promise<unknown>;
};

// Sorted by filename, the order knex expects.
const migrations: MigrationEntry[] = [
  { name: '20210105232420_fix_duplicate_title.js', up: migration_20210105232420_fix_duplicate_title.up, down: migration_20210105232420_fix_duplicate_title.down },
  { name: '20210106013350_create_t_review.js', up: migration_20210106013350_create_t_review.up, down: migration_20210106013350_create_t_review.down },
  { name: '20210108093032_alter_t_reviews.js', up: migration_20210108093032_alter_t_reviews.up, down: migration_20210108093032_alter_t_reviews.down },
  { name: '20210115014202_add_on_delete_cascade.js', up: migration_20210115014202_add_on_delete_cascade.up, down: migration_20210115014202_add_on_delete_cascade.down },
  { name: '20210206135836_drop_t_favorite.js', up: migration_20210206135836_drop_t_favorite.up, down: migration_20210206135836_drop_t_favorite.down },
  { name: '20210206141840_drop_not_null_constraints.js', up: migration_20210206141840_drop_not_null_constraints.up, down: migration_20210206141840_drop_not_null_constraints.down },
  { name: '20210213224539_alter_t_va.js', up: migration_20210213224539_alter_t_va.up, down: migration_20210213224539_alter_t_va.down },
  { name: '20210213233544_fill_va_uuid.js', up: migration_20210213233544_fill_va_uuid.up, down: migration_20210213233544_fill_va_uuid.down },
  { name: '20210223200240_drop_not_null_constraints.js', up: migration_20210223200240_drop_not_null_constraints.up, down: migration_20210223200240_drop_not_null_constraints.down },
  { name: '20210301141407_fix_title_redundant_chars.js', up: migration_20210301141407_fix_title_redundant_chars.up, down: migration_20210301141407_fix_title_redundant_chars.down },
  { name: '20210304101412_fix_view_userMetatdata.js', up: migration_20210304101412_fix_view_userMetatdata.up, down: migration_20210304101412_fix_view_userMetatdata.down },
  { name: '20210305161906_remove_ddl_from_review_api.js', up: migration_20210305161906_remove_ddl_from_review_api.up, down: migration_20210305161906_remove_ddl_from_review_api.down },
  { name: '20210307061415_refactor_queries.js', up: migration_20210307061415_refactor_queries.up, down: migration_20210307061415_refactor_queries.down },
  { name: '20210502081522_remove_obsolete_view.js', up: migration_20210502081522_remove_obsolete_view.up, down: migration_20210502081522_remove_obsolete_view.down },
  { name: '20221231013326_timestamp_for_work.js', up: migration_20221231013326_timestamp_for_work.up, down: migration_20221231013326_timestamp_for_work.down },
  { name: '20230730170219_play_histroy.js', up: migration_20230730170219_play_histroy.up, down: migration_20230730170219_play_histroy.down },
  { name: '20231201003918_work_file_memo.js', up: migration_20231201003918_work_file_memo.up, down: migration_20231201003918_work_file_memo.down },
  { name: '20260725000001_remove_lyric_status.js', up: migration_20260725000001_remove_lyric_status.up, down: migration_20260725000001_remove_lyric_status.down },
  { name: '20260731075621_add_illustrator_script_writer_series.js', up: migration_20260731075621_add_illustrator_script_writer_series.up, down: migration_20260731075621_add_illustrator_script_writer_series.down },
  { name: '20260801000000_drop_staticmetadata_view.js', up: migration_20260801000000_drop_staticmetadata_view.up, down: migration_20260801000000_drop_staticmetadata_view.down },
  { name: '20260802000000_text_ids_and_uuid_labels.js', up: migration_20260802000000_text_ids_and_uuid_labels.up, down: migration_20260802000000_text_ids_and_uuid_labels.down },
  { name: '20260803000000_track_progress.js', up: migration_20260803000000_track_progress.up, down: migration_20260803000000_track_progress.down },
  { name: '20260804000000_rename_play_histroy_to_history.js', up: migration_20260804000000_rename_play_histroy_to_history.up, down: migration_20260804000000_rename_play_histroy_to_history.down },
  { name: '20260808000000_session_table.js', up: migration_20260808000000_session_table.up, down: migration_20260808000000_session_table.down },
  { name: '20260814000000_merge_va_aliases.js', up: migration_20260814000000_merge_va_aliases.up, down: migration_20260814000000_merge_va_aliases.down },
  { name: '20260824000000_work_extras.js', up: migration_20260824000000_work_extras.up, down: migration_20260824000000_work_extras.down },
  { name: '20260825000000_merge_tag_aliases.js', up: migration_20260825000000_merge_tag_aliases.up, down: migration_20260825000000_merge_tag_aliases.down },
  { name: '20260828000000_canonical_fanza_id.js', up: migration_20260828000000_canonical_fanza_id.up, down: migration_20260828000000_canonical_fanza_id.down },
  { name: '20260831000000_index_label_names.js', up: migration_20260831000000_index_label_names.up, down: migration_20260831000000_index_label_names.down },
  { name: '20260912000000_relpath_track_keys.js', up: migration_20260912000000_relpath_track_keys.up, down: migration_20260912000000_relpath_track_keys.down },
  { name: '20260913000000_work_file_table.js', up: migration_20260913000000_work_file_table.up, down: migration_20260913000000_work_file_table.down },
  { name: '20260914000000_drop_work_memo.js', up: migration_20260914000000_drop_work_memo.up, down: migration_20260914000000_drop_work_memo.down },
  { name: '20260915000000_restore_work_circle_fk.js', up: migration_20260915000000_restore_work_circle_fk.up, down: migration_20260915000000_restore_work_circle_fk.down },
  { name: '20260915000001_merge_va_aliases_kotone.js', up: migration_20260915000001_merge_va_aliases_kotone.up, down: migration_20260915000001_merge_va_aliases_kotone.down },
];

export default migrations;
