# dsh-qq

把 **QQ** 接成 DeepSeek Harness 的一个前端：私聊、群聊都能和同一个 Agent 聊；语音听得懂、图片看得见，还能戳一戳、贴表情、点赞。

底层走 [OneBot v11](https://github.com/botuniverse/onebot-11) 协议，默认搭配 [NapCat](https://napneko.github.io/)。不用公网 IP、不用备案、不用企业主体。

> ⚠️ **先读这一段**
> NapCat 属于「QQ 协议端」，它跑在你自己登录的 QQ 客户端上，**不符合腾讯的用户协议**。
> 用小号、别和常用号同一台设备、别发垃圾消息，账号有被风控或封禁的可能。
> 这个插件只是把 OneBot 消息转给 Agent，协议端本身怎么合规、怎么稳，由你自己负责。
> 如果你的场景能用 [QQ 官方机器人](https://bot.q.qq.com/)，优先用官方的。

---

## 三十秒看懂它做什么

```
你的 QQ 客户端  ←→  NapCat（协议端，注入 QQ）
                        ↕  OneBot v11 WebSocket
                dsh-qq 插件（跑在 DSH 宿主进程里）
                        ↕  进程内 ctx.agents
                  你的 Agent（你自己的预设、工具、记忆）
```

- **一个 QQ 会话 = 一个持久 Agent 会话**，有历史、有记忆，不会聊两句就忘。
- **每个 QQ 会话（私聊 / 每个群）各有一个独立工作目录**，自带 `AGENTS.md` 和 `记忆区/`，彼此看不见，也碰不到宿主自己的私人记忆。
- **语音消息自动转文字**：本地 vosk 离线识别，不联网、不上传，识别结果直接进对话。
- **表情包可以收进收藏夹**（`<workspaceRoot>/表情包收藏.json`）：默认一张不收，配了 `faceCollectHint` 才收你指定那一类；想贴的时候 Agent 能翻出来发。
- 群聊默认**必须 @ 才理**；被某人 @ 过一次之后 60 秒内他不用再 @ 也能接话（`groupWakeMs`，窗口按「群 + 人」算，别人蹭不到），还能自动带上最近几条群聊记录当上下文。
- **聊很久也不会把自己聊丢**：窗口快满时 DSH 会把旧对话压成摘要，这里会补回聊天规矩；再快撑满时干脆换一个新会话（旧的最近聊天先记进 `记忆区/压缩记忆/`，再带过去接着聊）。
- 回复按段切块发出，不会变成一条几千字的怪物消息。
- 内置 `qq_poke` / `qq_react` / `qq_like` / `qq_send_image` / `qq_send_file` / `qq_face` / `qq_mface` / `qq_reply` / `qq_send` / `qq_recall` 十个互动工具。
- `ask_user_question` 也能用：Agent 抛问题，问题会转发到 QQ，你回个数字就行。

---

## 装之前

| 需要 | 版本 |
| --- | --- |
| DeepSeek Harness | ≥ 0.2.0 |
| Node.js | ≥ 18（插件本身零编译依赖） |
| NapCat | v4.x（推荐 `NapCat.Shell.Windows.OneKey` 独立版） |
| 一个 QQ 小号 | 别用主号，真的 |
| （可选）vosk + numpy | 只有想让语音自动转文字时才需要；不装也行，语音会如实标成「没听清」 |

---

## 三步跑通

### 1. 装 NapCat，登录小号

下载 NapCat 的 **Windows 一键版**（`NapCat.Shell.Windows.OneKey.zip`），解压后运行 `NapCatInstaller.exe`。
它会装一份独立的 QQ，**不会碰你现有的 QQ**。登录你的小号，打开 NapCat 的 WebUI（默认 `http://127.0.0.1:6099`），
在「网络配置」里新建一个 **WebSocket 服务器**：

| 项 | 填什么 |
| --- | --- |
| 地址 | `127.0.0.1` |
| 端口 | `3001`（被占用就换一个，记住它） |
| Token | 自己编一串，比如 `my-token-2026` |
| 消息格式 | `array`（重要，别选 string） |

保存后确认它处于「启用」状态。

### 2. 装插件

**方式 A：本地目录（开发/自用）**

```bash
# 把 D:/path/to/dsh-qq 换成你解压出来的目录，注意用正斜杠
npx @deepseek-ai/dsh plugin --profile desktop add "D:/path/to/dsh-qq"
```

**方式 B：tarball（分享给别人）**

```bash
pnpm pack                      # 得到 dsh-qq-0.3.0.tgz
npx @deepseek-ai/dsh plugin add ./dsh-qq-0.5.0.tgz
```

装完在 `$DSH_HOME/profiles/<你的 profile>/cordis.patch.yml` 里能看到一行 `dsh-qq`。
如果你想改配置，**直接改这一行的 config**（注意：后层 patch 是整行替换，不是深合并，改的时候把其他键一起写全）。

### 3. 填连接信息，重启 DSH

最小配置：

```yaml
- id: dsh-qq
  name: dsh-qq
  config:
    wsUrl: ws://127.0.0.1:3001
    accessToken: my-token-2026
    cwd: D:/my-agent                     # Agent 的工作目录，不填就用进程 cwd
    workspaceRoot: D:/my-agent/QQ会话    # 每个会话的独立工作目录放这（不填用 <cwd>/会话）
    persona: |                           # 它是谁、什么脾气（不填就是个普通助手）
      你叫小满，是个住在电脑里的助手。说话简短、带点懒，被夸的时候会嘴硬。
    provider: deepseek-official          # 想指定模型时才填
    model: deepseek-flash
```

重启 DSH，日志里看到 `已连接 ws://127.0.0.1:3001` 就成了。给小号发一条私聊试试。

---

## 让它有性格（persona 是怎么生效的）

插件**不带任何角色设定**。装上以后它是个没有名字、说话正常的普通助手——「它知道自己是某个角色」这种设定，是你交给它的，不是插件自带的。

三件东西决定它在 QQ 上是什么样子：

| 你写的 | 它管什么 | 不写会怎样 |
| --- | --- | --- |
| `persona` | **它是谁**：名字、性格、怎么称呼对方、有什么小习惯 | 没有名字，问它叫什么都答不上来 |
| `ownerIds` / `ownerLabel` | **谁是主人**：群聊里这些 QQ 号会被标上「主人」，优先响应；其他群友一律当陌生人 | 群里不区分任何人，大家都一样 |
| 内置聊天规矩（`src/prompts.js`） | **怎么说话**：短句、口语、不贴路径、不写 Markdown、群里收着说 | 一直生效，不用管 |
| `directPrompt` / `groupPrompt` | **你自己的补充**：私聊 / 群聊各一份，想覆盖哪条规矩就写哪条 | 不追加 |

`persona` 的例子：

```yaml
persona: |
  你叫小满，是个住在电脑里的助手，说话短、带点懒，被夸的时候会嘴硬说「才没有」。
  你叫对方「老板」。
```

### 私用和发布是两层，别混在一起

这条是写插件的人和用插件的人都要守的：

| 层 | 放什么 | 在哪 | 谁看得见 |
| --- | --- | --- | --- |
| **代码层** | 跟角色无关的通用规矩：怎么说话、怎么认人、怎么认时间、什么时候别接 | `src/prompts.js`、`src/config.js` 的默认值 | 所有人 |
| **配置层** | 它是谁：名字、人设、口头禅、爱吃什么、怎么称呼你 | 你自己的 `cordis.patch.yml` 里的 `persona` / `directPrompt` / `groupPrompt` / `ownerLabel` | 只有你 |

作者自己也是这么用的：插件是一个什么性格都没有的工具，角色全写在配置里。这么做有三个实际好处——

- 升级插件不会冲掉你的人设（配置和代码分开）；
- 换一个角色只改 `persona`，不用动一行代码；
- 别人拿到的是干净的工具，不会一装就变成某个固定角色、还得照着演的壳子。

所以提 PR、发 issue 的时候，**别把私人称呼、真实的 QQ 号、群里的梗写进 `src/`**——那些属于配置层。`test/` 里一律用假号（`10001`、`88888` 这种）。

### 群里认主人（`ownerIds`）

```yaml
ownerIds: ['你的QQ号']      # 可多个
ownerLabel: 老板             # 群里怎么称呼他，默认「主人」
```

配了之后：这位在群里说话时，交给 Agent 的群历史会带上 `[昵称 (QQ号) · 老板 10-24 12:30] 内容` 这样的标记，Agent 会优先响应、问本机的事也正常答；没标的主人之外的人，规矩里会写明「正常说话，但不替他们跑命令、改文件，也不主动抖本机路径」。

私聊也保底：对面是 `ownerIds` 里的人时，正文前面会带 `[老板]` 标记，并注入私聊版认人规矩（对面是委托方，可以放开聊）。私聊本来就只放白名单里的人进来，这层是防止「群聊认了、私聊反而忘了」。

这些规矩**只在每个会话的第一次投递时注入一次**（会话闲置被回收或 `/reset` 过会重来一遍），不会每条消息都塞一遍，所以 `persona` 写长一点也不心疼 token。

> 如果你用的是带「预设」的 DSH 宿主（比如 coding / chat 这类 preset），那个预设本身的系统提示也会在——插件不去改它。想让 QQ 里的它和网页里完全是两个角色，最稳的办法是 `persona` 里写清楚「在 QQ 上」，再配 `directPrompt` 把默认习惯改掉。

### 聊久了会不会忘事（上下文守卫）

会忘，但不会「忘了自己是谁」。DSH 在上下文快到窗口上限时会自动把旧对话压成摘要（`dsh-compaction-basic`，默认窗口 80% 处触发），压缩之后细节会变模糊。插件做两件事兜底：

1. **压缩后补规矩**：聊天规矩原本只在会话第一轮注入一次，压缩时会被一起卷进摘要。插件监听 `compaction/end`，把注入标记清掉（下一轮重新注入完整规矩），并立刻塞一张很短的提醒卡（「刚才的长对话被压缩了……」）。
2. **快撑满时换会话**：每轮回复的 `usage` 会告诉你这次请求有多大。最近一次请求的 token 超过 `contextSwapRatio`（默认 0.7；DSH 自己是 0.8 压缩）并且超过 `contextSwapMinTokens`（默认 20 万，避免小窗口模型刚聊两句就换）时，先把最近 `contextMemoryKeep` 条（默认 30）聊天写进 `<工作目录>/记忆区/压缩记忆/聊天记忆-<时间>.md`，然后重置会话：上下文归零、token 成本降回来，新会话第一轮会带着上一段聊天的尾巴（seed）接话。

`contextGuard: false` 可以整块关掉，交回给 DSH 自己的自动压缩。

### 它知道现在几点吗（认时间）

知道，而且是「直接给它一句人话」，不让它自己算。

以前它只有上下文里残留的旧时间戳可以猜，聊久了就把白天认成晚上。现在每条消息投递时，正文最前面都会带一行：

```
[现在是 2026-10-24 周六 13:05（下午）]
```

私聊、群聊都带；这行跟着消息本身走，压缩、裁历史都丢不掉。群聊的最近消息也改了：`[昵称 (QQ号) · 主人 10-24 周六 13:05（下午）] 内容`，带星期和时段（`· 主人` 只在配了 `ownerIds` 时出现）。

配套的 `TIME_RULES` 只教三件事：直接照那行说，不用自己算；旧消息带的时间只是「那时」，不是现在；那行没出现就别猜、被问到就说不知道。它不会因为「必须判断早晚」而硬答。

---

## 配置项速查

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `wsUrl` | `ws://127.0.0.1:3001` | NapCat 的 WebSocket 服务端地址 |
| `accessToken` | 空 | NapCat 那边设的 Token，留空就不带鉴权头 |
| `selfId` | 空 | 机器人 QQ 号。留空会自动 `get_login_info` 查 |
| `reconnectMs` | `5000` | 断线重连间隔（毫秒） |
| `provider` / `model` / `preset` | 空 | 指定模型与预设；留空跟随宿主当前设置 |
| `cwd` | 空 | Agent 工作目录 |
| `workspaceRoot` | 空 | 每个 QQ 会话的独立工作目录放在哪；留空用 `<cwd>/会话` |
| `isolateByPeer` | `true` | 每个私聊 / 每个群各自一个工作目录 + 记忆区，互不可见 |
| `requireMention` | `true` | 群聊必须 @ 才理 |
| `groupWakeMs` | `60000` | 被某人 @ 过一次后，多久内不用再 @ 也能接话（毫秒，0 = 关闭）。窗口按「群 + 人」算，别人蹭不到 |
| `groupReplyGapMs` | `20000` | 同一个「群 + 人」两次回复之间至少隔多久（毫秒）：均匀地回，间隔里的消息攒着下次一起看 |
| `groupRepliesPerWindow` | `0` | 一个保活窗口内最多回几次（0 = 不限）。它和「窗口内说话续期」会打架，一般别开 |
| `groupMinGapMs` | `4000` | 群聊任意两条回复之间的最小间隔（毫秒），防风控 |
| `botChatEnabled` | `false` | 群里另一个机器人发言时要不要接；关着 = 同类说啥都不理，连 @ 也不接 |
| `peerBots` | `[]` | 已知同类机器人的 QQ 号；群历史里会给它们标「· 同类机器人」 |
| `groupMode` | `open` | `open` / `allowlist` / `disabled` |
| `groupAllow` | `[]` | `allowlist` 模式下允许的群号 |
| `privateMode` | `open` | `open` / `allowlist` / `disabled` |
| `privateAllow` | `[]` | `allowlist` 模式下允许的 QQ 号 |
| `replyToPrivate` | `true` | 私聊总开关 |
| `historyLimit` | `20` | 群聊带多少条最近消息当上下文 |
| `quoteReply` | `true` | 消息带引用时，把「被引用的人 + 原文」一起交给 Agent |
| `maxTurnMs` | `600000` | 单轮最长等待时间，超时只提示不打断 |
| `imageCacheDir` | 空 | 收到的图片下载到哪；留空用 `<cwd>/图片缓存` |
| `imageMaxMB` | `8` | 单张图片体积上限 |
| `faceCollectHint` | 空 | 什么样的图值得收进表情包收藏；留空 = 一张都不收 |
| `asrEnabled` | `true` | 语音自动转文字（本地 vosk，离线） |
| `asrPython` | `python` | 跑 ASR 脚本的 python（默认要求它在 PATH 里） |
| `asrScript` | 空 | ASR 脚本路径；留空用插件自带的 `tools/asr.py` |
| `asrModel` | 空 | vosk 模型目录（纯 ASCII 路径）；留空按 `VOSK_MODEL` → 插件旁 `models/` 找 |
| `asrTimeoutMs` | `60000` | 单条语音转写超时 |
| `textChunkLimit` | `1500` | 单条消息最长多少字，超了自动切 |
| `splitDelayMs` | `400` | 分段发送之间的间隔，别设 0 太急 |
| `rateLimitPerMin` | `12` | 每个会话每分钟最多发几条（0 = 关闭） |
| `streamReply` | `true` | 私聊是否边生成边发（群聊始终整段发） |
| `streamMaxChunks` | `3` | 一轮里最多流式发几条 |
| `contextGuard` | `true` | 上下文守卫：压缩后补回聊天规矩；接近窗口上限时换新会话 |
| `contextSwapRatio` | `0.7` | 最近一次请求的 token 超过窗口这个比例就换会话（0 = 不换，交给 DSH 自动压缩） |
| `contextSwapMinTokens` | `200000` | 换会话的绝对下限：请求 token 不到这个数就不换 |
| `contextMemoryKeep` | `30` | 换会话前把最近多少条聊天记进 `记忆区/压缩记忆/` |
| `persona` | 空 | 它是谁：名字、性格、怎么称呼人（见上面「让它有性格」） |
| `ownerIds` | `[]` | 主人的 QQ 号（可多个）；群聊里这些人会被标出来，其他群友当陌生人 |
| `ownerLabel` | `主人` | 群聊里怎么称呼这位主人，例如「老板」 |
| `directPrompt` | 空 | 私聊时加在聊天规矩后面的补充指令 |
| `groupPrompt` | 空 | 群聊时的补充指令（比如「在群里说话，一两句就好」） |
| `sessionIdleTimeout` | `1800000` | 会话闲置多久回收（毫秒） |
| `showToolResults` | `false` | 要不要把工具调用过程也发到 QQ 里 |
| `debug` | `false` | 打开细节日志 |

---

## 给 Agent 的工具

| 工具 | 作用 |
| --- | --- |
| `qq_poke` | 戳一戳（私聊戳好友，群聊戳发言的人） |
| `qq_react` | 给最新消息贴表情回应，`emoji_id` 用 QQ 表情编号 |
| `qq_like` | 给名片点赞，1–10 次 |
| `qq_send_image` | 发本地图片（顺便能被收进表情包收藏） |
| `qq_send_file` | 发本地文件 |
| `qq_face` | 发 QQ 小黄脸 |
| `qq_mface` | 发商城表情 / 表情包（按 emoji_id） |
| `qq_reply` | 引用回复某条消息 |
| `qq_send` | 主动发消息（私聊 / 群） |
| `qq_recall` | 撤回自己两分钟内的消息 |

这些工具只在 QQ 会话里有效，别的通道调会直接报错，不会误伤。

另外 `ask_user_question` 在 QQ 会话里也能用：插件会把问题转成一条 QQ 消息（`❓ 标题 / 正文 / 1) 选项A …`），
你回个数字，插件把它翻译成 `selected: [选项文本]` 交回给 Agent。

---

## 常见问题

**连不上 / 一直重连**
先看 NapCat 的 WebUI 里那个 WS 服务器是不是「启用」状态，端口对不对，Token 两边是否一模一样。
插件日志里 `连接错误` 后面会带具体原因。

**收得到消息但 Agent 不回**
- 群聊：确认 @ 了，或者把 `requireMention` 设成 `false`。
- 私聊：看 `privateMode` 是不是 `allowlist` 但没把自己加进 `privateAllow`。
- 都没问题就看 DSH 那边 Agent 是否在处理（跑一轮本身要时间）。

**消息重复发两遍**
一般是同一条 `assistant/message` 被推了两次，插件内部按文本去重；如果还重复，开 `debug` 看日志，
顺便确认是不是同时装了两个 dsh-qq 实例。

**撤回总是失败**
QQ 只允许撤回 **两分钟以内** 的消息，超时是协议限制，插件没办法。

**语音消息没转出文字**
先确认 `asrPython` 指向一个装了 `vosk` 和 `numpy` 的 python（`<asrPython> -c "import vosk"`），
再手动跑一次：`<asrPython> <asrScript> <音频文件> [模型目录]`，能打印识别结果就说明环境没问题。
模型目录要给 **纯 ASCII 路径**（vosk 的 C++ 层不认中文路径）；不传参数时按 `VOSK_MODEL` 环境变量、再按插件旁 `models/vosk-model-small-cn-0.22` 找。

**记忆到底存在哪 / 会不会和宿主串**
默认 `isolateByPeer: true`：每个私聊在 `<workspaceRoot>/会话/私聊_<QQ号>/`、每个群在 `<workspaceRoot>/会话/群_<群号>/`，
第一次用到时自动铺好 `AGENTS.md` + `记忆区/`（日记目录也建好）。想让它们共用宿主的工作目录，把 `isolateByPeer` 设成 `false`。

**能不能群发 / 主动推消息？**
这个版本不做主动推送，只对收到的消息做回复。想主动说话，自己用定时任务让 Agent 在那之前先收到一条消息。

---

## 开发

```bash
npm install
node test/e2e.mjs      # 假 NapCat + 假宿主，跑完整链路（不需要真 QQ）
```

`test/mock-napcat.mjs` 也能单独当调试工具用：

```bash
node test/mock-napcat.mjs --port 3001 --token my-token-2026
# 然后在标准输入敲一行 JSON，就当作 QQ 推来一条事件
```

目录：

```
src/
├── index.js           插件入口（apply）
├── config.js          schemastery 配置
├── prompts.js         聊天规矩 / persona 拼装（中性默认，不含任何私人设定）
├── session.js         会话管理（QQ 会话 ↔ DSH Agent）
├── workspace.js       每个会话独立工作目录 + AGENTS.md / 记忆区骨架
├── inbound.js         QQ 消息 → agent.followup（含语音转写、图片落盘、引用还原）
├── outbound.js        session/event → QQ 消息
├── tools.js           十个互动工具
├── faces.js           表情包收藏夹（扫描 / 收藏 / 归一化）
├── questions.js       ask_user_question → QQ 问答通道
├── approval.js        授权审批 → QQ 问答通道
├── onebot/client.js   OneBot WebSocket 客户端（自动重连）
├── onebot/segment.js  消息段 / CQ 码解析
└── shared/chunk.js    长文本切块

tools/
└── asr.py             离线语音识别脚本（vosk，可选，不装也能跑其它功能）
```

---

## 许可证

MIT。见 [LICENSE](LICENSE)。

用出问题、账号被风控，作者不承担责任 —— 协议端本来就是灰色地带，用之前想清楚。
