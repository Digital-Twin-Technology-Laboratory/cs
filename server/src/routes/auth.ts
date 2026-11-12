import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { audit, db } from '../db.js';
import { requireAuth, toPublic, type UserRow } from '../auth.js';
import { getSettings } from '../settings.js';
import { getCheckQuota } from '../services/checkQuota.js';

export const authRouter = Router();

const usernameSchema = z
  .string()
  .trim()
  .min(3, '用户名至少3个字符')
  .max(32, '用户名最多32个字符')
  .regex(/^[A-Za-z0-9_.@-]+$/, '用户名只能包含字母、数字及 _ . @ -');
export const passwordSchema = z.string().min(8, '密码至少8位').max(64, '密码最多64位');
const INITIAL_PASSWORD = '12345678';

const userCount = () => (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;

// 登录失败限制：同一用户名+IP 连续失败5次，锁定5分钟
const failures = new Map<string, { n: number; until: number }>();

authRouter.get('/me', (req, res) => {
  const site = getSettings('site');
  res.json({
    user: req.user ?? null,
    checkQuota: req.user ? getCheckQuota(req.user.id) : null,
    site: { siteName: site.siteName, registrationMode: site.registrationMode, hasUsers: userCount() > 0 },
  });
});

authRouter.post('/register', (req, res) => {
  const body = z
    .object({
      username: usernameSchema,
      password: passwordSchema,
      name: z.string().trim().min(1, '请填写姓名').max(50),
      department: z.string().trim().max(100).default(''),
    })
    .parse(req.body);

  const site = getSettings('site');
  const result = db.transaction(() => {
    const first = userCount() === 0;
    // 第一个注册的账号自动成为管理员，不受注册开关限制
    if (!first && site.registrationMode === 'closed') return { error: '当前未开放注册，请联系管理员开通账号' };
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(body.username)) return { error: '该用户名已被注册' };
    const role = first ? 'admin' : 'user';
    const status = first || site.registrationMode === 'open' ? 'active' : 'pending';
    const r = db
      .prepare('INSERT INTO users (username, password_hash, name, department, role, status) VALUES (?, ?, ?, ?, ?, ?)')
      .run(body.username, bcrypt.hashSync(body.password, 10), body.name, body.department, role, status);
    return { id: r.lastInsertRowid, role, status, first };
  })();

  if ('error' in result) return res.status(400).json({ error: result.error });
  audit({ id: result.id, username: body.username }, result.first ? '注册（首个账号，设为管理员）' : '注册', body.username, undefined, req.ip);
  if (result.status === 'active') {
    req.session.userId = result.id;
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(result.id) as UserRow;
    return res.json({ user: toPublic(u), message: result.first ? '注册成功，您是本系统第一个账号，已设为管理员' : '注册成功' });
  }
  res.json({ user: null, pending: true, message: '注册成功，请等待管理员审核后登录' });
});

authRouter.post('/login', (req, res) => {
  const { username, password } = z
    .object({
      username: z.string().trim().min(1, '请输入工号或姓名').max(50),
      password: z.string().min(1, '请输入密码').max(64),
    })
    .parse(req.body);
  const key = `${username.toLowerCase()}|${req.ip}`;
  const f = failures.get(key);
  if (f && f.until > Date.now()) return res.status(429).json({ error: '登录失败次数过多，请5分钟后再试' });

  let u = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined;
  if (!u) {
    const matches = db.prepare('SELECT * FROM users WHERE name = ?').all(username) as UserRow[];
    if (matches.length > 1) return res.status(400).json({ error: '存在同名用户，请使用工号或用户名登录' });
    u = matches[0];
  }
  if (u && !(u.password_hash ? bcrypt.compareSync(password, u.password_hash) : u.roster_login === 1 && password === INITIAL_PASSWORD)) u = undefined;
  if (!u) {
    const n = (f && f.until <= Date.now() && f.n >= 5 ? 0 : f?.n ?? 0) + 1;
    failures.set(key, { n, until: n >= 5 ? Date.now() + 5 * 60_000 : 0 });
    return res.status(400).json({ error: '工号、姓名或密码错误' });
  }
  failures.delete(key);
  if (u.status === 'pending') return res.status(403).json({ error: '账号正在等待管理员审核' });
  if (u.status === 'disabled') return res.status(403).json({ error: '账号已被停用，请联系管理员' });

  if (!u.password_hash) {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(INITIAL_PASSWORD, 10), u.id);
  }
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: '登录失败' });
    req.session.userId = u.id;
    db.prepare("UPDATE users SET last_login_at = datetime('now','localtime'), must_change_password = 0 WHERE id = ?").run(u.id);
    audit(u, '登录', undefined, undefined, req.ip);
    res.json({ user: toPublic(db.prepare('SELECT * FROM users WHERE id = ?').get(u.id) as UserRow) });
  });
});

authRouter.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

authRouter.put('/profile', requireAuth, (req, res) => {
  const body = z
    .object({ name: z.string().trim().min(1, '请填写姓名').max(50), department: z.string().trim().max(100).default('') })
    .parse(req.body);
  db.prepare('UPDATE users SET name = ?, department = ? WHERE id = ?').run(body.name, body.department, req.user!.id);
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user!.id) as UserRow;
  res.json({ user: toPublic(u) });
});

authRouter.put('/password', requireAuth, (req, res) => {
  const body = z.object({ oldPassword: z.string(), newPassword: passwordSchema }).parse(req.body);
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user!.id) as UserRow;
  if (!bcrypt.compareSync(body.oldPassword, u.password_hash)) return res.status(400).json({ error: '原密码不正确' });
  if (body.newPassword === body.oldPassword) return res.status(400).json({ error: '新密码不能与原密码相同' });
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0, roster_login = 0 WHERE id = ?').run(bcrypt.hashSync(body.newPassword, 10), u.id);
  audit(u, '修改密码', undefined, undefined, req.ip);
  res.json({ ok: true, user: toPublic(db.prepare('SELECT * FROM users WHERE id = ?').get(u.id) as UserRow) });
});
