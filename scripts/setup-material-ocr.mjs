import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const win = process.platform === 'win32';
const venv = path.join(root, '.venv-material-ocr');
const configured = process.env.MATERIAL_OCR_PYTHON;
const python = configured || path.join(venv, win ? 'Scripts/python.exe' : 'bin/python');
const probe = ['-c', 'import runpy, sys; runpy.run_path(sys.argv[1])', path.join(root, 'scripts', 'material-ocr.py')];

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', windowsHide: true });
  if (result.error?.code === 'ENOENT') {
    console.error(`[OCR] 找不到 ${command}，请安装 Python 3.11 或 3.12，或检查 MATERIAL_OCR_PYTHON。`);
    process.exit(1);
  }
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (configured) {
  console.log('[OCR] 检查 MATERIAL_OCR_PYTHON 指定的解释器及依赖。');
  run(python, probe);
} else {
  const existing = existsSync(python);
  if (!existing || spawnSync(python, probe, { stdio: 'ignore', windowsHide: true }).status !== 0) {
    console.log('[OCR] 正在准备本地图片识别环境。');
    if (!existing) run(win ? 'python' : 'python3', ['-m', 'venv', venv]);
    run(python, ['-m', 'pip', 'install', '--no-input', '-r', path.join(root, 'scripts', 'material-ocr-requirements.txt')]);
    run(python, probe);
  }
}
console.log('[OCR] 本地图片识别环境已就绪。');
