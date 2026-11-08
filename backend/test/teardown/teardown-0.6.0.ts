// @ts-nocheck

import { knex } from '../../database/db.ts';

const dropDatabase = async () => {
 await knex.schema.raw('DROP TABLE IF EXISTS knex_migrations');
 await knex.schema.raw('DROP TABLE IF EXISTS t_circle');
 await knex.schema.raw('DROP TABLE IF EXISTS t_tag');
 await knex.schema.raw('DROP TABLE IF EXISTS r_tag_work');
 await knex.schema.raw('DROP TABLE IF EXISTS t_user');
 await knex.schema.raw('DROP TABLE IF EXISTS t_review');
 await knex.schema.raw('DROP TABLE IF EXISTS t_va');
 await knex.schema.raw('DROP TABLE IF EXISTS r_va_work');
 await knex.schema.raw('DROP TABLE IF EXISTS t_work');
 await knex.schema.raw('DROP TABLE IF EXISTS t_work');
 await knex.schema.raw('DROP VIEW IF EXISTS userMetadata');
 await knex.schema.raw('DROP VIEW IF EXISTS staticMetadata');
};

export { dropDatabase };
  