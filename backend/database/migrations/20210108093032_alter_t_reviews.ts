import type { Knex } from 'knex';

export const up = async (knex: Knex): Promise<void> => {
  await knex.schema.alterTable('t_review', function(table) {
    table.string('progress'); // add column ['marked', 'listening', 'listened', 'postponed', null]
  });
};

export const down = async (knex: Knex): Promise<void> => {
  await knex.schema.alterTable('t_review', function(table) {
    table.dropColumn('progress'); // drop column progress
  });
};
