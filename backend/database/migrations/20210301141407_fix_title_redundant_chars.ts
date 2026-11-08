// Issue #29
import type { Knex } from 'knex';

export const up = async (knex: Knex): Promise<void> => {
  const fixTitle = (title: string): string => {
    const pattern = /(円|日元)$/u;
    return title.replace(pattern, '');
  };

  const records = await knex('t_work').select('id', 'title');
  try {
    for (const item of records) {
      const oldTitle = item['title'];
      const newTitle = fixTitle(oldTitle);
      await knex('t_work').update('title', newTitle).where('id', item['id']);
    }
  } catch (err) {
    console.error(err);
    throw err;
  }
};

// Cannot be reverted
 
export const down = async (knex: Knex): Promise<void> => {

};
