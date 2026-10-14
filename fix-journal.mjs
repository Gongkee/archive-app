/**
 * 修档案：把重名的栏目合并成一个。
 *
 *   node fix-journal.mjs journal.md              → 写出 journal.md.fixed.md
 *   node fix-journal.mjs journal.md out.md       → 写到指定文件
 *
 * 默认**不覆盖原文件**，先看去重的结果对不对，再自己替换。
 *
 * 合并规则：
 *   - 同名栏目按第一次出现的顺序合并到一起
 *   - 合并后整行完全相同的内容只留一条（表格重复的表头、重复的行会被去掉）
 *   - 其它内容一律原样保留，不排序、不改写、不删东西
 */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const isH2 = (line) => /^##(?!#)/.test(line.trim());

export function mergeDuplicateSections(md) {
  const lines = String(md).split('\n');
  const firstH2 = lines.findIndex(isH2);

  const header = firstH2 === -1 ? lines.slice() : lines.slice(0, firstH2);
  const rest = firstH2 === -1 ? [] : lines.slice(firstH2);

  const sections = [];
  let cur = null;
  for (const l of rest) {
    if (isH2(l)) {
      cur = { name: l.trim().replace(/^##[ \t]+/, '').replace(/[ \t]+$/, ''), lines: [] };
      sections.push(cur);
      continue;
    }
    if (cur) cur.lines.push(l);
    else header.push(l);
  }

  const order = [];
  const byName = new Map();
  for (const s of sections) {
    if (!byName.has(s.name)) {
      byName.set(s.name, []);
      order.push(s.name);
    }
    byName.get(s.name).push(...s.lines);
  }

  const merged = order.filter((n) => byName.get(n).length && sections.filter((s) => s.name === n).length > 1);
  let removed = 0;

  const parts = [];
  for (const name of order) {
    const seen = new Set();
    const kept = [];
    for (const l of byName.get(name)) {
      const t = l.trim();
      if (t && seen.has(t)) {
        removed++;
        continue;
      }
      if (t) seen.add(t);
      kept.push(l);
    }
    while (kept.length && !kept[0].trim()) kept.shift();
    while (kept.length && !kept[kept.length - 1].trim()) kept.pop();
    parts.push(`## ${name}\n\n${kept.join('\n')}\n`);
  }

  const head = header.join('\n').replace(/\s*$/, '') + '\n';
  return {
    md: head + '\n' + parts.join('\n'),
    merged,
    removedLines: removed,
    totalSections: sections.length,
    uniqueSections: order.length,
  };
}

// 直接跑的时候才执行；被 import 的时候不执行
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const input = process.argv[2];
  if (!input) {
    console.error('用法: node fix-journal.mjs <journal.md> [输出文件]');
    process.exit(1);
  }
  const output = process.argv[3] || input + '.fixed.md';

  const src = fs.readFileSync(input, 'utf8');
  const r = mergeDuplicateSections(src);

  console.log(`原始：${r.totalSections} 个栏目`);
  console.log(`合并后：${r.uniqueSections} 个栏目`);
  if (r.merged.length) {
    console.log(`合并了重复的：${r.merged.join('、')}`);
    console.log(`去掉了 ${r.removedLines} 行完全重复的内容`);
  } else {
    console.log('没有重名栏目 ✓');
  }

  if (r.md === src) {
    console.log('\n内容没有变化，不写文件。');
  } else {
    fs.writeFileSync(output, r.md, 'utf8');
    console.log(`\n已写出：${output}`);
    console.log('自己看一眼，确认没问题再替换原文件。');
  }
}
