import session from 'express-session';
import type { Request, Response, NextFunction } from 'express';
import { db } from './db.js';
import { SESSION_SECRET } from './services/crypto.js';

declare module 'express-session' {
  interface SessionData {
    userId?: number;
  }
}

export interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  name: string;
  department: string;
  role: 'admin' | 'user';
  status: 'pending' | 'active' | 'disabled';
  created_at: string;
  last_login_at: string | null;
}

export type PublicUser = Omit<UserRow, 'password_hash'>;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: PublicUser;
    }
  }
}

export function toPublic(u: UserRow): PublicUser {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { password_hash, ...rest } = u;
  return rest;
}

/** 基于 SQLite 的会话存储 */
class SqliteStore extends session.Store {
  get(sid: string, cb: (err: unknown, s?: session.SessionData | null) => void) {
    const row = db.prepare('SELECT sess, expires FROM sessions WHERE sid = ?').get(sid) as
      | { sess: string; expires: number }
      | undefined;
    if (!row || row.expires < Date.now()) return cb(null, null);
    cb(null, JSON.parse(row.sess));
  }
  set(sid: string, s: session.SessionData, cb?: (err?: unknown) => void) {
    const expires = s.cookie?.expires ? new Date(s.cookie.expires).getTime() : Date.now() + 7 * 864e5;
    db.prepare(
      'INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?) ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires',
    ).run(sid, JSON.stringify(s), expires);
    cb?.();
  }
  destroy(sid: string, cb?: (err?: unknown) => void) {
    db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
    cb?.();
  }
  touch(sid: string, s: session.SessionData, cb?: () => void) {
    this.set(sid, s, cb);
  }
}

setInterval(() => db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now()), 3600_000).unref();

export const sessionMiddleware = session({
  name: 'sc.sid',
  secret: SESSION_SECRET,
  store: new SqliteStore(),
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 7 * 864e5 },
});

/** 每个请求加载当前用户；被禁用或删除的用户立即失效 */
export function loadUser(req: Request, _res: Response, next: NextFunction) {
  if (req.session.userId) {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId) as UserRow | undefined;
    if (u && u.status === 'active') req.user = toPublic(u);
    else delete req.session.userId;
  }
  next();
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.user) return res.status(401).json({ error: '请先登录' });
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.user) return res.status(401).json({ error: '请先登录' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: '需要管理员权限' });
  next();
}
