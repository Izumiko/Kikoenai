// The extraction pipeline shared by scripts/extract-track-titles.js and
// the SUGGEST_TRACK_TITLES socket handler. The verbatim guard is the piece that
// matters most: it is what keeps a paraphrasing or refusing model from putting
// invented Japanese into the database.

process.env.FREEZE_CONFIG_FILE = '1';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { htmlToText, distinctTrackNames, structuredTitles, buildHaystack, validate, collectTitles, isVerbatim, isUninformative, readModelStream } from '../track-titles.ts';
import type { DescriptionPart } from '../types/scraper.ts';

describe('track title extraction', () => {
  describe('distinctTrackNames', () => {
    // The NO_SE case: one work, the same tracks several times over.
    it('collapses variant folders to one entry per name, in disk order', () => {
      const audio = [
        { title: '01.mp3', shortFilePath: '01.mp3' },
        { title: '02.mp3', shortFilePath: '02.mp3' },
        { title: '01.mp3', shortFilePath: 'NO_SE/01.mp3' },
        { title: '02.mp3', shortFilePath: 'NO_SE/02.mp3' },
      ];
      assert.deepEqual(distinctTrackNames(audio), ['01.mp3', '02.mp3']);
    });

    it('keeps genuinely different names apart', () => {
      const audio = [{ title: '01.mp3' }, { title: '02.wav' }];
      assert.deepEqual(distinctTrackNames(audio), ['01.mp3', '02.wav']);
    });

    // Both count bugs were the same mistake: measuring files instead of tracks.
    // A 6-track work with a NO_SE copy reported 12, which double-counted the
    // uninformative names and stopped 6 structured titles from ever matching.
    it('is what makes the structured fast path line up on a variant layout', () => {
      const audio = ['01.mp3', '02.mp3', '03.mp3'].flatMap(name => ([
        { title: name, shortFilePath: name },
        { title: name, shortFilePath: `NO_SE/${name}` },
      ]));
      const parts: DescriptionPart[] = [{
        type: 'tracklist', heading: null, images: [],
        tracks: [{ title: 'A', time: '' }, { title: 'B', time: '' }, { title: 'C', time: '' }],
      }];
      const structured = structuredTitles(parts);

      assert.equal(audio.length, 6);
      assert.equal(distinctTrackNames(audio).length, structured.length);
    });
  });

  describe('validate', () => {
    const fileNames = ['01.mp3', '02.mp3'];
    const haystack = buildHaystack('01 はじまりの朝\n02 おわりの夜', []);

    it('accepts a title copied verbatim from the description', () => {
      const { accepted, rejected } = validate(
        { tracks: [{ file: '01.mp3', title: '01 はじまりの朝' }] }, haystack, fileNames,
      );
      assert.deepEqual(accepted, { '01.mp3': '01 はじまりの朝' });
      assert.equal(rejected.length, 0);
    });

    it('rejects a paraphrase, which is the dominant model failure', () => {
      const { accepted, rejected } = validate(
        { tracks: [{ file: '01.mp3', title: 'Morning of beginnings' }] }, haystack, fileNames,
      );
      assert.deepEqual(accepted, {});
      assert.equal(rejected[0][2], 'not verbatim in description');
    });

    // A remote provider declining the content returns prose, none of which is
    // in the description -- so a refusal yields nothing rather than nonsense.
    it('rejects everything when the model refuses instead of answering', () => {
      const refusal = { tracks: [{ file: '01.mp3', title: "I can't help with that request." }] };
      assert.deepEqual(validate(refusal, haystack, fileNames).accepted, {});
    });

    it('rejects a file the work does not have', () => {
      const { rejected } = validate(
        { tracks: [{ file: '99.mp3', title: '01 はじまりの朝' }] }, haystack, fileNames,
      );
      assert.equal(rejected[0][2], 'no such file');
    });

    it('ignores malformed rows rather than throwing', () => {
      const parsed = { tracks: [null, { file: 5 }, { file: '01.mp3' }, { file: '01.mp3', title: '   ' }] };
      assert.deepEqual(validate(parsed, haystack, fileNames).accepted, {});
    });

    it('matches whitespace-insensitively, since titles wrap in the prose', () => {
      const wrapped = buildHaystack('01 はじまりの\n朝', []);
      const { accepted } = validate(
        { tracks: [{ file: '01.mp3', title: '01 はじまりの 朝' }] }, wrapped, fileNames,
      );
      assert.equal(accepted['01.mp3'], '01 はじまりの 朝');
    });

    // buildHaystack folds the structured titles in; validating against the
    // prose alone would reject every structurally-published work.
    it('accepts a title that exists only as a structured track', () => {
      const parts: DescriptionPart[] = [
        { type: 'tracklist', heading: null, images: [], tracks: [{ title: 'Track1 ごあいさつ', time: '' }] },
      ];
      const { accepted } = validate(
        { tracks: [{ file: '01.mp3', title: 'Track1 ごあいさつ' }] },
        buildHaystack('', parts), fileNames,
      );
      assert.equal(accepted['01.mp3'], 'Track1 ごあいさつ');
    });
  });

  // Renumbering is what small local models get wrong: they copy the title but
  // rewrite "\u2460\u3000" as "1. ". Rejecting that threw away good answers.
  describe('isVerbatim', () => {
    const hay = buildHaystack('\u2460\u3000\u306f\u3058\u307e\u308a\u306e\u671d\n\u2461\u3000\u304a\u308f\u308a\u306e\u591c', []);

    it('accepts an exact copy', () => {
      assert.equal(isVerbatim('\u2460\u3000\u306f\u3058\u307e\u308a\u306e\u671d', hay), true);
    });

    it('accepts a copy whose track marker was reformatted', () => {
      for (const t of ['1. \u306f\u3058\u307e\u308a\u306e\u671d', '01 \u306f\u3058\u307e\u308a\u306e\u671d', 'Track1 \u306f\u3058\u307e\u308a\u306e\u671d', '\u25c6\u306f\u3058\u307e\u308a\u306e\u671d']) {
        assert.equal(isVerbatim(t, hay), true, t);
      }
    });

    it('still rejects a paraphrase', () => {
      assert.equal(isVerbatim('1. Morning of beginnings', hay), false);
    });

    // Stripping the marker must not leave a husk that matches anything: '01.'
    // reduces to '', which would otherwise be found in every description.
    it('rejects a title that is nothing but a marker', () => {
      assert.equal(isVerbatim('01.', hay), false);
      assert.equal(isVerbatim('Track 3', hay), false);
    });

    it('rejects an invented title even when its marker is reformatted', () => {
      assert.equal(isVerbatim('3. \u5b58\u5728\u3057\u306a\u3044\u66f2', hay), false);
    });

    // A short title must still match exactly -- no length floor on this path.
    it('accepts a genuinely short exact title', () => {
      assert.equal(isVerbatim('\u671d', buildHaystack('\u671d', [])), true);
    });
  });

  describe('collectTitles', () => {
    const hay = buildHaystack('\u2460\u3000\u306f\u3058\u307e\u308a\n\u2461\u3000\u304a\u308f\u308a', []);

    // A gap would shift every later title onto the wrong file, because the
    // dialog applies the list positionally.
    it('keeps a reworded title rather than leaving a gap', () => {
      const parsed = { titles: ['\u2460\u3000\u306f\u3058\u307e\u308a', 'Made up', '\u2461\u3000\u304a\u308f\u308a'] };
      const { titles, unverified } = collectTitles(parsed, hay);
      assert.deepEqual(titles, ['\u2460\u3000\u306f\u3058\u307e\u308a', 'Made up', '\u2461\u3000\u304a\u308f\u308a']);
      assert.equal(unverified, 1);
    });

    // SYSTEM_PROMPT_LIST asks for a bare array, but a small model that answers
    // in the old mapping shape is still readable.
    it('reads the mapping shape too, keeping returned order', () => {
      const parsed = { tracks: [
        { file: 'nonexistent.mp3', title: '\u2461\u3000\u304a\u308f\u308a' },
        { title: '\u2460\u3000\u306f\u3058\u307e\u308a' },
      ] };
      assert.deepEqual(collectTitles(parsed, hay).titles, ['\u2461\u3000\u304a\u308f\u308a', '\u2460\u3000\u306f\u3058\u307e\u308a']);
    });

    it('drops non-string and empty entries, counting nothing as unverified', () => {
      assert.deepEqual(collectTitles({ titles: [null, '   ', 5] }, hay), { titles: [], unverified: 0 });
    });

    // A refusal now reaches the dialog instead of vanishing -- flagged, so the
    // admin sees it for what it is.
    it('surfaces a refusal as an unverified title', () => {
      assert.equal(collectTitles({ titles: ["I can't help with that."] }, hay).unverified, 1);
    });
  });

  describe('htmlToText', () => {
    it('keeps the line structure the markup implies', () => {
      assert.equal(htmlToText('<p>one</p><p>two</p>'), 'one\ntwo');
    });

    // DLsite writes "<br />\n", so a tag turned into a newline of its own would
    // double every break. The sentinel swallows the source newline.
    it('does not double a break DLsite wrote as "<br />\\n"', () => {
      assert.equal(htmlToText('a<br />\nb'), 'a\nb');
    });

    it('passes plain text through, so an older row needs no detection', () => {
      assert.equal(htmlToText('01 はじまり\n02 おわり'), '01 はじまり\n02 おわり');
    });

    it('keeps a break with no trailing source newline', () => {
      assert.equal(htmlToText('a<br />b'), 'a\nb');
    });

    it('still gives "<br /><br />" a blank line', () => {
      assert.equal(htmlToText('a<br /><br />b'), 'a\n\nb');
    });

    // The sentinel is private-use, but a blurb that somehow carried one must
    // not be able to inject line breaks.
    it('strips a pre-existing sentinel from the input', () => {
      assert.equal(htmlToText('a\ue000b'), 'ab');
    });

    it('returns empty for a work with no description', () => {
      assert.equal(htmlToText(null), '');
    });
  });

  describe('isUninformative', () => {
    it('spots the filenames this whole feature exists for', () => {
      for (const name of ['01.mp3', '#2.wav', 'track 3.flac', '１.mp3']) {
        assert.equal(isUninformative(name), true, name);
      }
    });

    it('leaves a filename that already carries a title alone', () => {
      for (const name of ['01 はじまりの朝.mp3', 'ごあいさつ.mp3']) {
        assert.equal(isUninformative(name), false, name);
      }
    });
  });
});
