// @ts-nocheck
export const up = async function(knex) {
    await knex.schema.alterTable('t_work', function(table) {
       table.json('memo');
    });
    await knex.raw("UPDATE t_work SET memo = '{}';");
  };
  
  export const down = async function(knex) {
    await knex.schema.alterTable('t_work', function(table) {
      table.dropColumn('memo');
    });
  };
  