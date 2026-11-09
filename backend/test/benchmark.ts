// Env (FREEZE_CONFIG_FILE, NODE_ENV) comes from test/setup-env.ts, preloaded via --import.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { makeQueries } from '../database/queries.ts';
import { formatSearchTerm } from '../database/search-query.ts';
import { config } from '../config.ts';
import knex, { type Knex } from 'knex';
import * as knexfile from '../database/knexfile.ts';
import Client_NodeSQLite from '../database/node-sqlite-client.ts';

const WARMUP = 5;
const ITERATIONS = parseInt(process.env.BENCH_ITERATIONS || '50', 10);
const PAGE_SIZE = config.pageSize || 12;

interface BenchRow {
  query: string;
  n: number;
  minMs: number;
  avgMs: number;
  medianMs: number;
  p95Ms: number;
  maxMs: number;
}

// Real ids sampled from the development database; each benchmark reads the
// ones it needs. Null means the sample could not be taken.
interface Sample {
  username: string;
  workId?: string | null;
  numericId?: string | null;
  circleName?: string | null;
  tagName?: string | null;
  vaName?: string | null;
  illustratorName?: string | null;
  scriptWriterName?: string | null;
  seriesName?: string | null;
  keyword?: string | null;
  reviewUser?: string | null;
  historyUser?: string | null;
}

const results: BenchRow[] = [];
const sample: Sample = { username: 'admin' };

const bench = async (label: string, fn: () => unknown): Promise<BenchRow> => {
  for (let i = 0; i < WARMUP; i += 1) {
    await fn();
  }
  const timings: number[] = [];
  for (let i = 0; i < ITERATIONS; i += 1) {
    const start = process.hrtime.bigint();
    await fn();
    const end = process.hrtime.bigint();
    timings.push(Number(end - start) / 1e6);
  }
  timings.sort((a, b) => a - b);
  const n = timings.length;
  const min = timings[0];
  const max = timings[n - 1];
  const avg = timings.reduce((a, b) => a + b, 0) / n;
  const medIdx = Math.floor(n / 2);
  const median = n % 2 ? timings[medIdx] : (timings[medIdx - 1] + timings[medIdx]) / 2;
  const p95Idx = Math.min(Math.ceil(0.95 * n) - 1, n - 1);
  const p95 = timings[p95Idx];
  const row = {
    query: label, n,
    minMs: +min.toFixed(3), avgMs: +avg.toFixed(3),
    medianMs: +median.toFixed(3), p95Ms: +p95.toFixed(3), maxMs: +max.toFixed(3),
  };
  results.push(row);
  return row;
};

// The database is opened in the `before` hook, so the id samples it fills in
// are read by the benchmarks below it. A missing or empty database skips every
// case with the reason instead of failing the run.
const dbPath = process.env.BENCH_DB || path.join(config.databaseFolderDir, 'db.sqlite3');
let skipReason = fs.existsSync(dbPath) ? '' : `Dev DB (${dbPath}) not found — skipping benchmark`;
let myKnex: Knex;
let Q: ReturnType<typeof makeQueries>;

describe('DB query benchmark', { timeout: Math.max(30000, (WARMUP + ITERATIONS) * 1000) }, () => {
  before(async () => {
    if (skipReason) return;

    if (process.env.BENCH_DB) {
      myKnex = knex({ client: Client_NodeSQLite, useNullAsDefault: true, connection: { filename: process.env.BENCH_DB } });
    } else {
      myKnex = knex(knexfile.development);
    }
    Q = makeQueries(myKnex);

    // Check t_work has data
    const workCount = await myKnex('t_work').count('id as count').first();
    if (!workCount || workCount.count === 0) {
      skipReason = 't_work is empty — skipping benchmark';
      return;
    }

    // Sample real IDs from the DB
    const workRow = await myKnex('t_work').select('id').first();
    sample.workId = workRow ? workRow.id : null;

    // Label filters resolve by name, so that is what the benchmarks need.
    const labelName = async (relTable: string, key: string, nameTable: string) => {
      const rel = await myKnex(relTable).select(`${key} as id`).first();
      if (!rel) return null;
      const row = await myKnex(nameTable).select('name').where('id', rel.id).first();
      return row ? row.name : null;
    };

    const circleRow = await myKnex('t_work')
      .join('t_circle', 't_circle.id', 't_work.circle_id')
      .select('t_circle.name').whereNotNull('circle_id').first();
    sample.circleName = circleRow ? circleRow.name : null;

    sample.tagName = await labelName('r_tag_work', 'tag_id', 't_tag');
    sample.vaName = await labelName('r_va_work', 'va_id', 't_va');
    sample.illustratorName = await labelName('r_illustrator_work', 'illustrator_id', 't_illustrator');
    sample.scriptWriterName = await labelName('r_script_writer_work', 'script_writer_id', 't_script_writer');
    sample.seriesName = await labelName('r_series_work', 'series_id', 't_series');

    // Numeric RJ id for keyword search
    if (sample.workId) {
      sample.numericId = String(sample.workId).replace(/\D/g, '');
    }

    // Text keyword from an existing title
    const titleRow = await myKnex('t_work').select('title').whereNotNull('title').first();
    sample.keyword = (titleRow && titleRow.title) ? titleRow.title.slice(0, 12) : null;

    // Username with reviews
    const reviewUserRow = await myKnex('t_review').select('user_name').distinct().first();
    sample.reviewUser = reviewUserRow ? reviewUserRow.user_name : null;

    // Username with play history
    const historyUserRow = await myKnex('t_play_history').select('user_name').distinct().first();
    sample.historyUser = historyUserRow ? historyUserRow.user_name : null;
  });

  after(async () => {
    if (results.length) {
      console.table(results);
    }
    if (myKnex) {
      try {
        await myKnex.destroy();
      } catch (err) {
        console.warn('benchmark knex destroy warning:', (err as Error).message);
      }
    }
  });

  it('getWorksBy default (all works)', async (t) => {
    if (skipReason) { t.skip(skipReason); return; }
    // Omit limit/offset to get all works
    const row = await bench('getWorksBy default', () => Q.getWorksBy({ username: sample.username }));
    assert.ok(row);
  });

  it('label filter circle', async (t) => {
    if (skipReason) { t.skip(skipReason); return; }
    if (!sample.circleName) { t.skip('no circle name'); return; }
    const keyword = formatSearchTerm({ field: 'circle', value: sample.circleName, exact: true });
    const row = await bench('filter circle', () => Q.getWorksByFilter({ filter: keyword, username: sample.username }));
    assert.ok(row);
  });

  it('label filter tag', async (t) => {
    if (skipReason) { t.skip(skipReason); return; }
    if (!sample.tagName) { t.skip('no tag name'); return; }
    const keyword = formatSearchTerm({ field: 'tag', value: sample.tagName, exact: true });
    const row = await bench('filter tag', () => Q.getWorksByFilter({ filter: keyword, username: sample.username }));
    assert.ok(row);
  });

  it('label filter va', async (t) => {
    if (skipReason) { t.skip(skipReason); return; }
    if (!sample.vaName) { t.skip('no va name'); return; }
    const keyword = formatSearchTerm({ field: 'va', value: sample.vaName, exact: true });
    const row = await bench('filter va', () => Q.getWorksByFilter({ filter: keyword, username: sample.username }));
    assert.ok(row);
  });

  it('label filter illustrator', async (t) => {
    if (skipReason) { t.skip(skipReason); return; }
    if (!sample.illustratorName) { t.skip('no illustrator name'); return; }
    const keyword = formatSearchTerm({ field: 'illustrator', value: sample.illustratorName, exact: true });
    const row = await bench('filter illustrator', () => Q.getWorksByFilter({ filter: keyword, username: sample.username }));
    assert.ok(row);
  });

  it('label filter script_writer', async (t) => {
    if (skipReason) { t.skip(skipReason); return; }
    if (!sample.scriptWriterName) { t.skip('no script_writer name'); return; }
    const keyword = formatSearchTerm({ field: 'script_writer', value: sample.scriptWriterName, exact: true });
    const row = await bench('filter script_writer', () => Q.getWorksByFilter({ filter: keyword, username: sample.username }));
    assert.ok(row);
  });

  it('label filter series', async (t) => {
    if (skipReason) { t.skip(skipReason); return; }
    if (!sample.seriesName) { t.skip('no series name'); return; }
    const keyword = formatSearchTerm({ field: 'series', value: sample.seriesName, exact: true });
    const row = await bench('filter series', () => Q.getWorksByFilter({ filter: keyword, username: sample.username }));
    assert.ok(row);
  });

  it('realistic /api/works (paged + count)', async (t) => {
    if (skipReason) { t.skip(skipReason); return; }
    const row = await bench('realistic /api/works', () => Q.getWorksBy({
      username: sample.username, nsfw: 0,
      order: 'release', sort: 'desc',
      limit: PAGE_SIZE, offset: 48,
    }));
    assert.ok(row);
  });

  it('getWorksByFilter numeric id', async (t) => {
    if (skipReason) { t.skip(skipReason); return; }
    if (!sample.numericId) { t.skip('no numeric id'); return; }
    const row = await bench('getWorksByFilter numeric', () => Q.getWorksByFilter({ filter: `RJ${sample.numericId}`, username: sample.username }));
    assert.ok(row);
  });

  it('getWorksByFilter text keyword', async (t) => {
    if (skipReason) { t.skip(skipReason); return; }
    if (!sample.keyword) { t.skip('no keyword'); return; }
    const row = await bench('getWorksByFilter text', () => Q.getWorksByFilter({ filter: sample.keyword!, username: sample.username }));
    assert.ok(row);
  });

  it('getWorkMetadata', async (t) => {
    if (skipReason) { t.skip(skipReason); return; }
    if (!sample.workId) { t.skip('no work id'); return; }
    const row = await bench('getWorkMetadata', () => Q.getWorkMetadata(sample.workId!, sample.username));
    assert.ok(row);
  });

  it('getLabels circle', async (t) => {
    if (skipReason) { t.skip(skipReason); return; }
    const row = await bench('getLabels circle', () => Q.getLabels('circle'));
    assert.ok(row);
  });

  it('getLabels tag', async (t) => {
    if (skipReason) { t.skip(skipReason); return; }
    const row = await bench('getLabels tag', () => Q.getLabels('tag'));
    assert.ok(row);
  });

  it('getLabels va', async (t) => {
    if (skipReason) { t.skip(skipReason); return; }
    const row = await bench('getLabels va', () => Q.getLabels('va'));
    assert.ok(row);
  });

  it('getLabels illustrator', async (t) => {
    if (skipReason) { t.skip(skipReason); return; }
    const row = await bench('getLabels illustrator', () => Q.getLabels('illustrator'));
    assert.ok(row);
  });

  it('getLabels script_writer', async (t) => {
    if (skipReason) { t.skip(skipReason); return; }
    const row = await bench('getLabels script_writer', () => Q.getLabels('script_writer'));
    assert.ok(row);
  });

  it('getLabels series', async (t) => {
    if (skipReason) { t.skip(skipReason); return; }
    const row = await bench('getLabels series', () => Q.getLabels('series'));
    assert.ok(row);
  });

  it('getWorksWithReviews (paged)', async (t) => {
    if (skipReason) { t.skip(skipReason); return; }
    if (!sample.reviewUser) { t.skip('no reviewing user'); return; }
    const row = await bench('getWorksWithReviews', () => Q.getWorksWithReviews({
      username: sample.reviewUser!, limit: PAGE_SIZE, offset: 0,
      orderBy: 'release', sortOption: 'desc',
    }));
    assert.ok(row);
  });

  it('getPlayHistory (paged)', async (t) => {
    if (skipReason) { t.skip(skipReason); return; }
    if (!sample.historyUser) { t.skip('no history user'); return; }
    const row = await bench('getPlayHistory', () => Q.getPlayHistory({
      username: sample.historyUser!, limit: PAGE_SIZE, offset: 0, sortOption: 'desc',
    }));
    assert.ok(row);
  });
});
