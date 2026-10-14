/**
 * 档案 · 核心逻辑
 *
 * 浏览器和 Node 都能跑：不碰文件系统，存储走 GitHub API，模型走 fetch。
 *
 * 这个文件里有三处是拿真实故障换来的，**改之前先看注释**：
 *   - MAX_HISTORY / buildMessages()  —— 历史格式和历史长度
 *   - callUntilUsable()              —— 模型吐空白/吐残渣时的兜底
 *   - fetchWithTimeout / DEFAULT_TIMEOUT_MS —— 请求永远不返回时的死等
 */

const endpoint = (baseUrl) => baseUrl.replace(/\/+$/, '') + '/chat/completions';

/**
 * 是不是 DeepSeek 的接口（只有它认 `thinking` 这个参数）。
 *
 * ⚠ 必须锚定到主机名结尾：不锚的话 `api.deepseek.com.evil.com` 也会判成 true，
 * 然后我们会给一个陌生域名发 `thinking` —— 非标准参数，对面可能直接 400。
 * 前面的边界也要留：`notdeepseek.com` 不能算。
 */
const DEEPSEEK_HOST = /(?:^|[./])deepseek\.com(?:[:/]|$)/i;
const isDeepSeek = (baseUrl) => DEEPSEEK_HOST.test(String(baseUrl || ''));

/**
 * 关掉 DeepSeek 的思考模式。
 *
 * 这条也是拿真实故障换来的：DeepSeek **默认打开思考模式，且 effort 默认 high**，
 * 模型会先吐一整段 `reasoning_content` 再吐正文。这个 App 只读 `message.content`，
 * 思维链那段时间一个字都收不到 —— 手机上就是「在想。。」一直转，看图尤其明显。
 *
 * 注意：`thinking` 不是标准 OpenAI 参数，发给别家（通义、月之暗面等）可能直接 400，
 * 所以只对 DeepSeek 的域名发。想恢复思考模式：把 disabled 改成 enabled。
 */
function applyThinking(body, baseUrl) {
  if (isDeepSeek(baseUrl)) body.thinking = { type: 'disabled' };
  return body;
}

/**
 * 把常见的接口地址写法归一。
 *
 * `https://api.deepseek.com` 和 `https://api.deepseek.com/v1` 官方都认，
 * 但 README 和各家 SDK 写的都是带 `/v1` 的那个，统一成它少踩坑。
 * 已经带路径的（`.../compatible-mode/v1`）原样保留。
 */
function normalizeBaseUrl(raw) {
  const s = String(raw || '').trim().replace(/\/+$/, '');
  if (!s) return '';
  if (/^https?:\/\/(api\.)?deepseek\.com$/i.test(s)) {
    return s + '/v1';
  }
  return s;
}

/**
 * 重试时把图片换成一句说明。
 *
 * 四档重试如果每档都重发完整 base64，一张 4 MB 的图要出网 16 MB，
 * 手机上一次能等好几分钟 —— 这本身就是「卡在想」的另一个来源。
 * 图已经进仓库了，把路径告诉模型就够它继续聊。
 */
function stripImagesForRetry(messages, imageLines) {
  const note = imageLines ? `（图片已经存进仓库，但我这次看不到内容：\n${imageLines}）` : '（这次看不到图片内容。）';
  return messages.map((m) => {
    if (!Array.isArray(m.content)) return m;
    const hasImage = m.content.some((p) => p?.type === 'image_url');
    if (!hasImage) return m;
    const text = m.content
      .filter((p) => p?.type === 'text')
      .map((p) => p.text)
      .join('\n');
    return { ...m, content: [text, note].filter(Boolean).join('\n') };
  });
}


/**
 * 带超时、并且会报清楚「是谁连不上」的 fetch。
 *
 * 两件事都拿真实故障换来过：
 *
 * 1. **没有超时就会永远卡住**。原来一个超时都没有，手机发图之后界面就
 *    卡在「在想。。」永远转下去 —— 视觉接口不回、连接半死不活、运营商挂起，
 *    三种情况表现完全一样。宁可等到 150 秒报一句明确的「超时」。
 *    150 秒是给「看图」留的余量：图片比纯文字慢，再叠上模型侧排队，
 *    90 秒实测偏紧，会把本来能成功的一次误报成超时。
 *
 * 2. **网络层失败必须说清是谁**。`fetch` 拨不通时抛的是 TypeError，
 *    message 只有 Safari 的「Load failed」或 Chrome 的「Failed to fetch」
 *    —— 用户看到的就这一句，分不出是 GitHub 还是模型接口。所以用 label
 *    把服务名和主机名（**不含 key**）挂在前面。
 *
 * 浏览器和 Node 都有 AbortController，不需要额外依赖。
 */
const DEFAULT_TIMEOUT_MS = 150000;

async function fetchWithTimeout(url, opts = {}, timeoutMs = DEFAULT_TIMEOUT_MS, label = '') {
  const ctl = new AbortController();
  const ms = Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctl.signal });
  } catch (err) {
    // abort 在浏览器里是 AbortError，Node 里是自己抛的 InvalidStateError
    if (ctl.signal.aborted) {
      const e = new Error(`请求超过 ${Math.round(ms / 1000)} 秒没有响应（网络或者接口卡住了）`);
      e.timeout = true;
      throw e;
    }
    // 网络层失败：把「是谁」补上，别只留一句 Load failed
    let host = '';
    try {
      host = new URL(String(url)).host;
    } catch {}
    const e = new Error(`连不上${label}${host ? '（' + host + '）' : ''}：${err?.message || err}`);
    e.cause = err;
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

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

### 要删掉一个栏目，用这个

\`\`\`json
{ "section": "栏目名", "delete": true }
\`\`\`

**合并重复栏目时必须用它。** 正确的两步是：

1. 把两个栏目的内容并起来，用 \`content\` 写进要保留的那个
2. 用 \`delete: true\` 把多余的那个删掉

**只改内容不删，重复的栏目还在。** 删不掉就说明白，不要假装删了。

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

**这是条原则，不是一张词表 —— 别去找别的说法绕过去。**

**任何关于「档案变了」的话，都必须以这一轮 \`updates\` 里真的改了东西为前提。**

不管是完成时、进行时还是将来时：

- ✗ 「记下了」「存好了」「已归到身体下面了」
- ✗ 「合并好了」「整理完了」「重复的已经去掉了」
- ✗ 「我把它们合并一下」「我这就改」「稍后补上」

只要这一轮的 \`updates\` 是空的（或者 \`delete\` 没真的删掉东西），
**上面这些一个字都不许说。**

做不到就老实说做不到，别报个假的完成。

**问句是允许的** —— 「要我现在把它们合并掉吗？」这种征求意见没问题。
但 ta 一旦说"要"，下一轮你就**必须真的动手**。

**要改就这一轮改完，改不了就直说改不了。中间态和假完成，一个字都不要说。**

ta 问"有没有重复"这种关于档案本身的问题时，正确做法是：
**先在这一轮的 \`updates\` 里真的改好，然后才在 reply 里说改了什么。**

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

/**
 * 整个删掉一个栏目。
 *
 * ⚠ 这个函数不能没有。模型合并重复栏目时要做的事是「把内容并进 A，再删掉 B」，
 * 而原来的 updates 只能改和建、**不能删** —— 它做不到，于是嘴上说「合并好了」，
 * 档案一个字没动。给它删的能力，它就不用撒谎了。
 */
function removeSection(md, name) {
  const re = new RegExp(`^##[ \\t]+${escapeRe(name)}[ \\t]*$`, 'm');
  const m = re.exec(md);
  if (!m) return md;

  const afterHeader = m.index + m[0].length;
  const rest = md.slice(afterHeader);
  const nextRel = rest.search(/^##[ \t]+/m);
  const end = nextRel === -1 ? md.length : afterHeader + nextRel;

  const joined = md.slice(0, m.index) + md.slice(end);
  return joined.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+$/, '').replace(/\s*$/, '') + '\n';
}

async function callModel(slot, messages, { json = false, temperature = 0.8, phase } = {}) {
  if (!slot.apiKey || !slot.baseUrl || !slot.model) {
    throw new Error('模型槽位没配好（baseUrl / apiKey / model 缺一个）');
  }
  const body = {
    model: slot.model,
    messages,
    temperature,
  };
  if (json) body.response_format = { type: 'json_object' };
  applyThinking(body, slot.baseUrl);

  const t0 = Date.now();
  const res = await fetchWithTimeout(
    endpoint(slot.baseUrl),
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${slot.apiKey}`,
      },
      body: JSON.stringify(body),
    },
    DEFAULT_TIMEOUT_MS,
    `模型接口（${slot.model}）`
  );
  phase?.(`模型回应了 · ${((Date.now() - t0) / 1000).toFixed(1)}s`);

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
async function callUntilUsable(slot, messages, { phase, onRetry } = {}) {
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
    // 重试时先让调用方有机会换掉昂贵的内容（比如整张图的 base64）
    if (i > 0 && onRetry) msgs = onRetry(msgs);
    if (a.nudge) msgs = [...msgs, { role: 'user', content: NUDGE }];
    if (a.minimal) msgs = [{ role: 'system', content: MINIMAL }, msgs[msgs.length - 1]];

    phase?.(i === 0 ? `在问模型（${slot.model}）…` : `第 ${i + 1} 种方式重试中（${a.label}）…`);

    const r = await callModel(slot, msgs, { json: a.json, temperature: a.temperature, phase });
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
  const url = `${ghUrl(g, path)}?ref=${encodeURIComponent(g.branch || 'main')}`;
  const r = await fetchWithTimeout(
    url,
    { headers: ghHeaders(g), cache: 'no-store' },
    DEFAULT_TIMEOUT_MS,
    ' GitHub'
  );
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

  const r = await fetchWithTimeout(
    ghUrl(g, path),
    {
      method: 'PUT',
      headers: { ...ghHeaders(g), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    DEFAULT_TIMEOUT_MS,
    ' GitHub'
  );

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

async function readJournal(g, { phase } = {}) {
  phase?.('在读 GitHub 上的档案…');
  const f = await ghGet(g, g.journalPath || 'journal.md');
  if (!f) return { md: JOURNAL_HEADER, sha: null };
  return { md: f.text, sha: f.sha };
}

/**
 * 把 data URL 拆成 `{ mime, b64 }`。
 *
 * ⚠ base64 正文里的换行必须先清掉：Canvas 的 toDataURL 一般不换行，但
 * 别的来源会，而 GitHub 的内容 API 讨厌 `\n`。原来的正则用 `.` 不跨行，
 * 带换行的数据 URL 会**匹配失败然后被静默丢掉** —— 图片看着"发了"，
 * 仓库里却没有。
 */
function parseDataUrl(du) {
  const s = String(du || '').trim();
  const comma = s.indexOf(',');
  if (comma < 0) return null;
  const head = /^data:([^;,]+);base64$/i.exec(s.slice(0, comma));
  if (!head) return null;
  const b64 = s.slice(comma + 1).replace(/\s+/g, '');
  if (!b64) return null;
  return { mime: head[1].toLowerCase(), b64 };
}

/** 把图片存进同一个仓库的 images/ 下，返回相对路径 */
async function saveImages(g, dataUrls, { phase } = {}) {
  const list = dataUrls || [];
  const out = [];
  for (const du of list) {
    const parsed = parseDataUrl(du);
    if (!parsed) {
      // 不静默：说不清楚是哪一张，就让调用方知道有一张被跳过了
      throw new Error('有一张图片的格式读不出来（不是标准的 data URL），没有传进仓库');
    }
    const ext =
      { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' }[parsed.mime] ||
      'jpg';
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
    const name = `images/${stamp}-${Math.random().toString(16).slice(2, 8)}.${ext}`;
    phase?.(`在把图片传进仓库（${out.length + 1}/${list.length}）…`);
    try {
      await ghPutB64(g, name, parsed.b64, null, `图片 ${name}`);
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

/**
 * 会话持久化前的瘦身。
 *
 * ⚠ 这条是拿真实故障换来的，别改回去：
 * 原来 localStorage 直接存整条 turns，而图片是完整 base64 ——
 * 手机一张原图 base64 就有 4 MB 上下，**5 MB 配额当场爆掉**，
 * `localStorage.setItem` 同步抛 QuotaExceededError。
 * 那个调用在 send() 里不在 try 块内，异常直接冲出函数：
 * 界面永远停在「在想。。」、runTurn 一次都没跑（仓库里当然没有图）、
 * 刷新后只剩上一次保存的旧会话 —— 三个症状，一个原因。
 *
 * 所以：**任何 data URL 都不准进 localStorage**，只留张数、路径和缩略图。
 */
const STORAGE_BUDGET = 3 * 1024 * 1024; // 留一半余量，别的页面可能也在用

function storageSnapshot(turns, budget = STORAGE_BUDGET) {
  let images = null; // 图片全丢了就记一笔，返回给调用方提示
  const slim = (arr) =>
    (arr || []).map((t) => {
      if (!t || typeof t !== 'object') return t;
      if (t.imgs && t.imgs.length) {
        images = t.imgs.length;
        return {
          role: t.role,
          text: t.text,
          at: t.at,
          updated: t.updated,
          error: t.error,
          imgCount: t.imgs.length,
          thumbs: t.imgs.map((i) => i?.thumb || i?.rel || '').filter(Boolean),
        };
      }
      return t;
    });

  let out = slim(turns);
  // 还是太大（对话太长）→ 从最老的开始丢缩略图，文字一条不丢
  for (let round = 0; round < 4 && JSON.stringify(out).length > budget; round++) {
    let dropped = false;
    for (const t of out) {
      if (t && t.thumbs && t.thumbs.length > 1) {
        t.thumbs = t.thumbs.slice(-1);
        dropped = true;
      }
    }
    if (!dropped) break;
  }
  return { turns: out, images };
}

// ═══════════════════════════════════════════════ 一轮对话

/**
 * 读档案 → 问模型 → 写回档案。
 * @param {object} [opts] - opts.phase(text) 用来给界面报当前进行到哪一步了
 * @returns {Promise<{reply:string, updated:boolean, images:string[]}>}
 */
async function runTurn(cfg, history, input, { phase } = {}) {
  const g = cfg.github;
  const now = localNow();

  let { md, sha } = await readJournal(g, { phase });

  const images = await saveImages(g, input?.images || [], { phase });
  /**
   * 留空 = 用聊天模型。
   *
   * 同厂家的多模态模型（比如 deepseek-flash）本身就能看图，再填一遍纯属重复劳动，
   * 而且两栏填不一致时会出现「文字走 A、图片走 B」的怪现象。
   * 三栏都填了才用视觉槽位，否则回退到聊天槽位。
   */
  const visionCfg =
    cfg.vision?.apiKey && cfg.vision?.baseUrl && cfg.vision?.model ? cfg.vision : cfg.chat;
  const hasVision = Boolean(visionCfg?.apiKey && visionCfg?.baseUrl && visionCfg?.model);
  const visionIsOwnSlot = visionCfg === cfg.vision;

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

  const slot = hasVision && images.length ? visionCfg : cfg.chat;
  const messages = buildMessages(buildSystemPrompt(md, now.text, hasVision), history, userContent);

  if (images.length) {
    phase?.(
      hasVision
        ? `在问视觉模型（${visionCfg.model}）${visionIsOwnSlot ? '' : ' · 视觉栏留空，用的聊天模型'}…`
        : '没配视觉模型，只能问它这是什么…'
    );
  } else {
    phase?.('在想…');
  }

  let r;
  try {
    r = await callUntilUsable(slot, messages, {
      phase,
      // 第 2 档开始不再重发整张图：图已经在仓库里，重发 4 MB×3 次
      // 只会让手机上多等好几分钟。
      onRetry: (msgs) => (images.length ? stripImagesForRetry(msgs, imageLines) : msgs),
    });
  } catch (err) {
    // 有些视觉接口要的是**不带** `data:...;base64,` 前缀的纯 base64。
    // 只在确实调用了视觉接口、而且不是超时的情况下换一种再试一次。
    if (!hasVision || !images.length || err.timeout) throw err;
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
    phase?.('视觉接口没接受标准格式，换纯 base64 再试一次…');
    r = await callUntilUsable(slot, bare, {
      phase,
      onRetry: (msgs) => (images.length ? stripImagesForRetry(msgs, imageLines) : msgs),
    });
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
  let skippedUpdates = [];
  if (updates.length) {
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        let next = md;
        skippedUpdates = [];
        for (const u of updates) {
          if (!u || typeof u !== 'object') {
            skippedUpdates.push(String(u).slice(0, 60));
            continue;
          }
          const name = String(u.section || '').trim().replace(/^#+\s*/, '');
          if (!name) {
            skippedUpdates.push(JSON.stringify(u).slice(0, 80));
            continue;
          }
          // 删除：合并重复栏目时必须用它，光靠改内容是删不掉的
          if (u.delete === true) {
            next = removeSection(next, name);
            continue;
          }
          if (typeof u.content !== 'string') {
            // ⚠ 不要静默跳过。以前这里直接 continue，模型用别的字段表达删除时
            // 整条被吞掉，外面看起来就是「说了要改，档案却没动」，查都没法查。
            skippedUpdates.push(`「${name}」既没有 content，也没有 delete 标记`);
            continue;
          }
          next = replaceSection(next, name, u.content);
        }
        if (skippedUpdates.length) {
          console.warn(`  ⚠ 有 ${skippedUpdates.length} 条更新看不懂，已跳过：${skippedUpdates.join('；')}`);
        }
        if (next === md) break;
        try {
          phase?.('在把这一条写进档案…');
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

  return {
    reply,
    updated,
    writeError,
    skippedUpdates,
    images: images.map((i) => i.rel).filter(Boolean),
  };
}

export {
  MAX_HISTORY,
  DEFAULT_TIMEOUT_MS,
  STORAGE_BUDGET,
  fetchWithTimeout,
  normalizeBaseUrl,
  applyThinking,
  isDeepSeek,
  buildSystemPrompt,
  buildMessages,
  parseModelJSON,
  salvageReply,
  replaceSection,
  removeSection,
  callModel,
  callUntilUsable,
  localNow,
  readJournal,
  saveImages,
  parseDataUrl,
  stripImagesForRetry,
  storageSnapshot,
  runTurn,
  JOURNAL_HEADER,
  b64ToText,
  textToB64,
};
