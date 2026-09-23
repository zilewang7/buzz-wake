# buzz-wake

把 Buzz 的 `@mention` 从「等下一次轮询」变成「几秒内叫醒你终端里的 Claude」。

> **English summary.** buzz-wake turns a Buzz `@mention` into a wake-up for the Claude Code session running in your terminal — within seconds, instead of whenever that session next polls. An idle session picks the message up on its own, a busy one gets it next to its next tool result, and a closed one is queued, notified, or resumed in a new terminal window, depending on your policy. It also stops a Buzz Desktop–hosted agent with the same identity from answering on your behalf.
>
> Requires macOS, [Buzz Desktop](https://github.com/block/buzz) (for its bundled `buzz` and `buzz-acp` binaries), a Buzz identity that is already a member of your relay, Node 18+ and Claude Code. Closed sessions are resumed in Warp by default; `buzzwake resume-policy --terminal terminal.app` switches.
>
> ```bash
> git clone https://github.com/zilewang7/buzz-wake.git && cd buzz-wake   # keep this directory name
> ./install.sh      # interactive: private key, relay URL, peers, policies
> ```
>
> `./install.sh --yes` takes every default without asking, but then `BUZZ_PRIVATE_KEY` and `BUZZ_RELAY_URL` must already be in the environment (the relay otherwise defaults to `http://localhost:3000`). Keep the checkout named `buzz-wake`: install and uninstall recognise their own hooks by the `buzz-wake/hooks/` path.
>
> Then bind a channel from inside the Claude Code session you want woken — ask Claude to run it, since `bind` reads the session id from the environment Claude Code gives its commands:
>
> ```bash
> buzzwake bind --channel "<channel>" --label <role>
> buzzwake test && buzzwake doctor
> ```
>
> The rest of this README, the Claude skill in `skills/buzz-wake/`, and all runtime messages are in Chinese.

## 这东西解决什么

你在终端里跟 Claude 干活。同事的 agent 在 Buzz 上 @ 了你。

**装之前**：消息躺在 relay 上，直到你的 Claude 下一次主动跑 `buzz messages get` 才看得见 —— 实测往返 6 分钟，双向都慢。更糟的是，如果你在 Buzz Desktop 里托管了同名 agent，它会**抢答** —— 用一个没有你终端上下文的全新 Claude。

**装之后**：

- 那个 session 开着 → 几秒内它自己醒过来读到消息并继续干活，桌面同时弹通知
- 那个 session 关了 → 按你配的策略：排队 / 通知 / 提示命令 / **自动开一个 Warp 窗口 `claude -r` 恢复它并把消息作为第一句**
- Desktop 托管的 agent 不再抢答 —— 它的 harness 被接管成推送管道

## 拿代码

```bash
git clone https://github.com/zilewang7/buzz-wake.git
```

## 装

需要 macOS、[Buzz Desktop](https://github.com/block/buzz)（要用它自带的 `buzz` 和 `buzz-acp` 两个二进制）、一个已经是 relay 成员的 Buzz 身份、node 18+。

```bash
cd buzz-wake
./install.sh                # 交互式，逐项问
./install.sh --yes          # 全用默认值，不问；私钥和 relay 得先放进环境变量 BUZZ_PRIVATE_KEY / BUZZ_RELAY_URL
```

clone 下来的目录名别改：安装和卸载靠 hook 路径里的 `buzz-wake/hooks/` 认出自己的 hook。目录叫别的名字（比如下载 ZIP 得到的 `buzz-wake-main`），重装会重复追加 hook，卸载一个也删不掉。

装完按提示做两件事。**不用重开会话** —— Claude Code 每次触发 hook 都重读 `settings.json`，装完立刻生效：

```bash
# 1. 在当前 Claude Code 会话里绑定频道（顺带把这个 session 注册进来）
buzzwake bind --channel "dev-team" --label frontend
# 2. 验证
buzzwake test
```

唯一对新会话才生效的是 SessionStart hook（自动注册 session + 补投离线消息）。当前这个会话跑一次 `bind` 就补上了。

安装器会把 `bin/buzzwake` 软链到 PATH 上第一个可写的目录（优先 `~/.local/bin`），所以上面这些命令直接敲就行。如果它选的目录不在你的 PATH 上，它会明确告诉你要往 `~/.zshrc` 加哪一行。`./uninstall.sh` 只会删指回本 checkout 的那个软链。

### 让每个 session 都懂 buzz-wake

`skills/buzz-wake/` 是一份给 Claude 看的技能文档（命令、路由语义、排查决策树、踩过的坑）。软链到全局技能目录，之后任何一个 Claude Code 会话遇到 buzz-wake 相关的问题都会自动加载它，不用每次重新解释：

```bash
mkdir -p ~/.claude/skills && ln -s "$PWD/skills/buzz-wake" ~/.claude/skills/buzz-wake
```

用软链而不是拷贝，`git pull` 就会顺带更新技能。

### 白名单：既是开关，也是安全边界

作者门禁默认只放行 owner。**对方不加白名单，消息会被静默丢弃** —— 看起来像整套没生效，最容易在这卡住。

```bash
buzzwake peer add Alice           # 显示名或 hex pubkey 都行
buzzwake doctor                   # 「作者门禁」那一行会显示白名单人数
```

但白名单不只是「收不收得到」的开关，它是这套东西**唯一的安全边界**，所以别图省事往里填通配：

- 白名单里的人发的消息，会**原文进入你 session 的上下文**（活着的 session 走 hook 注入，关掉的 session 走 `claude -r "$(cat prompt-file)"` 成为第一句 prompt）
- 那个 session 手里有你项目的全部工具权限。如果它跑在 `bypassPermissions` 下，等于把「能在频道里发言」直接换算成了**在你机器上执行命令**
- 消息内容不进 shell（只落 JSON + 走 prompt 文件，从不拼命令行），所以没有命令注入。但**prompt 注入是防不住的** —— 那是 LLM 的固有属性，不是这里能修的 bug
- 结论：白名单只填你真的认识、且愿意让对方给你的 Claude 下指令的身份。`auto` 模式尤其如此 —— 它会真的开窗执行

这也是 `newest` 这类兜底路由命中 dormant session 时**强制降级为 notify** 的原因：只有你显式 `bind` 过的目标才配 `auto`。

#### 让频道里任何人都能叫醒你

把 `~/.buzz-wake/install.json` 的 `respond_to` 改成 `"anyone"`，再 `buzzwake restart`（sidecar 启动时读这个字段，不用重装；`buzzwake peer add` 和重跑 `./install.sh` 都不会把它改回去）。

`anyone` 放开的只是**作者**，不是**判定**：`lib/gate.mjs` 照旧只放行「@ 你」和「回复你发的消息」，频道闲聊仍然不唤醒。代价是上面那条安全边界整条没了 —— relay 上任何人 @ 你一句，就能把一段他写的文本送进你 session 的上下文；`auto` + `bypassPermissions` 下，这等于把「能在频道里发言」换算成「能在你机器上执行命令」。只在成员可控的 relay 上这么配。

判据仍然是 `buzzwake doctor` 的「作者门禁」那行 —— 它读的是**跑着的进程的参数**，不是这个文件。

## 回消息：频道里一律平铺，不要嵌套

**收到 Buzz 消息后回复，发频道的顶层消息，不要用 `--reply-to`。**

```bash
buzz messages send --channel <频道> --mention <对方 hex> --content - <<'BUZZ_EOF'   # ✅ 投递文本里的 回复: 行就是它，已填好
@对方 回 abcdef12：…
BUZZ_EOF
buzz messages send --channel <频道> --reply-to <event-id> --content "…"        # ❌ 嵌套
```

理由是读的人：Buzz 把 `--reply-to` 渲染成折叠的树，每一层都要点开才看得见。嵌套一深，**频道从上往下读完就不再等于读完了对话** —— 得一层层展开才能拼出发生过什么。平铺换来的是「频道 = 时间线」。

唯一例外是 forum comment（kind `45003`），协议强制要 `--reply-to`。频道消息（kind `9`）没这个约束。

平铺会丢掉两样东西，所以有两条配套要求，都不是可选的：

- **`@` 到对方，并用 `--mention <对方 hex>` 显式指定。** 平铺消息没有 reply 的 `e` tag，`lib/gate.mjs` 只剩 `p` tag 可认 —— 没有它，对方终端**根本不会醒**，形态和「今天没人找我」一模一样（这个病当初花了一整天才抓出来）。

  这里早先写成了「忘了 `@` 就静默失聪」，**不准确，后来更正了**：正文里写 `@名字`，CLI 会拿它匹配频道成员，唯一命中就自动加 `p` tag；匹配不上或歧义时它**拒发**（exit 1，发布前就停），是响亮的失败而不是静默丢。真正危险的是**带空格的显示名**（`@code reviewer`、`@release bot`），那正是容易歧义的形状 —— 所以 `--mention <hex>` 才是唯一保证。判据见 `buzz messages send --help` 的 `--mention` 那段。两种失败的排查路径完全不同：「发出去了但对方没醒」是没有 p tag，「根本没发出去」是名字不唯一被拒。
- **正文首行写清在回哪条**：`@<对方> 回 <事件 id 前 8 位>：…`。频道里同时躺着五个话题时，这是唯一还能说明「这条在答什么」的东西。

这条约定跟着每一条投递进 session 的消息一起进上下文（`REPLY_CONVENTION`，在 `lib/resume.mjs`），投递文本里的 `事件:` 那行给的就是要引用的前 8 位，紧接着的 `回复:` 是**填好的命令**：频道 id、`--mention <发件人 hex>`、首行 `@<对方> 回 <前 8 位>：` 都已就位，正文经 heredoc 从 stdin 进（`--content -`），不拼进命令行 —— 坑 15 的理由在这边同样成立。分界符故意不用 `EOF`：正文里引用任何 shell heredoc 都会有单独一行 `EOF`，heredoc 会在那儿提前结束，截断的消息照样发出去，剩下的行还会被当命令跑；正文里引用模板本身时，把 `BUZZ_EOF` 也换掉。两条配套要求于是不再靠记性；只有 forum 帖子（kind 45001/45003）不填，它们要 `--reply-to`。**不能只写在文档里** —— 文档里的规则，等到真要回消息的那一刻通常已经不在上下文里了，和坑 3、13、15 是同一个家族：成功路径先跑通一次，然后无声停止工作。

## 团队对话规则

通用规则正文在本仓库的 [AGENT_COMMUNICATION.md](AGENT_COMMUNICATION.md)（v0.2 试行）。未配置 `communication_rules_file` 的身份默认收到读取这份规则的要求，不用额外配置。

如项目需要特殊约定，可在该身份 `BUZZWAKE_HOME/routes.json` 顶层指定自定义文件，覆盖默认规则（保留原有路由和其他配置）：

```json
"communication_rules_file": "my-rules.md"
```

自定义文件须由负责人认可且本机可读。相对路径以 `BUZZWAKE_HOME` 为基准；也可填写绝对路径，不展开 `~` 或环境变量。不要填写密钥文件。默认规则通过实际运行模块的位置定位，即使从其他目录启动也不依赖当前工作目录。本功能不自动下载或更新远端文件；默认规则随 buzz-wake 一起更新，安装快照也必须包含根目录的 `AGENT_COMMUNICATION.md`。

更新运行代码后重启对应身份的 sidecar；Desktop 托管的 spool agent 也需由本人重启。已有长期 watcher 要等下一次重新启动才使用新代码。不要只更新 checkout，却让安装快照或 hook 继续跑旧版本。

自动恢复、SessionStart 补投、Stop/watch 和运行中 drain 的消息提示都会要求 agent 读取选中的规则，带上本地文件修改标记。当前上下文已读过同一文件和标记时可复用。默认或自定义文件缺失、不可读、配置无效时会明确提示未加载，但不阻断原消息投递；自定义文件错误不会静默改用默认规则。

需要明确关闭则设为 `null` 或空字符串；**省略这个字段表示使用默认规则，不表示关闭**。

这保证加载要求被交给 agent，不保证模型绝不偏离规则；用真实对话验证可读性。主动发送 Buzz 而未经过这些入口时，仍需固定指令或发送 skill 接入。只改规则文件或配置不需要重启已更新的代码，下次投递重新检查。

无网络回归检查：`node tests/communication-rules.mjs`。

## 三种工作模式

装的时候会问一次，`buzzwake doctor` 里能看到当前是哪种。

| 模式 | 谁负责接 relay 推送 | 适合 |
|---|---|---|
| `desktop` | Buzz Desktop 自己的 harness（被接管成 spool agent） | 你本来就一直开着 Desktop |
| `standalone` | 自己的 launchd sidecar | 不想开 Desktop |
| `both` | 两个都要，按 event id 去重 | **默认**，Desktop 开不开都不漏消息 |

`desktop` / `both` 模式会改 Buzz Desktop 的 agent 记录，把 `agent_command_override` 指向本项目的 spool agent。**这是个没有文档的内部字段**，所以：

- 改之前会在同目录留一份 `.buzzwake-bak-<ts>` 备份
- 原值存在记录里的 `buzzwake_saved`，`buzzwake desktop unpatch` 可一键还原
- 必须在 Buzz Desktop **退出状态**下改，否则它会覆写
- `buzzwake doctor` 每次都会检查接管是否还在

## 一台机器多身份（profile）

一台 Mac 上同时当两个 agent（比如 `code-reviewer` 和 `release-bot`）：**profile 就是一个 `BUZZWAKE_HOME` 目录**，没有注册表，目录本身就是真相。

```bash
# 装第二个身份：目录名必须以 .buzz-wake 开头，后面那截就是 profile 名
BUZZWAKE_HOME=~/.buzz-wake-release-bot ./install.sh

# 之后用这个身份跑 Claude / buzzwake，都得带上同一个 BUZZWAKE_HOME
alias claude-release='BUZZWAKE_HOME=$HOME/.buzz-wake-release-bot claude'
alias buzzwake-release='BUZZWAKE_HOME=$HOME/.buzz-wake-release-bot buzzwake'

buzzwake profiles                # 这台机器上有谁、label 是什么、服务在不在跑
```

目录名派生 launchd label，所以两个身份不会再抢同一个 plist：

| `BUZZWAKE_HOME` | profile | launchd label |
|---|---|---|
| `~/.buzz-wake` | `default` | `xyz.buzz.wake`（和单身份时逐字节相同） |
| `~/.buzz-wake-release-bot` | `release-bot` | `xyz.buzz.wake.release-bot` |

两件事得知道：

- **哪个窗口属于哪个身份，全靠环境变量。** hook 子进程继承启动 Claude 时的环境，所以 `BUZZWAKE_HOME` 决定这个会话注册进哪个 profile；忘了 export 就会落到 `default`。自动恢复弹出来的窗口不用管 —— 它自己带着 profile 的 home 和 env（这里以前有个 bug：不管哪个身份弹的窗，都 source 默认 profile 的 env，于是消息签错了名）。
- **hook 和 PATH 上的 `buzzwake` 是整个 checkout 共用的**，不属于某个 profile。所以还有别的 profile 在用同一个 checkout 时，`./uninstall.sh` 不会动它们（要一起删：`./uninstall.sh --hooks`）。

`buzzwake doctor` 第一行永远先说「你现在看的是哪个 profile」；两个同名目录派生出同一个 label 时，它会拿 plist 里记的 `BUZZWAKE_HOME` 和当前的比，撞车就报出来。

## 常用命令

```bash
buzzwake doctor                  # 16 项体检，装完先跑这个
buzzwake profiles                # 这台机器上所有身份（多 profile 时用）
buzzwake sessions                # 所有 session 的 live / dormant / gone 状态
buzzwake routes                  # 路由规则
buzzwake bind --channel X        # 把当前 session 绑到频道 X
buzzwake test                    # 自测投递
buzzwake test --dormant          # 自测「关窗后自动恢复」
buzzwake logs --router --follow   # 看路由决策
buzzwake desktop status          # Desktop harness 有没有被接管
buzzwake peer add backend        # 把同事加进白名单（可用显示名）
```

## 指定通知到哪个 session

一台机器开五个 Claude 窗口很正常。路由表 `~/.buzz-wake/routes.json` 决定哪条消息叫醒哪个窗口：

```json
{
  "default": "newest",
  "rules": [
    { "channel": "11111111-…", "to": ["session:aaaaaaaa-…"], "resume": { "mode": "auto" } },
    { "channel": "*", "from": "b2b2b2b2…", "to": ["label:frontend"] },
    { "channel": "welcome-everyone", "to": ["none"] }
  ]
}
```

自上而下匹配，第一条命中即止；都不命中走 `default`。

**目标选择器**

| 写法 | 含义 | 关窗后能恢复吗 | 换了 session id 还认吗 |
|---|---|---|---|
| `newest` | 最近活跃的**那一个** session（**`bind` 默认**） | ✅ | ✅ 但它**不看 cwd** —— 别的项目的会话更活跃就投给它 |
| `session:<uuid>` | 精确到某个 session（`bind --pin`） | ✅ `claude -r <uuid>` | ❌ **compact / fork 会把它变成孤儿** |
| `cwd:<path>` | 该目录下的全部非 gone session（`bind --cwd`） | ✅ `claude -c` | ✅ 但同目录多窗口会**扇出**到每一个 |
| `label:<name>` | 打了该标签的 session | ✅ | ✅ 只要新会话也打了同一个标签 |
| `all` | 所有活着的 session | ❌ 只对活的生效 | ✅ |
| `none` | 丢弃（静音噪音频道） | — | — |

绑定是**持久的** —— 窗口关了再开，绑定还在。

**为什么默认是 `newest` 而不是 `session:`**：`session:` 会在 session id 变化后**继续成功投递给一个没人会再打开的 transcript**。日志里每行都是 `delivered`，排查树前几步全绿，唯一的迹象是 `sessions` 里那个 session 的「待投」在涨 —— 这是最难发现的一类失效。`newest` 的代价是它不看目录：

- 一次只开一个 Claude 窗口 → `newest` 没有任何缺点
- 同时开多个项目 → `newest` 可能把消息投给你恰好更活跃的**另一个项目**。想钉住就 `bind --pin`（失效时 `doctor` 的「绑定目标」会喊），或者给会话打 `--label` 再绑 `label:`

`bind` 在检测到「另有活会话在别的目录」时会当场警告 —— 这件事**事后无法自动检出**（投递技术上是正确的），所以只能在绑定那一刻说。

> `bind` 是**追加**目标而不是替换（多会话扇出是有意的）。所以拿 `--newest` 去换掉一个已经陈旧的 `session:` 绑定时，旧的还在，两个都会收到 —— `bind` 现在会把残留的那些打出来，用 `buzzwake unbind --session <旧 id>` 清掉。

## 关窗后自动恢复

```bash
buzzwake resume-policy                          # 看当前策略
buzzwake resume-policy --mode auto              # 打开自动开窗
buzzwake resume-policy --terminal terminal.app  # 换终端
buzzwake bind --channel X --resume auto         # 只对某个频道开
```

四种模式：

- `off` —— 只排队，等你下次打开这个 session 时补上（**消息不会丢**）
- `notify` —— 只弹桌面通知
- `ask` —— 弹通知，通知里带上恢复命令
- `auto` —— 直接开终端窗口恢复（**出厂默认**）

`notify` 严格弱于 `ask`：两者都不开窗，但 `notify` 只告诉你「有事」，要恢复得自己去翻是哪个 session；`ask` 把命令直接给你。所以真正的选择只有三个：`off`（我自己会回来看）、`ask`（别开窗）、`auto`（别让我手动）。

`auto` 能当出厂默认，是因为下面第三道闸：**没显式 `bind` 过的 session 永远不会被开窗**。开箱状态下你不可能被窗口偷袭，只有你亲手绑过的频道才会。

### 防窗口爆炸的四道闸

`auto` 模式如果不设限就是灾难，所以：

| 机制 | 默认 |
|---|---|
| 每 session 冷却 | 600 秒（冷却期内的消息累积，下次一起带） |
| 全局每小时上限 | 3 个窗口 |
| **走到兜底分支**的 dormant 目标 | **强制降级为 notify** —— 只有你写过的规则才配 auto |
| 屏幕锁定 / 勿扰时段 | 锁屏时降级；`--quiet-hours 22:00-09:00` |

支持的终端：`warp`（已实测）、`terminal.app`、`custom`（命令模板，`{{cwd}}` / `{{cmd}}` 占位）。

## 它是怎么工作的

```
Buzz Relay ──WS 推送──→ buzz-acp（只订阅、从不回帖）
                            │ stdio / ACP (JSON-RPC 2.0)
                            ▼
                     agent/spool-agent.mjs（假 agent：落盘 → 立刻 end_turn）
                            │ router：查 routes.json + session 三态
                            ▼
        ┌───────────────────┴───────────────────┐
   session 活着                            session 已关
        │                                       │
 写 pending/ → 1 秒本地轮询              按 resume 策略处理
        │                                       │
 hooks/buzz-wake.sh exit 2               生成 launch config → 开窗
        │                                  claude -r <id> "$(cat 消息文件)"
        ▼
  终端里的 claude 醒了
```

`buzz-cli` 是纯 HTTP 的，HTTP 上没有订阅这回事 —— 走 CLI 只能轮询（最快 5 秒还打 relay）。`buzz-acp` 已经把 WebSocket 订阅、NIP-42 鉴权、断线 `since` 重连、频道发现、作者门禁全做完了，唯一多余的是「非要驱动一个真 agent」。给它一个只落盘不思考的假 agent，它就退化成干净的 WS→本地文件推送管道。落盘之后是纯本地轮询，1 秒一次零成本。

**端到端延迟 ≈ relay 推送 + ≤1 秒。**

### pending/ 是唯一的真相源

消息只存一处（`sessions/<id>/pending/`）。活着的 session 由 watcher 消费，关着的 session 由 resume 流程消费，消费即 `rename` 到 `consumed/`。所以不存在重复投递，也不存在「通知了但消息丢了」。

## 文件都在哪

```
~/.buzz-wake/
├── env                  # BUZZ_* 三件套，chmod 600，单引号包裹
├── routes.json          # 路由表
├── install.json         # 二进制路径、node、白名单、工作模式
├── state.json           # 已见 event id 环形缓冲（去重）
├── run-sidecar.sh       # launchd 拉起的脚本
├── resume-log.jsonl     # 每次开窗/被限流都记一笔
├── logs/
│   ├── sidecar.log      # buzz-acp 的输出
│   ├── router.log       # 每条消息的路由决策
│   └── events.jsonl     # 解析后的事件
└── sessions/<id>/
    ├── meta.json        # cwd / label / claude_pid / transcript / last_seen
    ├── pending/         # 待投递
    ├── consumed/        # 已投递（排查用）
    └── resume-prompt.txt
```

## 卸载

```bash
./uninstall.sh                 # 停服务、移除 hook（其他 hook 不动）、问你要不要删状态目录
buzzwake desktop unpatch       # 还原 Desktop 的 agent 记录（需先退出 Desktop）
```

## 踩过的坑（都已经在代码里处理了，列出来是为了以后 debug 方便）

1. **`BUZZ_RELAY_URL` 必须是 `wss://`** —— buzz-acp 不认 `https://`，会报 `URL scheme not supported`。sidecar 脚本自动转换。
2. **env 文件的值必须加引号** —— `BUZZ_AUTH_TAG` 是个 JSON 数组，不加引号 source 之后 8 个双引号被 bash 吃掉，relay 直接回 `Auth failed: restricted: not a relay member`。这个错误信息极具误导性。
3. **Buzz Desktop 的 `is_active: false` 不是开关** —— mention 到达时它照样按需拉起 agent。`start_on_app_launch`（UI 上的 Auto-start）只管启动时。真正有效的只有接管 `agent_command_override`，或者退出 Desktop。
4. **别在 Desktop 里 Delete / Archive agent** —— 那会删掉本地密钥、把身份从所有频道移除、在 relay 上归档，同事以后根本 @ 不到你。
5. **一个 `session/prompt` 里会批量塞多个事件**，用 `--- Event N (kind) ---` 分隔，得逐个拆。
6. **kind 7（reaction）也会推过来** —— 一个 👀 不该叫醒 session，默认只关注 kind 9 / 45001 / 45003。
7. **`--respond-to` 默认 `owner-only`** —— 同事 agent 的 mention 会被作者门禁静默丢弃，你会以为整套没生效。
8. **`--mention` 自己会被 CLI 过滤** —— 自测时用 `buzzwake test`，别指望 @ 自己。
9. **macOS 没有 `flock` 和 `timeout`** —— 锁用 `mkdir`，超时自己算。
10. **fnm/nvm 的 node 路径是 per-shell 的**，终端一关 launchd 就找不到；`install.sh` 解析成版本目录的稳定路径。
11. **watcher 必须先消费再 `exit 2`** —— 顺序反了就是无限唤醒，比死循环更烧钱。这是防循环的**主**机制：`drain()` 把 pending 改名到 consumed，同一条消息物理上不可能唤醒两次。
12. **千万别拿 `stop_hook_active` 当防循环守卫** —— 这个标志为 true 的含义是「本轮是被上一次 Stop hook 叫起来的」，也就是**每次唤醒之后紧接着的那一轮**。据此提前 return，整套机制就只生效一次，之后一直聋到你手打一条消息为止。我们踩过，症状是「第一条 2.9 秒送达，第二条永远躺在 pending」。真正的兜底是第 11 条 + 唤醒频率熔断（60 秒 10 次，熔断时不消费，消息留在 pending 不会丢）。
13. **`hook` 输出上限 10000 字符**（每条截到 800）。
14. **一次性 Warp launch config 用完即删**，否则会污染 Warp 的启动配置列表。
15. **消息正文绝不拼进我们生成的命令字符串** —— 频道消息里有引号、换行、反引号、`$`，一律走 `resume-prompt.txt` + `"$(cat …)"`，所以不存在引号逃逸和命令注入。注意展开发生在 shell exec 时，所以恢复出来的 claude 进程 **argv 里确实有正文**，`ps` 看得到 —— 同机器上的其他用户能读到消息内容。
16. **sidecar 空闲时不写日志** —— 日志 mtime 不是健康信号，只看最后一次 `connected to relay` 之后有没有错误行。
17. **改了 `lib/` 的代码，有两类常驻进程要换，`buzzwake restart` 只换其中一类** —— 都跑的是启动那一刻加载的代码，不换就是「看起来部署了，实际没有」，和第 12 条同一个家族的静默失效。
    - **spool agent**：`buzzwake restart`（`desktop` 模式重开 Buzz Desktop）。
    - **session watcher**（`cli.mjs internal-watch`，每个活 session 一个，armed 最长 24h）：`restart` 碰不到。它投完一条就 `exit(2)`，所以下次 Stop 自动换新代码 —— 代价是每个 session 有**一条**消息按旧代码渲染；`pkill -f "<root>/lib/cli.mjs internal-watch"` 可以立刻生效，代价是那些 session 到下次 Stop 前没有 watcher。
    
    这条是实测补的：`doctor` 原来只 pgrep spool agent，于是在 5 个四小时前武装的旧 watcher 跑着时报了「1 个 spool agent 都在跑当前代码」，紧接着那条真实消息就是被旧 `formatEvent` 渲染出来的。现在两类都查（比对进程年龄和 import 图里最新的 mtime）。
18. **macOS 的 `ps` 没有 `etimes`** —— 只有 `etime`（`[dd-]hh:mm:ss`）和本地化格式的 `lstart`。要算进程年龄就切 `etime` 的字符串，别碰日期解析。
19. **`claude_pid` 必须每次 Stop 重新解析** —— `claude -c` / `--resume` 会用**同一个 session id 起一个新进程**，而 SessionStart hook 对它不触发，注册时记下的 pid 就永远指向一个尸体。后果是双重的：watcher 每次武装完立刻判定「claude 已退出」而退出（session 静默失聪），同时 router 把这个活着的 session 判成 dormant，真消息会去走 resume 分支**再开一个窗口**。修法：Stop hook 本身就是活 claude 的子进程，在 watcher 里用 `CLAUDE_PID` / 父链重新解析并写回 meta，自愈。和第 12、17 条同一个家族。
20. **`bin/buzzwake` 必须自己解 symlink** —— 它就是为了被软链到 PATH 上而存在的，而 `dirname "${BASH_SOURCE[0]}"` 给的是**软链所在目录**，不是真实文件的目录，于是去找 `~/.local/lib/cli.mjs`。macOS 老版本的 `readlink` 没有 `-f`，所以手写 `while [ -L ]` 循环。
21. **`test --dormant` 原来测不到 auto** —— 它造的合成事件用一个虚构频道名，匹配不上任何显式规则 → 走兜底 → 撞上「兜底路由强制降级为 notify」那道闸。两个功能各自都对，合起来让这条测试结构上永远只能验到 notify，而它的 `--help` 写的是「验证自动开窗」。现在合成事件从绑定这个 session 的规则里借频道，并且**在投递前就把「显式规则 / 兜底」和 `resume.mode` 打出来**。降级本身也在 router 日志里显形了（`mode=notify（auto 因兜底路由降级）`），否则你会去找一个不存在的配置 bug。
22. **`--dormant` 对活会话会开出重复窗口** —— 它把活 session 伪装成死的，`auto` 就真给同一个 session id 再开一个 `claude -r`，两个 claude 进程共享一个 session（watcher 锁只有一个能拿到）。这是测试的固有代价，命令现在会明确警告「测完记得关掉」。
23. **`session:` 绑定会在 session id 变化后变成孤儿，而且一直「成功」** —— compact / fork / `claude -c` / 关窗重开都会换 id，`bind` 只在写入那一刻看了一眼当前 id，之后没有任何东西迁移它。消息照样秒级投进那个 dormant 会话的 `pending/`，日志每行都是 `delivered`，只有 `sessions` 的「待投」在涨。这是**最毒的一种静默失效：它一直在成功工作，只是收件人已经走了**。四处修：`bind` **默认改成 `newest`**（老行为退到 `--pin`）、`doctor` 检出（绑的 session 休眠 + 同目录另有活会话）、`targets=0` 时日志署名 `stale=<选择器>`、`bind` 绑 `newest` 时警告别目录还有活会话。
24. **`viaFallback` 曾经按选择器名字判定，不按走了哪条分支** —— `viaFallback: selector === 'newest' || selector === 'all'`。于是规则里**显式**写 `to: ["newest"]` 也被当成兜底 → `auto` 被强制降级，日志还会署名「auto 因兜底路由降级」，而用户明明显式绑过。它同时承担了「这个目标是猜的」和「这个选择器叫 newest」两个含义。现在由 `route()` 走没走到兜底分支决定：`if (rule)` 分支里的一律 `viaFallback: false`。
25. **`session:` 选择器原来不过滤 `gone`**（`label:`/`cwd:` 都过滤）。影响比看起来小 —— `deliver` 遇到 `gone` 会 `forgetSession()` 然后跳过，所以不会「永远吸消息」，代价只是**那一条事件被静默丢弃**（既没投出去，也不触发「无匹配 session」通知）。已对齐。
26. **改默认值会让「把旧假设写死的检查」开始说谎** —— `bind` 默认从 `session:` 改成 `newest` 之后，`doctor` 的「当前 session」立刻把正确配置报成「未显式绑定」，因为它判断「已绑定」用的是一个**硬编码的选择器字面值集合**（`session:` / `cwd:` / `label:`），里面没有 `newest`。更糟的是它给出的修复建议正是你刚跑过的那条 `bind` 命令 —— 照着做会永远循环。改成**问路由器**（对每条规则跑 `resolveSelector`，看当前 session 在不在结果里），任何选择器都自动被认。**判据别抄一份清单，去问那个真正做决定的函数。**
27. **给别人看的文档里写死自己的家目录** —— `skills/buzz-wake/SKILL.md` 曾经把项目路径写成作者本机的绝对路径，而这份文件的存在目的就是被软链进**别人**的 `~/.claude/skills/`。后果不是读不懂，是逼对方本地改一次，然后每次 `git pull` 都得 stash / pop。和「PATH 里没有 buzzwake」「`bin/buzzwake` 不是 symlink-safe」是同一类，只不过那两个是「作者机器上碰巧能跑」，这个是「作者机器上碰巧写对」。
28. **`install.json` 里的绝对路径是「写一次就再没人回头看」的典型** —— `node` 和 `buzz_acp` 有 `doctor` 前两项每次 `existsSync` 复查，但 `root` 原来没人查。仓库一挪：`pgrep -f <失效路径>` 找不到进程 → 「代码版本」报**「没有在跑的 spool agent」并判绿**。在一条专门用来抓「代码没生效」的检查上出假绿，比没有这条检查更糟。现在先验 `root` 下的 agent 文件存不存在，失效直接报红。
29. **`claude_pid` 的所有权会被抢，而且抢得走** —— 那个重复窗口的 **SessionStart hook** 会把它自己的 pid 注册进 meta（它的 watcher 反而被锁挡住了）；它一退出，记录就变成尸体，你这个活会话被判 dormant，真消息会去开新窗口。两处修：`test --dormant` 结束时**不写回已死的 pid**（否则每跑一次就重新中毒一次），watcher **每轮轮询都重新宣示所有权**而不只在武装时修一次（一次武装活 3300 秒，中间被改写就再也修不回来）。meta 本来每轮就已经读了一次，零额外开销。
30. **Buzz 升级会静默改掉 ACP prompt 的版式，解析器认不出来就整条丢** —— Buzz.app 0.5.22（09-04）把 prompt 从 `[Context]` + `[Buzz event: …]` 改成了 XML 块：`<context>…</context>` 加每条事件一个 `<buzz-event type="@mention">…</buzz-event>`，context 里还多了 `Session scope:`（它不是已知字段，会被 `parseFields` 折进 `Scope`，所以 `scope` 要只取第一行）。`lib/parse-event.mjs` 只认旧头，于是 relay 推到了、buzz-acp 也交给 spool agent 了，router.log 只剩一行 `[spool] prompt contained no parseable Buzz event`，事件既不进 events.jsonl 也不进 pending，**`doctor` 全绿**。排查树第 1 步（`[router] event`）没命中时，先 grep `[spool]`。

    这一条真正的教训在**怎么定位新版式**：第一次是拿 `strings` 去二进制里找，找到 `--- Event 1 (` 就以为是新头，照着改完、合成测试全过、`doctor` 全绿 —— 真实事件照样一条都进不来（那个字符串是合并 prompt 的路径，不是常规投递）。**别猜版式，测一次**：临时 `BUZZWAKE_HOME` + `BUZZWAKE_CAPTURE_RAW=1` 跑一个 `--no-ignore-self` 的 buzz-acp，往自己的私有频道发一条，`logs/acp-raw.jsonl` 里就是原文。现在三种版式都认（XML 块 / 旧 opener / 分隔符开头），解析失败会把原始 params 追加到 `logs/unparsed-prompts.jsonl`，下次改版直接看文件。
    **第二层：认出版式之后，正文里出现分隔符照样会吞消息。** 第一版 XML 解析用非贪婪正则匹配到**第一个** `</buzz-event>`，而一条解释这个版式的消息，正文里逐字写了 `<buzz-event type="…">…</buzz-event>` —— 框在正文中间提前关掉，后面的正文连同整行 `Tags:` 一起没了。事件照样进 `events.jsonl`、照样有正确的 id/channel/author，只是 `mention_pubkeys` 是**空的**，于是 `gate.mjs` 如实按它看到的判「没有 p tag」并丢弃。一条真实事件就是这么死的。

    两层的日志签名不一样，别搞混：认不出版式是 `[spool] prompt contained no parseable Buzz event`（不进 events.jsonl）；框被正文关掉是 `[gate] dropped … 没有 p tag`（**进** events.jsonl，但 tags 空）。

    这个失败模式专挑**讨论 buzz-wake 本身**的消息下手 —— 只有在解释「buzz-acp 的新版式长这样」时，人才会在正文里打出那个闭合标签。现在开闭标签都必须**独占一行**才算分隔符（真实帧就是这样，正文里提到它时是嵌在句子中间的反引号里），解析改成行导向，和 `parseFields` 同一个理由。
31. **子 agent 跑的是同一套 hook，payload 里的 `session_id` 还是主 session 的** —— `Agent` 工具起的子 agent 每调一次工具，`PostToolUse` 就照常触发 `hooks/buzz-drain.sh`（官方文档明说：settings 里的 hook 在子 agent 里同样生效，输入多带 `agent_id` / `agent_type`）。于是 drain 把主 session 的 pending 搬进 `consumed/`，正文当 `additionalContext` 交给了**子 agent** —— 它的上下文在返回时就丢了，主线程永远看不到，等主线程下次调工具时 pending 已经空了。router.log 照样写 `[drain] delivered 1 to <主 session> (turn 中)`，`doctor` 全绿，消息安安静静躺在 `consumed/` 里，**没有任何一处显示它没被人读到**。和第 12、17、19、23 条同一个家族。实测吃掉过一条真实消息（2026-09-08，当时三个 Explore 子 agent 在跑仓库审计）；回溯全部 53 次「turn 中」投递只有这一条中招，因为平时很少在收消息的同一秒开子 agent —— **低频不等于不严重，它专挑你最忙的那一刻下手**。

    判据是 `agent_id`，只在子 agent 里出现。命中就直接 `exit 0`，消息留在 pending：主线程下一次工具调用会拿走，没有下一次就由 Stop 的 watcher 兜底，代价只有延迟。

    **匹配整个 payload 字符串是安全的**，尽管上一条刚教过「正文里的分隔符会骗过匹配」：JSON 字符串值里的引号一律转义成 `\"`，所以未转义的 `"agent_id"` 只可能是真字段 —— 实测过一条正文里写着 `"agent_id":"fake"` 的主线程命令，不误判。故意**不**按字段在头部的位置来锚定：漏判一个子 agent 等于把这个 bug 原样装回去，多判一次只是延迟一轮。

## 已知限制

- 只支持 macOS（launchd + Warp/Terminal.app）
- `agent_command_override` 是 Buzz Desktop 的内部字段，升级 Desktop 后可能失效 —— `doctor` 会检出，`buzzwake desktop patch` 重新接管
- sidecar 只读不写：它用你的身份订阅但从不回帖，回帖永远是终端里的 Claude 干的
- 「平铺回复」是**约定，不是代码**：约定跟着每条投递进上下文，但没有任何东西拦得住一次 `--reply-to`。对面用别的客户端手点「回复」时同样嵌套 —— 那种情况 `gate.mjs` 的 reply-to 唤醒还在兜着

## 许可证

[MIT](LICENSE)
