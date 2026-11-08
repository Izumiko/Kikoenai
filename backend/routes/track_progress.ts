// @ts-nocheck

import express from 'express';
const router = express.Router();
import { body } from 'express-validator';
import { config } from '../config.ts';
import db from '../database/db.ts';
import { isValidRequest, workIdParam } from './utils/validate.ts';
import { resolveTrack } from './utils/track.ts';

// Report per-track playback progress
router.put('/:id/*path',
  workIdParam(),
  body('seconds').isFloat({ min: 0 }),
  body('completed').isBoolean(),
  body('observedAt').optional().isInt({ min: 0 }),
  async (req, res, next) => {
    if(!isValidRequest(req, res)) return;

    const username = config.auth ? req.user.name : 'admin';
    try {
      const resolved = await resolveTrack(req, res);
      if (!resolved) return;

      await db.upsertTrackProgress(
        username,
        req.params.id,
        resolved.track.shortFilePath,
        req.body.seconds,
        req.body.completed,
        req.body.observedAt ? Number(req.body.observedAt) : undefined
      );
      res.send({ message: 'track progress updated' });
    } catch (err) {
      console.error(err);
      res.status(500).send({ error: 'failed to update track progress' });
    }
  }
);

export default router;
