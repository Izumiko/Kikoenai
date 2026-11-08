// @ts-nocheck

import { createHash } from 'crypto';

import { config } from '../config.ts';

const cmd5 = (str) => createHash('md5').update(str + config.md5secret).digest('hex');

export { cmd5 as md5 };
