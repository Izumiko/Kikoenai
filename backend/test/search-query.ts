// Advanced search syntax: parser unit tests + end-to-end query behaviour

// Env (FREEZE_CONFIG_FILE, NODE_ENV) comes from test/setup-env.ts, preloaded via --import.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import knexLib, { type Knex } from 'knex';

import { parseSearchQuery, formatSearchTerm, formatSearchQuery } from '../database/search-query.ts';
import type { SearchTerm } from '../database/search-query.ts';
import { makeQueries } from '../database/queries.ts';
import Client_NodeSQLite from '../database/node-sqlite-client.ts';
import { nameToUUID } from '../scraper/utils.ts';

describe('parseSearchQuery()', function () {
  it('splits a bare query into free-text terms', function () {
    assert.deepEqual(parseSearchQuery('foo bar'), [
      { field: null, value: 'foo', raw: 'foo', exact: false, negate: false },
      { field: null, value: 'bar', raw: 'bar', exact: false, negate: false },
    ]);
  });

  it('parses a quoted namespaced term with the $ anchor', function () {
    assert.deepEqual(parseSearchQuery('va:"space separated name$"'), [
      { field: 'va', value: 'space separated name', raw: 'space separated name', exact: true, negate: false },
    ]);
  });

  it('accepts the $ outside the quotes too', function () {
    assert.deepEqual(parseSearchQuery('va:"space separated name"$'), [
      { field: 'va', value: 'space separated name', raw: 'space separated name', exact: true, negate: false },
    ]);
  });

  it('turns underscores in an unquoted value into spaces', function () {
    assert.deepEqual(parseSearchQuery('circle:underscore_name'), [
      { field: 'circle', value: 'underscore name', raw: 'underscore_name', exact: false, negate: false },
    ]);
  });

  it('keeps underscores inside quotes', function () {
    assert.equal(parseSearchQuery('circle:"under_score"')[0].value, 'under_score');
  });

  it('negates a term prefixed with -', function () {
    assert.deepEqual(parseSearchQuery('-tag:NTR'), [
      { field: 'tag', value: 'NTR', raw: 'NTR', exact: false, negate: true },
    ]);
  });

  it('resolves namespace aliases case-insensitively', function () {
    assert.deepEqual(parseSearchQuery('Group:foo CV:bar Illust:baz Scenario:qux').map(t => t.field), ['circle', 'va', 'illustrator', 'script_writer']);
  });

  it('leaves an unknown namespace as free text', function () {
    assert.deepEqual(parseSearchQuery('foo:bar'), [
      { field: null, value: 'foo:bar', raw: 'foo:bar', exact: false, negate: false },
    ]);
    // maker / seiyuu / actor are deliberately not aliases
    assert.deepEqual(parseSearchQuery('maker:y seiyuu:z actor:w').map(t => t.field), [null, null, null]);
  });

  it('handles an unterminated quote and an empty query', function () {
    assert.equal(parseSearchQuery('tag:"unterminated')[0].value, 'unterminated');
    assert.deepEqual(parseSearchQuery(''), []);
    assert.deepEqual(parseSearchQuery(undefined), []);
  });
});

describe('formatSearchQuery()', function () {
  const fields = (terms: SearchTerm[]) => terms.map(t => [t.field, t.value, t.exact, t.negate]);

  it('builds a term from a label, quoting so the name survives verbatim', function () {
    assert.equal(formatSearchTerm({ field: 'tag', value: 'よしよし', exact: true }), 'tag:"よしよし$"');
    assert.equal(formatSearchTerm({ field: 'va', value: 'Some Name', exact: true, negate: true }), '-va:"Some Name$"');
    assert.equal(formatSearchTerm({ field: null, value: 'free text' }), '"free text"');
  });

  it('round-trips whatever the parser produced', function () {
    for (const query of [
      'tag:"耳かき 囁き$" -va:"Some Name$"',
      'free text tag:NTR -title:foo$',
      'series:"第 1 期$"',
      'va:"名前"',
    ]) {
      const terms = parseSearchQuery(query);
      assert.deepEqual(fields(parseSearchQuery(formatSearchQuery(terms))), fields(terms), query);
    }
  });

  // The bare form rewrites '_' as a space, so quoting is what keeps a name
  // containing one pointing at its own row.
  it('keeps an underscore in a name out of the space substitution', function () {
    const built = formatSearchTerm({ field: 'circle', value: 'A_B', exact: true });
    assert.equal(built, 'circle:"A_B$"');
    assert.equal(parseSearchQuery(built)[0].value, 'A_B');
  });
});

describe('getWorksByFilter() advanced filtering', { timeout: 10000 }, () => {
  const TEST_DB = join(import.meta.dirname, 'db-search-test.sqlite3');
  let knex: Knex;
  let Q: ReturnType<typeof makeQueries>;

  const LABELS = {
    t_circle: ['Sound Factory', 'Under Score', 'Other Circle'],
    t_tag: ['癒し', 'NTR'],
    t_va: ['山田 太郎', '山田 太郎ちゃん', '他の人'],
    t_illustrator: [],
    t_script_writer: [],
    t_series: [],
    t_author: [],
  };

  const WORKS = [
    { id: '100001', title: '夏の思い出', circle: 'Sound Factory', nsfw: false, va: ['山田 太郎'], tag: ['癒し'] },
    { id: '100002', title: '冬の記憶', circle: 'Under Score', nsfw: true, va: ['山田 太郎ちゃん'], tag: ['NTR'] },
    { id: 'd100001', title: 'Fanza Work', circle: 'Other Circle', nsfw: true, va: ['他の人'], tag: ['癒し'] },
    { id: 'BJ01288313', title: 'Books Work', circle: 'Sound Factory', nsfw: false, va: [], tag: [] },
  ];

  const search = async (filter: string, opts: { nsfw?: number } = {}) => {
    const { works } = await Q.getWorksByFilter({ filter, ...opts });
    return works.map(w => w.id).sort();
  };

  before(async () => {
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
    knex = knexLib({
      client: Client_NodeSQLite,
      useNullAsDefault: true,
      connection: { filename: TEST_DB },
    });
    Q = makeQueries(knex);

    for (const table of Object.keys(LABELS)) {
      await knex.schema.createTable(table, (t) => {
        t.string('id').notNullable();
        t.string('name').notNullable();
      });
    }
    await knex.schema.createTable('t_work', (t) => {
      t.string('id').notNullable();
      t.string('title').notNullable();
      t.string('circle_id').notNullable();
      t.boolean('nsfw');
      t.string('release');
      t.integer('dl_count');
      t.integer('price');
      t.integer('review_count');
      t.integer('rate_count');
      t.float('rate_average_2dp');
      t.text('rate_count_detail');
      t.text('rank');
      t.timestamp('created_at');
      t.timestamp('updated_at');
    });
    for (const [rel, key] of Object.entries({
      r_tag_work: 'tag_id', r_va_work: 'va_id', r_illustrator_work: 'illustrator_id',
      r_script_writer_work: 'script_writer_id', r_series_work: 'series_id', r_author_work: 'author_id',
    })) {
      await knex.schema.createTable(rel, (t) => {
        t.string(key);
        t.string('work_id');
      });
    }
    await knex.schema.createTable('t_review', (t) => {
      t.string('user_name');
      t.string('work_id');
      t.integer('rating');
    });

    for (const [table, names] of Object.entries(LABELS)) {
      for (const name of names) {
        await knex(table).insert({ id: nameToUUID(name), name });
      }
    }
    for (const w of WORKS) {
      await knex('t_work').insert({
        id: w.id, title: w.title, circle_id: nameToUUID(w.circle), nsfw: w.nsfw, release: '2024-01-01',
      });
      for (const name of w.va) await knex('r_va_work').insert({ va_id: nameToUUID(name), work_id: w.id });
      for (const name of w.tag) await knex('r_tag_work').insert({ tag_id: nameToUUID(name), work_id: w.id });
    }
  }, { timeout: 10000 });

  after(async () => {
    if (knex) await knex.destroy();
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  });

  it('matches a VA by substring', async function () {
    assert.deepEqual(await search('va:山田_太郎'), ['100001', '100002']);
  });

  it('anchors the match with a trailing $', async function () {
    assert.deepEqual(await search('va:"山田 太郎$"'), ['100001']);
  });

  it('matches a circle whose name carries a space', async function () {
    assert.deepEqual(await search('circle:under_score'), ['100002']);
  });

  it('ANDs several terms and honours negation', async function () {
    assert.deepEqual(await search('tag:癒し -circle:Sound_Factory'), ['d100001']);
  });

  it('still matches free text across every field', async function () {
    assert.deepEqual(await search('記憶'), ['100002']);
    assert.deepEqual(await search('癒し'), ['100001', 'd100001']);
  });

  it('mixes free text, namespaced and negated terms in one query', async function () {
    assert.deepEqual(await search('癒し circle:Other_Circle'), ['d100001']);
    assert.deepEqual(await search('癒し -circle:Other_Circle'), ['100001']);
    assert.deepEqual(await search('-癒し'), ['100002', 'BJ01288313']); // negated bare word
    assert.deepEqual(await search('RJ100001 tag:癒し'), ['100001']);
    assert.deepEqual(await search('RJ100001 tag:NTR'), []);
  });

  it('still resolves work codes', async function () {
    assert.deepEqual(await search('RJ100001'), ['100001']);
    assert.deepEqual(await search('id:100002'), ['100002']);
  });

  it('resolves DLsite books ids without dropping the BJ prefix', async function () {
    assert.deepEqual(await search('BJ01288313'), ['BJ01288313']);
    assert.deepEqual(await search('bj01288313'), ['BJ01288313']);
    assert.deepEqual(await search('id:BJ01288313'), ['BJ01288313']);
  });

  it('takes a Fanza id with or without the underscore', async function () {
    // ids are stored underscore-free since migration 20260828000000; the
    // underscore form is still accepted, because that is what DMM prints
    assert.deepEqual(await search('d100001'), ['d100001']);
    assert.deepEqual(await search('d_100001'), ['d100001']);
    assert.deepEqual(await search('id:d100001'), ['d100001']);
    assert.deepEqual(await search('id:d_100001'), ['d100001']);
    assert.deepEqual(await search('d100001 tag:癒し'), ['d100001']);
    // the bare form only counts as a whole term: `CD100001` must not be read
    // as the Fanza cid d_100001 (it falls through to the DLsite code path)
    assert.deepEqual(await search('CD100001'), ['100001']);
  });

  it('ANDs the nsfw filter with an OR-ing free-text term', async function () {
    assert.deepEqual(await search('癒し', { nsfw: 2 }), ['d100001']);
    assert.deepEqual(await search('癒し', { nsfw: 1 }), ['100001']);
  });

  it('returns the whole library for an empty filter', async function () {
    assert.deepEqual(await search(''), ['100001', '100002', 'BJ01288313', 'd100001']);
  });
});
