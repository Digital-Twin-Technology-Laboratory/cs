import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';
import type { Request, Response, NextFunction } from 'express';
import { TMP_DIR, DATA_DIR } from '../config.js';
import { getSettings } from '../settings.js';

/** multer 在部分环境下按 latin1 解码文件名，这里还原中文文件名 */
export function fixName(name: string) {
  try {
    const decoded = Buffer.from(name, 'latin1').toString('utf8');
    return /�/.test(decoded) ? name : decoded;
  } catch {
    return name;
  }
}

/** 单文件上传中间件（字段名 file），大小上限取系统设置 */
function uploadMiddleware(exts: string[], fields?: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const maxMB = getSettings('site').maxUploadMB;
    const uploader = multer({
      dest: TMP_DIR,
      limits: { fileSize: maxMB * 1024 * 1024, files: fields?.length ?? 1 },
      fileFilter: (_req, file, cb) => {
        file.originalname = fixName(file.originalname);
        const ext = path.extname(file.originalname).toLowerCase();
        if (ext === '.doc') return cb(new Error('暂不支持旧版 .doc 格式，请在 Word 中“另存为” .docx 后上传'));
        if (!exts.includes(ext)) return cb(new Error(`只支持 ${exts.join('、')} 文件`));
        cb(null, true);
      },
    });
    const up = fields ? uploader.fields(fields.map((name) => ({ name, maxCount: 1 }))) : uploader.single('file');
    up(req, res, (err: unknown) => {
      if (err) {
        const msg =
          err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE'
            ? `文件超过 ${maxMB}MB 上限`
            : (err as Error).message || '上传失败';
        return res.status(400).json({ error: msg });
      }
      next();
    });
  };
}

export const singleUpload = (exts: string[]) => uploadMiddleware(exts);
export const multipleUpload = (exts: string[], fields: string[]) => uploadMiddleware(exts, fields);

/** 把临时文件移入正式目录，返回相对 DATA_DIR 的路径 */
export function storeFile(tmpPath: string, subdir: string, originalName: string): string {
  const ext = path.extname(originalName).toLowerCase();
  const dir = path.join(DATA_DIR, subdir);
  fs.mkdirSync(dir, { recursive: true });
  const rel = path.join(subdir, `${crypto.randomUUID()}${ext}`);
  fs.renameSync(tmpPath, path.join(DATA_DIR, rel));
  return rel.split(path.sep).join('/');
}

export const absPath = (rel: string) => path.join(DATA_DIR, rel);

/** 下载已保存的文件（数据目录可能位于以 . 开头的路径下，需允许 dotfiles） */
export function sendStored(res: Response, rel: string, downloadName: string) {
  const p = absPath(rel);
  if (!fs.existsSync(p)) return res.status(404).json({ error: '文件不存在或已被删除' });
  res.download(p, downloadName, { dotfiles: 'allow' }, (err) => {
    if (err && !res.headersSent) res.status(500).json({ error: '文件下载失败' });
  });
}

export function removeFile(rel?: string | null) {
  if (!rel) return;
  try {
    fs.unlinkSync(absPath(rel));
  } catch {
    /* 文件不存在时忽略 */
  }
}

export function cleanupTmp(file?: Express.Multer.File) {
  if (file?.path) fs.rm(file.path, { force: true }, () => {});
}
