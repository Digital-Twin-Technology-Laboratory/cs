import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// server/src 或 server/dist → 项目根目录
export const ROOT_DIR = path.resolve(here, '..', '..');
export const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT_DIR, 'data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
export const PLAN_DIR = path.join(DATA_DIR, 'plans');
export const TMP_DIR = path.join(DATA_DIR, 'tmp');
export const WEB_DIST = path.join(ROOT_DIR, 'web', 'dist');
export const PORT = Number(process.env.PORT || 3000);
export const HOST = process.env.HOST || '0.0.0.0';

for (const d of [DATA_DIR, UPLOAD_DIR, PLAN_DIR, TMP_DIR]) fs.mkdirSync(d, { recursive: true });
