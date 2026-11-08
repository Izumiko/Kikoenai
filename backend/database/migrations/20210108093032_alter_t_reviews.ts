// @ts-nocheck
export const up = async function(knex) {
  await knex.schema.alterTable('t_review', function(table) {
    table.string('progress'); // add column ['marked', 'listening', 'listened', 'postponed', null]
  });
};

export const down = async function(knex) {
  await knex.schema.alterTable('t_review', function(table) {
    table.dropColumn('progress'); // drop column progress
  });
};
