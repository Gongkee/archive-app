/**
 * 模拟 GitHub Pages：把目录当静态站点发出去，然后像浏览器一样把所有资源拉一遍。
 * 验证文件路径、MIME 类型、以及模块能不能被正确解析。
 *
 *   node check-serve.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
};

const srv = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(ROOT, rel === '/' ? 'index.html' : rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});

await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}`;
console.log(`静态服务器: ${base}\n`);

let pass = 0;
let fail = 0;
async function get(p, expectType) {
  const r = await fetch(base + p);
  const ct = r.headers.get('content-type') || '';
  const body = await r.text();
  const okType = !expectType || ct.includes(expectType);
  const ok = r.ok && okType;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${p.padEnd(24)} ${r.status} ${ct} (${body.length}B)`);
  ok ? pass++ : fail++;
  return { r, body };
}

console.log('── 静态资源 ──');
await get('/index.html', 'text/html');
await get('/archive-core.js', 'text/javascript');
await get('/manifest.webmanifest', 'manifest');
await get('/sw.js', 'text/javascript');
await get('/icon-192.png', 'image/png');
await get('/icon-512.png', 'image/png');

console.log('\n── index.html 里的引用是不是都能取到 ──');
const html = (await get('/index.html')).body;
const refs = [...html.matchAll(/(?:href|src)="(?!https?:|data:)([^"]+)"/g)].map((m) => m[1]);
for (const ref of refs) {
  const r = await fetch(`${base}/${ref}`);
  const ok = r.ok;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${ref}`);
  ok ? pass++ : fail++;
}

console.log('\n── 模块能不能被浏览器解析（检查 import/export 名字对得上）──');
{
  const core = (await get('/archive-core.js')).body;
  const im = html.match(/import\s*\{([^}]+)\}\s*from\s*'\.\/archive-core\.js'/);
  assert.ok(im, 'index.html 没有 import');
  const names = im[1].split(',').map((s) => s.trim()).filter(Boolean);
  const ex = core.match(/export\s*\{([\s\S]*?)\};/);
  const exported = ex[1].split(',').map((s) => s.trim()).filter(Boolean);
  let bad = 0;
  for (const n of names) {
    const ok = exported.includes(n);
    if (!ok) {
      console.log(`  FAIL 导出了但 index.html 要的「${n}」不存在`);
      bad++;
    }
  }
  console.log(`  ${bad === 0 ? 'ok  ' : 'FAIL'} 导入 ${names.length} 个，全部匹配`);
  bad === 0 ? pass++ : fail++;
}

console.log('\n── 关键内容抽查 ──');
{
  const core = (await get('/archive-core.js')).body;
  for (const must of ['什么值得记', '绝对不要编', '别说谎', 'MAX_HISTORY', 'runTurn', 'api.github.com']) {
    const ok = core.includes(must);
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} 包含「${must}」`);
    ok ? pass++ : fail++;
  }
}

console.log(`\n通过 ${pass} · 失败 ${fail}\n`);
srv.closeAllConnections?.();
await new Promise((r) => srv.close(r));
process.exitCode = fail ? 1 : 0;
