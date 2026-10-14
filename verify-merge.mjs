/**
 * 拿**真实模型**验证：档案里有重复栏目时，它到底会不会真的清理干净。
 *
 *   node verify-merge.mjs
 *
 * 这个不是单元测试（test.mjs 才是）。它要花钱、结果还跟模型的随机性有关，
 * 所以只在**改了提示词或者改动了档案读写逻辑之后**手动跑一次。
 * 提示词这种东西，mock 测不出好坏 —— 只有真模型能告诉你它听不听话。
 *
 * 会读本地 config.json 拿 key。**别把 key 提交进来。**
 *
 * 判据两条，缺一不可：
 *   1. 清理完还有没有重复栏目
 *   2. 有没有丢掉一条真的记录（这条更重要 —— 少一条重复没关系，少一条记录不行）
 * 不只是看模型发不发 delete —— 而是**真的把它的更新应用到档案上**，
 * 再检查：还有没有重复栏目？有没有丢内容？
 */
import fs from 'node:fs';
import {
  buildSystemPrompt,
  buildMessages,
  callUntilUsable,
  parseModelJSON,
  applyUpdates,
} from './archive-core.js';

const cfg = JSON.parse(fs.readFileSync('../personal-archive/config.json', 'utf8'));
const slot = { baseUrl: cfg.chat.baseUrl, apiKey: cfg.chat.apiKey, model: cfg.chat.model };

const DUP = `# 我的档案

> 这份文件由「档案」自动维护。

## 身体

### 睡眠
| 日期 | 时长 |
|---|---|
| 2026-10-13 | 6小时 |

### 体重
| 日期 | 体重 |
|---|---|
| 2026-10-13 | 190斤 |

## 饮食

| 日期 | 内容 |
|---|---|
| 2026-10-13 | 牛肉面 |

## 睡眠

| 日期 | 时长 |
|---|---|
| 2026-10-13 | 6小时 |
| 2026-10-14 | 7小时 |

## 宠物

| 日期 | 记录 |
|---|---|
| 2026-10-13 | 楼下的橘猫 |

## 东西

| 日期 | 记录 |
|---|---|
| 2026-10-12 | 买了辆摩托车 |

## 宠物

| 日期 | 记录 |
|---|---|
| 2026-10-13 | 楼下的橘猫 |
| 2026-10-14 | 又看见那只狗 |
`;

const ASKS = ['档案里有重复的栏目，帮我整理一下', '合并一下重复的部分', '把多余的删掉'];

/** 用的就是线上那份逻辑 —— 不再自己抄一遍 */
const apply = (md, updates) => applyUpdates(md, updates).md;

function dupNames(md) {
  const names = [...md.matchAll(/^##[ \t]+(.+?)[ \t]*$/gm)].map((m) => m[1]);
  const count = new Map();
  for (const n of names) count.set(n, (count.get(n) || 0) + 1);
  return [...count.entries()].filter(([, c]) => c > 1).map(([n, c]) => `${n}×${c}`);
}

const KEY_CONTENT = ['7小时', '又看见那只狗', '买了辆摩托车', '190斤', '牛肉面'];

const sys = buildSystemPrompt(DUP, '2026-10-15 周三 10:30', false);
console.log(`整理前：「${dupNames(DUP).join('、')}」· 关键内容 ${KEY_CONTENT.length} 条\n`);

let clean = 0;
let lostContent = 0;

for (const ask of ASKS) {
  const r = await callUntilUsable(slot, buildMessages(sys, [], ask));
  const o = parseModelJSON(r.content) || r.parsed;
  const updates = Array.isArray(o?.updates) ? o.updates : [];
  const after = apply(DUP, updates);

  const dup = dupNames(after);
  const lost = KEY_CONTENT.filter((k) => !after.includes(k));
  if (!dup.length) clean++;
  if (lost.length) lostContent++;

  console.log(`══════ 问：「${ask}」`);
  console.log(`  模型回了 ${updates.length} 条更新`);
  console.log(`  整理后重复栏目：${dup.length ? '❌ ' + dup.join('、') : '✅ 没有'}`);
  console.log(`  内容丢失：${lost.length ? '❌ ' + lost.join('、') : '✅ 一条没丢'}`);
  console.log();
}

console.log('────────────────────────');
console.log(`${ASKS.length} 次里：重复清干净 ${clean} 次 · 丢内容 ${lostContent} 次`);
