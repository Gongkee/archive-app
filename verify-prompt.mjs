/**
 * 拿**真实模型**验证提示词的效果。不是单元测试，改了提示词之后手动跑。
 *
 *   node verify-prompt.mjs
 *
 * 两件事，都是 mock 测不出来的：
 *   1. 模糊数字会不会被"翻译"成精确值 ——「亏了小1万」记成 -10000 就是编造
 *   2. ta 敷衍的时候会不会一直追问、语气够不够热
 *
 * 会读本地 config.json 拿 key。**别把 key 提交进来。**
 */
import fs from 'node:fs';
import { buildSystemPrompt, buildMessages, callUntilUsable, parseModelJSON, applyUpdates } from './archive-core.js';

const cfg = JSON.parse(fs.readFileSync('../personal-archive/config.json', 'utf8'));
const slot = { baseUrl: cfg.chat.baseUrl, apiKey: cfg.chat.apiKey, model: cfg.chat.model };

const EMPTY = `# 我的档案

> 说明

`;

async function turn(md, history, text) {
  const sys = buildSystemPrompt(md, '2026-10-15 周三 21:30', false);
  const r = await callUntilUsable(slot, buildMessages(sys, history, text));
  const o = parseModelJSON(r.content) || r.parsed || {};
  return { reply: (o.reply || '').trim(), updates: Array.isArray(o.updates) ? o.updates : [] };
}

console.log('══════════ 一、模糊数字会不会被"翻译"成精确值 ══════════\n');

const FUZZY = [
  ['今天股市亏了小1万', ['小1万', '小一万', '约1万', '不到1万', '1万左右'], ['-10000', '亏损10000']],
  ['大概花了800块', ['约800', '大概800', '800左右', '大约800'], ['| 800 |']],
  ['昨天睡了六个多小时', ['六个多', '6个多', '6小时多', '6个多小时'], ['| 6小时 |']],
  ['体重快190了', ['快190', '将近190', '接近190', '190左右', '快到190'], ['| 190 |']],
];

const norm = (s) => String(s).replace(/\s+/g, '');
let bad = 0;
for (const [said, good, evil] of FUZZY) {
  const r = await turn(EMPTY, [], said);
  const applied = applyUpdates(EMPTY, r.updates).md;
  const keptFuzzy = good.some((g) => norm(applied).includes(norm(g)));
  const hasFakePrecise = evil.some((e) => norm(applied).includes(norm(e)));
  if (!keptFuzzy || hasFakePrecise) bad++;
  console.log(`我：${said}`);
  console.log(`它：${r.reply}`);
  const lines = applied.split('\n').filter((l) => l.startsWith('|') && !/^\|[\s\-|]+\|$/.test(l) && !l.includes('日期'));
  for (const l of lines) console.log(`    记录 → ${l.trim()}`);
  console.log(`    保留了模糊说法：${keptFuzzy ? '✅' : '❌'}   编出了精确值：${hasFakePrecise ? '❌ 有' : '✅ 没有'}`);
  console.log();
}
console.log(`模糊数字：${FUZZY.length} 条里 ${bad} 条不合格\n`);

console.log('══════════ 二、会不会一直追问、语气够不够热 ══════════\n');

let md = EMPTY;
let history = [];
const CONVO = ['今天上班累死了', '嗯', '还行吧', '不知道', '没什么好说的'];
for (const said of CONVO) {
  const r = await turn(md, history, said);
  md = applyUpdates(md, r.updates).md;
  history.push({ role: 'user', text: said });
  history.push({ role: 'assistant', text: r.reply });
  console.log(`我：${said}`);
  console.log(`它：${r.reply}\n`);
}
