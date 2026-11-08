// Scan progress reporting: one message per line, a bounded snapshot, and a
// durable copy on disk.

process.env.FREEZE_CONFIG_FILE = '1';

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

import { LOG } from '../filesystem/scannerModules.ts';
import * as scanLog from '../filesystem/scanLog.ts';
import type { ScanEvent, ScanInitState } from '../types/scan-events.ts';

// scannerModules installs a fallback over process.send unless one is already
// there, but it reads process.send when it emits, so replacing it here is
// enough: the capture has to exist before the first event, not before the
// import (which ESM would hoist above any assignment anyway).
const sent: ScanEvent[] = [];
const realSend = process.send;
process.send = (message, callback) => {
  sent.push(message as ScanEvent);
  if (typeof callback === 'function') callback(null);
  return true;
};

function eventsOf<E extends ScanEvent['event']>(name: E): Array<Extract<ScanEvent, { event: E }>>;
function eventsOf(name: string): ScanEvent[];
function eventsOf(name: string): ScanEvent[] {
  return sent.filter(m => m.event === name);
}
const initState = (): ScanInitState => {
  sent.length = 0;
  process.emit('message', { emit: 'SCAN_INIT_STATE' });
  return eventsOf('SCAN_INIT_STATE')[0].payload;
};

describe('scan progress reporting', function () {
  after(function () {
    if (realSend) process.send = realSend;
    else delete process.send;
  });

  beforeEach(function () {
    sent.length = 0;
  });

  describe('one message per line', function () {
    it('sends a main log line as its own entry, not the whole log', function () {
      LOG.main.info('第一行');
      LOG.main.error('第二行');

      const messages = eventsOf('SCAN_MAIN_LOG');
      assert.equal(messages.length, 2);
      // The point of the delta: the second message must not carry the first.
      assert.deepEqual(messages[1].payload, { entry: { level: 'error', message: '第二行' } });
      assert.equal(eventsOf('SCAN_MAIN_LOGS').length, 0);
    });

    it('sends a task log line as its own entry, not the whole task list', function () {
      LOG.task.add('100001');
      LOG.task.info('100001', '下载图片');

      assert.deepEqual(eventsOf('SCAN_TASK_ADD')[0].payload, { rjcode: '100001' });
      assert.deepEqual(eventsOf('SCAN_TASK_LOG')[0].payload, {
        rjcode: '100001',
        entry: { level: 'info', message: '下载图片' },
      });
      assert.equal(eventsOf('SCAN_TASKS').length, 0);

      LOG.task.remove('100001', 'added');
      assert.deepEqual(eventsOf('SCAN_TASK_REMOVE')[0].payload, { rjcode: '100001', result: 'added' });
    });

    it('reports a failed task once, with its logs', function () {
      LOG.task.add('100002');
      LOG.task.error('100002', '抓取失败');
      LOG.task.remove('100002', 'failed');

      const failed = eventsOf('SCAN_FAILED_TASK');
      assert.equal(failed.length, 1);
      assert.equal(failed[0].payload.task.rjcode, '100002');
      assert.equal(failed[0].payload.task.logs.length, 1);
    });

    it('sends a result as its own entry', function () {
      LOG.result.add('100003', 'added', 7);
      assert.deepEqual(eventsOf('SCAN_RESULT')[0].payload, {
        result: { rjcode: '100003', result: 'added', count: 7 },
      });
      assert.equal(eventsOf('SCAN_RESULTS').length, 0);
    });
  });

  describe('the snapshot stays bounded', function () {
    // SCAN_INIT_STATE is sent on every page load and every reconnect, so it is
    // the one payload that carries accumulated state. A run over a large
    // library emits far more lines than this.
    it('keeps only the tail of the main log', function () {
      for (let i = 0; i < 700; i++) LOG.main.info(`行 ${i}`);

      const { mainLogs } = initState();
      assert.equal(mainLogs.length, 500);
      assert.equal(mainLogs[mainLogs.length - 1].message, '行 699');
    });

    it('keeps only the tail of a task\'s own log', function () {
      LOG.task.add('100004');
      for (let i = 0; i < 300; i++) LOG.task.info('100004', `图片 ${i}`);

      const task = initState().tasks.find(task => task.rjcode === '100004')!;
      assert.equal(task.logs.length, 200);
      assert.equal(task.logs[task.logs.length - 1].message, '图片 299');
      LOG.task.remove('100004', 'added');
    });

    it('keeps only the tail of the results', function () {
      for (let i = 0; i < 600; i++) LOG.result.add('100005', 'added', i);
      assert.equal(initState().results.length, 500);
    });
  });

  describe('the log file', function () {
    // The durable half: a dropped socket loses whatever arrived while it was
    // down, and the page keeps only a capped tail, so this file is the only
    // complete record of a long run.
    let filePath: string;

    after(function () {
      if (filePath) fs.rmSync(filePath, { force: true });
      // Node 26 rejects an explicit `recursive: false`; plain rmdirSync still
      // refuses a non-empty directory, which is the behaviour this relies on.
      fs.rmdirSync(scanLog.LOG_FOLDER_DIR);
    });

    it('writes every line it is given, with level and work id', function () {
      filePath = scanLog.open('test')!;
      assert.equal(typeof filePath, 'string');
      assert.equal(path.dirname(filePath), scanLog.LOG_FOLDER_DIR);

      scanLog.write('info', '共找到 3 个音声文件夹.');
      scanLog.write('warn', '下载失败', 'RJ100006');

      const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n');
      assert.equal(lines.length, 2);
      assert.match(lines[0], /^\S+ INFO  共找到 3 个音声文件夹\.$/);
      assert.match(lines[1], /^\S+ WARN  \[RJ100006\] 下载失败$/);
    });

    it('reopening the same run keeps the same file', function () {
      assert.equal(scanLog.open('test'), filePath);
    });
  });
});
