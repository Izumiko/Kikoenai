import express from 'express';
import type { NextFunction, Request, Response } from 'express';
const router = express.Router();
import { config } from '../config.ts';
import fs from 'fs';
import path from 'path';
import jschardet from 'jschardet';
import { transcodeFileName, transcodeToOpusLimited } from '../filesystem/utils.ts';
import { joinFragments } from './utils/url.ts';
import { isValidRequest, workIdParam } from './utils/validate.ts';
import { findLyricTracks } from './utils/lyrics.ts';
import { resolveTrack } from './utils/track.ts';
import type { RootFolder } from '../types/config.ts';
import type { Track } from '../types/track.ts';

/**
 * What a media request resolves to. A media route's `*path` arrives as an array
 * of already-decoded segments (Express 5), hence the two params.
 */
type MediaRequest = Request<{ id: string; path: string[] }>;

/** The resolved work, track and folders a stream needs (see routes/utils/track.ts). */
type ResolvedTrack = NonNullable<Awaited<ReturnType<typeof resolveTrack>>>;

const offloadUrlFor = (basePath: string, rootFolder: RootFolder, work: { dir: string }, track: Track) => {
  const url = joinFragments(basePath, rootFolder.name, work.dir, track.subtitle || '', track.title);
  return process.platform === 'win32' ? url.replace(/\\/g, '/') : url;
};

const LOSSLESS_AUDIO_EXT_LIST = ['.wav', '.flac', '.alac', '.ape', '.tta'];
const TEXT_EXT_LIST = ['.txt', '.lrc', '.srt', '.ass', '.vtt'];

// GET (stream) a specific track from work folder
router.get('/stream/:id/*path',
  workIdParam(),
  async (req: MediaRequest, res: Response, next: NextFunction) => {
    if(!isValidRequest(req, res)) return;

    try {
      const resolved = await resolveTrack(req, res);
      if (!resolved) return;
      const { work, rootFolder, fullPath: fileName, track } = resolved;

      const extName = path.extname(fileName).toLocaleLowerCase();
      if (extName === '.txt' || extName === '.lrc') {
        const fileBuffer = fs.readFileSync(fileName);
        const charsetMatch = jschardet.detect(fileBuffer).encoding;
        if (charsetMatch) {
          res.setHeader('Content-Type', `text/plain; charset=${charsetMatch}`);
        }
      }
      if (extName === '.flac') {
        // iOS patch
        res.setHeader('Content-Type', `audio/flac`);
      }

      if (config.offloadMedia && extName !== '.txt' && extName !== '.lrc') {
        res.redirect(offloadUrlFor(config.offloadStreamPath, rootFolder, work, track));
      } else {
        // By default, serve file through express
        res.sendFile(fileName, { dotfiles: 'allow' });
      }
    } catch (err) {
      next(err);
    }
});

router.get('/download/:id/*path',
  workIdParam(),
  async (req: MediaRequest, res: Response, next: NextFunction) => {
    if(!isValidRequest(req, res)) return;

    try {
      const resolved = await resolveTrack(req, res);
      if (!resolved) return;
      const { work, rootFolder, fullPath, track } = resolved;

      if (config.offloadMedia) {
        res.redirect(offloadUrlFor(config.offloadDownloadPath, rootFolder, work, track));
      } else {
        // By default, serve file through express
        res.download(fullPath);
      }
    } catch (err) {
      next(err);
    }
});

// GET the best offline-friendly copy of a track
router.get('/offline/:id/*path',
  workIdParam(),
  async (req: MediaRequest, res: Response, next: NextFunction) => {
    if(!isValidRequest(req, res)) return;

    try {
      const resolved = await resolveTrack(req, res);
      if (!resolved) return;
      const { fullPath: fileName, track } = resolved;

      const extName = path.extname(fileName).toLocaleLowerCase();

      if (TEXT_EXT_LIST.includes(extName)) {
        const fileBuffer = fs.readFileSync(fileName);
        const charsetMatch = jschardet.detect(fileBuffer).encoding;
        if (charsetMatch) {
          res.setHeader('Content-Type', `text/plain; charset=${charsetMatch}`);
        }
        res.sendFile(fileName, { dotfiles: 'allow' });
        return;
      }

      if (!LOSSLESS_AUDIO_EXT_LIST.includes(extName)) {
        res.sendFile(fileName, { dotfiles: 'allow' });
        return;
      }

      if (!config.enableTranscoding) {
        res.status(503).send({error: 'Transcoding is disabled on this server.'});
        return;
      }

      const { mtimeMs } = await fs.promises.stat(fileName);
      const cachePath = path.join(
        config.transcodeCacheDir,
        transcodeFileName(req.params.id, track.shortFilePath, Math.round(mtimeMs), config.transcodeBitrate)
      );

      if (!fs.existsSync(cachePath)) {
        await transcodeToOpusLimited(fileName, cachePath, config.transcodeBitrate);
      }

      res.setHeader('Cache-Control', 'public, max-age=31536000');
      res.sendFile(cachePath, { dotfiles: 'allow' });
    } catch (err) {
      next(err);
    }
});

router.get('/check-lrc/:id/*path',
  workIdParam(),
  async (req: MediaRequest, res: Response, next: NextFunction) => {
    if(!isValidRequest(req, res)) return;

    try {
      // `|| {}` is the not-found case, where resolveTrack has already sent the
      // 404: the guard below returns without reading either field.
      const { tracks, track } = await resolveTrack(req, res) || {} as ResolvedTrack;
      if (!track) return;

      const lyrics = findLyricTracks(track, tracks);
      if (lyrics.length) {
        console.log('Found lyrics file: ', lyrics.map(lyric => lyric.trackId).join(', '));
        res.send({
          result: true,
          message: 'Found lyrics file',
          lyrics,
        });
      } else {
        res.send({result: false, message:'Found no lyrics file', lyrics: []});
      }
    } catch (err) {
      next(err);
    }
});

export default router;
