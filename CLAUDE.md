# CLAUDE.md

本文件为未来的 Claude Code 会话（claude.ai/code）提供本仓库的工作指引。

## 项目概述

**加密货币自动跟单机器人。** 监听 Discord 付费群的 KOL 信号，用 LLM 解析成结构化交易指令，经风控/守卫检查后通过 Telegram 请求人工审批，批准后在 CCXT 连接的交易所自动下单。Next.js 面板负责可视化信号 → 审批 → 成交的完整链路。

整体架构大量参考 `reference/OpenAlice`，很多模块直接 lift 过来改动极小（见下方 **复用的 OpenAlice 模块**）。凡是 OpenAlice 已经解决好的问题，**照搬后适配**，不要重新发明。

## 技术栈

- **运行时**：Node.js 22+，TypeScript 严格模式（**禁止 `any`**，边界处用 `unknown` 然后显式收窄）
- **后端（`src/signal/`）**：Hono，独立进程，**端口 3001**
- **前端（`src/dashboard/`）**：Next.js 15 App Router，端口 3000
- **共享类型**：`shared/types.ts` —— 前后端跨进程类型的唯一来源，不允许漂移
- **Discord 监听**：`discord.js-selfbot-v13`（user token，**不是** bot token —— 付费群不让 bot 进）
- **交易所**：`ccxt`（TypeScript 版）
- **Telegram 审批**：`telegraf`
- **LLM 信号解析**：Vercel AI SDK（`ai` 包）走 OpenRouter
- **配置校验**：Zod
- **金额计算**：`decimal.js`（**永远**不要用 float 存价格/数量）
- **日志**：Pino → `logs/signal.log`
- **包管理**：pnpm workspace

## 仓库是一个文件夹

**整个项目就是一个 repo，一个部署单元。** 里面用 pnpm workspace 分了两个 package（`src/signal` 和 `src/dashboard`），只是为了依赖隔离和构建解耦——它们共享 `shared/`、`data/`、`logs/`，一起打包推到 VPS。

部署时：
- 克隆/上传整个文件夹 → `pnpm install` → `pnpm -r build`
- 用 pm2（推荐）或 systemd 起两个进程：signal（3001）+ dashboard（3000）
- Nginx 反代 dashboard 到 HTTPS；signal 只在内网或 localhost 暴露
- 敏感信息全进 `.env`（Discord token、交易所 API key、Telegram bot token、OpenRouter key），**不要**进仓库
- `data/` 目录要在重部署之间持久化保留（pm2 默认不动它；docker 部署必须挂卷）

**⚠️ Discord selfbot 在 VPS 上的风险：** VPS 的 IP 段容易被 Discord 标记，新 IP 登录可能触发验证码甚至封号。建议先在本地登录养号，再迁 VPS；或走住宅代理更安全。**这个风险和代码结构无关，只取决于运行环境。**

## 目录结构（目标）

```
trading-bot/
├── shared/
│   └── types.ts                        # Signal / Operation / GitCommit / Position 等
├── src/
│   ├── signal/                         # Hono 后端，端口 3001
│   │   ├── main.ts                     # 组合根（wire 所有模块）
│   │   ├── core/                       # 从 OpenAlice lift
│   │   │   ├── event-log.ts            # append-only 事件总线（磁盘 + 内存环形缓冲）
│   │   │   ├── session.ts              # JSONL 持久化
│   │   │   ├── config.ts               # Zod 校验的 JSON 配置加载器
│   │   │   └── logger.ts
│   │   ├── domain/
│   │   │   ├── trading/
│   │   │   │   ├── git/                # TradingGit：add → commit → push / reject
│   │   │   │   ├── brokers/            # IBroker 接口 + CcxtBroker
│   │   │   │   ├── guards/             # 风控管道 + 内置守卫
│   │   │   │   └── snapshot/           # 权益曲线快照
│   │   │   ├── signals/
│   │   │   │   ├── parser.ts           # LLM 解析原始消息 → Signal
│   │   │   │   ├── kol.ts              # KOL 注册表 + 信任过滤
│   │   │   │   └── types.ts            # Signal、RawMessage（通过 shared 再导出）
│   │   │   ├── risk/
│   │   │   │   ├── position-sizing.ts  # 根据权益 % + 信号把握度算仓位
│   │   │   │   └── guards/             # 自定义守卫：日亏损上限、每 KOL 持仓上限、冷却
│   │   │   ├── approval/
│   │   │   │   └── approval-queue.ts   # 审批状态机：pending → approved/rejected/expired
│   │   │   └── copy-trading/
│   │   │       └── engine.ts           # 编排器：把各阶段串起来
│   │   ├── connectors/
│   │   │   ├── discord/                # discord.js-selfbot-v13 监听器
│   │   │   └── telegram/                # telegraf 审批 bot（inline keyboard）
│   │   └── routes/                     # 给 dashboard 调的 Hono HTTP 路由
│   │       ├── signals.ts              # GET /signals, /signals/:id
│   │       ├── trades.ts               # GET /trades（从 git log 读）
│   │       ├── accounts.ts             # GET /accounts/:id/{wallet,positions,snapshots}
│   │       ├── kols.ts                 # KOL 注册表 CRUD
│   │       └── config.ts               # GET/PUT 风控配置
│   └── dashboard/                      # Next.js 15 App Router
│       └── app/...
├── data/                               # 运行期数据（gitignored）
│   ├── config/*.json                   # Zod 校验的配置文件
│   ├── trading/{accountId}/commit.json # 每账户的 git 订单历史
│   ├── trading/{accountId}/snapshots/  # 周期性权益快照
│   ├── event-log/events.jsonl          # 全系统事件总线归档
│   ├── signals/signals.jsonl           # 原始 + 解析后信号
│   ├── kols/kols.json                  # KOL 注册表
│   ├── approvals/pending.json          # 未决审批（用于崩溃恢复）
│   └── sessions/*.jsonl                # LLM 解析会话（可选审计）
├── logs/
├── package.json                        # workspace 根
├── pnpm-workspace.yaml
└── CLAUDE.md
```

**当前状态**：代码仍然在仓库根的 `dashboard/` 和 `signal/` 下；搬到 `src/dashboard/` 和 `src/signal/` 是 Phase 1 的第一步。在搬完之前，沿用现有路径工作。

## 数据流管道

```
Discord 付费群
       │ （discord.js-selfbot-v13，MessageCreate 事件）
       ▼
DiscordListener ──► eventLog.append('signal.received', rawMessage)
       │
       ▼
SignalParser（Vercel AI SDK + OpenRouter，Zod schema 结构化输出）
       │
       ▼
eventLog.append('signal.parsed', Signal)
       │
       ▼
KolFilter（作者是否被信任？有没有 per-KOL 覆盖？）
       │
       ▼
PositionSizer（权益 % + 信号把握度 + KOL 风险倍数）→ Operation
       │
       ▼
GuardPipeline（持仓上限、冷却、日亏损、白名单 …）
       │
       ▼
TradingGit.add(operation) → commit(message) → CommitHash（prepared，未执行）
       │
       ▼
ApprovalQueue.submit(hash, preview) → 持久化到 data/approvals/pending.json
       │
       ▼
TelegramBot.sendApprovalRequest(chatId, preview, inline keyboard [✅ / ❌])
       │
       ▼                              ▼
  用户点 ✅                        用户点 ❌ / 超时
       │                              │
       ▼                              ▼
TradingGit.push()                TradingGit.reject(reason)
       │                              │
       ▼                              ▼
IBroker.placeOrder（CCXT）        审计 commit 落盘
       │
       ▼
eventLog.append('trade.executed' | 'trade.failed')
SnapshotService 捕获成交后权益
       │
       ▼
Dashboard 轮询/流式拉取 signal 后端渲染整条链路
```

**审批超时**：未决审批在可配置窗口（默认 5 分钟）后自动拒绝，原因为 `timeout`，并落盘到 git 历史。

**崩溃恢复**：启动时从 `data/approvals/pending.json` 重建审批队列；老的 pending 要么重发 Telegram 提示，要么按年龄判定直接过期。

## 核心数据模型

所有类型住在 `shared/types.ts`。交易侧沿用 OpenAlice 的模型；信号侧是新的。

**Signal（新）：**
```ts
interface Signal {
  id: string                         // ULID
  source: 'discord'
  channelId: string
  messageId: string
  kolId: string                      // Discord user ID
  rawText: string
  parsedAt: string                   // ISO 8601
  action: 'open' | 'close' | 'modify'
  side?: 'long' | 'short'
  symbol: string                     // 比如 "BTC/USDT:USDT"（CCXT 统一格式）
  entry?: { type: 'market' | 'limit'; price?: string }
  size?: { type: 'percent' | 'absolute'; value: string } // Decimal 字符串
  leverage?: number
  takeProfit?: string[]              // 多 TP，Decimal 字符串
  stopLoss?: string
  conviction?: number                // 0..1 —— 解析器给或 KOL 默认
  confidence: number                 // 0..1 —— LLM 对本次解析的置信度
  notes?: string
}
```

**Operation + GitCommit（从 OpenAlice lift）：** `placeOrder | modifyOrder | cancelOrder | closePosition | syncOrders`。每个 commit 是 `{ hash, parentHash, message, operations, results, stateAfter, timestamp }`。hash 是 8 位 SHA256。见 `reference/OpenAlice/src/domain/trading/git/types.ts`。

**Position / AccountInfo / Contract / Order：** 从 `reference/OpenAlice/src/domain/trading/brokers/types.ts` lift —— 这些 IBKR 形状的通用类型对 CCXT 一样好用。

**Decimal 纪律：** 跨进程传输时 `Decimal` 序列化成字符串，计算路径上再 parse 回 `Decimal`。**永远**不要用 float 存价格或数量。

## 存储哲学

沿用 OpenAlice：**文件驱动、追加写、JSONL/JSON，无数据库。**

| 路径 | 格式 | 作用 |
|---|---|---|
| `data/config/*.json` | JSON（Zod） | broker / 风控 / KOL / LLM 配置 |
| `data/trading/{accountId}/commit.json` | JSON | 账户级 git 订单历史（完整 commit log） |
| `data/trading/{accountId}/snapshots/` | JSON | 周期性权益快照 |
| `data/event-log/events.jsonl` | JSONL | 全系统事件总线归档 |
| `data/signals/signals.jsonl` | JSONL | 原始 + 解析后信号 |
| `data/kols/kols.json` | JSON | KOL 注册表（含信任分） |
| `data/approvals/pending.json` | JSON | 未决审批队列（崩溃恢复用） |

读取先走内存环形缓冲（和 OpenAlice event log 同样的套路），磁盘是持久化真相源。

## 模块职责

- **`core/event-log.ts`** —— append-only 事件总线。任何模块都可以 `subscribe` / `subscribeType`。从 OpenAlice 直接 lift。
- **`core/session.ts`** —— JSONL session 存储。用于 LLM 解析器的审计轨迹（可选但值得）。
- **`core/config.ts`** —— Zod 校验的 JSON 配置加载器，支持热重载。
- **`domain/trading/git/`** —— `TradingGit` 状态机：`add → commit → push | reject`。这是**唯一**把订单写进历史的地方。整个 lift。
- **`domain/trading/brokers/`** —— `IBroker` 接口 + `CcxtBroker`。适配 OpenAlice 的 CCXT 实现，砍掉我们不需要的 Alpaca/IBKR。
- **`domain/trading/guards/`** —— `guard-pipeline.ts` + 内置守卫（最大持仓、冷却、symbol 白名单）。整个 lift，再加自定义守卫。
- **`domain/trading/snapshot/`** —— 周期性 + 事件触发的权益捕获。lift。
- **`domain/signals/parser.ts`** —— **新**。Vercel AI SDK `generateObject` + 匹配 `Signal` 的 Zod schema，走 OpenRouter（模型在配置里 pin 住）。重试必须幂等（对原始消息做 content-hash）。
- **`domain/signals/kol.ts`** —— **新**。KOL 注册表 + 信任过滤。每个 KOL 有 `{ id, label, enabled, riskMultiplier, maxOpenPositions }`。
- **`domain/risk/position-sizing.ts`** —— **新**。`Signal + 账户状态 + KOL 配置 → Operation`。仓位 = `equity * baseRiskPct * kol.riskMultiplier * signal.conviction`，被守卫夹紧。
- **`domain/risk/guards/`** —— **新**的自定义守卫：日亏损上限、每 KOL 持仓上限、每 symbol 持仓上限。
- **`domain/approval/approval-queue.ts`** —— **新**。内存队列 + `data/approvals/pending.json` 镜像。状态：`pending → approved → executed | rejected | expired`。每次状态迁移都发事件。
- **`domain/copy-trading/engine.ts`** —— **新**。编排器。订阅 `signal.parsed`，把流水推到 `TradingGit.commit()` 和 `ApprovalQueue.submit()`；监听审批结果触发 `push()` / `reject()`。
- **`connectors/discord/`** —— **新**。`discord.js-selfbot-v13` 客户端。监听白名单频道的 `messageCreate`，往事件总线发 `signal.received`。必须显式处理重连、限流、user token 失效。
- **`connectors/telegram/`** —— **新**。`telegraf` bot。用 inline keyboard 渲染审批卡（`✅ 批准` / `❌ 拒绝`）。callback handler 解决审批队列。另外暴露 `/status` / `/positions` / `/pnl` 只读命令。
- **`routes/`** —— 给 dashboard 调的 Hono 路由。初期纯 REST；后期加 SSE 做实时流。

## 复用的 OpenAlice 模块（对照表）

下面这些文件原样复制，只改 import 路径。**不要**从头写等价物。

| 用途 | OpenAlice 路径 |
|---|---|
| 事件日志（append-only 总线） | `reference/OpenAlice/src/core/event-log.ts` |
| Session JSONL 存储 | `reference/OpenAlice/src/core/session.ts` |
| ToolCenter / config 模式 | `reference/OpenAlice/src/core/tool-center.ts`、`config.ts` |
| TradingGit 状态机 | `reference/OpenAlice/src/domain/trading/git/TradingGit.ts` + `types.ts` + `interfaces.ts` |
| Git 持久化层 | `reference/OpenAlice/src/domain/trading/git-persistence.ts` |
| UnifiedTradingAccount 包装器 | `reference/OpenAlice/src/domain/trading/UnifiedTradingAccount.ts` |
| IBroker 接口 | `reference/OpenAlice/src/domain/trading/brokers/types.ts` |
| CCXT broker | `reference/OpenAlice/src/domain/trading/brokers/ccxt/CcxtBroker.ts`（+ `overrides.ts`） |
| 守卫管道 + 内置守卫 | `reference/OpenAlice/src/domain/trading/guards/` |
| Snapshot 服务 | `reference/OpenAlice/src/domain/trading/snapshot/` |

lift 的时候：保持公共 API 不变，让下游代码读起来和 OpenAlice 一致；只砍掉我们不需要的内部依赖。

## 开发阶段

按垂直切片推进。每个阶段结束都要能在本阶段范围内端到端跑通——**不允许**在半连通状态下进下一个阶段。

**Phase 1 —— 基础 & 重构**
- `dashboard/` → `src/dashboard/`，`signal/` → `src/signal/`
- 建 `shared/types.ts`，两个 package 都通过它导入
- 更新 `pnpm-workspace.yaml` 新路径
- signal 端口改成 3001
- 从 OpenAlice lift `core/event-log.ts`、`core/session.ts`、`core/config.ts`
- Hono 基线服务 + `/health` 端点
- Pino 日志写到 `logs/signal.log`

**Phase 2 —— 交易原语**
- 把 `IBroker` 类型、`Contract`、`Order`、`Position`、`AccountInfo` lift 进 `shared/types.ts`
- lift `CcxtBroker`（砍掉 Alpaca/IBKR）
- lift `TradingGit` + `git-persistence`
- lift 守卫管道 + 内置守卫
- 集成测试：连一个 testnet（Bybit/Binance），拉余额 + 持仓，走一遍 `TradingGit.add → commit → push` 下假单，验证 commit.json 被写入

**Phase 3 —— 信号接入**
- Discord 监听器（`discord.js-selfbot-v13`），频道白名单走配置
- `SignalParser`：Vercel AI SDK `generateObject` + Zod schema + OpenRouter
- 原始 + 解析后信号落盘到 `data/signals/signals.jsonl`
- KOL 注册表 + 单 KOL 开关
- 端到端验证：被监听频道发一条消息 → 事件日志里能看到 `signal.received` 和 `signal.parsed`

**Phase 4 —— 风控 + 编排**
- Position sizer 连到真实账户权益
- 自定义守卫：日亏损、每 KOL 持仓、每 symbol 持仓
- `copy-trading/engine.ts` 订阅 `signal.parsed` 并 stage operation

**Phase 5 —— 审批闭环**
- Telegraf bot + inline keyboard 审批卡
- 审批队列持久化 + 崩溃恢复
- 可配置超时自动拒绝
- 审批结果连到 `TradingGit.push()` / `reject()`

**Phase 6 —— Dashboard**
- 信号流（来自 `signals.jsonl` + 事件日志）
- 交易历史（来自 `git log` / `commit.json`）
- 账户面板（持仓、权益曲线来自 snapshot）
- KOL 管理 + 风控配置表单

**Phase 7 —— 加固**
- Discord 断线重连 + token 失效告警
- CCXT 错误分类（网络 vs 限流 vs 认证 vs 拒单）+ 类型化重试
- 监控：日内 PnL、审批失败率、解析置信度分布

## 不可协商项

- **TypeScript 严格，禁止 `any`。** 边界处用 `unknown`，显式收窄。
- **金额不用 float。** 全程 `decimal.js`；跨进程传输用字符串。
- **无审批不 push。** 每一单都必须走 `TradingGit.commit()` → 审批 → `push()`。唯一例外是显式的 dry-run 模式（永远不调 broker）。
- **共享类型就得共享。** 跨 signal ↔ dashboard 边界的类型必须住在 `shared/types.ts`。发现漂移先修再发功能。
- **所有事件进日志。** 发生过的事就要在 `events.jsonl` 里留痕。Dashboard 和审计轨迹都依赖这个。
- **人机回圈神圣不可侵犯。** Telegram 审批 UX 必须展示：symbol、方向、数量、名义金额、杠杆、TP/SL、KOL、账户余额、生成的 commit hash。一条塞不下就分段——**绝不**隐藏细节。

## 机器人的职责边界（心智模型）

**机器人只做三件事：翻译、执行、留痕。它不理解策略。**

### 三层模型

| 层 | 职责 | 边界 |
|---|---|---|
| **翻译** | 把 KOL 的原始消息（文字、图片）转成结构化的 `Signal` 对象 | 只转译字面意思，不补充 KOL 的"潜台词"或"一贯风格" |
| **执行** | 把批准后的 `Operation` 通过 broker 下单 | 只执行被审批的操作，不自行判断"这单值不值得做" |
| **留痕** | 把所有发生过的事写进事件日志和 git 历史 | 只负责忠实记录，不过滤或修改原始信息 |

### 什么不是机器人的职责

- **不理解为什么**：KOL 为什么开这单、为什么选这个杠杆、这套策略背后的逻辑——机器人不知道，也不需要知道。
- **不替 KOL 决策**：如果消息模糊，机器人应该如实标记 `confidence` 低，而不是"猜测 KOL 的意图"然后填一个假值。
- **不因 KOL 不同而分支**：代码里**不应该出现** `if (kolId === 'xxx')` 这类针对特定 KOL 的行为分支。KOL 之间的差异全部表达在数据里（`parsingHints`、`riskMultiplier`、`parsingStrategy`），不在代码逻辑里。

### 为什么这条边界重要

跟单机器人最常见的腐化路径：开发者为了让某个 KOL"效果更好"，开始在解析器里加 per-KOL 特殊处理。一旦这条线被跨过，代码里的隐式知识（"这个 KOL 发 `entry` 的时候其实是均价"）就比数据里的显式知识更权威——但这些隐式知识无法被审计、无法被热更新、无法被其他人看到。

**正确做法**：把一切 KOL 特有行为写进 `kols.json` 的 `parsingHints`，由 LLM 在翻译阶段消化。代码路径对所有 KOL 一视同仁。

### 检查清单（代码审查时用）

如果你在代码里看到以下任何一种模式，应该立即质疑：

```
// 红旗：特定 KOL 的 if 分支
if (kolId === 'some-specific-id') { ... }

// 红旗：解析器里的"领域知识"注释
// This KOL always means X when they say Y

// 红旗：把 KOL 的"惯例"硬编码成默认值
const defaultSide = kolId.startsWith('aggressive') ? 'long' : undefined
```

合法的 KOL 差异化只有一种形式：从 `KolConfig` 里读数据字段（`parsingHints`、`riskMultiplier` 等），然后统一处理。

## 命令

### 后端（`src/signal/`）
```bash
pnpm dev      # tsx watch src/main.ts —— 端口 3001 热重载
pnpm build    # tsc
pnpm start    # node dist/main.js
```

### 前端（`src/dashboard/`）
```bash
pnpm dev      # next dev，端口 3000
pnpm build    # next build
pnpm lint     # eslint
```

### 根目录
```bash
pnpm -r dev   # 并行跑两个（workspace 搭好之后）
```

## Next.js 版本说明

本项目使用 **Next.js 15** 的 App Router。
