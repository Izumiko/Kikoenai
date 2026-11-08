import express from 'express';
import type { Request, Response } from 'express';
const router = express.Router();

// Health check endpoint
router.get('/health', (req: Request, res: Response) => {
  res.send('OK');
});

import auth from './auth.ts';
router.use('/auth', auth);
import credentials from './credentials.ts';
router.use('/credentials', credentials);
import version from './version.ts';
router.use('/version', version);
import config from './config.ts';
router.use('/config', config);
import media from './media.ts';
router.use('/media', media);
import review from './review.ts';
router.use('/review', review);
import playHistory from './play_history.ts';
router.use('/history', playHistory);
import trackProgress from './track_progress.ts';
router.use('/track-progress', trackProgress);
// Other routes
import metadata from './metadata.ts';
router.use('/', metadata);

export default router;