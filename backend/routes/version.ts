import express from 'express';
import type { Request, Response } from 'express';
const router = express.Router();
import { updateLock } from '../upgrade.ts';
import pjson from '../package.json' with { type: 'json' };

const lockReason = '新版解决了旧版扫描时将かの仔和こっこ识别为同一个人的问题，建议进行扫描以自动修复这一问题';

router.get('/', (req: Request, res: Response) => {
  res.send({
    current: pjson.version,
    lockFileExists: updateLock.isLockFilePresent,
    lockReason: updateLock.isLockFilePresent ? lockReason : null
  });
});

export default router;
