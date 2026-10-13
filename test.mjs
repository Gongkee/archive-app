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
import {
  MAX_HISTORY,
  DEFAULT_TIMEOUT_MS,
  fetchWithTimeout,
  normalizeBaseUrl,
  applyThinking,
  isDeepSeek,
  buildMessages,
  parseModelJSON,
  salvageReply,
  replaceSection,
  runTurn,
  localNow,
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

// ═══════════════════════════════ 历史拼装

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

check('核心逻辑里不再有裸 fetch（都必须带超时）', () => {
  const src = readFileSync(new URL('./archive-core.js', import.meta.url), 'utf8');
  const bare = [...src.matchAll(/(?<![.\w])fetch\(/g)];
  assert.strictEqual(
    bare.length,
    1,
    `archive-core.js 里应该只有 fetchWithTimeout 内部的那一处 fetch，实际有 ${bare.length} 处 —— 裸 fetch 会死等`
  );
  assert.ok(/function fetchWithTimeout/.test(src));
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

console.log(`\n通过 ${pass} · 失败 ${fail}\n`);
process.exitCode = fail ? 1 : 0;
