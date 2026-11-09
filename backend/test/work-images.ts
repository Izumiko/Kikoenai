// Scraped image bookkeeping: which files a work claims, and which get pruned

// Env (FREEZE_CONFIG_FILE, NODE_ENV) comes from test/setup-env.ts, preloaded via --import.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import { join } from 'path';

import { config } from '../config.ts';
import { collectWorkImages, deleteWorkImagesFromDisk, workImageFileNamePattern } from '../filesystem/utils.ts';
import { splitDownloadTargets } from '../filesystem/workExtras.ts';

describe('scraped work images', function () {
  describe('collectWorkImages', function () {
    it('lists the slider first, then description images, deduplicated', function () {
      const images = collectWorkImages({
        sampleImages: [{ url: 'a.jpg', thumb: 'a_t.jpg' }, { url: 'b.jpg' }],
        descriptionParts: [
          // a.jpg is already in the slider
          { type: 'image', heading: null, images: ['c.jpg', 'a.jpg'], tracks: [] },
          { type: 'image', heading: null, images: ['d.jpg'], tracks: [] },
        ],
      });

      assert.deepEqual(images.map(i => i.url), ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg']);
      assert.deepEqual(images.map(i => i.kind), ['smp', 'smp', 'part', 'part']);
      assert.equal(images[0].thumb, 'a_t.jpg');
    });
  });

  describe('splitDownloadTargets', function () {
    const target = (url: string, file: string | null) => ({ url, file });

    it('reuses an image the last run put in the same file', function () {
      const targets = [target('a.jpg', 'RJ1_img_smp1.jpg'), target('b.jpg', 'RJ1_img_smp2.jpg')];
      const previous = [target('a.jpg', 'RJ1_img_smp1.jpg'), target('b.jpg', 'RJ1_img_smp2.jpg')];
      const { reuse, fetch } = splitDownloadTargets(targets, previous, new Set(['RJ1_img_smp1.jpg', 'RJ1_img_smp2.jpg']));

      assert.deepEqual(reuse.map(t => t.url), ['a.jpg', 'b.jpg']);
      assert.equal(fetch.length, 0);
    });

    it('refetches when the file is gone from disk', function () {
      const targets = [target('a.jpg', 'RJ1_img_smp1.jpg')];
      const { reuse, fetch } = splitDownloadTargets(targets, targets, new Set());

      assert.equal(reuse.length, 0);
      assert.deepEqual(fetch.map(t => t.url), ['a.jpg']);
    });

    it('refetches when the name now belongs to a different image', function () {
      // The description lost its first image, so every later one shifts up a
      // number: part2's bytes are on disk under part1's name.
      const targets = [target('b.jpg', 'RJ1_img_part1.jpg')];
      const previous = [target('a.jpg', 'RJ1_img_part1.jpg'), target('b.jpg', 'RJ1_img_part2.jpg')];
      const { reuse, fetch } = splitDownloadTargets(targets, previous, new Set(['RJ1_img_part1.jpg', 'RJ1_img_part2.jpg']));

      assert.equal(reuse.length, 0);
      assert.deepEqual(fetch.map(t => t.url), ['b.jpg']);
    });

    it('fetches everything when there is no previous list', function () {
      const targets = [target('a.jpg', 'RJ1_img_smp1.jpg')];
      assert.equal(splitDownloadTargets(targets, [], new Set(['RJ1_img_smp1.jpg'])).fetch.length, 1);
      assert.equal(splitDownloadTargets(targets, undefined, new Set()).fetch.length, 1);
    });

    it('ignores a previous entry whose download had failed', function () {
      const targets = [target('a.jpg', 'RJ1_img_smp1.jpg')];
      const previous = [{ url: 'a.jpg', file: null }];
      assert.equal(splitDownloadTargets(targets, previous, new Set(['RJ1_img_smp1.jpg'])).fetch.length, 1);
    });
  });

  describe('deleteWorkImagesFromDisk', function () {
    let imageDir: string;
    let originalDir: string;

    beforeEach(function () {
      imageDir = fs.mkdtempSync(join(os.tmpdir(), 'kiko-images-'));
      originalDir = config.imageFolderDir;
      config.imageFolderDir = imageDir;
    });

    afterEach(function () {
      config.imageFolderDir = originalDir;
      fs.rmSync(imageDir, { recursive: true, force: true });
    });

    const write = (name: string) => fs.writeFileSync(join(imageDir, name), 'x');
    const remaining = () => fs.readdirSync(imageDir).sort();

    it('deletes every image of the work, and nothing else', async function () {
      ['RJ123456_img_smp1.jpg', 'RJ123456_img_part1.png', 'RJ654321_img_smp1.jpg',
        'RJ123456_img_main.jpg', 'notes.txt'].forEach(write);

      const deleted = await deleteWorkImagesFromDisk('123456');

      assert.equal(deleted, 2);
      // The cover (_img_main) survives: a deployment may point imageFolderDir
      // at the cover folder.
      assert.deepEqual(remaining(), ['RJ123456_img_main.jpg', 'RJ654321_img_smp1.jpg', 'notes.txt']);
    });

    it('spares the names a fresh download claimed', async function () {
      ['RJ123456_img_smp1.jpg', 'RJ123456_img_part1.jpg', 'RJ123456_img_part2.jpg'].forEach(write);

      // The description lost a part image, so part2 is left over from last run.
      const deleted = await deleteWorkImagesFromDisk('123456',
        new Set(['RJ123456_img_smp1.jpg', 'RJ123456_img_part1.jpg']));

      assert.equal(deleted, 1);
      assert.deepEqual(remaining(), ['RJ123456_img_part1.jpg', 'RJ123456_img_smp1.jpg']);
    });

    it('does nothing when the image folder does not exist', async function () {
      config.imageFolderDir = join(imageDir, 'nope');
      assert.equal(await deleteWorkImagesFromDisk('123456'), 0);
    });
  });

  describe('workImageFileNamePattern', function () {
    it('matches only this work\'s scraped images', function () {
      const pattern = workImageFileNamePattern('123456');

      assert.equal(pattern.test('RJ123456_img_smp1.jpg'), true);
      assert.equal(pattern.test('RJ123456_img_part12.webp'), true);
      assert.equal(pattern.test('RJ654321_img_smp1.jpg'), false);
      assert.equal(pattern.test('RJ123456_img_main.jpg'), false);
      assert.equal(pattern.test('../../config/config.json'), false);
    });

    it('takes the prefixed spelling of every floor', function () {
      assert.equal(workImageFileNamePattern('BJ635795').test('BJ635795_img_smp1.jpg'), true);
      assert.equal(workImageFileNamePattern('d215444').test('d_215444_img_smp1.jpg'), true);
    });
  });
});
