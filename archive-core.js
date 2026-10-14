/**
 * 档案 · 核心逻辑
 *
 * 浏览器和 Node 都能跑：不碰文件系统，存储走 GitHub API，模型走 fetch。
 *
 * 这个文件里有两处是拿真实故障换来的，**改之前先看注释**：
 *   - MAX_HISTORY / buildMessages()  —— 历史格式和历史长度
 *   - callUntilUsable()              —— 模型吐空白/吐残渣时的兜底
 */

const endpoint = (baseUrl) => baseUrl.replace(/\/+$/, '') + '/chat/completions';

/** 现在的本地时间（给人看的字符串 + 给模型用的字段） */
function localNow(d = new Date()) {
  const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
  const p = (n) => String(n).padStart(2, '0');
  return {
    iso: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
    time: `${p(d.getHours())}:${p(d.getMinutes())}`,
    text: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${week} ${p(d.getHours())}:${p(d.getMinutes())}`,
  };
}


function buildSystemPrompt(md, now, hasVision) {
  const visionNote = hasVision
    ? `你能看到图片内容。先说一句你真正看到的——具体，不要罗列——然后问一个你真想知道的问题。`
    : `你现在看不到图片内容（没配视觉模型）。所以不要假装看到了。
收到图片时，老实说你这边只收到一张图、看不到里面，然后自然地问 ta 这是什么。不要编造画面细节。`;

  return `你是「档案」——属于同一个人、长期陪着的记录者。

## 你在做什么

ta 会随手丢给你一些东西：一句话、一张照片、刚做完的一件事、一个突然的念头。
你接住它，聊两句，然后判断：这里面有没有值得长期留下来的东西。
有，就写进下面这份档案。

档案是 ta 的，不是你的。你只是替 ta 保管。

## 档案当前全文

${md}

（以上就是档案的全部内容。你有完整的一份。要写之前先看清楚已有栏目。）

## 怎么归类

档案**没有预设栏目**，栏目是你在长期记录中自己长出来的。所以每次写之前先看上面：

1. **能装进已有栏目，就装进去。** 别因为叫法不完全一样就另起一个。
   已经有「身体」，那体重、睡眠、训练、饮食都往里放，不要再建「体重」「睡眠记录」。
2. **真的装不下，才新建。而且新栏目要「宽」，不要「窄」。**

   建栏目之前先问自己一句：**这个名字，半年后还能继续往里装东西吗？**

   - ✗ 窄：「体重」「睡眠」「跑步」「今天的心情」——每个只能装一种东西，很快就长出一地碎片
   - ✓ 宽：「身体」「心情」「工作」「关系」「想法」——同类的东西都能进去

   宁可先建一个稍大的，以后在里面分小节，也不要一上来就切碎。
3. **一个栏目内部可以用三级标题分小节。** 比如「身体」下面分「体重」「训练」两个小节。
   顶层栏目要少，内部分节可以细。
4. 栏目顺序不用管，新建的追加在末尾即可。
5. 如果你发现上面的栏目切得太碎（比如同时存在「体重」和「睡眠」），
   可以在这次更新里把它们合并成一个更宽的栏目——但**合并时必须把两边的记录都带上，一条都不能丢**。

6. **最容易犯的错：因为几件事发生在同一天、同一段对话里，就把它们全塞进现有那个栏目。**

   栏目是按**性质**分的，**不是按时间分的**。

   - 「今天开了四个小时会」→ 工作
   - 「早上称了体重 152 斤」→ 身体
   - 「中午吃了个三明治」→ 身体（或饮食）
   - 「昨晚只睡了 5 个小时」→ 身体

   这四条发生在同一天，但属于不同的栏目。**该新建就新建，不要图省事。**
   一个栏目一旦变成了什么都能装的筐，这份档案就废了。

## 数字必须进表格

体重、睡眠时长、训练量、跑步配速、次数、金额这类**数值**，不要写成一句话。
在该栏目里维护一个 markdown 表格，一行一条记录。这样以后才看得出趋势。

例如：

### 体重
| 日期 | 时间 | 体重 | 备注 |
|---|---|---|---|
| 2026-10-14 | 10:00 | 150斤 | 空腹 |

## 你怎么说话

- **短。一到三句。** 你在跟人聊天，不是写报告。
- **一次只问一个问题**，问完就等着。不要连着抛第二个。
- 不要总结 ta 说的话。不要说"我理解你的感受"这种空话。
- 不要鼓励，不要给建议，除非 ta 明确问你要。
- 不要问"这是在哪里拍的"这类像填表的问题。
- ta 只回一个"嗯"，或者干脆不回，就不要再追问了。让话题自然结束。
- 不要每次都长篇大论。有时候一句"记下了"就够了。

## 照片

${visionNote}

## 先记，再问

**先把能记的记下来，再去追问。绝对不要等 ta 回答了才记。**

理由很简单：ta 可能就不回了。你不记，这条就永远丢了。

- ✓ 「吃了碗面」→ 先记「18:07 吃了碗面」，再问「什么面？」
- ✓ 「有点烦」→ 先记进「心情」，再问「怎么了？」
- ✗ 什么都不记，只回一句「什么面？」——要是 ta 不回，这顿饭就从档案里消失了

细节等下一轮 ta 说了，你再把细节补进同一条里。
追问只问一句，ta 不接就算了，但**前面记下的东西必须已经记下了**。

## 界线

- 不说教，不评价 ta 的生活方式。
- 不假装记得档案里没有的事。
- **明显敏感的信息不要写进档案**：身份证号、银行卡、密码、具体住址门牌、别人的隐私。
  这类内容当聊天接住就行，不要落盘，也不要在 reply 里复述。
- 如果 ta 流露出严重伤害自己或他人的念头，放下以上所有风格，直接、认真地说。

## 输出格式

**只输出一个 JSON 对象**，前后不要有任何其他文字：

{
  "reply": "你要对 ta 说的话",
  "updates": [
    { "section": "栏目名", "content": "这个栏目的完整新内容（markdown）" }
  ]
}

要求：

- \`updates\` 里是**该栏目的完整内容**，不是增量。所以必须把原有内容一起带上，只做必要的增加或修改。
  **绝对不要弄丢已有记录。**
- \`content\` 里**不要写 \`## 栏目名\` 这个标题**。栏目名已经由 \`section\` 字段指明了。
  \`content\` 只写正文，小节用三级标题。
- 一次最多更新两个栏目。

## 什么值得记

**判断标准不是"这件事够不够重要"，而是"这是不是一个可以说清楚的事实"。**
是事实，就记。哪怕只有一句话、哪怕信息不全。

下面这些**出现就必须记，没有例外**：

| ta 说了什么 | 归到 |
|---|---|
| 睡了几小时、几点睡几点起 | 身体 |
| 体重、体脂、身体数据 | 身体 |
| 跑了多远、练了什么、什么强度 | 身体 |
| 吃了什么、想吃什么、在哪吃 | 饮食 |
| 花了多少钱、买了什么 | 开销 |
| 心情怎么样、状态如何 | 心情 |
| 见了谁、跟谁聊了什么 | 关系 |
| 突然想起什么、冒出来什么念头 | 想法 |
| 看了什么、听了什么、去了哪 | 想法 |

**只有这些才不记**：寒暄（"在吗""嗯""好"）、你追问的来回、以及你自己说过的话。

**拿不准的时候，一律记。** 这是一份要攒很多年的档案，
宁可多写一条暂时没用的，也不要漏掉一条 ta 以后想找的。

⚠ 最常见的错误是：觉得"这条太简单了，等信息全了再记"。**不要等。**
ta 可能永远不补那句话，这条就从档案里消失了。

## 绝对不要编

**只记 ta 真正说过的。不要补上任何"合理"的细节。**

这是这份档案能不能信的底线。你编进去的东西，ta 自己回头看会以为是真的。

- ta 说「早上称体重 152 斤」→ 就记 152 斤。
  **不要**自己加上"空腹"——ta 没说过空腹。
- ta 说「昨天睡了 5 个小时」→ 就记 5 小时。
  **不要**猜是"睡得晚"还是"没睡好"。
- ta 说「开了四个小时会」→ 就记四个小时。
  **不要**补上会议内容、参会的人、你的推测。

**追问是允许的，猜是不允许的。** 你问出来、ta 答了，下一轮再补进同一条里。
没问到的，就空着——空着比编造强一百倍。

## 别说谎，也别预告

**只有当你真的在 \`updates\` 里写了东西，才能说"记下了""记上了""存好了"这类话。**

如果 \`updates\` 是空的，就**绝对不要**说这种话——那是在骗 ta，
而且 ta 会以为已经记上了、以后再也想不起来要补。

**同样地：不要预告你要做什么。**

- ✗ 「我把它们合并一下」—— 说完就没动静了，ta 只能干等着
- ✗ 「我来整理一下」「稍后补上」—— 全是空话
- ✓ 这一轮就在 \`updates\` 里改完，然后说「合了」

**要改就这一轮改完，改不了就别说。中间态的话一句都不要说。**

ta 问"有没有重复"这种关于档案本身的问题时，正确做法是：
**先在这一轮的 \`updates\` 里真的把它改好，然后在 reply 里说改了什么。**

大多数时候你根本不用提"记"这个字，自然接话就行。

## reply 永远不能是空的

**ta 说了话，你就必须回一句。** 哪怕只是一个"嗯"。

写档案和回话是两件独立的事，不能只做一件。
就算这一轮你什么都没打算记，\`reply\` 里也必须有你真正要对 ta 说的话。

\`reply\` 是空字符串，等于你在 ta 面前突然不出声了——这是最糟的失败。

## 现在

${now}`;
}

/**
 * 对话历史最多往回带几条。**这个数字很关键，别随手调大。**
 *
 * 实测（同一段 14 轮对话，只看"该记的记了没"）：
 *   全部历史 → 3/14
 *   6 条     → 13/14   ← 就是这个
 *   4 条     → 11/14
 *   2 条     → 10/14
 *
 * 历史一长，模型就被带进"闲聊模式"，把「该记的必须记」这条指令稀释掉了。
 * 长期记忆本来就在档案里，这里只需要近期上下文。
 */
const MAX_HISTORY = 6;

/** 去掉 ```json 围栏 */
function stripFences(s) {
  return String(s)
    .replace(/^\s*```(?:json)?[ \t]*\r?\n?/i, '')
    .replace(/\r?\n?```[ \t]*$/, '')
    .trim();
}

/** 从第一个 `{` 起按括号配平截出完整的对象（字符串内的括号不算） */
function sliceBalanced(s) {
  const start = s.indexOf('{');
  if (start === -1) return '';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return s.slice(start);
}

/**
 * 模型经常在 JSON 字符串里直接写换行、或者多留一个逗号。
 * 这两种都不合法，但修一下就能用 —— 比整轮丢掉强。
 */
function repairJSON(s) {
  let out = '';
  let inStr = false;
  let esc = false;
  for (const ch of s) {
    if (esc) { out += ch; esc = false; continue; }
    if (ch === '\\') { out += ch; esc = true; continue; }
    if (ch === '"') { inStr = !inStr; out += ch; continue; }
    if (inStr && ch < ' ') {
      out += ch === '\n' ? '\\n' : ch === '\r' ? '\\r' : ch === '\t' ? '\\t' : '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0');
      continue;
    }
    out += ch;
  }
  return out.replace(/,\s*([}\]])/g, '$1'); // 末尾多余的逗号
}

/** 模型输出的一段东西，像不像 JSON 残渣（不能让这种东西露给用户） */
function looksLikeDebris(t) {
  const s = String(t || '').trim();
  if (!s) return true;
  if (/^[{[\]}"',:]/.test(s)) return true;
  if (/^(reply|updates|section|content)"?\s*:/.test(s)) return true;
  return false;
}

/** 模型有时会用 ``` 包住，或者前后带废话 —— 尽量把对象抠出来 */
function parseModelJSON(text) {
  const raw = stripFences(text);
  if (!raw) return null;
  const candidates = [raw, sliceBalanced(raw)];
  for (const c of candidates.slice()) candidates.push(repairJSON(c));

  for (const c of candidates) {
    if (!c) continue;
    try {
      const o = JSON.parse(c);
      if (o && typeof o === 'object') return o;
    } catch {
      /* 换下一种试法 */
    }
  }
  return null;
}

/** 从残缺的 JSON 里硬抠出 reply 字段，抠不出来返回空 */
function salvageReply(text) {
  const s = String(text || '');
  const m = /"reply"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(s);
  if (m) {
    let v = m[1];
    try {
      v = JSON.parse('"' + m[1] + '"');
    } catch {
      /* 转义坏了就用原文 */
    }
    v = String(v).trim();
    if (v && !looksLikeDebris(v)) return v;
  }
  const t = stripFences(s);
  if (looksLikeDebris(t)) return '';
  return t;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * content 是「栏目正文」，本来不该出现任何二级标题（小节用三级）。
 * 模型时不时会把 `## 心情` 塞进来 —— 那会长出一个重复栏目。
 *
 * ⚠ 不能只剥**开头**的。模型把标题写在正文**中间**时，
 * 那个 `## 睡眠` 会变成一个凭空多出来的栏目，而且从它往后
 * 的内容都会被卷进那个栏目里 —— 重复栏目就是这么来的。
 * 所以：**正文里出现的所有二级标题，一律剥掉。**
 */
function stripSectionHeading(content) {
  const lines = String(content).split('\n');
  const kept = lines.filter((l) => !/^##(?!#)/.test(l.trim()));
  const dropped = lines.length - kept.length;
  if (dropped > 0) {
    console.warn(`  ⚠ content 里混进了 ${dropped} 个二级标题，已剥掉（否则会长出重复栏目）`);
  }
  return kept.join('\n').trim();
}

/**
 * 把某个栏目的内容整段换掉；栏目不存在就在文件末尾新建。
 * 栏目 = 一个 `## 标题`，范围到下一个 `## ` 或文件末尾。
 */
function replaceSection(md, name, content) {
  const body = stripSectionHeading(content);
  const re = new RegExp(`^##[ \\t]+${escapeRe(name)}[ \\t]*$`, 'm');
  const m = re.exec(md);

  if (!m) {
    return md.replace(/\s*$/, '') + `\n\n## ${name}\n\n${body}\n`;
  }

  const afterHeader = m.index + m[0].length;
  const rest = md.slice(afterHeader);
  const nextRel = rest.search(/^##[ \t]+/m);
  const end = nextRel === -1 ? md.length : afterHeader + nextRel;

  return md.slice(0, afterHeader) + '\n\n' + body + '\n\n' + md.slice(end).replace(/^\n+/, '');
}

async function callModel(slot, messages, { json = false, temperature = 0.8 } = {}) {
  if (!slot.apiKey || !slot.baseUrl || !slot.model) {
    throw new Error('模型槽位没配好（baseUrl / apiKey / model 缺一个）');
  }
  const body = {
    model: slot.model,
    messages,
    temperature,
  };
  if (json) body.response_format = { type: 'json_object' };

  const res = await fetch(endpoint(slot.baseUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${slot.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    let hint = text.slice(0, 400);
    try {
      const j = JSON.parse(text);
      hint = j.error?.message || j.message || hint;
    } catch {}
    throw new Error(`模型返回 ${res.status}：${hint}`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('模型返回的不是 JSON：' + text.slice(0, 200));
  }
  return {
    content: data.choices?.[0]?.message?.content ?? '',
    usage: data.usage ?? null,
    raw: data,
  };
}

/**
 * 模型偶尔会吐一串纯空白（DeepSeek flash 上实测过）。
 * 关键：**同一份请求重发是没用的**——它会稳定地再吐一次空白。
 * 所以每次换一个条件再试。
 *
 * 另外：**不是 JSON 不等于没用**。关掉 JSON 模式后模型可能直接说了人话，
 * 那种也要收下（只是这一轮不改档案），不能扔掉。
 */
async function callUntilUsable(slot, messages) {
  const NUDGE =
    '（系统提醒：你上一次一个字都没说出来。请重新回答上面那条消息，只输出 JSON。）';
  const MINIMAL =
    '你是「档案」，陪人聊天的记录者。只输出一个 JSON 对象，不要别的东西：\n' +
    '{"reply": "你要对 ta 说的话", "updates": []}\n' +
    'reply 绝对不能是空的。';

  const attempts = [
    { label: '标准', json: true, temperature: 0.8 },
    { label: '关掉 JSON 模式', json: false, temperature: 0.8 },
    { label: '换温度 + 提醒', json: true, temperature: 1.15, nudge: true },
    { label: '极简上下文', json: false, temperature: 1.0, minimal: true },
  ];

  let last = null;
  let fallback = null; // 抢救出来的散文回复，留到最后再用

  for (let i = 0; i < attempts.length; i++) {
    const a = attempts[i];
    let msgs = messages;
    if (a.nudge) msgs = [...msgs, { role: 'user', content: NUDGE }];
    if (a.minimal) msgs = [{ role: 'system', content: MINIMAL }, messages[messages.length - 1]];

    const r = await callModel(slot, msgs, { json: a.json, temperature: a.temperature });
    const parsed = parseModelJSON(r.content);

    // reply 本身也必须像句人话 —— 实测出现过模型把 '{' 当成回复
    if (
      parsed &&
      typeof parsed.reply === 'string' &&
      parsed.reply.trim() &&
      !looksLikeDebris(parsed.reply)
    ) {
      return { ...r, parsed };
    }

    // 没按格式来、但说了人话 —— 先留着备用。
    // 不能立刻返回：后面几轮要是能拿到完整 JSON（含档案更新），那个更值钱。
    if (!fallback) {
      const salvaged = salvageReply(r.content);
      if (salvaged) fallback = { ...r, parsed: null, salvagedReply: salvaged };
    }

    last = { ...r, parsed };
    if (i < attempts.length - 1) {
      const why = !r.content.trim() ? '全是空白' : parsed ? 'reply 是空的' : '不是 JSON';
      console.warn(`  ⚠ 第 ${i + 1} 次（${a.label}）${why}，换个条件重试`);
      console.warn(`     输出：${JSON.stringify(String(r.content)).slice(0, 120)}`);
    }
  }

  if (fallback) {
    console.warn('  ⚠ 四种条件都没拿到完整 JSON，用抢救出来的原话（这轮不改档案）');
    return fallback;
  }
  return last;
}

/**
 * 把对话历史拼成模型消息。
 *
 * ⚠ 还有一处不能动：
 * assistant 的历史**必须还原成 JSON 形状**，不能把给人看的散文直接塞回去。
 * 模型看到自己上一轮"没守格式"，下一轮就跟着不守——
 * 实测：散文历史 + JSON 模式 = 12/12 全吐空白；还原成 JSON 后 = 0/12。
 */
function buildMessages(systemPrompt, history, userContent, maxHistory = MAX_HISTORY) {
  const messages = [{ role: 'system', content: systemPrompt }];
  const recent = (history || []).filter((h) => h && h.text).slice(-maxHistory);
  for (const h of recent) {
    if (h.role === 'assistant') {
      messages.push({
        role: 'assistant',
        content: JSON.stringify({ reply: String(h.text), updates: [] }),
      });
    } else {
      messages.push({ role: 'user', content: String(h.text) });
    }
  }
  messages.push({ role: 'user', content: userContent });
  return messages;
}


// ═══════════════════════════════════════════════ 存储：GitHub

const GH_API = 'https://api.github.com';

/** UTF-8 安全的 base64（浏览器和 Node 都有 atob/btoa/TextDecoder） */
function b64ToText(b64) {
  const bin = atob(String(b64).replace(/\s/g, ''));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function textToB64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function ghHeaders(g) {
  return {
    Authorization: `Bearer ${g.token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

function ghUrl(g, path) {
  const safe = String(path)
    .split('/')
    .map(encodeURIComponent)
    .join('/');
  return `${GH_API}/repos/${g.owner}/${g.repo}/contents/${safe}`;
}

function ghExplain(status, body) {
  if (status === 401) return 'GitHub 令牌无效或已过期';
  if (status === 403) return 'GitHub 拒绝访问 —— 令牌是不是没勾这个仓库的权限？';
  if (status === 404) return '找不到仓库或文件 —— 检查用户名/仓库名，以及令牌有没有授权它';
  return `GitHub ${status}：${String(body).slice(0, 200)}`;
}

async function ghGet(g, path) {
  const r = await fetch(`${ghUrl(g, path)}?ref=${encodeURIComponent(g.branch || 'main')}`, {
    headers: ghHeaders(g),
    cache: 'no-store',
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(ghExplain(r.status, await r.text()));
  const j = await r.json();
  return { text: b64ToText(j.content || ''), sha: j.sha };
}

/**
 * 写入。content 必须是 base64 —— 文本走 ghPut，二进制走 ghPutB64。
 * sha 不匹配时抛一个带 conflict 标记的错误，让调用方重读后重放。
 */
async function ghPutB64(g, path, base64Content, sha, message) {
  const body = { message, content: base64Content, branch: g.branch || 'main' };
  if (sha) body.sha = sha;

  const r = await fetch(ghUrl(g, path), {
    method: 'PUT',
    headers: { ...ghHeaders(g), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  // 409 = sha 对不上（别处改过）；422 有时也是这个意思
  if (r.status === 409 || r.status === 422) {
    const e = new Error('文件在别处被改过');
    e.conflict = true;
    throw e;
  }
  if (!r.ok) throw new Error(ghExplain(r.status, await r.text()));
  const j = await r.json();
  return j.content?.sha ?? null;
}

const ghPut = (g, path, text, sha, message) => ghPutB64(g, path, textToB64(text), sha, message);

const JOURNAL_HEADER = `# 我的档案

> 这份文件由「档案」自动维护。内容都是你自己说出来的，AI 只负责归类和保管。
> 栏目是长出来的，不是预设的。

`;

async function readJournal(g) {
  const f = await ghGet(g, g.journalPath || 'journal.md');
  if (!f) return { md: JOURNAL_HEADER, sha: null };
  return { md: f.text, sha: f.sha };
}

/** 把图片存进同一个仓库的 images/ 下，返回相对路径 */
async function saveImages(g, dataUrls) {
  const out = [];
  for (const du of dataUrls || []) {
    const m = /^data:([^;,]+);base64,(.+)$/s.exec(String(du || ''));
    if (!m) continue;
    const ext =
      { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' }[m[1]] || 'jpg';
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
    const name = `images/${stamp}-${Math.random().toString(16).slice(2, 8)}.${ext}`;
    try {
      await ghPutB64(g, name, m[2], null, `图片 ${name}`);
      out.push({ name, rel: name, dataUrl: du });
    } catch (err) {
      // 图片没存上不能拖垮整轮：模型还是能用 data URL 看到它，
      // 只是不能给它一个会写进档案的路径 —— 那会变成死链。
      console.warn(`图片没存上（${err.message}）；这轮照常聊，但档案里不会引用这张图`);
      out.push({ name, rel: null, dataUrl: du, failed: true });
    }
  }
  return out;
}

// ═══════════════════════════════════════════════ 一轮对话

/**
 * 读档案 → 问模型 → 写回档案。
 * @returns {Promise<{reply:string, updated:boolean, images:string[]}>}
 */
async function runTurn(cfg, history, input) {
  const g = cfg.github;
  const now = localNow();

  let { md, sha } = await readJournal(g);

  const images = await saveImages(g, input?.images || []);
  const hasVision = Boolean(cfg.vision?.apiKey && cfg.vision?.baseUrl && cfg.vision?.model);

  const userText = String(input?.text || '').trim();
  // 只有真的存上去了才给它路径 —— 否则模型会往档案里写一条死链
  const imageLines = images
    .filter((i) => i.rel)
    .map((i) => `图片路径（要写进档案时原样引用）：${i.rel}`)
    .join('\n');

  let userContent;
  if (hasVision && images.length) {
    userContent = [
      { type: 'text', text: [userText, imageLines].filter(Boolean).join('\n') || '（ta 只发了图片，没说话）' },
    ];
    for (const img of images) userContent.push({ type: 'image_url', image_url: { url: img.dataUrl } });
  } else {
    const bits = [];
    if (userText) bits.push(userText);
    if (images.length) {
      bits.push(`（ta 发了 ${images.length} 张图片，但你这边看不到图片内容。）\n${imageLines}`);
    }
    userContent = bits.join('\n\n') || '（空消息）';
  }

  const slot = hasVision && images.length ? cfg.vision : cfg.chat;
  const messages = buildMessages(buildSystemPrompt(md, now.text, hasVision), history, userContent);

  let r;
  try {
    r = await callUntilUsable(slot, messages);
  } catch (err) {
    // 有些视觉接口要的是纯 base64，不带 `data:...;base64,` 前缀。换一种再试一次。
    if (!hasVision || !images.length) throw err;
    console.warn(`⚠ 视觉调用失败：${err.message} —— 换成纯 base64 再试`);
    const bare = messages.map((m) =>
      Array.isArray(m.content)
        ? {
            ...m,
            content: m.content.map((p) =>
              p.type === 'image_url'
                ? { type: 'image_url', image_url: { url: p.image_url.url.replace(/^data:[^,]+,/, '') } }
                : p
            ),
          }
        : m
    );
    r = await callUntilUsable(slot, bare);
  }

  let reply = '';
  let updates = [];
  if (r.parsed && typeof r.parsed === 'object') {
    reply = typeof r.parsed.reply === 'string' ? r.parsed.reply.trim() : '';
    updates = Array.isArray(r.parsed.updates) ? r.parsed.updates : [];
  }
  if (!reply && r.salvagedReply) reply = r.salvagedReply;
  if (!reply) reply = salvageReply(r.content);
  if (!reply) reply = '我这边卡了一下，你再说一句试试？';

  // 写回。中途在别处被改过就重读、重放，最多三次。
  //
  // ⚠ 写失败**不能连累回复**：话已经生成了，必须让用户看到。
  // 之前这里是直接 throw 的，结果档案写不进去的时候连 AI 说的话都丢了。
  let updated = false;
  let writeError = null;
  if (updates.length) {
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        let next = md;
        for (const u of updates) {
          if (!u || !u.section || typeof u.content !== 'string') continue;
          const name = String(u.section).trim().replace(/^#+\s*/, '');
          if (!name) continue;
          next = replaceSection(next, name, u.content);
        }
        if (next === md) break;
        try {
          await ghPut(g, g.journalPath || 'journal.md', next, sha, `档案更新 ${now.text}`);
          updated = true;
          break;
        } catch (err) {
          if (!err.conflict || attempt === 2) throw err;
          console.warn('⚠ 档案在别处被改过，重读之后重放这次更新');
          const fresh = await readJournal(g);
          md = fresh.md;
          sha = fresh.sha;
        }
      }
    } catch (err) {
      writeError = err.message;
      console.warn(`⚠ 档案没写进 GitHub：${err.message}（但回复照常给）`);
    }
  }

  return { reply, updated, writeError, images: images.map((i) => i.rel).filter(Boolean) };
}

export {
  MAX_HISTORY,
  buildSystemPrompt,
  buildMessages,
  parseModelJSON,
  salvageReply,
  replaceSection,
  callModel,
  callUntilUsable,
  localNow,
  readJournal,
  saveImages,
  runTurn,
  JOURNAL_HEADER,
  b64ToText,
  textToB64,
};
