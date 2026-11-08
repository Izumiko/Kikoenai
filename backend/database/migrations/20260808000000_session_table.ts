import type { Knex } from 'knex';

export const up = async (knex: Knex): Promise<void> => {
  const exists = await knex.schema.hasTable('t_session');
  if (!exists) {
    await knex.schema.createTable('t_session', (table) => {
      table.string('id').notNullable(); // sha256 of the session secret, never the secret itself
      table.string('user_name').notNullable();
      // Epoch milliseconds, not a datetime column: knex's sqlite3 dialect does not
      // serialize Date objects consistently, so an integer keeps `where expires_at > ?`
      // unambiguous.
      table.bigInteger('expires_at').notNullable();
      table.timestamps(true, true);

      table.foreign('user_name').references('name').inTable('t_user').onDelete('CASCADE');
      table.primary(['id']);
      table.index('expires_at');
    });
  }
};

export const down = async (knex: Knex): Promise<void> => {
  await knex.schema.dropTableIfExists('t_session');
};
