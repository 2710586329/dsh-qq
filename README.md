# dsh-qq

把 **QQ** 接成 DeepSeek Harness 的一个前端：私聊、群聊都能和同一个 Agent 聊，还能戳一戳、贴表情、点赞。

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
                  助手 Agent（你自己的预设、工具、记忆）
```

- **一个 QQ 会话 = 一个持久 Agent 会话**，有历史、有记忆，不会聊两句就忘。
- 群聊默认**必须 @ 才理**，还能自动带上最近几条群聊记录当上下文。
- 回复按段切块发出，不会变成一条几千字的怪物消息。
- 内置 `qq_poke` / `qq_react` / `qq_like` / `qq_send_image` / `qq_recall` 五个互动工具。

---

## 装之前

| 需要 | 版本 |
| --- | --- |
| DeepSeek Harness | ≥ 0.2.0 |
| Node.js | ≥ 18（插件本身零编译依赖） |
| NapCat | v4.x（推荐 `NapCat.Shell.Windows.OneKey` 独立版） |
| 一个 QQ 小号 | 别用主号，真的 |

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
| Token | 自己编一串，比如 `whale-2026` |
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
pnpm pack                      # 得到 dsh-qq-0.1.0.tgz
npx @deepseek-ai/dsh plugin add ./dsh-qq-0.1.0.tgz
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
    accessToken: whale-2026
    cwd: D:/my-agent          # Agent 的工作目录，不填就用进程 cwd
    provider: deepseek-official      # 想指定模型时才填
    model: deepseek-flash
```

重启 DSH，日志里看到 `已连接 ws://127.0.0.1:3001` 就成了。给小号发一条私聊试试。

---

## 配置项速查

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `wsUrl` | `ws://127.0.0.1:3001` | NapCat 的 WebSocket 服务端地址 |
| `accessToken` | 空 | NapCat 那边设的 Token，留空就不带鉴权头 |
| `selfId` | 空 | 机器人 QQ 号。留空会自动 `get_login_info` 查 |
| `provider` / `model` | 空 | 指定模型；留空跟随宿主当前设置 |
| `cwd` | 空 | Agent 工作目录 |
| `requireMention` | `true` | 群聊必须 @ 才理 |
| `groupMode` | `open` | `open` / `allowlist` / `disabled` |
| `groupAllow` | `[]` | `allowlist` 模式下允许的群号 |
| `privateMode` | `open` | `open` / `allowlist` / `disabled` |
| `privateAllow` | `[]` | `allowlist` 模式下允许的 QQ 号 |
| `replyToPrivate` | `true` | 私聊总开关 |
| `historyLimit` | `20` | 群聊带多少条最近消息当上下文 |
| `textChunkLimit` | `1500` | 单条消息最长多少字，超了自动切 |
| `splitDelayMs` | `400` | 分段发送之间的间隔，别设 0 太急 |
| `directPrompt` | 空 | 私聊时额外塞给 Agent 的前缀指令 |
| `groupPrompt` | 空 | 群聊时的前缀指令（比如「你是在群里说话，别太长」） |
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
| `qq_send_image` | 发本地图片 |
| `qq_recall` | 撤回自己两分钟内的消息 |

这些工具只在 QQ 会话里有效，别的通道调会直接报错，不会误伤。

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
node test/mock-napcat.mjs --port 3001 --token whale-2026
# 然后在标准输入敲一行 JSON，就当作 QQ 推来一条事件
```

目录：

```
src/
├── index.js           插件入口（apply）
├── config.js          schemastery 配置
├── session.js         会话管理（QQ 会话 ↔ DSH Agent）
├── inbound.js         QQ 消息 → agent.followup
├── outbound.js        session/event → QQ 消息
├── tools.js           五个互动工具
├── onebot/client.js   OneBot WebSocket 客户端（自动重连）
├── onebot/segment.js  消息段 / CQ 码解析
└── shared/chunk.js    长文本切块
```

---

## 许可证

MIT。见 [LICENSE](LICENSE)。

用出问题、账号被风控，作者不承担责任 —— 协议端本来就是灰色地带，用之前想清楚。
