import express from 'express';
import type { NextFunction, Request, Response } from 'express';
const router = express.Router();
import { config, setConfig, sharedConfigHandle } from '../config.ts';
import type { Config } from '../types/config.ts';

/**
 * The config as it may leave the server: the two secrets never do, and
 * `production` is not writable through the admin endpoint.
 */
const filterConfig = (_config: Config, option: 'read' | 'write' = 'read'): Partial<Config> => {
  const configClone: Partial<Config> = structuredClone(_config);
  delete configClone.md5secret;
  delete configClone.jwtsecret;
  if (option === 'write') {
    delete configClone.production;
  }
  return configClone;
};

// 修改配置文件
router.put('/admin', (req: Request, res: Response, next: NextFunction) => {
  if (!config.auth || req.user!.name === 'admin') {
    try {
      // Note: setConfig uses Object.assign to merge new configs
      setConfig(filterConfig(req.body.config, 'write'));
      res.send({ message: '保存成功.' });
    } catch(err) {
      next(err);
    }
  } else {
    res.status(403).send({ error: '只有 admin 账号能修改配置文件.' });
  }
});

// 获取配置文件
router.get('/admin', (req: Request, res: Response, next: NextFunction) => {
  if (!config.auth || req.user!.name === 'admin') {
    try {
      res.send({ config: filterConfig(config, 'read') });
    } catch(err) {
      next(err);
    }
  } else {
    res.status(403).send({ error: '只有 admin 账号能读取管理配置文件.' });
  }
});

router.get('/shared', (req: Request, res: Response, next: NextFunction) => {
  try {
    res.send({ sharedConfig: sharedConfigHandle.export() });
  } catch(err) {
    next(err);
  }
});

export default router;