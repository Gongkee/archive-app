# 档案

随手说点什么——一句话、一张照片、刚做完的一件事——它接话，然后把值得留下的东西写进**你自己 GitHub 仓库里的一份 markdown**。

**没有服务器。** 手机上的 App 直接跟模型和 GitHub 说话。

```
        手机上的 App（托管在 GitHub Pages）
              │
      ┌───────┴────────┐
      ▼                ▼
  DeepSeek/通义      GitHub API
  （聊天 + 看图）   （读写你的私有仓库）
```

---

## 一次性设置（十五分钟）

### 1. 建一个**私有**仓库放档案

GitHub → New repository：

- 名字随便，比如 `my-journal`
- **选 Private**
- ✅ **勾上 "Add a README file"** ← 别漏，否则仓库没有初始分支，App 第一次写不进去

### 2. 生成访问令牌

GitHub → 右上角头像 → Settings → Developer settings → **Personal access tokens → Fine-grained tokens** → Generate new token：

| 项 | 填什么 |
|---|---|
| Repository access | **Only select repositories** → 只勾 `my-journal` |
| Permissions → Repository permissions → **Contents** | **Read and write** |
| Expiration | 按你喜好（一年或更久） |

生成后**把那串 `github_pat_...` 复制下来**——它只显示一次。

> ⚠️ 这个令牌只能碰 `my-journal` 这一个仓库，别的什么都动不了。这是故意的。

### 3. 把 App 发到 GitHub

在 `archive-app` 目录里：

```powershell
git init
git add .
git commit -m "档案 App"
git branch -M main
git remote add origin https://github.com/<你的用户名>/archive-app.git
git push -u origin main
```

（先在 GitHub 上建一个**公开**仓库叫 `archive-app`，别勾 README。）

### 4. 开启 GitHub Pages

那个 App 仓库 → Settings → Pages：

- Source: **Deploy from a branch**
- Branch: **main** / **/(root)**
- Save

等一分钟，网址是：

```
https://<你的用户名>.github.io/archive-app/
```

### 5. 手机上装

手机浏览器打开上面那个网址 → 点右上角**设置**，填三组东西：

| 组 | 填什么 |
|---|---|
| **GitHub** | 令牌（第 2 步那串）、用户名、仓库名 `my-journal`、分支 `main` |
| **聊天模型** | 接口地址 `https://api.deepseek.com/v1`、模型 `deepseek-chat`、你的 DeepSeek Key |
| **视觉模型** | 见下面「看图」一节（可以留空） |

保存 → 点**测试连接**，两行都通了就对了。

然后浏览器菜单里选「**添加到主屏幕**」。

**完事。** 以后点桌面上那个图标就能用。

---

## 看图（可选）

视觉模型这一栏**留空也行**——图片会自动交给聊天模型。所以只要你的聊天模型本身能看图（比如 `deepseek-flash`），这里不填也没关系。想用更强的看图模型再填：

**注意智谱不接受网页直连**（没有 CORS），用这几家：

| 提供方 | 接口地址 | 模型名 |
|---|---|---|
| 通义 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-vl-max` |
| 硅基流动 | `https://api.siliconflow.cn/v1` | 看它家模型列表 |
| 月之暗面 | `https://api.moonshot.cn/v1` | `moonshot-v1-8k-vision-preview` |

聊天模型也看不见图的话，照片照样发、照样进仓库，只是 AI 看不到内容，会反过来问你这是什么。

**发之前会自动压缩**：最长边压到 1600px、JPEG 质量 0.85。手机原图动辄 4 MB，压完通常只有几百 KB——又快又省流量，而且不会撑爆浏览器那 5 MB 的本地存储配额。

---

## 怎么用

- **打字**：回车发送，Shift+回车换行
- **发照片**：点左下角 `＋`
- **看档案**：右上角「看档案」，就是你 GitHub 上那份 markdown
- **新的一段**：清掉屏幕上的对话（档案不受影响）

聊天记录那段只留在手机浏览器里，超过 90 分钟没动静就自动翻篇——**长期记忆全在那份 markdown 里**。

---

## 出问题了

| 现象 | 原因 |
|---|---|
| 「GitHub 令牌无效」 | 令牌过期了，或者在设置里贴错了 |
| 「找不到仓库或文件」 | 用户名/仓库名写错，或者令牌没勾这个仓库 |
| 手机打不开网址 | `github.io` 在国内时好时坏。换个网络试试 |
| 模型报 401 | 模型 Key 不对，或者余额没了 |
| 模型报跨域错误 | 这家不接受网页直连（智谱就是），换一家 |
| 聊完没写进档案 | 模型判断这条不值得记。直接说「把这个记下来」 |
| 发大图永远卡在「在想。。」 | 老版本会把整张图的 base64 塞进 localStorage，超 5 MB 配额直接抛异常，界面卡死、图也不会进仓库。现在发图前会先压缩，并且 base64 绝不进本地存储 |
| 刷新后图片变成「图片已存进仓库」 | 正常。大图只存在 GitHub 仓库里，本地只留缩略图 |

---

## 关于花费和记录

- 每聊一次 = 一次 GitHub 提交。用久了仓库历史会比较长——**这是好事**，你能看到自己的档案是怎么一天天长起来的。
- 模型费用自理。DeepSeek 很便宜，还有 prompt 缓存。
- **App 代码是公开的，你的档案是私有的。** 两者不在一个仓库里，令牌和 Key 只存在你手机本地。

---

## 开发

```powershell
node test.mjs          # 网络全部 mock 掉
node check-html.mjs    # 单独体检 index.html 里的内联脚本语法
node make-icons.mjs    # 重新生成图标
```

`archive-core.js` 是全部逻辑（浏览器和 Node 通用）。里面有**几处是拿真实故障换来的**，注释写了原因，改之前先看：

- `MAX_HISTORY` / `buildMessages()` —— 对话历史的格式和长度，实测能把记录率从 3/14 拉到 13/14
- `stripSectionHeading()` —— 正文里混进 `## 标题` 会长出重复栏目，必须**全部**剥掉，不能只剥开头的
- `callUntilUsable()` —— 模型吐空白或吐 JSON 残渣时的兜底
- `storageSnapshot()` —— **持久化之前必须剥掉图片的 base64**。手机上整张图的 base64 就有 4 MB 左右，直接存 localStorage 会超 5 MB 配额、同步抛异常，而那个调用在 `send()` 的 try 块之外 —— 结果就是界面永远卡在「在想。。」、图也进不了仓库。**别改回去。**
- `parseDataUrl()` —— 带换行的 base64 也要认。以前的正则不跨行，匹配失败就**静默丢图**
- `applyUpdates()` —— 三件事：`delete` 让路给同一轮的写入、全篇扫重复栏目、看不懂的更新条目**不许静默跳过**

改完跑 `node test.mjs`（`check-html.mjs` 也要跑，浏览器不会帮你提前发现拼写错误）。**别靠肉眼验。**

### 改了提示词之后

```powershell
node verify-merge.mjs      # 重复栏目能不能真的清干净、会不会丢内容
node verify-prompt.mjs     # 模糊数字会不会被翻译成精确值、会不会一直追问
```

这两个**用真模型跑**（要花点钱、结果有随机性，所以不进 `test.mjs`）。
提示词这种东西 mock 测不出好坏 —— 只有真模型能告诉你它听不听话。

**`verify-merge.mjs`** 拿一份故意做了重复的档案，问三次"帮我整理一下"，检查：

1. 整理完还有没有重复栏目
2. **有没有丢掉一条真的记录** ← 这条更重要。少一条重复没关系，少一条记录不行。

**`verify-prompt.mjs`** 检查两件容易出错的事：

1. **模糊数字会不会被"翻译"成精确值。**「今天亏了小1万」被记成 `-10000` 就是编造 ——
   它把"我记得差不多亏了一万"改成了"我亏了一万"。这类词必须留在记录里：
   小、大概、左右、不到、多、快、将近。
2. **ta 敷衍的时候会不会一直追问。** 会不会冒出「那就不问了」「想说了随时说」这种收尾话。

### 档案已经长了重复栏目怎么办

```powershell
node fix-journal.mjs journal.md
```

它写出 `journal.md.fixed.md`（**不覆盖原文件**），把重名栏目合到一起、去掉完全重复的行。
看一眼确认没问题，再自己替换。

> 顺带一提：**App 现在自己会清**。每次写档案都会全篇扫一遍重复栏目并合并，
> 所以这个工具主要是给历史遗留的档案用的。
