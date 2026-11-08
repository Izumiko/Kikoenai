import type { Knex } from 'knex';

export const up = async (knex: Knex): Promise<void> => {
  // Idempotent: only rename if the old table still exists (fresh DBs already
  // have t_play_history via createSchema, so this is a no-op for them).
  const exists = await knex.schema.hasTable('t_play_histroy');
  if (exists) {
    await knex.raw('ALTER TABLE t_play_histroy RENAME TO t_play_history;');
  }
};

export const down = async (knex: Knex): Promise<void> => {
  const exists = await knex.schema.hasTable('t_play_history');
  if (exists) {
    await knex.raw('ALTER TABLE t_play_history RENAME TO t_play_histroy;');
  }
};