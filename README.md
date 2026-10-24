# dsh-qq

把 **QQ** 接成 DeepSeek Harness 的一个前端：私聊、群聊都能和同一个 Agent 聊；语音听得懂、图片看得见，还能戳一戳、贴表情、点赞。

底层走 [OneBot v11](https://github.com/botuniverse/onebot-11) 协议，默认搭配 [NapCat](https://napneko.github.io/)。不用公网 IP、不用备案、不用企业主体。

> ⚠️ **先说清楚**：NapCat 属于「QQ 协议端」，跑在你自己登录的 QQ 客户端上，**不符合腾讯的用户协议**。用小号、别和常用号同一台设备、别发垃圾消息，账号有被风控或封禁的可能。插件只负责把 OneBot 消息转给 Agent，协议端本身怎么合规、怎么稳，由你自己负责。场景能用 [QQ 官方机器人](https://bot.q.qq.com/) 的，优先用官方的。

> 📢 **这是个公开仓库**：MIT，随便取用、改、再发。作者是个人不是公司，没有客服、没有 SLA，能回 issue 但不保证秒回。
> 提 issue 或贴日志之前，请先把 **token、真实 QQ 号、本机路径** 抹掉——发出去就收不回来了。

```
你的 QQ 客户端  ←→  NapCat（协议端，注入 QQ）
                        ↕  OneBot v11 WebSocket
                dsh-qq 插件（跑在 DSH 宿主进程里）
                        ↕  进程内 ctx.agents
                  你的 Agent（你自己的预设、工具、记忆）
```

## 它能干什么

| 特性 | 说明 |
| --- | --- |
| 一个 QQ 会话 = 一个持久 Agent 会话 | 有历史、有记忆，不会聊两句就忘 |
| 每个会话一个独立工作目录 | 自带 `AGENTS.md` 和 `记忆区/`，彼此看不见，也碰不到宿主自己的私人记忆 |
| 语音转文字 | 本地 vosk 离线识别，不联网、不上传，结果直接进对话 |
| 群里默认 @ 才理 | 被某人 @ 过一次后 60 秒内不用再 @ 也能接（窗口按「群 + 人」算，别人蹭不到） |
| 分得清谁在跟自己说话 | 引用算叫我、`[SILENT]` 可以不接、同类机器人单独开关、跳过的群消息也进上下文 |
| 不会把自己聊丢 | 窗口快满时补回聊天规矩；再撑满就换新会话，旧的最近聊天先落盘再接上 |
| 十个互动工具 | `qq_poke` / `qq_react` / `qq_like` / `qq_send_image` / `qq_send_file` / `qq_face` / `qq_mface` / `qq_reply` / `qq_send` / `qq_recall` |
| 问答能转回 QQ | `ask_user_question` 抛的问题会变成一条 QQ 消息，回个数字就行 |

## 三步跑通

### 1. 装 NapCat，登录小号

下载 **Windows 一键版**（`NapCat.Shell.Windows.OneKey.zip`），解压运行 `NapCatInstaller.exe`——它装一份独立的 QQ，**不会碰你现有的 QQ**。登录小号，打开 WebUI（默认 `http://127.0.0.1:6099`），在「网络配置」里新建 **WebSocket 服务器**：

| 项 | 填什么 |
| --- | --- |
| 地址 | `127.0.0.1` |
| 端口 | `3001`（被占用就换一个，记住它） |
| Token | 自己编一串，比如 `my-token-2026` |
| 消息格式 | `array`（重要，别选 string） |

### 2. 装插件

**先把 DSH 完全退出**（托盘也要退掉，插件文件被占用会装到一半失败）。

```powershell
# 从 Releases 下载 dsh-qq-0.7.2.tgz，然后
dsh plugin --profile desktop add "D:\下载\dsh-qq-0.7.2.tgz"
```

不想用打好的包，也可以直接装源码目录（`git clone`，或下 `Source code (zip)` 解压）：

```powershell
dsh plugin --profile desktop add "D:\dsh-qq-0.7.2"
```

三个容易踩的坑：

- **必须用 DSH 自带的 `dsh`，不能 `npx @deepseek-ai/dsh`。** `desktop` 这份 profile 由桌面端独占管理，npx 会直接报 `profile "desktop" is managed exclusively by the Electron application`。PATH 里找不到 `dsh` 就用完整路径：
  ```powershell
  & "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add "D:\dsh-qq-0.7.1"
  ```
- **`--profile` 不能省**，省了直接报 `error: --profile <name> is required`。
- **写绝对路径**，相对路径是按你敲命令那一刻的当前目录算的。

装完它会自动写进 `$DSH_HOME/profiles/desktop/package.json` 的 `dsh.profile.bundles`（默认就启用），启动后在 **设置 → 插件** 里能看到。想确认装没装上：

```powershell
dsh plugin --profile desktop why dsh-qq
```

### 3. 重启 DSH，填连接信息

重新打开 DSH → **设置 → QQ**，把 `wsUrl` 和 `accessToken` 填进去就行（34 项都在那个面板上，改完即时生效）。

想直接写配置文件也可以，改 `$DSH_HOME/profiles/desktop/cordis.patch.yml` 里 `dsh-qq` 那一段（整段替换，不是往下叠）：

```yaml
- id: dsh-qq
  name: dsh-qq
  config:
    wsUrl: ws://127.0.0.1:3001
    accessToken: my-token-2026
    cwd: D:/my-agent                     # Agent 工作目录，不填用进程 cwd
    workspaceRoot: D:/my-agent/QQ会话    # 每个会话的独立目录（不填用 <cwd>/会话）
    persona: |                           # 它是谁、什么脾气（不填就是个普通助手）
      你叫小满，是个住在电脑里的助手。说话简短、带点懒，被夸的时候会嘴硬。
    provider: deepseek-official          # 想指定模型时才填
    model: deepseek-flash
```

日志里看到 `已连接 ws://127.0.0.1:3001` 就成了，给小号发条私聊试试。

## 最常改的几个配置

| 配置 | 默认 | 什么时候改 |
| --- | --- | --- |
| `persona` | 空 | 想让它有名字、有性格、有称呼 |
| `ownerIds` / `ownerLabel` | `[]` / `主人` | 想在群里认出主人，优先响应 |
| `requireMention` | `true` | 群里不 @ 也想让它接话 |
| `groupMode` / `privateMode` | `open` | 只想在指定群 / 指定人那里开 |
| `groupReplyGapMs` | `20000` | 觉得回得太密（防刷屏、防风控） |
| `rateLimitPerMin` | `12` | 每个会话每分钟最多发几条 |
| `contextGuard` | `true` | 不想要自动换会话就关掉 |
| `chatLog` | `true` | 不想记原始流水就关掉 |

**全部 50+ 项见 [docs/configuration.md](docs/configuration.md)。**

## 想深入看哪块

| 想看 | 去哪 |
| --- | --- |
| 它是谁、群里怎么认主人、上下文守卫、认时间、引用与沉默判断 | [docs/persona.md](docs/persona.md) |
| 所有配置项的默认值和含义 | [docs/configuration.md](docs/configuration.md) |
| 长期跑、看门狗、定时写日记、开机自启 | [docs/deployment.md](docs/deployment.md) |
| 改代码、跑测试、目录结构 | [docs/development.md](docs/development.md) |
| 测试怎么做、踩坑记录、排障 | [TESTING.md](TESTING.md) · [tools/README.md](tools/README.md) |

## 在 DSH 设置里调它

不想手改 YAML 的话，**设置 → QQ** 那一节就是个面板，34 项都能点着改：

| 分组 | 能改什么 |
| --- | --- |
| 状态 | 连接点、登录账号、家目录、设置文件；「重连」「重新读一遍」两个按钮 |
| 连接 | `wsUrl`、`accessToken`、`selfId` |
| 它人设 | `persona`、`personaFile`、`ownerLabel` |
| 补充提示 | `directPrompt`、`groupPrompt` |
| 记忆区与工作区 | `workspaceRoot`、`isolateByPeer` |
| 群里怎么说话 | `requireMention`、`groupWakeMs`、`groupReplyGapMs`、`groupMinGapMs`、`rateLimitPerMin`、`historyLimit` |
| 谁能跟它说话 | `privateMode`、`privateAllow`、`ownerIds`、`groupMode`、`groupAllow` |
| 同类机器人 | `botChatEnabled`、`peerBots` |
| 其它 | `debug`、`textChunkLimit`、`splitDelayMs` |

改完立刻生效（`wsUrl` / `accessToken` 要点「重连」；`reconnectMs` / `selfId` / `workspaceRoot` / `isolateByPeer` / `asrPython` 要重启宿主）。设置写在 `$DSH_HOME/dsh-qq/settings.json`，只覆盖你显式设过的键，清空就回默认——**不动 profile 的 `cordis.patch.yml`**。

同一个 QQ 号不能两处同时登录（会互相抢消息），所以桌面 / Web GUI 那份配 `uiOnly: true`：只提供设置页，不连 NapCat；真正干活的是 `--profile qqbot` 那个宿主。

## 常见问题

**连不上 / 一直重连**
看 NapCat 的 WebUI 里 WS 服务器是不是「启用」，端口对不对，Token 两边是否一模一样。插件日志里 `连接错误` 后面会带具体原因。

**配置看着没问题，但就是发不出去**
NapCat 的 **WS 和 HTTP 是两个不同的 token**，填错不报错，只是安静地发不出去。另外别让 PowerShell 把配置写出 BOM——一个看不见的字节能让所有判断歪掉。

**收得到消息但 Agent 不回**
群里先确认 @ 了；私聊看 `privateMode` 是不是 `allowlist` 却没把自己加进 `privateAllow`；都没问题就看 DSH 那边是不是还在跑（一轮本身要时间）。

**消息重复发两遍**
一般是两个 qqbot 宿主同时连着 NapCat（日志里每行出现两次）。用 `tools/start-bot.cmd` 起，它会先掐掉旧的宿主。

**语音没转出文字**
先确认 `asrPython -c "import vosk"` 能过，再手动跑一次 `<asrPython> <asrScript> <音频文件> [模型目录]`。模型目录必须是**纯 ASCII 路径**（vosk 的 C++ 层不认中文路径）。

**记忆存在哪 / 会不会和宿主串**
默认 `isolateByPeer: true`：私聊在 `<workspaceRoot>/会话/私聊_<QQ号>/`，群在 `群_<群号>/`，第一次用自动铺好 `AGENTS.md` + `记忆区/`。想共用宿主目录就设 `false`。

**能不能群发 / 主动推消息**
这个版本不做主动推送，只回收到的消息。想主动说话，用定时任务在那之前先给它发一条。

## 装之前

| 需要 | 版本 |
| --- | --- |
| DeepSeek Harness | ≥ 0.2.0 |
| Node.js | ≥ 18（插件零编译依赖） |
| NapCat | v4.x（推荐 `NapCat.Shell.Windows.OneKey` 独立版） |
| 一个 QQ 小号 | 别用主号，真的 |
| （可选）vosk + numpy | 只有想让语音自动转文字才要；不装也行，语音会标成「没听清」 |

## 放出去之前，逐条确认

接入只是第一天，第二天才见真章。装之前先想清楚三件事：**你准备长期维护它吗？不想养了会好好收尾吗？它在公共场合出现时，你负责吗？**——群里其他人看到的是一个会说人话的账号，不是一个玩具。

1. **别把 token 提交进仓库。** NapCat 的 access token、模型 API key 都放配置里，别写进代码或 commit。
2. **别手改 profile 的 `package.json` / `pnpm-lock.yaml` / `node_modules`。** 装插件用 `dsh plugin --profile <名字> add`，而且要在 DSH 完全退出时做。手改 lockfile 会让 pnpm 重排包、撞到被占用的文件，最坏是整个桌面端报「web 缺失或文件损坏」（这个坑真踩过，最后靠卸载重装才救回来）。
3. **杀进程按路径挑，别 `Get-Process -Name QQ | Stop-Process` 一把全杀。** NapCat 的 QQ 和你桌面的 QQ 是两套程序，一把杀会把自己踢下线。
4. **它会花你的 token。** 群里每句话都是一次模型调用，先用 `rateLimitPerMin`、`groupReplyGapMs`、`groupWakeMs` 把节奏压住。
5. **它会读写你指定的工作区。** `workspaceRoot` 指到哪，它就能在哪读写文件。
6. **上下文会被压缩或换会话。** 重要的事要落盘，别指望它一直记得。
7. **人多的地方它可能说错话。** 先用 `groupMode: 'allowlist'` 缩到测试群，稳了再放开。
8. **账号风控不是插件的问题。** 频繁换设备登录、短时间大量发消息都可能被判风险，遇到了去手机 QQ 做安全恢复。

## 出问题了去哪问

先在 [Issues](https://github.com/2710586329/dsh-qq/issues) 提一个：带上插件版本、DSH 版本、`dsh-qq-debug.log` 里相关的几行、复现步骤。**别贴 token 和真实 QQ 号。**

也可以直接把报错原文、`api-state.txt`、日志尾部丢给你的 AI 助手，通常能判断出是配置、连接还是插件本身的问题。

## 许可证

MIT，见 [LICENSE](LICENSE)。用出问题、账号被风控，作者不承担责任——协议端本来就是灰色地带，用之前想清楚。
