/* eslint-disable n/no-unpublished-import */
// Unit tests for the small local modules that replace third-party packages:
// lib/uuid-v5.ts (uuid), lib/url-join.ts (url-join@4) and
// lib/limit-promise.ts (limit-promise).
//
// The expected hashes and URLs below are fixed values produced by the packages
// being replaced, so a behaviour change fails here rather than in production.

import { createHash } from 'crypto';

import chai from 'chai';
const expect = chai.expect;

import { uuidv5 } from '../lib/uuid-v5.ts';
import urljoin from '../lib/url-join.ts';
import LimitPromise from '../lib/limit-promise.ts';

// auth/utils' md5() is `createHash('md5').update(str + config.md5secret)`, so
// with an empty secret it is the plain digest of the string.
const md5 = (str: string) => createHash('md5').update(str).digest('hex');

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

describe('uuidv5()', () => {
  // The namespace used by scraper/utils.ts and the VA migration.
  const namespace = '699d9c07-b965-4399-bafd-18a3cacf073c';

  it('matches the uuid package for a Japanese name', () => {
    expect(uuidv5('かの仔', namespace)).to.equal('e82dac25-569f-54ef-9e6d-8b82fbefc808');
  });

  it('matches the uuid package for an ASCII name', () => {
    expect(uuidv5('ASMR', namespace)).to.equal('62fc73bd-43a2-510c-ab68-18b0761ef814');
  });

  it('matches the uuid package for mixed scripts and characters', () => {
    expect(uuidv5('Some Circle (サークル)', namespace)).to.equal('a24c0426-bced-5924-a8b8-241a06655f1d');
  });
});

describe('md5 digest', () => {
  it('hashes ASCII input', () => {
    expect(md5('admin')).to.equal('21232f297a57a5a743894a0e4a801fc3');
  });

  it('hashes UTF-8 input', () => {
    expect(md5('パスワード密码')).to.equal('30ff8da3bdcf78e2d6e6577237004ce0');
  });

  it('hashes input containing spaces and punctuation', () => {
    expect(md5('p@ss word')).to.equal('b9b86dad668f10fa8e4a1c4b29d104b3');
  });
});

describe('urljoin()', () => {
  it('joins a base URL without a trailing slash', () => {
    expect(urljoin('https://example.com', 'media', 'RJ123456', 'a%20b.mp3'))
      .to.equal('https://example.com/media/RJ123456/a%20b.mp3');
  });

  it('collapses duplicate slashes between parts', () => {
    expect(urljoin('https://example.com/', '/media/', 'RJ1'))
      .to.equal('https://example.com/media/RJ1');
  });

  it('keeps a base sub-path and percent-encoded segments', () => {
    expect(urljoin('http://x.org/base/', '%E7%94%BB', 'c.mp3'))
      .to.equal('http://x.org/base/%E7%94%BB/c.mp3');
  });
});

describe('LimitPromise', () => {
  it('runs at most `max` tasks at once and returns each result', async () => {
    const limit = new LimitPromise(2);
    let running = 0;
    let peak = 0;

    const tasks = Array.from({ length: 6 }, (_, i) => async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise(resolve => setTimeout(resolve, 5));
      running -= 1;
      return i;
    });

    const results = await Promise.all(tasks.map(task => limit.call(task)));
    expect(peak).to.equal(2);
    expect(results).to.deep.equal([0, 1, 2, 3, 4, 5]);
  });

  it('starts queued tasks in submission order', async () => {
    const limit = new LimitPromise(2);
    const started: number[] = [];
    const gates: Array<() => void> = [];

    const task = (i: number) => () => {
      started.push(i);
      return new Promise<number>(resolve => {
        gates[i] = () => resolve(i);
      });
    };

    const promises = [0, 1, 2, 3].map(i => limit.call(task(i)));

    // The first `max` tasks start synchronously; the rest wait.
    expect(started).to.deep.equal([0, 1]);

    gates[0]();
    await flush();
    expect(started).to.deep.equal([0, 1, 2]);

    gates[1]();
    await flush();
    expect(started).to.deep.equal([0, 1, 2, 3]);

    gates[2]();
    gates[3]();
    expect(await Promise.all(promises)).to.deep.equal([0, 1, 2, 3]);
  });

  it('keeps running queued tasks after one rejects', async () => {
    const limit = new LimitPromise(1);
    const order: string[] = [];

    const failing = limit.call(async () => {
      order.push('fails');
      throw new Error('boom');
    }).then(
      () => 'resolved',
      (err: Error) => err.message,
    );

    const succeeding = limit.call(async () => {
      order.push('runs');
      return 'ok';
    });

    expect(await failing).to.equal('boom');
    expect(await succeeding).to.equal('ok');
    expect(order).to.deep.equal(['fails', 'runs']);
  });
});
