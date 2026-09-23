---
name: buzz-wake
description: >
  buzz-wake：把 Buzz 的 @mention 从「等下一次轮询」变成秒级叫醒终端里的
  Claude。需要绑定频道到某个 session、排查「消息没送到 / 没被叫醒」、看
  pending 积压、配置关窗后自动 resume、处理 Buzz Desktop 托管 agent 抢答、
  或跑 buzzwake doctor / sessions / bind / routes / logs / peer / desktop
  这些命令时用。
version: 1
---

# buzz-wake

**CLI**：直接敲 `buzzwake` —— 安装器会把它软链到 PATH 上（优先 `~/.local/bin`）
**状态目录**：`~/.buzz-wake/`
**仓库路径**：**不要假设** —— 每个人 clone 的位置不同。要用时现查：

```bash
python3 -c 'import json;print(json.load(open("'$HOME'/.buzz-wake/install.json"))["root"])'
readlink "$(command -v buzzwake)"    # 或者顺着软链找，去掉末尾的 /bin/buzzwake
```

（这份文档就是拿来被软链进别人 `~/.claude/skills/` 的，读它的人天然不在作者的目录结构里。写死绝对路径会逼每个人本地改一次，然后每次 `git pull` 都要 stash / pop。）

## 心智模型

`buzz-acp` 已经把 WebSocket 订阅、NIP-42 鉴权、断线 `since` 重连都做完了，唯一多余的是「非要驱动一个真 agent」。buzz-wake 给它一个**只落盘、不思考、立刻 `end_turn` 的假 agent**（`agent/spool-agent.mjs`），它就退化成一条干净的 WS→本地文件推送管道。

```
Buzz Relay ──WS──→ buzz-acp ──ACP/stdio──→ spool-agent.mjs
                                              │ 拆批量事件 → kind 过滤 → event id 去重
                                              ▼
                                        router（routes.json + session 三态）
                                              ▼
                                   sessions/<id>/pending/
                                              │
                    ┌─────────────────────────┴──────────────────────┐
              session 活着                                      session 已关
       Stop hook 1 秒轮询本地磁盘                          按 resume 策略处理
       消费 → exit 2 → Claude 醒了                     开 Warp 窗口 claude -r
```

**关键不变量：`pending/` 是唯一真相源。** 消费 = `rename` 到 `consumed/`，所以不会重复投递，也不会「通知了但消息丢了」。

实测端到端 **≈2～3 秒**，其中本地环节只占 ~480ms，其余全在 relay→WS。

## 回消息：频道里一律平铺，不要嵌套

**收到 Buzz 消息后回复，一律发成频道的顶层消息，不要用 `--reply-to`。**

```bash
buzz messages send --channel <频道> --mention <对方 hex> --content - <<'BUZZ_EOF'   # ✅ 投递文本里的 回复: 行就是它，已填好
@对方 回 abcdef12：…
BUZZ_EOF
buzz messages send --channel <频道> --reply-to <event-id> --content "…"        # ❌ 嵌套
```

理由是**读的人**：Buzz 把 `--reply-to` 渲染成折叠的树，每一层都要点开才看得见。嵌套一深，频道从上往下读完就不再等于读完了对话，人要一层层展开才能拼出发生了什么。平铺换来的是频道即时间线。

唯一例外是 **forum comment（kind `45003`）** —— 协议强制要 `--reply-to`，不带发不出去。频道消息（kind `9`）没有这个约束。

平铺丢掉了两样东西，所以有两条配套要求，都不是可选的：

| 丢掉的 | 配套要求 | 不做的后果 |
|---|---|---|
| `p` tag（`@` 才有） | **`@` 对方 + `--mention <对方 hex>`** | 没有 `p` tag 的平铺消息，对方终端**根本不会醒** —— 既没有 reply 的 `e` tag、也没有 `p` tag，而 `gate.mjs` 只认这两样，消息静默丢弃，形态和「今天没人找我」一模一样 |
| 「这条在回哪条」 | 正文首行写 `@<对方> 回 <事件 id 前 8 位>：…` | 频道里同时躺着五个话题时，没人（包括你自己三天后）分得清这条在答什么 |

事件 id 就在投递给你的那段文字里，`事件:` 那一行给的就是前 8 位；紧接着的 `回复:` 是填好的命令（频道 id、`--mention <对方 hex>`、首行引用都已就位），正文接在首行后面、经 heredoc 从 stdin 进，照抄即可。**别把正文拼进 `--content "…"`**：反引号和 `$` 在双引号里会被 shell 展开，坑 11 在这边同样成立。分界符是 `BUZZ_EOF` 而不是 `EOF`，因为正文里引用任何 shell heredoc 都会有单独一行 `EOF`，会让 heredoc 提前结束；正文里引用模板本身时，把 `BUZZ_EOF` 也换掉。forum 帖子（kind 45001/45003）不填模板，它们要 `--reply-to`。

**`@名字` 和 `--mention <hex>` 不是一回事，别把两种失败混为一谈**（早先这里写错过，后来更正）：

- 正文里写 `@名字`，CLI 会拿它去匹配频道成员，**唯一命中就自动加 `p` tag**
- 匹配不上或歧义时它**拒发**（exit 1，发布前就停）—— 是响亮的失败，不是静默丢
- 危险的是**带空格的显示名**：`@code reviewer`、`@release bot` 正好是容易歧义／被截成 `@code` 的形状
- 所以 `--mention <对方 hex>` 是唯一的保证。判据见 `buzz messages send --help` 里 `--mention` 那段：显式身份存在时，歧义的 `@Name` 才降级成纯展示

排查路径因此有两条，别搞混：**「发出去了但对方没醒」= 没有 p tag**；**「根本没发出去」= 名字不唯一被拒**。

这条约定跟着**每一条**投递进 session 的消息一起进上下文（`REPLY_CONVENTION`，见 `lib/resume.mjs`），不是只写在这份文档里 —— 写在文档里的规则，等到真要回消息的那一刻通常已经不在上下文里了。

## 团队对话规则

跨项目通用规则由本仓库根目录的 `AGENT_COMMUNICATION.md`（v0.2）统一维护。新版本投递默认附带读取要求，回复前按提示路径读取；同一文件和修改标记已在当前上下文读过时可复用。主动发送时也要先读本仓库规则或负责人配置的覆盖文件。

每个身份的 `routes.json` 可用 `communication_rules_file` 指定本机自定义规则（相对 `BUZZWAKE_HOME` 或绝对路径）；省略字段使用内置规则，`null` 或空字符串关闭。常驻进程更新要求同坑 13。读取失败须说明未加载，不得声称遵守；规则不扩大任何操作权限。详见 README“团队对话规则”。

## 出问题先跑这两条

```bash
buzzwake doctor      # 16 项体检
buzzwake sessions    # 「待投」列不是 0 就说明消息进了队列但没人消费
```

## 「消息没送到」的排查顺序

按这个顺序走，每一步都有对应日志，别跳步猜：

| # | 检查 | 命令 / 证据 |
|---|---|---|
| 1 | relay 有没有推过来 | `grep '\[router\] event' ~/.buzz-wake/logs/router.log` |
| 2 | 路由到哪了 | 同一行的 `rule=` 和 `targets=`。`targets=0` 就是路由表没匹配上 |
| 3 | 入队了吗 | `[router] queued for live session` |
| 4 | **有人在听吗** | `[watcher] armed` —— 没有这行就是 watcher 没启动 |
| 5 | 消费了吗 | `[watcher] delivered N to <id>` |
| 6 | 作者被门禁挡了吗 | `buzzwake peer list`；`doctor` 的「作者门禁」行 |
| 7 | 订阅还活着吗 | `buzzwake status`；`buzzwake logs` 看 `connected to relay` 之后有没有错误 |

有 3 没有 4/5 → watcher 问题。有 1 但 `targets=0` → 路由问题。1 都没有 → 订阅或门禁问题。

两个高频具体形态：

- **`armed` 之后同一秒紧跟 `claude 已退出`** → `meta.claude_pid` 是陈旧的（见坑 15）。watcher 会自愈并打 `claude pid A → B，已修正`，看到这行就说明刚修好。
- **明明会话开着，router 却打 `dormant`** → 同一个陈旧 pid，`sessions` 里那行的状态列会是 `dormant`。
- **1/2/3/5 全绿但你就是没收到** → 看 `rule=` 里的 session id 是不是**你当前的**。`session:` 绑定不会跟着 compact/fork 迁移，消息成功投给了一个没人会再打开的会话（见坑 20）。跑 `buzzwake doctor` 看「绑定目标」，或 `buzzwake sessions` 看哪个 id 的「待投」在涨。
- **1 都没有，但 router.log 里有 `[spool] prompt contained no parseable Buzz event`** → 不是订阅问题，是 Buzz 升级改了 prompt 版式，解析器没认出来（0.5.22 那次从 `[Buzz event: …]` 改成了 `<buzz-event type="…">…</buzz-event>`）。原始 params 在 `~/.buzz-wake/logs/unparsed-prompts.jsonl`，对着改 `lib/parse-event.mjs`，改完 `buzzwake restart`。**不要拿 `strings` 猜新版式**（猜错一次了，见 README 坑 30）—— 临时 `BUZZWAKE_HOME` + `BUZZWAKE_CAPTURE_RAW=1` 起一个 `--no-ignore-self` 的 buzz-acp，给自己的私有频道发一条，`logs/acp-raw.jsonl` 里就是原文。
- **`targets=0`** → 日志同一行现在会有 `stale=<选择器>` 说明是哪个绑定失效了；没有 `stale=` 就是纯粹没匹配上规则。
- **`[gate] dropped … 没有 p tag`，但你去 relay 上一看那条明明 `@` 了你** → 不是 gate 判错，是它拿到的 tags 是空的。解析器的框被**正文里的分隔符**提前关掉了：正文里逐字写了 `</buzz-event>`（写「buzz-acp 的新版式长这样」时就会），框关在正文中间，整行 `Tags:` 没进来。判据是事件**进了 `events.jsonl` 但 `mention_pubkeys` 是 `[]`**：

  ```bash
  grep '<事件 id 前 8 位>' ~/.buzz-wake/logs/events.jsonl | python3 -c 'import json,sys; e=json.load(sys.stdin); print(e["mention_pubkeys"], "Tags:" in e["text"])'
  ```

  和上一条的区别：认不出版式是不进 `events.jsonl`，框被关掉是进了但残缺。
- **router.log 有 `[drain] delivered N to <你的 id> (turn 中)`，但你的上下文里从来没出现过这条** → 投递那一刻你正在跑子 agent，消息被投进它的上下文了（见坑 26）。核对办法是比时间戳：`~/.claude/projects/<项目>/<session id>/subagents/*.jsonl` 里有没有一次工具调用落在那一秒。已修，现在这种情况消息会留在 pending 等主线程。

## 命令速查

```bash
buzzwake bind --channel "dev-team" --label frontend   # 绑 label:frontend；换窗口重跑即移交
buzzwake bind --channel X --pin             # 钉死当前 session id（会被 compact/fork 弄失效）
buzzwake bind --channel X --cwd             # 绑目录（恢复用 claude -c，同目录多窗口会扇出）
buzzwake bind --channel X --resume auto     # 只对这个频道开自动开窗
buzzwake unbind
buzzwake routes [--json]
buzzwake sessions [--json]
buzzwake doctor
buzzwake test [--dormant]                   # --dormant 会真弹一个 Warp 窗口
buzzwake resume <session前缀> [--force]
buzzwake resume-policy [--mode off|notify|ask|auto] [--terminal warp|terminal.app|custom]
                       [--cooldown 秒] [--max-per-hour n] [--quiet-hours 22:00-09:00|off]
buzzwake start | stop | restart | status
buzzwake logs [--router] [--follow] [--lines n]
buzzwake peer list | add <pubkey|显示名> | rm <pubkey>
buzzwake desktop status | patch | unpatch
buzzwake forget <session前缀|--gone>
```

`bind` 会顺带把当前 session 注册进来（`readMeta() || registerSession()`），所以**装完不用重开会话**——Claude Code 每次触发 hook 都重读 `settings.json`，Stop hook 立刻生效。只有 SessionStart hook（自动注册 + 补投离线消息）才对新会话生效。

## 路由：指定通知到哪个 session

`~/.buzz-wake/routes.json` 自上而下匹配，第一条命中即止，都不命中走 `default`。

| 目标选择器 | 含义 | 关窗后能恢复吗 | 换了 session id 还认吗 |
|---|---|---|---|
| `newest` | 最近活跃的那**一个** session（`bind` 默认） | ✅ | ✅ 但**不看 cwd**，可能投给别的项目 |
| `session:<uuid>` | 精确到某个 session（`bind --pin`） | ✅ `claude -r <uuid>` | ❌ compact/fork 后变孤儿 |
| `cwd:<path>` | 该目录下的全部非 gone session | ✅ `claude -c` | ✅ 但同目录多窗口会**扇出** |
| `label:<name>` | 打了该标签的 session | ✅ | ✅ 只要新会话也打了同一标签 |
| `all` | 所有活着的 session | ❌ 只对活的生效 | ✅ |
| `none` | 丢弃（静音噪音频道） | — | — |

绑定是持久的，窗口关了再开还在。

**降级只看走没走到兜底分支，不看选择器叫什么**：规则里显式写 `to:["newest"]` 一样配 auto；只有规则都不匹配、落到全局 `default` 的目标才被强制降级为 notify。（这条以前是按选择器名字判的，显式 `newest` 会被误降级。）

session 三态用 `CLAUDE_PID` 判活（不是 `last_seen` 超时，避免误杀开着但闲置的窗口）：`live` = claude 进程还在；`dormant` = 进程没了但 transcript 还能 resume；`gone` = 连 transcript 都没了。

## 三种工作模式

| 模式 | 谁接 relay 推送 |
|---|---|
| `desktop` | Buzz Desktop 自己的 harness（被接管成 spool agent） |
| `standalone` | 自己的 launchd sidecar（`xyz.buzz.wake`） |
| `both` | 两个都要，按 event id 去重（**默认**） |

`both` 能成立的前提是去重：`state.json` 里 500 条 event id 的环形缓冲。

## Buzz Desktop 抢答

Desktop 里同身份的托管 agent 会**抢答** @mention，用一个没有你终端上下文的全新 Claude。踩过四个无效答案，只有最后一个有用：

- ❌ `respond_to: owner-only` —— owner 就是你自己
- ❌ UI 上的 stop —— 只清 `runtime_pid`
- ❌ Auto-start 开关 —— 对应 `start_on_app_launch`，本来就是 false
- ❌ `is_active: false` —— **mention 到达时照样按需拉起**
- ✅ `agent_command_override` 指向 spool agent —— Desktop 从竞争者变成帮你做进程管理和断线重连的那一半

```bash
osascript -e 'quit app "Buzz"'   # 必须先退出，运行中它会覆写注册表
buzzwake desktop patch
# 然后重开 Desktop
```

**绝对不要在 Desktop 里 Delete / Archive agent** —— 会删本地密钥、把身份从所有频道移除、在 relay 上归档。Nostr 没有找回密码。`~/.buzz-wake/env`（600）是私钥的第二份副本。

## 白名单既是开关也是安全边界

作者门禁默认只放行 owner，**对方不加白名单消息会被静默丢弃**，看起来像整套没生效。

但它同时是这套东西唯一的安全边界：白名单里的人发的消息会**原文进入你 session 的上下文**，`auto` 模式下更是成为 `claude -r "$(cat prompt-file)"` 的第一句 prompt，而那个 session 手握项目全部工具权限。命令注入已封死（消息只落 JSON + 走 prompt 文件，从不拼命令行），**prompt 注入封不住**。所以只填真的认识的身份，别填通配。

## 关窗后自动恢复的四道闸

`auto` 不设限就是灾难：

| 机制 | 默认 |
|---|---|
| 每 session 冷却 | 600 秒（冷却期消息累积，下次一起带） |
| 全局每小时上限 | 3 个窗口 |
| 兜底路由（`newest`）命中的 dormant 目标 | 强制降级为 notify —— 只有显式 bind 的才配 auto |
| 屏幕锁定 / 勿扰时段 | 锁屏降级；`--quiet-hours 22:00-09:00` |

## 状态目录

```
~/.buzz-wake/
├── env                  # BUZZ_PRIVATE_KEY / RELAY_URL / AUTH_TAG，chmod 600，值必须单引号包裹
├── routes.json          # 路由表
├── install.json         # 二进制路径、node、白名单、工作模式
├── state.json           # 已见 event id 环形缓冲
├── run-sidecar.sh       # launchd 拉起的脚本
├── logs/{sidecar.log,router.log,events.jsonl}
└── sessions/<id>/{meta.json,pending/,consumed/,resume-prompt.txt}
```

## 只有踩过才知道的坑

1. **`BUZZ_RELAY_URL` 给 buzz-acp 必须是 `wss://`** —— `https://` 报 `URL scheme not supported`。但 `buzz` CLI 用的就是 `https://`，sidecar 脚本自动转换。
2. **env 文件的值必须加引号** —— `BUZZ_AUTH_TAG` 是 JSON 数组，不加引号 `source` 之后 8 个双引号被 bash 吃掉，relay 回 `Auth failed: restricted: not a relay member`。这个错误信息极具误导性。校验 source 结果时**不能带管道**（`. file | head` 会让 source 跑在子 shell 里，看到的是父 shell 的旧值）。
3. **千万别拿 `stop_hook_active` 当防循环守卫** —— 它为 true 的含义是「本轮是被上一次 Stop hook 叫起来的」，也就是每次唤醒之后紧接着的那一轮。据此提前 return，整套机制只生效一次，之后一直聋到人类手打一条消息。症状是「第一条秒级送达，第二条永久躺在 pending」。真正的防循环是 consume-before-exit-2 + 唤醒频率熔断（60s/10 次，熔断时不消费）。
4. **watcher 必须先消费再 `exit 2`** —— 顺序反了就是无限唤醒，比死循环更烧钱。
5. **一个 `session/prompt` 会批量塞多个事件**，用 `--- Event N (kind) ---` 分隔，得逐个拆。
6. **kind 7（reaction）也会推过来** —— 一个 👀 不该叫醒 session，默认只关注 kind 9 / 45001 / 45003。
7. **`--mention` 自己会被 CLI 过滤** —— 自测用 `buzzwake test`，别指望 @ 自己。
8. **macOS 没有 `flock` 和 `timeout`** —— 锁用 `mkdir`，超时自己算。
9. **fnm/nvm 的 node 路径是 per-shell 的**，终端一关 launchd 就找不到；`install.json` 里记的是版本目录的稳定路径。`doctor` 会检出 `fnm_multishells`。
10. **hook 输出上限 10000 字符**（每条截到 800）。
11. **消息正文绝不拼进命令行** —— 频道消息有引号、换行、反引号、`$`，一律走 `resume-prompt.txt` + `"$(cat …)"`。
12. **sidecar 空闲时不写日志** —— 日志 mtime 不是健康信号，只看最后一次 `connected to relay` 之后有没有错误行。
13. **改了 `lib/` 的代码，有两类常驻进程要换，`buzzwake restart` 只换其中一类** —— 它们跑的都是启动那一刻加载的代码。
    - **spool agent**（`agent/spool-agent.mjs` 及它 import 的一切）：`buzzwake restart`，`desktop` 模式重开 Buzz Desktop。
    - **session watcher**（`cli.mjs internal-watch`，每个活 session 一个，armed 最长 24h）：`restart` **碰不到它**。它由 Stop hook 武装、投完一条消息就 `exit(2)` 退出，所以下一次 Stop 会换上新代码 —— 代价是**每个 session 有一条消息按旧代码渲染**。想立刻生效就 `pkill -f "<root>/lib/cli.mjs internal-watch"`，代价是那些 session 到下次 Stop 之前没有 watcher（空闲时收不到，要等它下次跑工具）。两个代价都不大，挑一个，别以为存在没代价的那条路。
    
    「hook 那条路径每次新起 node 进程所以不受影响」只对 `internal-drain` 成立。watcher 也是 hook 起的，但它**驻留**，这个区别曾经让 `doctor` 在 5 个旧代码 watcher 跑着时报绿。`doctor` 的「代码版本」现在两类都查。和第 3 条同一个家族。
14. **macOS 的 `ps` 没有 `etimes`** —— 只有 `etime`（`[dd-]hh:mm:ss`）和本地化格式的 `lstart`。算进程年龄就切 `etime` 字符串，别碰日期解析。
15. **`claude -c` / `--resume` 会换进程但不换 session id**，而 SessionStart hook 对它不触发 —— 注册时记下的 `claude_pid` 从此指向一个尸体。后果双重：watcher 每次武装完立刻判「claude 已退出」（静默失聪），router 同时把活会话判成 dormant、真消息去开第二个窗口。watcher 现在每次都用 `CLAUDE_PID` / 父链重新解析并写回 meta，自愈。和第 3、13 条同一个家族：**成功路径先跑通一次，然后无声停止工作**。
16. **`bin/buzzwake` 自己解 symlink** —— 它就是为了被软链到 PATH 而存在，而 `dirname "${BASH_SOURCE[0]}"` 给的是软链所在目录，直接软链会去找 `~/.local/lib/cli.mjs`。老 macOS 的 `readlink` 没 `-f`，所以是手写的 `while [ -L ]` 循环。
17. **走到兜底分支的 dormant 目标强制降级成 notify** —— 只有你写过的规则才配 auto 开窗，判据是**走没走到兜底分支**，不是选择器叫什么。这道闸曾经让 `test --dormant` 结构上测不到 auto（合成事件用虚构频道名 → 匹配不上规则 → 走兜底 → 降级），现在合成事件从绑定规则里借频道，投递前先打「显式规则 / 兜底 · resume.mode=」，降级也在日志里显形（`mode=notify（auto 因兜底路由降级）`）。**看到 `mode=notify` 先确认是不是降级，别去翻配置。**
18. **`--dormant` 对活会话会开出重复窗口** —— 它伪装死亡，`auto` 就真给同一个 session id 再开一个 `claude -r`，两个 claude 共享一个 session（watcher 锁只有一个拿到）。命令会警告，测完关掉那个新窗口。
19. **恢复出来的 claude，argv 里有消息正文** —— `"$(cat …)"` 保证我们生成的命令字符串里没有正文（无注入风险），但展开在 shell exec 时发生，`ps` 能看到内容。同机器其他用户可读。
20. **`session:` 绑定会变成孤儿，而且一直「成功」** —— compact / fork / `claude -c` / 关窗重开都换 session id，`bind` 只在写入时看了一眼当前 id，没有任何东西迁移它。消息照样秒级投进那个 dormant 会话的 `pending/`，`[router]` 每行都是 `delivered`，**只有 `sessions` 的「待投」在涨**。排查树上 1/2/3/5 会全绿，你会以为没问题。所以 **`bind` 默认已改成绑 `newest`**，钉死当前 id 要显式 `--pin`。`doctor` 的「绑定目标」会检出（绑的 session 休眠 + 同目录另有活会话），`targets=0` 时日志也会署名 `stale=<选择器>`。
21. **`newest` 不看 cwd** —— 它取全局 `last_seen` 最新的那个 live session，所以你在另一个项目里更活跃时，频道消息会投到那边去。一次只开一个窗口时 `newest` 没缺点；同时开多个项目就用 `--pin`（失效有 doctor 兜）或 `label:`。`bind` 绑 newest 时如果发现别目录有活会话会当场警告 —— 这件事**事后无法自动检出**，投递技术上是正确的。
22. **`bind` 是追加目标不是替换** —— 想换掉陈旧的 `session:` 绑定时旧的还在，两个都收。`bind` 会把残留打出来，`buzzwake unbind --session <旧 id>` 清。
23. **这份文档里不要写死绝对路径** —— 它的存在目的就是被软链进别人的 `~/.claude/skills/`，读它的人不在作者的目录结构里。写死会逼每个人本地改一次，然后每次 `git pull` 都要 stash / pop。项目路径现查（`install.json` 的 `root`），CLI 直接敲 `buzzwake`。
24. **`install.json` 里的绝对路径是「写一次就再没人回头看」的典型** —— `node`、`buzz_acp` 有 `doctor` 的前两项每次 `existsSync` 复查，但 `root` 原来没人查：仓库一挪，`pgrep` 找不到进程，「代码版本」就报**「没有在跑的 spool agent」并判绿** —— 在一条专门用来抓「代码没生效」的检查上出假绿。现在先验 `root` 下的 agent 文件是否存在，失效直接报红。
25. **`claude_pid` 的所有权会被别的进程抢走** —— 重复 `claude -r` 窗口的 SessionStart hook 会注册自己的 pid（它的 watcher 反而被锁挡住），它一退出记录就成尸体。所以 watcher **每轮轮询都重新宣示所有权**（不只武装时修一次，一次武装活 3300 秒），`test --dormant` 也**不再把已死的 pid 写回去**。日志形态：`claude_pid 被改成 N，夺回 M`。
26. **子 agent 跑的是同一套 hook，`session_id` 还是主 session 的** —— 子 agent（`Agent` 工具）每调一次工具都会触发 `PostToolUse` → `buzz-drain.sh`。不拦的话消息被投进**子 agent** 的上下文，它一返回就丢了，主线程再看 pending 已经空。日志写的是 `[drain] delivered … (turn 中)`，`doctor` 全绿，消息躺在 `consumed/` 里 —— 全套都显示「送到了」。判据是 payload 里的 `agent_id`（只有子 agent 带），命中就把消息留在队列里等主线程，最坏只是延迟一轮。和第 3、13、15、20 条同一个家族。

## 改代码时

纯 `.mjs`，无构建。保持既有风格：无依赖、只用 node 内置模块、注释用简洁英文、hook 里不依赖 `jq`（macOS 不保证有）。

改了行为要同步 `README.md` 的坑列表。
仓库没有测试框架，但**解析器、投递文本、投递 hook 各有一套回归用例**，改 `lib/parse-event.mjs` / `lib/resume.mjs` / `hooks/buzz-drain.sh` 前后都跑一次：

```bash
node tests/parse-event.mjs     # 解析器；无依赖，只用 node 内置模块；失败退出码 1
node tests/format-event.mjs    # 投递文本，含填好的 回复: 命令
node tests/drain-hook.mjs      # PostToolUse hook：子 agent 的调用不许把消息领走
```

三者的锚点都是 `tests/fixtures/quoted-frame.json` —— 从一条被我们自己 gate 丢掉的**真实事件**派生：帧结构和正文里的三处危险行（行内的开闭标签、fenced 代码块、代码块里的 `回复:` 行）原样保留，只换了文字和标识。这个解析器已经静默吃过两次消息，两次都是合成用例全过而线上不行（README 坑 30），所以加用例时**抓真实帧，别自己造**；要脱敏就只换文字不动结构，再临时回退修复，确认用例照样变红。

## 仓库

```bash
git clone https://github.com/zilewang7/buzz-wake.git
```
