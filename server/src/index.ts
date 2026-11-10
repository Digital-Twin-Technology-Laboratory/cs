import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express, { type NextFunction, type Request, type Response } from 'express';
import { ZodError } from 'zod';
import { HOST, PORT, WEB_DIST } from './config.js';
import './db.js';
import { loadUser, sessionMiddleware } from './auth.js';
import { authRouter } from './routes/auth.js';
import { userRouter } from './routes/user.js';
import { adminRouter } from './routes/admin.js';
import { statisticOverridesRouter } from './routes/statisticOverrides.js';
import { supervisionManagementRouter, supervisionViewRouter } from './routes/supervision.js';
import { startQueue } from './services/checkQueue.js';

const app = express();
app.set('trust proxy', 'loopback');
app.disable('x-powered-by');
app.use(express.json({ limit: '5mb' }));
app.use(sessionMiddleware);
app.use(loadUser);

app.use('/api/auth', authRouter);
app.use('/api/supervision-management', supervisionManagementRouter);
app.use('/api/supervision', supervisionViewRouter);
app.use('/api/admin', adminRouter);
app.use('/api/statistic-overrides', statisticOverridesRouter);
app.use('/api', userRouter);
app.use('/api', (_req, res) => res.status(404).json({ error: '接口不存在' }));

// 生产模式：托管前端构建产物
if (fs.existsSync(WEB_DIST)) {
  app.use(express.static(WEB_DIST, { index: false, maxAge: '1h' }));
  app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(WEB_DIST, 'index.html')));
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof ZodError) {
    return res.status(400).json({ error: err.issues.map((i) => i.message).join('；') });
  }
  console.error(err);
  res.status(500).json({ error: '服务器内部错误' });
});

startQueue();

app.listen(PORT, HOST, () => {
  const lan = Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => `http://${i!.address}:${PORT}`);
  console.log(`教学材料检查系统已启动：http://localhost:${PORT}`);
  if (lan.length) console.log(`局域网访问：${lan.join('  ')}`);
});
