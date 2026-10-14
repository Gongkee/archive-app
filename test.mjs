/**
 * 档案核心的回归测试。跑这个，不要靠肉眼。
 *
 *   node test.mjs
 *
 * 网络全部 mock 掉：GitHub 用假响应，模型也用假响应。
 * 所以 runTurn 这条最关键的链路能被完整验证。
 */
import assert from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import * as core from './archive-core.js';
import { mergeDuplicateSections } from './fix-journal.mjs';
import {
  MAX_HISTORY,
  DEFAULT_TIMEOUT_MS,
  STORAGE_BUDGET,
  fetchWithTimeout,
  normalizeBaseUrl,
  applyThinking,
  isDeepSeek,
  buildMessages,
  parseModelJSON,
  salvageReply,
  replaceSection,
  removeSection,
  dedupeSection,
  dedupeAllSections,
  applyUpdates,
  runTurn,
  localNow,
  parseDataUrl,
  stripImagesForRetry,
  storageSnapshot,
  b64ToText,
  textToB64,
} from './archive-core.js';

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    console.log('  ok   ' + name);
    pass++;
  } catch (e) {
    console.log('  FAIL ' + name + '\n       ' + e.message);
    fail++;
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    console.log('  ok   ' + name);
    pass++;
  } catch (e) {
    console.log('  FAIL ' + name + '\n       ' + e.message);
    fail++;
  }
}

const countH2 = (md, name) => (md.match(new RegExp(`^##[ \\t]+${name}[ \\t]*$`, 'gm')) || []).length;
const HEAD = '# 我的档案\n\n> 说明\n\n';

// ═══════════════════════════════ mock 网络

const jsonRes = (status, obj) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null },
  text: async () => JSON.stringify(obj),
  json: async () => obj,
});

function installFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = opts.method || 'GET';
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url: u, method, body });
    for (const r of routes) {
      const res = r(u, method, body, calls);
      if (res) return res;
    }
    throw new Error('没有 mock 路由匹配: ' + method + ' ' + u);
  };
  return calls;
}

/** 造一个假的模型回复 */
const modelSays = (obj) => jsonRes(200, { choices: [{ message: { role: 'assistant', content: JSON.stringify(obj) } }], usage: {} });

const GH = { token: 't', owner: 'me', repo: 'journal', branch: 'main', journalPath: 'journal.md' };
const CFG = {
  github: GH,
  chat: { baseUrl: 'https://api.example.com/v1', apiKey: 'k', model: 'm' },
  vision: { baseUrl: '', apiKey: '', model: '' },
};

// ═══════════════════════════════ 栏目读写

console.log('\n── 栏目读写 ──');

check('新栏目会建出来', () => {
  const md = replaceSection(HEAD, '心情', '### 记录\n| 有点烦 |');
  assert.strictEqual(countH2(md, '心情'), 1);
  assert.ok(md.includes('| 有点烦 |'));
});

check('更新已有栏目，不会多出一个', () => {
  let md = replaceSection(HEAD, '心情', '### 记录\n| 有点烦 |');
  md = replaceSection(md, '心情', '### 记录\n| 有点烦 |\n| 累死了 |');
  assert.strictEqual(countH2(md, '心情'), 1);
  assert.ok(md.includes('累死了'));
});

check('模型把 ## 标题塞进 content 时也不重复（真实踩过）', () => {
  let md = replaceSection(HEAD, '心情', '### 记录\n| 有点烦 |');
  md = replaceSection(md, '心情', '## 心情\n\n### 记录\n| 有点烦 |\n| 累死了 |');
  assert.strictEqual(countH2(md, '心情'), 1);
  assert.ok(md.includes('累死了') && md.includes('有点烦'));
});

check('多个栏目交织更新，顺序和数量都稳', () => {
  let md = HEAD;
  md = replaceSection(md, '饮食', '### 记录\n| 面 |');
  md = replaceSection(md, '心情', '### 记录\n| 有点烦 |');
  md = replaceSection(md, '工作', '### 记录\n| 加班 |');
  md = replaceSection(md, '饮食', '### 记录\n| 面 |\n| 火锅 |');
  md = replaceSection(md, '心情', '### 记录\n| 有点烦 |\n| 累死了 |');
  for (const n of ['饮食', '心情', '工作']) assert.strictEqual(countH2(md, n), 1, n + ' 重复了');
  assert.ok(md.indexOf('## 饮食') < md.indexOf('## 心情'));
  assert.ok(md.indexOf('## 心情') < md.indexOf('## 工作'));
});

check('三级标题不会被误当成栏目', () => {
  const md = replaceSection(HEAD, '身体', '### 体重\n| 150斤 |');
  assert.strictEqual(countH2(md, '体重'), 0);
});

check('正文中间的 ## 标题必须剥掉（重复栏目就是这么来的）', () => {
  let md = replaceSection(HEAD, '身体', '### 体重\n| 150斤 |');
  // 模型把别的栏目标题写进了正文中间 —— 以前只剥开头的，这个会漏过去
  md = replaceSection(md, '身体', '### 体重\n| 151斤 |\n\n## 睡眠\n| 6小时 |');
  assert.strictEqual(countH2(md, '睡眠'), 0, '凭空长出了一个「睡眠」栏目');
  assert.strictEqual(countH2(md, '身体'), 1);
  assert.ok(md.includes('| 6小时 |'), '内容不该丢，只是那个标题该被剥掉');
});

check('剥掉中间标题后，后面的真栏目不会被卷进去', () => {
  let md = replaceSection(HEAD, '身体', '| a |');
  md = replaceSection(md, '工作', '| b |');
  md = replaceSection(md, '身体', '| a2 |\n\n## 心情\n| c |');
  assert.strictEqual(countH2(md, '工作'), 1, '工作栏目被那个假标题吞掉了');
  assert.ok(md.includes('| b |'), '工作栏目的内容丢了');
});

// ═══════════════════════════════ 历史拼装

console.log('\n── 删栏目（合并重复时必须用）──');

check('能整个删掉一个栏目', () => {
  let md = replaceSection(HEAD, '心情', '| a |');
  md = replaceSection(md, '工作', '| b |');
  md = removeSection(md, '心情');
  assert.strictEqual(countH2(md, '心情'), 0);
  assert.strictEqual(countH2(md, '工作'), 1, '不该误删别的栏目');
  assert.ok(md.includes('| b |'));
});

check('删栏目不会误伤同名的三级小节', () => {
  let md = replaceSection(HEAD, '身体', '### 睡眠\n| 6小时 |');
  md = replaceSection(md, '睡眠', '| 10-13 | 6小时 |');
  md = removeSection(md, '睡眠');
  assert.strictEqual(countH2(md, '睡眠'), 0, '顶层「睡眠」没删掉');
  assert.ok(/### 睡眠/.test(md), '身体下面的「### 睡眠」小节被误删了');
  assert.ok(md.includes('| 6小时 |'));
});

check('删最后一个栏目不会吃掉前面的内容', () => {
  let md = replaceSection(HEAD, '心情', '| a |');
  md = replaceSection(md, '工作', '| b |');
  md = removeSection(md, '工作');
  assert.ok(md.includes('| a |'), '前面栏目的内容丢了');
  assert.strictEqual(countH2(md, '工作'), 0);
});

check('删不存在的栏目 = 原样不动', () => {
  const md = replaceSection(HEAD, '心情', '| a |');
  assert.strictEqual(removeSection(md, '根本没有'), md);
});

console.log('\n── 合并重复栏目（全都是真踩过的）──');

const DUPED = HEAD + '## 宠物\n\n| 橘猫 |\n\n## 东西\n\n| 摩托 |\n\n## 宠物\n\n| 橘猫 |\n| 狗 |\n';

check('dedupeSection 并成一个，且不丢独有的行', () => {
  const r = dedupeSection(DUPED, '宠物');
  assert.strictEqual(countH2(r.md, '宠物'), 1);
  assert.ok(r.md.includes('| 狗 |'), '重复栏目里独有的行被删没了');
  assert.ok(r.md.includes('| 摩托 |'), '别的栏目被误伤');
});

check('合并时不会把重复栏目的标题本身并进正文（会又造一个重复）', () => {
  const r = dedupeSection(DUPED, '宠物');
  assert.strictEqual(countH2(r.md, '宠物'), 1, '标题被当正文并进去了');
});

check('dedupeAllSections 扫全篇，不管重复的是哪个栏目', () => {
  const md = HEAD + '## 甲\n\n| 1 |\n\n## 乙\n\n| 2 |\n\n## 甲\n\n| 3 |\n\n## 乙\n\n| 4 |\n';
  const r = dedupeAllSections(md);
  assert.strictEqual(countH2(r.md, '甲'), 1);
  assert.strictEqual(countH2(r.md, '乙'), 1);
  for (const v of ['| 1 |', '| 2 |', '| 3 |', '| 4 |']) assert.ok(r.md.includes(v), v + ' 丢了');
  assert.deepStrictEqual(r.merged.sort(), ['乙', '甲'].sort());
});

check('同一个栏目既写又删时，写赢（删会连新内容一起删掉）', () => {
  // 模型表达「宠物重复了，合成一个」就是这么发的
  const r = applyUpdates(DUPED, [
    { section: '宠物', content: '| 橘猫 |' },
    { section: '宠物', delete: true },
  ]);
  assert.strictEqual(countH2(r.md, '宠物'), 1, '重复没清掉');
  assert.ok(r.md.includes('| 狗 |'), '删操作把独有内容弄丢了');
});

check('模型没碰过的重复栏目，也会被全篇扫掉', () => {
  const r = applyUpdates(DUPED, [{ section: '东西', content: '| 摩托 |\n| 头盔 |' }]);
  assert.strictEqual(countH2(r.md, '宠物'), 1, '模型没碰「宠物」，重复就留下来了');
  assert.ok(r.md.includes('| 狗 |'), '顺手去重不该丢内容');
  assert.ok(r.md.includes('| 头盔 |'), '这次的更新没写进去');
});

check('真的删除（没有配套内容）照常生效', () => {
  const md = replaceSection(HEAD, '临时', '| x |');
  const r = applyUpdates(md, [{ section: '临时', delete: true }]);
  assert.strictEqual(countH2(r.md, '临时'), 0);
});

console.log('\n── 对话历史拼装 ──');

check('assistant 历史必须是 JSON 形状（塞散文会让模型跟着不守格式）', () => {
  const msgs = buildMessages(
    'SYS',
    [
      { role: 'user', text: '刚下班' },
      { role: 'assistant', text: '怎么个累法？' },
      { role: 'user', text: '开了四个小时的会' },
      { role: 'assistant', text: '先去喝口水吧。' },
    ],
    '现在几点了'
  );
  const assistants = msgs.filter((m) => m.role === 'assistant');
  assert.strictEqual(assistants.length, 2);
  for (const a of assistants) {
    const parsed = JSON.parse(a.content);
    assert.ok(parsed.reply && Array.isArray(parsed.updates));
  }
});

check('历史要截短 —— 留太长模型就不记东西了（实测 3/14 → 13/14）', () => {
  const long = [];
  for (let i = 0; i < 20; i++) {
    long.push({ role: 'user', text: 'u' + i });
    long.push({ role: 'assistant', text: 'a' + i });
  }
  const msgs = buildMessages('SYS', long, '这轮');
  assert.strictEqual(msgs.length, 1 + MAX_HISTORY + 1);
  assert.strictEqual(msgs[1].content, 'u17');
  assert.strictEqual(msgs.at(-1).content, '这轮');
});

check('没文字的条目不占历史额度', () => {
  const msgs = buildMessages('SYS', [{ role: 'user', text: '' }, { role: 'assistant', text: '' }, { role: 'user', text: '在' }], '你好');
  assert.strictEqual(msgs.length, 3);
});

// ═══════════════════════════════ 模型输出解析

console.log('\n── 模型输出解析 ──');

check('正常 JSON', () => assert.deepStrictEqual(parseModelJSON('{"reply":"嗯"}'), { reply: '嗯' }));
check('带 ``` 围栏也能解析', () => assert.deepStrictEqual(parseModelJSON('```json\n{"reply":"嗯"}\n```'), { reply: '嗯' }));
check('前后有废话也能解析', () => assert.deepStrictEqual(parseModelJSON('好的：{"reply":"嗯"} 以上'), { reply: '嗯' }));
check('字符串里有裸换行也能修好（模型常犯）', () => {
  const o = parseModelJSON('{"reply":"记下了。","updates":[{"section":"饮食","content":"| a |\n| b |"}]}');
  assert.ok(o, '没解析出来');
  assert.strictEqual(o.updates[0].content, '| a |\n| b |');
});
check('末尾多余逗号也能修好', () => assert.deepStrictEqual(parseModelJSON('{"reply":"嗯",}'), { reply: '嗯' }));
check('真的坏了就返回 null', () => {
  assert.strictEqual(parseModelJSON('{'), null);
  assert.strictEqual(parseModelJSON(''), null);
});

console.log('\n── 模型输出兜底 ──');

check('从残缺 JSON 里抠出 reply', () => {
  assert.strictEqual(salvageReply('{"reply": "记下了。\\n你呢？", "updates": ['), '记下了。\n你呢？');
});
check('纯散文原样返回', () => assert.strictEqual(salvageReply('嗯，今天怎么样？'), '嗯，今天怎么样？'));
check('单个 { 这种残渣绝不能露给用户（真实踩过）', () => assert.strictEqual(salvageReply('{'), ''));
check('残缺 JSON 片段不能露给用户', () => {
  assert.strictEqual(salvageReply('"updates": []'), '');
  assert.strictEqual(salvageReply('{"reply": "'), '');
});
check('空白返回空', () => assert.strictEqual(salvageReply('      '), ''));

// ═══════════════════════════════ base64

console.log('\n── base64 编解码 ──');

check('中文和 emoji 能原样往返（GitHub 存的就是这个）', () => {
  const s = '# 我的档案\n体重 150 斤 🍜\n心情：还行 — 就这样\n';
  assert.strictEqual(b64ToText(textToB64(s)), s);
});
check('空字符串', () => assert.strictEqual(b64ToText(textToB64('')), ''));

// ═══════════════════════════════ 端到端：runTurn

console.log('\n── 端到端（GitHub 和模型全 mock）──');

await checkAsync('第一次用：日记还不存在 → 新建，并把内容写进 GitHub', async () => {
  const puts = [];
  installFetch([
    (u, m) => (u.includes('/contents/journal.md') && m === 'GET' ? jsonRes(404, { message: 'Not Found' }) : null),
    (u, m, b) => {
      if (u.includes('/contents/journal.md') && m === 'PUT') {
        puts.push(b);
        return jsonRes(200, { content: { sha: 'sha1' } });
      }
      return null;
    },
    (u) => (u.includes('/chat/completions') ? modelSays({ reply: '记上了。空腹吗？', updates: [{ section: '身体', content: '### 体重\n| 日期 | 体重 |\n|---|---|\n| 10-14 | 150斤 |' }] }) : null),
  ]);

  const r = await runTurn(CFG, [], { text: '刚称的体重，150斤', images: [] });
  assert.strictEqual(r.reply, '记上了。空腹吗？');
  assert.strictEqual(r.updated, true);
  assert.strictEqual(puts.length, 1, '应该提交一次');

  const written = b64ToText(puts[0].content);
  assert.ok(written.startsWith('# 我的档案'), '档案头丢了');
  assert.ok(written.includes('## 身体'), '栏目没写进去');
  assert.ok(written.includes('150斤'), '数据没写进去');
  assert.ok(puts[0].sha === undefined, '新建文件不该带 sha');
});

await checkAsync('已有档案 → 带上 sha 更新，旧内容不丢', async () => {
  const existing = HEAD + '## 心情\n\n| 日期 | 记录 |\n|---|---|\n| 10-13 | 有点烦 |\n';
  const puts = [];
  installFetch([
    (u, m) => (u.includes('/contents/journal.md') && m === 'GET' ? jsonRes(200, { content: textToB64(existing), sha: 'sha-old' }) : null),
    (u, m, b) => {
      if (u.includes('/contents/journal.md') && m === 'PUT') {
        puts.push(b);
        return jsonRes(200, { content: { sha: 'sha-new' } });
      }
      return null;
    },
    (u) => (u.includes('/chat/completions') ? modelSays({ reply: '怎么了？', updates: [{ section: '工作', content: '| 日期 | 记录 |\n|---|---|\n| 10-14 | 开了四小时会 |' }] }) : null),
  ]);

  const r = await runTurn(CFG, [], { text: '开了四个小时的会', images: [] });
  assert.strictEqual(r.updated, true);
  assert.strictEqual(puts[0].sha, 'sha-old', '更新时必须带上原文件的 sha');

  const written = b64ToText(puts[0].content);
  assert.ok(written.includes('有点烦'), '旧栏目的内容丢了');
  assert.ok(written.includes('开了四小时会'), '新内容没写进去');
  assert.strictEqual(countH2(written, '心情'), 1);
  assert.strictEqual(countH2(written, '工作'), 1);
});

await checkAsync('合并重复栏目：改内容 + 删多余，一轮真的做完（真实踩过）', async () => {
  const before =
    HEAD +
    '## 身体\n\n### 睡眠\n| 10-13 | 6小时 |\n\n' +
    '## 睡眠\n\n| 10-13 | 6小时 |\n| 10-14 | 7小时 |\n\n' +
    '## 工作\n\n| 加班 |\n';
  const puts = [];
  installFetch([
    (u, m) => (u.includes('/contents/journal.md') && m === 'GET' ? jsonRes(200, { content: textToB64(before), sha: 's' }) : null),
    (u, m, b) => {
      if (u.includes('/contents/journal.md') && m === 'PUT') {
        puts.push(b);
        return jsonRes(200, { content: { sha: 'n' } });
      }
      return null;
    },
    (u) =>
      u.includes('/chat/completions')
        ? modelSays({
            reply: '合并好了。',
            updates: [
              { section: '身体', content: '### 睡眠\n| 10-13 | 6小时 |\n| 10-14 | 7小时 |' },
              { section: '睡眠', delete: true },
            ],
          })
        : null,
  ]);

  const r = await runTurn(CFG, [], { text: '合并', images: [] });
  assert.strictEqual(r.updated, true, '说了合并就必须真的写进去');
  const after = b64ToText(puts[0].content);
  assert.strictEqual(countH2(after, '睡眠'), 0, '顶层「睡眠」没被删掉');
  assert.strictEqual(countH2(after, '身体'), 1);
  assert.ok(after.includes('7小时'), '合并后的内容没带上');
  assert.ok(after.includes('| 加班 |'), '工作栏目被误删');
  assert.ok(/### 睡眠/.test(after), '身体下面的小节被误删了');
});

await checkAsync('档案在别处被改过 → 自动重读重放，两边内容都保住', async () => {
  const first = HEAD + '## 心情\n\n| 日期 | 记录 |\n|---|---|\n| 10-13 | 有点烦 |\n';
  const elsewhere = first + '\n## 想法\n\n| 日期 | 记录 |\n|---|---|\n| 10-14 | 别人加的 |\n';

  let getCount = 0;
  const puts = [];
  installFetch([
    (u, m) => {
      if (u.includes('/contents/journal.md') && m === 'GET') {
        getCount++;
        return jsonRes(200, { content: textToB64(getCount === 1 ? first : elsewhere), sha: 'sha' + getCount });
      }
      return null;
    },
    (u, m, b) => {
      if (u.includes('/contents/journal.md') && m === 'PUT') {
        puts.push(b);
        // 第一次故意撞车
        return puts.length === 1 ? jsonRes(409, { message: 'sha does not match' }) : jsonRes(200, { content: { sha: 'ok' } });
      }
      return null;
    },
    (u) => (u.includes('/chat/completions') ? modelSays({ reply: '哦？', updates: [{ section: '工作', content: '| 日期 | 记录 |\n|---|---|\n| 10-14 | 开会 |' }] }) : null),
  ]);

  const r = await runTurn(CFG, [], { text: '开了个会', images: [] });
  assert.strictEqual(r.updated, true, '重试之后应该成功');
  assert.strictEqual(puts.length, 2, '应该提交两次（一次撞车一次成功）');
  assert.strictEqual(getCount, 2, '撞车后应该重读');

  const written = b64ToText(puts[1].content);
  assert.ok(written.includes('别人加的'), '别处加的内容被覆盖了！');
  assert.ok(written.includes('有点烦'), '原有内容丢了');
  assert.ok(written.includes('开会'), '这次的内容没写进去');
});

await checkAsync('模型说没事可记 → 不提交任何东西', async () => {
  const puts = [];
  installFetch([
    (u, m) => (u.includes('/contents/journal.md') && m === 'GET' ? jsonRes(200, { content: textToB64(HEAD), sha: 's' }) : null),
    (u, m, b) => {
      if (u.includes('/contents/journal.md') && m === 'PUT') {
        puts.push(b);
        return jsonRes(200, { content: { sha: 'x' } });
      }
      return null;
    },
    (u) => (u.includes('/chat/completions') ? modelSays({ reply: '在的。', updates: [] }) : null),
  ]);
  const r = await runTurn(CFG, [], { text: '在吗', images: [] });
  assert.strictEqual(r.reply, '在的。');
  assert.strictEqual(r.updated, false);
  assert.strictEqual(puts.length, 0, '不该产生空提交');
});

await checkAsync('模型吐空白 → 换条件重试后仍能拿到回复', async () => {
  let calls = 0;
  installFetch([
    (u, m) => (u.includes('/contents/journal.md') && m === 'GET' ? jsonRes(200, { content: textToB64(HEAD), sha: 's' }) : null),
    (u) => {
      if (!u.includes('/chat/completions')) return null;
      calls++;
      return calls === 1
        ? jsonRes(200, { choices: [{ message: { role: 'assistant', content: '      ' } }], usage: {} })
        : modelSays({ reply: '嗯，我在。', updates: [] });
    },
  ]);
  const r = await runTurn(CFG, [], { text: '在吗', images: [] });
  assert.strictEqual(r.reply, '嗯，我在。');
  assert.ok(calls >= 2, '应该重试过');
});

await checkAsync('模型回复是 JSON 残渣 → 不能露给用户', async () => {
  let calls = 0;
  installFetch([
    (u, m) => (u.includes('/contents/journal.md') && m === 'GET' ? jsonRes(200, { content: textToB64(HEAD), sha: 's' }) : null),
    (u) => {
      if (!u.includes('/chat/completions')) return null;
      calls++;
      return calls === 1
        ? modelSays({ reply: '{', updates: [] })
        : modelSays({ reply: '在的。', updates: [] });
    },
  ]);
  const r = await runTurn(CFG, [], { text: '在吗', images: [] });
  assert.strictEqual(r.reply, '在的。');
});

await checkAsync('GitHub 令牌无效 → 报清楚，而不是静默失败', async () => {
  installFetch([(u, m) => (u.includes('/contents/journal.md') && m === 'GET' ? jsonRes(401, { message: 'Bad credentials' }) : null)]);
  await assert.rejects(() => runTurn(CFG, [], { text: '你好', images: [] }), /令牌无效/);
});

await checkAsync('档案写不进去时，回复照样给用户（不能连话都丢了）', async () => {
  installFetch([
    (u, m) => (u.includes('/contents/journal.md') && m === 'GET' ? jsonRes(200, { content: textToB64(HEAD), sha: 's' }) : null),
    (u, m) => (u.includes('/contents/journal.md') && m === 'PUT' ? jsonRes(500, { message: '服务器炸了' }) : null),
    (u) => (u.includes('/chat/completions') ? modelSays({ reply: '记上了。', updates: [{ section: '身体', content: '| a |' }] }) : null),
  ]);
  const r = await runTurn(CFG, [], { text: '体重150斤', images: [] });
  assert.strictEqual(r.reply, '记上了。', '回复被写失败连累丢了 —— 这正是要防的');
  assert.strictEqual(r.updated, false);
  assert.ok(r.writeError, '应该标明这轮没写进去');
});

await checkAsync('图片存不上去也不影响这轮对话，且不会往档案里写死链', async () => {
  let chatBody = null;
  installFetch([
    (u, m) => (u.includes('/contents/journal.md') && m === 'GET' ? jsonRes(404, { message: 'Not Found' }) : null),
    (u, m) => (u.includes('/contents/images/') && m === 'PUT' ? jsonRes(500, { message: '炸了' }) : null),
    (u, m, b) => {
      if (!u.includes('/chat/completions')) return null;
      chatBody = b;
      return modelSays({ reply: '看不清', updates: [] });
    },
  ]);
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const cfgV = { ...CFG, vision: { baseUrl: 'https://v.example.com/v1', apiKey: 'vk', model: 'vm' } };
  const r = await runTurn(cfgV, [], { text: '', images: [png] });
  assert.strictEqual(r.reply, '看不清');
  assert.deepStrictEqual(r.images, [], '存不上的图片不该出现在返回结果里');
  const textPart = chatBody.messages.at(-1).content.find((p) => p.type === 'text');
  assert.ok(!/images\//.test(textPart.text), '不该给模型一条会变成死链的路径：' + textPart.text);
});

await checkAsync('图片会先存进 GitHub，路径再交给模型', async () => {
  const puts = [];
  let sentBody = null;
  installFetch([
    (u, m) => (u.includes('/contents/journal.md') && m === 'GET' ? jsonRes(404, { message: 'Not Found' }) : null),
    (u, m, b) => {
      if (m === 'PUT') {
        puts.push({ u, b });
        return jsonRes(200, { content: { sha: 'x' } });
      }
      return null;
    },
    (u, m, b) => {
      if (u.includes('/chat/completions')) {
        sentBody = b;
        return modelSays({ reply: '这是什么？', updates: [] });
      }
      return null;
    },
  ]);

  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const cfgV = { ...CFG, vision: { baseUrl: 'https://v.example.com/v1', apiKey: 'vk', model: 'vm' } };
  const r = await runTurn(cfgV, [], { text: '', images: [png] });

  assert.strictEqual(r.reply, '这是什么？');
  const imgPut = puts.find((p) => p.u.includes('/contents/images/'));
  assert.ok(imgPut, '图片没存进 GitHub');
  assert.ok(imgPut.u.includes('.png'), '扩展名不对');

  // 有视觉模型时，应该走视觉槽位，并且真的把图片交过去
  assert.ok(sentBody.model === 'vm', '没走视觉模型');
  const userMsg = sentBody.messages.at(-1);
  assert.ok(Array.isArray(userMsg.content), '图片应该以数组形式发过去');
  assert.ok(userMsg.content.some((p) => p.type === 'image_url'), '图片没带上');
});

await checkAsync('模型用别的字段表达删除时，必须留下痕迹而不是闷掉（真实踩过）', async () => {
  installFetch([
    (u, m) => (u.includes('/contents/journal.md') && m === 'GET' ? jsonRes(200, { content: textToB64(HEAD), sha: 's' }) : null),
    (u) =>
      u.includes('/chat/completions')
        ? modelSays({ reply: '合并好了。', updates: [{ section: '睡眠', action: 'delete' }] })
        : null,
  ]);

  const r = await runTurn(CFG, [], { text: '合并', images: [] });
  assert.strictEqual(r.updated, false, '这条本来就没法执行，不该说写成功了');
  assert.strictEqual(r.skippedUpdates.length, 1, '看不懂的更新必须被记下来，否则以后查都没法查');
  assert.ok(/睡眠/.test(r.skippedUpdates[0]), '要指出是哪一条：' + r.skippedUpdates[0]);
});

await checkAsync('视觉栏留空 → 图片自动交给聊天模型', async () => {
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  let sent = null;
  installFetch([
    (u, m) => (m === 'GET' ? jsonRes(200, { content: textToB64(HEAD), sha: 's1' }) : null),
    (u, m, b) => {
      if (u.includes('/contents/images/') && m === 'PUT') return jsonRes(200, { content: { sha: 'x' } });
      if (u.includes('/contents/journal.md') && m === 'PUT') return jsonRes(200, { content: { sha: 's2' } });
      return null;
    },
    (u, m, b) => {
      if (u.includes('/chat/completions')) {
        sent = b;
        return modelSays({ reply: '看到了', updates: [] });
      }
      return null;
    },
  ]);

  // vision 三栏全空（test.mjs 的 CFG 本来就是空的），只有聊天模型
  const r = await runTurn(CFG, [], { text: '', images: [png] });
  assert.strictEqual(r.reply, '看到了');
  assert.ok(sent, '没发出模型请求');
  assert.strictEqual(sent.model, 'm', '应该用聊天模型');
  const last = sent.messages.at(-1);
  assert.ok(Array.isArray(last.content), '留空时图片也必须以数组形式发出去');
  assert.ok(last.content.some((p) => p.type === 'image_url'), '留空时图片没带上');
});

// ═══════════════════════════════ 超时
console.log('\n── 超时（不给超时就会永远卡在「在想。。」）──');

await checkAsync('接口不回时，fetchWithTimeout 会明确超时，不会死等', async () => {
  const real = globalThis.fetch;
  // 模拟半死不活的连接：既不响应，也不报错
  globalThis.fetch = (url, opts = {}) =>
    new Promise((_, reject) => {
      opts.signal?.addEventListener('abort', () => {
        const e = new Error('aborted');
        e.name = 'AbortError';
        reject(e);
      });
    });
  try {
    await assert.rejects(
      () => fetchWithTimeout('https://api.example.com/v1/chat/completions', {}, 40),
      (err) => {
        assert.ok(err.timeout, '超时错误应该带 timeout 标记');
        assert.match(err.message, /40 秒|没有响应/);
        return true;
      }
    );
  } finally {
    globalThis.fetch = real;
  }
});

await checkAsync('正常响应照常返回，超时器不会误伤', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => 'ok' });
  try {
    const r = await fetchWithTimeout('https://api.example.com/x', {}, 500);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(await r.text(), 'ok');
  } finally {
    globalThis.fetch = real;
  }
});

check('默认超时是一个有限的正数', () => {
  assert.ok(Number.isFinite(DEFAULT_TIMEOUT_MS), '默认超时必须是有限数字，否则等于没超时');
  assert.ok(DEFAULT_TIMEOUT_MS > 0 && DEFAULT_TIMEOUT_MS <= 300000);
});

// 手机上报错只给一句「Load failed」，分不出是 GitHub 还是模型挂了 —— 必须说清是谁
console.log('\n── 拨不通的时候要说清是谁 ──');

const deadFetch = (name) => {
  const real = globalThis.fetch;
  globalThis.fetch = () => {
    const e = new TypeError(name);
    return Promise.reject(e);
  };
  return () => {
    globalThis.fetch = real;
  };
};

await checkAsync('拨不通时带上标签和主机名，不再只有一句 Load failed', async () => {
  const restore = deadFetch('Load failed');
  try {
    await assert.rejects(
      () => fetchWithTimeout('https://api.example.com/v1/chat/completions', {}, 500, '模型接口（m）'),
      (err) => {
        assert.ok(!err.timeout, '这不是超时，别标成超时');
        assert.match(err.message, /连不上模型接口（m）/);
        assert.match(err.message, /api\.example\.com/, '得带上主机名，不然还是不知道连的谁');
        assert.match(err.message, /Load failed/, '原始信息不能丢');
        return true;
      }
    );
  } finally {
    restore();
  }
});

await checkAsync('runTurn 里模型拨不通 → 报的是模型，不是 GitHub', async () => {
  const restore = deadFetch('Load failed');
  try {
    // GitHub 走通，只有模型接口拨不通
    globalThis.fetch = (u) =>
      String(u).includes('github.com')
        ? Promise.resolve(jsonRes(200, { content: textToB64(HEAD), sha: 's' }))
        : Promise.reject(new TypeError('Load failed'));
    await assert.rejects(() => runTurn(CFG, [], { text: '你好', images: [] }), (err) => {
      assert.match(err.message, /连不上模型接口/, '应该指出是模型接口：' + err.message);
      assert.ok(!/GitHub/.test(err.message), '别冤枉 GitHub：' + err.message);
      return true;
    });
  } finally {
    restore();
  }
});

await checkAsync('GitHub 拨不通 → 报的是 GitHub', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (u) => {
    if (String(u).includes('github.com')) return Promise.reject(new TypeError('Load failed'));
    return Promise.resolve(jsonRes(200, { choices: [{ message: { content: '{}' } }], usage: {} }));
  };
  try {
    await assert.rejects(() => runTurn(CFG, [], { text: '你好', images: [] }), (err) => {
      assert.match(err.message, /连不上 GitHub/, '应该指出是 GitHub：' + err.message);
      return true;
    });
  } finally {
    globalThis.fetch = real;
  }
});

check('核心逻辑里只有一处 fetch，且必须带超时（裸 fetch 会死等）', () => {
  const src = readFileSync(new URL('./archive-core.js', import.meta.url), 'utf8');
  // 数**所有** fetch 调用。以前用 lookbehind 排除 `.fetch(`，结果
  // `() => fetch(` 也被一起排除了 —— 断言是绿的，但漏了真的裸 fetch。
  const all = [...src.matchAll(/\bfetch\s*\(/g)].map((m) => m.index);
  // 唯一允许的那一处，必须在 fetchWithTimeout 里面
  const decl = src.search(/(?:async\s+)?function\s+fetchWithTimeout\b/);
  assert.ok(decl >= 0, '找不到 fetchWithTimeout');
  const bodyStart = src.indexOf('{', decl);
  const bodyEnd = src.indexOf('\n}', bodyStart);
  assert.ok(bodyStart > 0 && bodyEnd > bodyStart, 'fetchWithTimeout 的函数体没解析出来');

  const outside = all.filter((i) => i < bodyStart || i > bodyEnd);
  assert.strictEqual(
    outside.length,
    0,
    `fetchWithTimeout 之外还有 ${outside.length} 处 fetch：` +
      outside.map((i) => JSON.stringify(src.slice(i - 40, i + 30))).join(' | ')
  );
  assert.strictEqual(all.length, 1, `整个文件应该只有一处 fetch，实际 ${all.length} 处`);
});

check('DeepSeek 关掉思考模式（否则只读 content 会一直转圈）', () => {
  const b = applyThinking({ model: 'deepseek-flash' }, 'https://api.deepseek.com/v1');
  assert.deepStrictEqual(b.thinking, { type: 'disabled' });
});

check('别家厂商不发 thinking 参数（非标准参数会 400）', () => {
  const other = applyThinking(
    { model: 'qwen-vl-max' },
    'https://dashscope.aliyuncs.com/compatible-mode/v1'
  );
  assert.ok(!('thinking' in other), '给通义发了 thinking 参数，可能直接 400');
});

check('正确识别 DeepSeek 域名', () => {
  assert.ok(isDeepSeek('https://api.deepseek.com'));
  assert.ok(isDeepSeek('https://api.deepseek.com/v1'));
  assert.ok(isDeepSeek('https://deepseek.com/v1'), '不带 api. 前缀的也要认');
  assert.ok(isDeepSeek('https://api.deepseek.com:443/v1'), '带端口也要认');
  assert.ok(!isDeepSeek('https://api.deepseek.com.evil.com/v1'), '域名后缀不能误判');
  assert.ok(!isDeepSeek('https://notdeepseek.com/v1'), '前缀边界不能误判');
  assert.ok(!isDeepSeek('https://api.moonshot.cn/v1'));
  assert.ok(!isDeepSeek(''));
});

check('接口地址归一：deepseek 补上 /v1，其它原样', () => {
  assert.strictEqual(normalizeBaseUrl('https://api.deepseek.com'), 'https://api.deepseek.com/v1');
  assert.strictEqual(normalizeBaseUrl('https://api.deepseek.com/'), 'https://api.deepseek.com/v1');
  assert.strictEqual(normalizeBaseUrl('https://api.deepseek.com/v1'), 'https://api.deepseek.com/v1');
  assert.strictEqual(
    normalizeBaseUrl('https://dashscope.aliyuncs.com/compatible-mode/v1'),
    'https://dashscope.aliyuncs.com/compatible-mode/v1'
  );
  assert.strictEqual(normalizeBaseUrl('  '), '');
});

// ═══════════════════════════════ 时间

console.log('\n── 时间 ──');

check('localNow 的格式', () => {
  const n = localNow(new Date(2026, 9, 13, 9, 5));
  assert.strictEqual(n.iso, '2026-10-13');
  assert.strictEqual(n.time, '09:05');
  assert.ok(n.text.includes('2026-10-13'));
  assert.ok(n.text.includes('周二'));
});

console.log('\n── 修档案（合并重复栏目）──');

const DUP = `# 我的档案

> 说明

## 睡眠

| 日期 | 时长 |
|---|---|
| 10-13 | 6小时 |

## 宠物

| 日期 | 记录 |
|---|---|
| 10-13 | 猫来了 |

## 睡眠

| 日期 | 时长 |
|---|---|
| 10-13 | 6小时 |
| 10-14 | 7小时 |

## 工作

| 日期 | 记录 |
|---|---|
| 10-14 | 加班 |
`;

check('重名的栏目被合成一个', () => {
  const r = mergeDuplicateSections(DUP);
  assert.strictEqual(countH2(r.md, '睡眠'), 1, '睡眠还是重复的');
  assert.deepStrictEqual(r.merged, ['睡眠']);
  assert.strictEqual(r.uniqueSections, 3);
});

check('合并后重复的表头和行被去掉，新内容保留', () => {
  const { md } = mergeDuplicateSections(DUP);
  assert.ok(md.includes('7小时'), '新内容丢了');
  assert.strictEqual((md.match(/\| 10-13 \| 6小时 \|/g) || []).length, 1, '重复的行没去掉');
});

check('其它栏目一个字不动', () => {
  const { md } = mergeDuplicateSections(DUP);
  assert.ok(md.includes('| 10-13 | 猫来了 |'), '宠物栏目内容丢了');
  assert.ok(md.includes('| 10-14 | 加班 |'), '工作栏目内容丢了');
  assert.ok(md.startsWith('# 我的档案'), '文件头丢了');
  assert.ok(md.includes('> 说明'));
});

check('没有重复时，内容原样返回', () => {
  const clean = HEAD + '## 心情\n\n| 日期 | 记录 |\n|---|---|\n| 10-14 | 还行 |\n';
  const r = mergeDuplicateSections(clean);
  assert.deepStrictEqual(r.merged, []);
  assert.ok(r.md.includes('| 10-14 | 还行 |'));
  assert.strictEqual(countH2(r.md, '心情'), 1);
});

check('重复三次也能合成一个', () => {
  const md = HEAD + '## 心情\n\n| a |\n\n## 心情\n\n| b |\n\n## 心情\n\n| c |\n';
  const r = mergeDuplicateSections(md);
  assert.strictEqual(countH2(r.md, '心情'), 1);
  for (const v of ['| a |', '| b |', '| c |']) assert.ok(r.md.includes(v), v + ' 丢了');
});

console.log('\n── 文件与引用 ──');

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');

check('index.html 从 archive-core.js 导入的函数，都必须真的导出', () => {
  const m = html.match(/import\s*\{([^}]+)\}\s*from\s*'\.\/archive-core\.js'/);
  assert.ok(m, 'index.html 里没找到 import 语句');
  const names = m[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  assert.ok(names.length > 0);
  for (const n of names) assert.ok(n in core, `archive-core.js 没有导出「${n}」`);
});

check('index.html 引用的文件都在', () => {
  const refs = [...html.matchAll(/(?:href|src)="(?!https?:|data:)([^"]+)"/g)].map((m) => m[1]);
  for (const r of refs) {
    assert.ok(existsSync(new URL('./' + r, import.meta.url)), `index.html 引用了不存在的文件：${r}`);
  }
});

check('service worker 预缓存清单里的文件都在', () => {
  const sw = readFileSync(new URL('./sw.js', import.meta.url), 'utf8');
  const m = sw.match(/const ASSETS = \[([\s\S]*?)\];/);
  assert.ok(m, 'sw.js 里没找到 ASSETS');
  const files = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).filter((f) => f !== './');
  assert.ok(files.length >= 4);
  for (const f of files) {
    assert.ok(existsSync(new URL('./' + f, import.meta.url)), `sw.js 缓存了不存在的文件：${f}`);
  }
});

check('service worker 绝不缓存外部请求（GitHub / 模型）', () => {
  const sw = readFileSync(new URL('./sw.js', import.meta.url), 'utf8');
  assert.ok(
    /url\.origin !== self\.location\.origin/.test(sw),
    'sw.js 少了同源判断 —— 会把 GitHub 和模型的响应缓存下来，档案就成旧的了'
  );
});

check('manifest 是合法 JSON，图标文件存在', () => {
  const mf = JSON.parse(readFileSync(new URL('./manifest.webmanifest', import.meta.url), 'utf8'));
  assert.ok(mf.name && mf.start_url);
  assert.strictEqual(mf.display, 'standalone');
  for (const ic of mf.icons) {
    assert.ok(existsSync(new URL('./' + ic.src, import.meta.url)), `图标不存在：${ic.src}`);
  }
});

check('文本文件不能带 UTF-8 BOM（会让 manifest 解析失败、PWA 装不上）', () => {
  // 真踩过：用 PowerShell 的 Set-Content -Encoding utf8 改文件会悄悄加 BOM。
  // HTML 和 .mjs 忍得了，但 manifest.webmanifest 是 JSON —— 浏览器直接解析失败。
  const files = ['index.html', 'archive-core.js', 'manifest.webmanifest', 'sw.js', 'test.mjs'];
  const bad = [];
  for (const f of files) {
    const buf = readFileSync(new URL('./' + f, import.meta.url));
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) bad.push(f);
  }
  assert.strictEqual(bad.length, 0, '这些文件带了 BOM：' + bad.join('、'));
});

// ═══════════════════════════════ 会话持久化（手机发大图卡死的现场）

console.log('\n── 会话持久化（base64 绝不能进 localStorage）──');

const BIG = 'data:image/jpeg;base64,' + 'A'.repeat(5 * 1024 * 1024); // 一张 5 MB 的假图

check('持久化时必须剥掉整张 base64', () => {
  const s = storageSnapshot([{ role: 'user', text: '看看', at: 1, imgs: [{ dataUrl: BIG, thumb: 'data:image/jpeg;base64,AAA' }] }]);
  const raw = JSON.stringify(s);
  assert.ok(!raw.includes('AAAA'.repeat(10)), '大 base64 混进去了');
  assert.ok(!raw.includes(BIG.slice(0, 200)), 'dataUrl 没被剥掉');
  assert.ok(raw.length < 2000, `瘦身后的会话还是太大：${raw.length} 字节`);
});

check('剥掉大图之后仍然知道有几张图、缩略图还在', () => {
  const s = storageSnapshot([
    { role: 'user', text: '', at: 1, imgs: [{ dataUrl: BIG, thumb: 'data:image/jpeg;base64,T1' }, { dataUrl: BIG, thumb: 'data:image/jpeg;base64,T2' }] },
  ]);
  const t = s.turns[0];
  assert.strictEqual(t.imgCount, 2, '张数丢了，刷新后连"有几张图"都不知道');
  assert.deepStrictEqual(t.thumbs, ['data:image/jpeg;base64,T1', 'data:image/jpeg;base64,T2']);
  assert.strictEqual(t.imgs, undefined, 'imgs 不该留在持久化结果里');
  assert.strictEqual(t.text, '');
  assert.strictEqual(t.role, 'user');
});

check('一张 5 MB 的图，瘦身后必须远小于配额（这就是当初炸掉的原因）', () => {
  const before = JSON.stringify({ turns: [{ role: 'user', imgs: [{ dataUrl: BIG }] }] }).length;
  const after = JSON.stringify(storageSnapshot([{ role: 'user', imgs: [{ dataUrl: BIG, thumb: 'x' }] }])).length;
  assert.ok(before > 5 * 1024 * 1024, '造的数据不够大，这个测试就没意义了');
  assert.ok(after < STORAGE_BUDGET / 10, `瘦身后 ${after} 字节，还是太大`);
});

check('对话太长时优先丢缩略图，文字一条都不能丢', () => {
  const turns = [];
  for (let i = 0; i < 40; i++) {
    turns.push({ role: 'user', text: '第' + i + '句', at: i, imgs: [{ dataUrl: BIG, thumb: 'T'.repeat(50) + i }] });
  }
  const s = storageSnapshot(turns, 20 * 1024);
  assert.strictEqual(s.turns.length, 40, '文字条目被丢了');
  for (const t of s.turns) assert.ok(typeof t.text === 'string' && t.text.startsWith('第'), '文字丢了');
  assert.ok(JSON.stringify(s).length < 60 * 1024, '还是没收进预算');
});

check('没有图片的普通对话原样保留', () => {
  const s = storageSnapshot([{ role: 'user', text: '在吗', at: 1 }, { role: 'assistant', text: '在的。', at: 2 }]);
  assert.deepStrictEqual(s.turns.map((t) => t.text), ['在吗', '在的。']);
  assert.strictEqual(s.images, null);
});

// ═══════════════════════════════ 图片解析

console.log('\n── 图片 data URL 解析 ──');

const ONE_PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

check('标准 data URL 能拆开', () => {
  const p = parseDataUrl(`data:image/png;base64,${ONE_PX}`);
  assert.strictEqual(p.mime, 'image/png');
  assert.strictEqual(p.b64, ONE_PX);
});

check('base64 里有换行也要认（原来会被静默丢掉，图就"发丢"了）', () => {
  const wrapped = ONE_PX.slice(0, 20) + '\n' + ONE_PX.slice(20);
  const p = parseDataUrl(`data:image/jpeg;base64,${wrapped}`);
  assert.ok(p, '带换行的 data URL 没解析出来');
  assert.strictEqual(p.b64, ONE_PX, '换行没被清掉');
});

check('不是 data URL 就返回 null，不要装作成功', () => {
  assert.strictEqual(parseDataUrl(''), null);
  assert.strictEqual(parseDataUrl('https://example.com/a.png'), null);
  assert.strictEqual(parseDataUrl('data:image/png;base64,'), null);
  assert.strictEqual(parseDataUrl('data:image/png,abc'), null, '没有 base64 标记的不能当图片');
});

await checkAsync('格式坏的图片要报错，不能静默跳过', async () => {
  installFetch([(u, m) => (m === 'GET' ? jsonRes(404, { message: 'Not Found' }) : null)]);
  await assert.rejects(
    () => runTurn(CFG, [], { text: '看图', images: ['这不是图片'] }),
    /格式读不出来/
  );
});

// ═══════════════════════════════ 重试不复传大图

console.log('\n── 重试不复传大图 ──');

check('重试时图片被换成一句说明，base64 不再出网', () => {
  const msgs = [
    { role: 'system', content: 'SYS' },
    { role: 'user', content: [{ type: 'text', text: '这是什么' }, { type: 'image_url', image_url: { url: BIG } }] },
  ];
  const once = stripImagesForRetry(msgs, 'images/a.jpg');
  const raw = JSON.stringify(once);
  assert.ok(!raw.includes('AAAA'.repeat(10)), '重试时还在发整张图');
  assert.ok(raw.includes('images/a.jpg'), '路径应该留给模型');
  assert.ok(raw.includes('这是什么'), '原来的文字不能丢');
  assert.strictEqual(once[0].content, 'SYS', '纯文字的系统消息不该被动');
});

check('没有图片的消息原样返回', () => {
  const msgs = [{ role: 'user', content: '普通文字' }];
  assert.deepStrictEqual(stripImagesForRetry(msgs), msgs);
});

await checkAsync('图片调用失败重试时，第二次不再重发 base64', async () => {
  const sizes = [];
  let n = 0;
  installFetch([
    (u, m) => (m === 'GET' ? jsonRes(200, { content: textToB64(HEAD), sha: 's' }) : null),
    (u, m) => (u.includes('/contents/images/') && m === 'PUT' ? jsonRes(200, { content: { sha: 'x' } }) : null),
    (u, m, b) => {
      if (!u.includes('/chat/completions')) return null;
      n++;
      sizes.push(JSON.stringify(b).length);
      // 第一次故意失败（非超时），逼它走重试
      if (n === 1) return jsonRes(400, { error: { message: 'bad image format' } });
      return modelSays({ reply: '看到了', updates: [] });
    },
  ]);

  const big = 'data:image/png;base64,' + ONE_PX + 'A'.repeat(4000);
  const cfgV = { ...CFG, vision: { baseUrl: 'https://v.example.com/v1', apiKey: 'vk', model: 'vm' } };
  const r = await runTurn(cfgV, [], { text: '看看', images: [big] });
  assert.strictEqual(r.reply, '看到了');
  assert.ok(sizes.length >= 2, '应该重试过');
  assert.ok(sizes[1] < sizes[0], `重试的请求没变小：${sizes[0]} → ${sizes[1]}`);
});

// ═══════════════════════════════ 前端不许再犯同样的错

console.log('\n── 前端防线（index.html 源码约束）──');

check('saveSession 有 try/catch —— 配额爆了不许拖垮整个 send()', () => {
  const m = html.match(/function saveSession\(\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(m, '没找到 saveSession');
  assert.ok(/try\s*\{/.test(m[1]), 'saveSession 里没有 try —— 手机配额一爆界面就卡死');
  assert.ok(/catch/.test(m[1]), 'saveSession 里没有 catch');
});

check('localStorage 只存瘦身后的会话，绝不直接存 turns', () => {
  const sets = [...html.matchAll(/localStorage\.setItem\(([^;]*)\)/g)];
  assert.ok(sets.length > 0);
  for (const s of sets) {
    const arg = s[1];
    assert.ok(
      !/JSON\.stringify\(\s*\{\s*turns\s*,/.test(arg),
      '又把裸 turns 存进 localStorage 了：' + arg.slice(0, 80)
    );
  }
  assert.ok(/storageSnapshot\(/.test(html), 'saveSession 应该走 storageSnapshot 瘦身');
});

check('发图之前必须先压缩（手机原图直接用会把配额撑爆）', () => {
  assert.ok(/MAX_EDGE/.test(html) && /readImageFile/.test(html), '图片没有压缩这一步');
  const m = html.match(/async function readImageFile\([^)]*\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(m, '没找到 readImageFile');
  assert.ok(/toDataURL\(/.test(m[1]), '压缩后没有重新编码');
  assert.ok(/scale|Math\.min/.test(m[1]), '没有缩放计算');
});

check('会话瘦身后不留 dataUrl 字段给 localStorage', () => {
  const s = storageSnapshot([{ role: 'user', imgs: [{ dataUrl: 'data:image/png;base64,' + 'B'.repeat(100000), thumb: 'T' }] }]);
  for (const t of s.turns) {
    for (const v of Object.values(t)) {
      assert.ok(!String(v).includes('BBBBBBBB'), '还有字段带着大 base64');
    }
  }
});

console.log(`\n通过 ${pass} · 失败 ${fail}\n`);
process.exitCode = fail ? 1 : 0;
