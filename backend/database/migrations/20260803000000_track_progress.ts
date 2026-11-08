import type { Knex } from 'knex';

export const up = async (knex: Knex): Promise<void> => {
  const exists = await knex.schema.hasTable('t_track_progress');
  if (!exists) {
    await knex.schema.createTable('t_track_progress', (table) => {
      table.string('user_name').notNullable();
      table.string('work_id').notNullable();
      table.string('track_key').notNullable(); // CRC32 hex
      table.float('seconds').notNullable().defaultTo(0);
      table.boolean('completed').notNullable().defaultTo(false);
      table.timestamps(true, true);

      table.foreign('user_name').references('name').inTable('t_user').onDelete('CASCADE');
      table.foreign('work_id').references('id').inTable('t_work').onDelete('CASCADE');
      table.primary(['user_name', 'work_id', 'track_key']);
    });
  }
};

export const down = async (knex: Knex): Promise<void> => {
  await knex.schema.dropTableIfExists('t_track_progress');
};