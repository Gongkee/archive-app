/**
 * 把 index.html 里的内联 module 脚本抽出来做语法检查。
 * 浏览器才不会帮你提前发现拼写错误 —— 手机上直接白屏。
 */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const m = html.match(/<script type="module">([\s\S]*?)<\/script>/);
if (!m) {
  console.error('没找到内联 module 脚本');
  process.exit(1);
}
const dir = mkdtempSync(join(tmpdir(), 'archive-'));
const file = join(dir, 'inline.mjs');
writeFileSync(file, m[1], 'utf8');
try {
  execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  console.log('index.html 内联脚本语法 OK（' + m[1].split('\n').length + ' 行）');
} catch {
  process.exit(1);
}
