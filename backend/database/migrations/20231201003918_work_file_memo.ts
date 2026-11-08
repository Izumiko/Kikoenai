import type { Knex } from 'knex';

export const up = async (knex: Knex): Promise<void> => {
    await knex.schema.alterTable('t_work', function(table) {
       table.json('memo');
    });
    await knex.raw("UPDATE t_work SET memo = '{}';");
  };
  
  export const down = async (knex: Knex): Promise<void> => {
    await knex.schema.alterTable('t_work', function(table) {
      table.dropColumn('memo');
    });
  };
  