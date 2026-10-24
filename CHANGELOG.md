# Changelog

本文件记录 dsh-qq 的版本变更。格式照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号照 [SemVer](https://semver.org/lang/zh-CN/)。

## [0.3.0] - 2026-10-24

这一版把插件里属于某一个人的东西全部拿掉：谁都可以装，装了也是它自己。

### 变更

- **新增 `persona` 配置**：它是谁、什么性格、怎么称呼人，全写在这里；留空就是一个没有名字、说话正常的普通助手。插件不再自带任何私人设定。
- **认主人（群聊打标 + 私聊保底）**（`ownerIds` / `ownerLabel`）：群聊里这些 QQ 号的发言会在群历史里标上主人称呼（`[昵称 (QQ号) · 主人 12:30] 内容`），Agent 优先响应、问本机的事也正常答；其他成员按陌生人对待，不替他们跑命令、改文件，也不主动抖本机路径。私聊里对面是名单里的人时，正文带 `[主人]` 标记并注入私聊版认人规矩，防止「群聊认了、私聊反而忘了」。
- **聊天规矩改中性版**（`src/prompts.js`）：只保留「怎么说话」这类跟角色无关的规矩（短句、口语、不贴路径、不写 Markdown、群里收着说），并且改成**会话第一次投递时注入一次**，不再每条消息都重复一遍占 token。
- **图片默认不收**：新增 `faceCollectHint`，不配就一张都不收藏；配了只收描述里那一类图。
- **`/reset` 文案**去掉个人称呼。
- **ASR 默认值去个人化**：`asrPython` 默认 `python`（走 PATH），`asrScript` 留空用插件自带的 `tools/asr.py`，新增 `asrModel` 指定 vosk 模型目录；模型目录优先级 = 参数 > `VOSK_MODEL` > `<插件>/../models/vosk-model-small-cn-0.22`。

### 修复

- `tools/asr.py` 支持第二个参数传模型目录，并在加载失败时把实际路径带进错误信息。

## [0.2.0] - 2026-10-24

这一版把「能聊」做成「能一起过日子」：会听语音、会收表情包、能反过来问你话，每个会话还有自己的记忆区。

### 新增

- **语音消息转文字**（`asrEnabled` / `asrPython` / `asrScript` / `asrTimeoutMs`）
  本地 vosk 离线识别，不联网、不上传；识别结果以 `[语音转文字] …` 并入对话，转不出来就如实标注。
- **表情包收藏夹**（`src/faces.js`）
  收到的商城表情会顺手记下身份证；图片按 `faceCollectHint` 判断要不要收，收进 `<workspaceRoot>/表情包收藏.json`；同名文件自动去重，路径相对 `workspaceRoot` 存。
- **`ask_user_question` → QQ 问答通道**（`src/questions.js`）
  Agent 提问会转发成一条 QQ 消息（`❓ 标题 / 正文 / 1) 选项A …`），用户回数字或原文，插件翻回 `selected: [选项文本]`。
- **授权审批 → QQ**（`src/approval.js`）
  需要授权的操作发到 QQ，回「通过 / 拒绝」即可。
- **群 @ 保活**（`groupWakeMs`，默认 5 分钟）
  被 @ 过一次之后，一段时间内不 @ 也能接着聊。
- **会话工作目录隔离**（`workspaceRoot` / `isolateByPeer`，`src/workspace.js`）
  每个私聊 / 每个群一个独立目录，首次使用自动铺 `AGENTS.md` + `记忆区/日记/`，互不可见，也不碰宿主自己的私人记忆。
- **新增工具**：`qq_send_file` / `qq_face` / `qq_mface` / `qq_reply` / `qq_send`（互动工具从 5 个到 10 个）。
- **引用还原**（`quoteReply`）：消息带引用时，把「被引用的人 + 原文」一并交给 Agent。
- **节奏控制**：`rateLimitPerMin`（默认 12 条/分钟）、`streamReply` / `streamMaxChunks`。
- **单轮超时**（`maxTurnMs`，默认 10 分钟）：超时只提示，不打断 Agent。

### 修复

- 重复回复：同一条 `assistant/message` 只发一次，并给出重复实例的排查线索。
- 群聊未 @ 且不在保活期时不再空跑一轮。
- 调试日志改为跟随 `workspaceRoot`（之前跟着进程 cwd，从程序目录启动时会写到安装目录里，差点误判「没在跑」）。
- 会话查找新增 `findByAgent(agent)`，问答 / 审批通道拿不到 sessionId 时能兜底。

### 说明

- 在 `cordis.patch.yml` 里**新增**插件条目必须用 `- insert:`；顶层 `- id: xxx` 只用于覆盖已存在的行，写不存在 id 会被静默忽略。

## [0.1.0] - 2026-10-23

首个版本。

### 新增

- OneBot 11 / NapCat 正向 WebSocket 接入，断线自动重连。
- 私聊 / 群聊各一个持久 Agent 会话，群聊 @ 才理、可带最近消息当上下文。
- 长文本按段落分条发送。
- 互动工具：`qq_poke` / `qq_react` / `qq_like` / `qq_send_image` / `qq_recall`。
- 访问控制：`privateMode` / `groupMode` + 白名单。
