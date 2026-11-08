/*
 * The `user` a request carries once the session middleware has run.
 *
 * `api.ts` (authenticate) attaches the `{ name, group }` getSession() returns,
 * and the routes read it back. Two interfaces are declared because the two
 * consumers are typed separately: routes read a `Express.Request`, while
 * Socket.IO's `socket.request` is the bare `http.IncomingMessage` of the
 * handshake -- which is not an Express Request, so it needs its own merge.
 *
 * Optional on purpose: it is only set inside api.ts's authenticate middleware,
 * which is skipped when `config.auth` is false and never runs for the public
 * routes (`POST /auth/me`, `GET /health`). A route that reads it must already
 * be gated on `config.auth`.
 */

/** The authenticated account, as auth/session.ts reads it from `t_user`. */
export interface SessionUser {
  name: string;
  /** 'administrator' | 'user' | 'guest' -- read live from t_user. */
  group: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: SessionUser;
    }
  }
}

declare module 'http' {
  interface IncomingMessage {
    user?: SessionUser;
  }
}
