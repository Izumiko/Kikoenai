// The allowlist that stands between seller-authored markup and v-html

// Env (FREEZE_CONFIG_FILE, NODE_ENV) comes from test/setup-env.ts, preloaded via --import.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../config.ts';
import { sanitizeDescriptionHtml, looksLikeHtml } from '../routes/utils/description-html.ts';
import type { SampleImage } from '../types/scraper.ts';

const IMAGES: SampleImage[] = [
  { url: 'https://img.dlsite.jp/parts/aaa.jpg', file: 'RJ123456_img_part1.jpg' },
  { url: 'https://img.dlsite.jp/parts/bbb.jpg', file: null },
];

const clean = (html: string | null) => sanitizeDescriptionHtml(html, '123456', IMAGES);

describe('looksLikeHtml', function () {
  it('tells a scraped blurb from a row that predates the markup', function () {
    assert.equal(looksLikeHtml('<p>text</p>'), true);
    assert.equal(looksLikeHtml('前<br>後'), true);
    // Plain text, including the JSON fallback's intro_s and text that merely
    // contains angle brackets.
    assert.equal(looksLikeHtml('キャラ紹介\n・Lカップ'), false);
    assert.equal(looksLikeHtml('5 < 6 > 4'), false);
    assert.equal(looksLikeHtml(''), false);
    assert.equal(looksLikeHtml(null), false);
  });
});

describe('sanitizeDescriptionHtml', function () {
  it('keeps the structure and emphasis a blurb is made of', function () {
    const out = clean('<p>一行目<br>二行目</p><ul><li><b>太字</b>と<em>斜体</em></li></ul>');
    assert.equal(out, '<p>一行目<br>二行目</p><ul><li><b>太字</b>と<em>斜体</em></li></ul>');
  });

  it('removes scripts and their content outright', function () {
    const out = clean('<p>前</p><script>alert(1)</script><style>body{}</style><p>後</p>');
    assert.equal(out, '<p>前</p><p>後</p>');
  });

  it('drops event handlers and unknown attributes, keeping the element', function () {
    const out = clean('<p class="work_parts" onclick="steal()" data-x="1">text</p>');
    assert.equal(out, '<p>text</p>');
  });

  it('unwraps an unknown tag rather than losing its text', function () {
    assert.equal(clean('<marquee>読んで</marquee>'), '読んで');
  });

  it('strips colours but keeps layout declarations', function () {
    const out = clean('<span style="color:#ff00ff;background:#000;font-size:20px;text-align:center">x</span>');
    assert.equal(out, '<span style="font-size:20px; text-align:center">x</span>');
  });

  it('refuses a style value that fetches something', function () {
    assert.equal(clean('<p style="font-size:url(http://evil/x)">x</p>'), '<p>x</p>');
  });

  it('points a downloaded image at the local file', function () {
    const out = clean('<img src="https://img.dlsite.jp/parts/aaa.jpg" alt="a">');
    assert.equal(out, '<img src="/api/image/123456/RJ123456_img_part1.jpg" alt="a" loading="lazy">');
  });

  it('matches the stored url however the markup spells the scheme', function () {
    // What DLsite actually serves: protocol-relative, while the scraper stored
    // the absolutized form.
    assert.equal(clean('<img src="//img.dlsite.jp/parts/aaa.jpg">'), '<img src="/api/image/123456/RJ123456_img_part1.jpg" loading="lazy">');
    assert.equal(clean('<img src="http://img.dlsite.jp/parts/aaa.jpg">'), '<img src="/api/image/123456/RJ123456_img_part1.jpg" loading="lazy">');
  });

  it('falls back to the full-size url the <a> wrapper carries', function () {
    // DLsite links the original around a resized copy, and the scraper stores
    // the href, so the <img src> alone would find nothing.
    const out = clean('<a href="//img.dlsite.jp/parts/aaa.jpg"><img src="//img.dlsite.jp/resize/aaa_600x600.jpg"></a>');
    assert.ok(out.includes('src="/api/image/123456/RJ123456_img_part1.jpg"'));
  });

  it('sends a click on the picture to the local copy, not to DLsite', function () {
    const out = clean('<a href="//img.dlsite.jp/parts/aaa.jpg"><img src="//img.dlsite.jp/parts/aaa.jpg"></a>');
    assert.equal(out, '<a href="/api/image/123456/RJ123456_img_part1.jpg" target="_blank" rel="noopener noreferrer">'
      + '<img src="/api/image/123456/RJ123456_img_part1.jpg" loading="lazy"></a>');
    assert.ok(!out.includes('dlsite.jp'));
  });

  it('drops a link that wrapped nothing but an undownloaded image', function () {
    assert.equal(clean('<p>a</p><a href="//img.dlsite.jp/parts/bbb.jpg"><img src="//img.dlsite.jp/parts/bbb.jpg"></a>'), '<p>a</p>');
  });

  it('keeps a labelled link to an image it does not hold', function () {
    // Not a picture, a worded link: the label is prose, and the destination is
    // an ordinary external link.
    const out = clean('<a href="https://img.dlsite.jp/parts/bbb.jpg">大きい画像</a>');
    assert.equal(out, '<a href="https://img.dlsite.jp/parts/bbb.jpg" target="_blank" rel="noopener noreferrer">大きい画像</a>');
  });

  it('drops an image that was never downloaded, rather than hotlinking it', function () {
    assert.equal(clean('<p>a</p><img src="https://img.dlsite.jp/parts/bbb.jpg">'), '<p>a</p>');
    assert.equal(clean('<img src="https://img.dlsite.jp/parts/unknown.jpg">'), '');
  });

  it('carries the deploy prefix into image urls', function () {
    const original = config.basePath;
    config.basePath = '/kikoeru';
    try {
      assert.equal(clean('<img src="https://img.dlsite.jp/parts/aaa.jpg">'), '<img src="/kikoeru/api/image/123456/RJ123456_img_part1.jpg" loading="lazy">');
    } finally {
      config.basePath = original;
    }
  });

  it('keeps an http link, marked safe to open', function () {
    assert.equal(clean('<a href="https://example.com">x</a>'), '<a href="https://example.com" target="_blank" rel="noopener noreferrer">x</a>');
  });

  it('unwraps a javascript: link, keeping its label', function () {
    assert.equal(clean('<a href="javascript:alert(1)">押して</a>'), '押して');
    assert.equal(clean('<a href="data:text/html,x">押して</a>'), '押して');
  });

  it('survives empty and malformed input', function () {
    assert.equal(clean(''), '');
    assert.equal(clean(null), '');
    assert.equal(clean('<p>unclosed'), '<p>unclosed</p>');
  });
});
