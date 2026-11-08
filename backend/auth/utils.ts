// @ts-nocheck

import md5 from 'md5';

import { config } from '../config.ts';

const cmd5 = (str) => md5(str + config.md5secret);

export { cmd5 as md5 };
