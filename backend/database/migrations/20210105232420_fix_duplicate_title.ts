import type { Knex } from 'knex';

export const up = async (knex: Knex): Promise<void> => {
  await knex.raw(`UPDATE t_work SET title = trim(substr(title, 1, length(title)/2 + 1), X'0A' || ' ')
    WHERE trim(substr(title, 1, length(title)/2 + 1), X'0A' || ' ') = 
    trim(substr(title, length(title)/2 + 2, length(title)), X'0A' || ' ');`)
    .catch(err => console.error(err));
};

export const down = async (): Promise<void> => {
  // Do nothing
};