import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PUBLIC_PATH_TOKEN, normalizeBasePath, applyBasePath } from '../base-path.ts';

describe('base-path', () => {
  describe('normalizeBasePath', () => {
    it('treats an unset, empty or root value as "serve from the root"', () => {
      [undefined, null, '', '   ', '/', '//'].forEach(value => {
        assert.equal(normalizeBasePath(value), '', JSON.stringify(value));
      });
    });

    it('adds the leading slash and drops the trailing one', () => {
      assert.equal(normalizeBasePath('kikoeru'), '/kikoeru');
      assert.equal(normalizeBasePath('/kikoeru'), '/kikoeru');
      assert.equal(normalizeBasePath('/kikoeru/'), '/kikoeru');
      assert.equal(normalizeBasePath('  /kikoeru/  '), '/kikoeru');
    });

    it('keeps multi-segment prefixes and collapses repeated slashes', () => {
      assert.equal(normalizeBasePath('//apps//kikoeru//'), '/apps/kikoeru');
    });

    // A bad value should not stop the server from booting, so every rejection
    // falls back to the root rather than throwing.
    it('rejects anything that is not a path', () => {
      ['http://example.com/kikoeru', 'https://x', 'C:\\kikoeru'].forEach(value => {
        assert.equal(normalizeBasePath(value), '', value);
      });
    });

    it('rejects relative segments and characters that do not belong in a path', () => {
      ['/a/../b', '/a/./b', '/kiko eru', '/kiko"eru', '/</script>'].forEach(value => {
        assert.equal(normalizeBasePath(value), '', value);
      });
    });
  });

  describe('applyBasePath', () => {
    it('swaps every occurrence of the token for the prefix', () => {
      const asset = `<script src=${PUBLIC_PATH_TOKEN}js/app.js></script><link href=${PUBLIC_PATH_TOKEN}css/app.css>`;
      assert.equal(applyBasePath(asset, '/kikoeru'), '<script src=/kikoeru/js/app.js></script><link href=/kikoeru/css/app.css>');
    });

    // The whole point of the empty default: a root-served install gets exactly
    // the URLs it had before any of this existed.
    it('collapses the token back to a bare slash when there is no prefix', () => {
      assert.equal(applyBasePath(`${PUBLIC_PATH_TOKEN}js/app.js`, ''), '/js/app.js');
    });

    it('leaves an asset with no token untouched', () => {
      assert.equal(applyBasePath('body { color: red }', '/kikoeru'), 'body { color: red }');
    });
  });
});
