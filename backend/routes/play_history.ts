import express from 'express';
import type { NextFunction, Request, Response } from 'express';
const router = express.Router();
import { query, body } from 'express-validator';
import { config } from '../config.ts';
import db from '../database/db.ts';
import normalize from './utils/normalize.ts';
import { isValidRequest, workIdParam } from './utils/validate.ts';

const PAGE_SIZE = config.pageSize || 12;

/**
 * The GET / query string, each field checked by the chains below. A type alias
 * rather than an interface so it keeps the implicit index signature Express's
 * ParsedQs requires.
 */
type HistoryQuery = {
  page?: string;
  sort?: string;
  excludeFinished?: string;
};


router.get('/',
  query('page').optional().isInt(),
  query('sort').optional().isIn(['desc', 'asc']),
  query('excludeFinished').optional().isIn(['all', 'listened']),
   
  async (req: Request<{}, unknown, unknown, HistoryQuery>, res: Response, next: NextFunction) => {
    if(!isValidRequest(req, res)) return;

    const currentPage = parseInt(req.query.page as string) || 1;
    const sort = req.query.sort || 'desc';
    const offset = (currentPage - 1) * PAGE_SIZE;
    const username = config.auth ? req.user!.name : 'admin';
    const excludeFinished = req.query.excludeFinished || 'listened';
    
    try {
      const {works, totalCount} = await db.getPlayHistory({
        username: username,
        limit: PAGE_SIZE,
        offset: offset,
        sortOption: sort,
        excludeFinished: excludeFinished,
      });
      // console.log(`works = ${works}, totalCount = ${totalCount[0]['count']}`)

      normalize(works, {dateOnly: true});

      res.send({
        works,
        pagination: {
          currentPage,
          pageSize: PAGE_SIZE,
          totalCount: totalCount[0]['count']
        }
      });
    } catch(err) {
      res.status(500).send({error: '查询过程中出错'});
      console.error(err);
    }
});

// 更新播放状态
router.put('/:id',
  workIdParam(),
  body('state').isObject(),
   
  (req: Request<{ id: string }>, res: Response, next: NextFunction) => {
    if(!isValidRequest(req, res)) return;

    let username = config.auth ? req.user!.name : 'admin';

    // console.log('update historoy =', username, req.body.work_id, req.body.state)
    // console.log(`config.auth = ${config.auth}`)
    
    db.updatePlayHistory(username, req.params.id, JSON.stringify(req.body.state))
        .then(() => {
          res.send({ message: '更新历史成功' });
        }).catch((err) =>{
          res.status(500).send({ error: '更新播放历史失败，服务器错误' });
          console.error(err);
        });
});

// 删除播放历史，适用于当前场景下，某些文件被删除后，作品只有一个文件，无法播放正确文件的bug
router.delete('/:id',
  workIdParam(),
  async (req: Request<{ id: string }>, res: Response, next: NextFunction) => {
    if(!isValidRequest(req, res)) return;

    let username = config.auth ? req.user!.name : 'admin';
    try {
      await db.deletePlayHistory(username, req.params.id);
      res.send({message: '删除历史记录成功'});
    } catch (err) {
      console.error(err);
      next(err);
    }
});

export default router;