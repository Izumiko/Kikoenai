import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { transcodeFileName } from '../filesystem/utils.ts';

// The cache key must cover everything the transcoded output depends on: which
// file, which version of it, and the encode settings. Miss one and the cache
// serves the wrong bytes indefinitely -- nothing cleans this directory up.
describe('transcodeFileName()', function(){
  const base = () => transcodeFileName('123456', 'SE/01 intro.wav', 1699999999000, '96k');

  it('is deterministic for the same file, version and settings', function() {
    assert.equal(base(), base());
    assert.match(base(), /^123456_[0-9a-f]{16}\.opus$/);
  });

  it('supports Fanza-style ids', function() {
    assert.match(transcodeFileName('d215444', '01.wav', 1, '96k'), /^d215444_[0-9a-f]{16}\.opus$/);
  });

  it('changes when the source file changes', function() {
    assert.notEqual(transcodeFileName('123456', 'SE/02 main.wav', 1699999999000, '96k'), base());
  });

  // The bug this replaced: the key was the source content hash alone, so
  // changing config.transcodeBitrate kept serving the old bitrate from cache.
  it('changes when the bitrate changes', function() {
    assert.notEqual(transcodeFileName('123456', 'SE/01 intro.wav', 1699999999000, '128k'), base());
  });

  it('changes when the source is re-encoded in place (mtime moves)', function() {
    assert.notEqual(transcodeFileName('123456', 'SE/01 intro.wav', 1700000000000, '96k'), base());
  });

  // A relPath carries slashes, spaces and unicode; the digest keeps all of that
  // out of the filename without reading the audio to hash it.
  it('keeps a nested non-ASCII path out of the filename', function() {
    const name = transcodeFileName('123456', '絶頂トレーニング/01 囁き♡.wav', 1, '96k');
    assert.match(name, /^123456_[0-9a-f]{16}\.opus$/);
  });
});
