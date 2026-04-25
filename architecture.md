# Architecture Overview
This document serves as a critical, living template designed to equip agents with a rapid and comprehensive understanding of the codebase's architecture, enabling efficient navigation and effective contribution from day one. Update this document as the codebase evolves.

## 1. Project Structure
This section provides a high-level overview of the project's directory and file structure, categorised by architectural layer or major functional area. It is essential for quickly navigating the codebase, locating relevant files, and understanding the overall organization and separation of concerns.


[Project Root]/
├── backend/              # Contains all server-side code and APIs
│   ├── src/              # Main source code for backend services
│   │   ├── api/          # API endpoints and controllers
│   │   ├── client/       # Business logic and service implementations
│   │   ├── models/       # Database models/schemas
│   │   └── utils/        # Backend utility functions
│   ├── config/           # Backend configuration files
│   ├── tests/            # Backend unit and integration tests
│   └── Dockerfile        # Dockerfile for backend deployment
├── frontend/             # Contains all client-side code for user interfaces
│   ├── src/              # Main source code for frontend applications
│   │   ├── components/   # Reusable UI components
│   │   ├── pages/        # Application pages/views
│   │   ├── assets/       # Images, fonts, and other static assets
│   │   ├── services/     # Frontend services for API interaction
│   │   └── store/        # State management (e.g., Redux, Vuex, Context API)
│   ├── public/           # Publicly accessible assets (e.g., index.html)
│   ├── tests/            # Frontend unit and E2E tests
│   └── package.json      # Frontend dependencies and scripts
├── common/               # Shared code, types, and utilities used by both frontend and backend
│   ├── types/            # Shared TypeScript/interface definitions
│   └── utils/            # General utility functions
├── docs/                 # Project documentation (e.g., API docs, setup guides)
├── scripts/              # Automation scripts (e.g., deployment, data seeding)
├── .github/              # GitHub Actions or other CI/CD configurations
├── .gitignore            # Specifies intentionally untracked files to ignore
├── README.md             # Project overview and quick start guide
└── ARCHITECTURE.md       # This document



## 2. High-Level System Diagram
Provide a simple block diagram (e.g., a C4 Model Level 1: System Context diagram, or a basic component diagram) or a clear text-based description of the major components and their interactions. Focus on how data flows, services communicate, and key architectural boundaries.
 
[User] <--> [Frontend Application] <--> [Backend Service 1] <--> [Database 1]
                                    |
                                    +--> [Backend Service 2] <--> [External API]                           

## 3. Core Components
(List and briefly describe the main components of the system. For each, include its primary responsibility and key technologies used.)

### 3.1. Frontend

Name: [e.g., Web App, Mobile App]

Description: Briefly describe its primary purpose, key functionalities, and how users or other systems interact with it. E.g., 'The main user interface for interacting with the system, allowing users to manage their profiles, view data dashboards, and initiate workflows.'

Technologies: [e.g., React, Next.js, Vue.js, Swift/Kotlin, HTML/CSS/JS]

Deployment: [e.g., Vercel, Netlify, S3/CloudFront]

### 3.2. Backend Services

(Repeat for each significant backend service. Add more as needed.)

#### 3.2.1. [Service Name 1]

Name: [e.g., User Management Service, Data Processing API]

Description: [Briefly describe its purpose, e.g., "Handles user authentication and profile management."]

Technologies: [e.g., Node.js (Express), Python (Django/Flask), Java (Spring Boot), Go]

Deployment: [e.g., AWS EC2, Kubernetes, Serverless (Lambda/Cloud Functions)]

#### 3.2.2. [Service Name 2]

Name: [e.g., Analytics Service, Notification Service]

Description: [Briefly describe its purpose.]

Technologies: [e.g., Python, Kafka, Redis]

Deployment: [e.g., AWS ECS, Google Cloud Run]

## 4. Data Stores

(List and describe the databases and other persistent storage solutions used.)

### 4.1. [Data Store Type 1]

Name: [e.g., Primary User Database, Analytics Data Warehouse]

Type: [e.g., PostgreSQL, MongoDB, Redis, S3, Firestore]

Purpose: [Briefly describe what data it stores and why.]

Key Schemas/Collections: [List important tables/collections, e.g., users, products, orders (no need for full schema, just names)]

### 4.2. [Data Store Type 2]

Name: [e.g., Cache, Message Queue]

Type: [e.g., Redis, Kafka, RabbitMQ]

Purpose: [Briefly describe its purpose, e.g., "Used for caching frequently accessed data" or "Inter-service communication."]

## 5. External Integrations / APIs

(List any third-party services or external APIs the system interacts with.)

Service Name 1: [e.g., Stripe, SendGrid, Google Maps API]

Purpose: [Briefly describe its function, e.g., "Payment processing."]

Integration Method: [e.g., REST API, SDK]

## 6. Deployment & Infrastructure

Cloud Provider: [e.g., AWS, GCP, Azure, On-premise]

Key Services Used: [e.g., EC2, Lambda, S3, RDS, Kubernetes, Cloud Functions, App Engine]

CI/CD Pipeline: [e.g., GitHub Actions, GitLab CI, Jenkins, CircleCI]

Monitoring & Logging: [e.g., Prometheus, Grafana, CloudWatch, Stackdriver, ELK Stack]

## 7. Security Considerations

(Highlight any critical security aspects, authentication mechanisms, or data encryption practices.)

Authentication: [e.g., OAuth2, JWT, API Keys]

Authorization: [e.g., RBAC, ACLs]

Data Encryption: [e.g., TLS in transit, AES-256 at rest]

Key Security Tools/Practices: [e.g., WAF, regular security audits]

## 8. Development & Testing Environment

Local Setup Instructions: [Link to CONTRIBUTING.md or brief steps]

Testing Frameworks: [e.g., Jest, Pytest, JUnit]

Code Quality Tools: [e.g., ESLint, Black, SonarQube]

## 9. Future Considerations / Roadmap

(Briefly note any known architectural debts, planned major changes, or significant future features that might impact the architecture.)

[e.g., "Migrate from monolith to microservices."]

[e.g., "Implement event-driven architecture for real-time updates."]

## 10. Project Identification

Project Name: [Insert Project Name]

Repository URL: [Insert Repository URL]

Primary Contact/Team: [Insert Lead Developer/Team Name]

Date of Last Update: [YYYY-MM-DD]

## 11. Glossary / Acronyms

Define any project-specific terms or acronyms.)

[Acronym]: [Full Definition]

[Term]: [Explanation]

分成六个部分：分层架构图、目录结构、每个模块的接口契约、数据流、扩展点、以及给执行模型的交付清单。

一、分层架构图
┌─────────────────────────────────────────────────────────────────┐
│                     Discord Connector                           │
│              (messageCreate + messageUpdate)                    │
└──────────────────────────┬──────────────────────────────────────┘
                           │ RawMessage
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                   Raw Message Store                             │
│           (append-only, jsonl, 供重放 + 审计)                    │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                 Signal Pre-Pipeline  (filter chain)             │
│   AuthorFilter → DuplicateFilter → NoiseFilter → UrlFilter      │
└──────────────────────────┬──────────────────────────────────────┘
                           │ RawMessage (已过滤)
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                   Message Aggregator                            │
│         (per-KOL 滑动窗口 + 最大时长安全网)                       │
└──────────────────────────┬──────────────────────────────────────┘
                           │ MessageBundle
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                   Parser Dispatcher                             │
│   (按 kol.parsingStrategy 路由到对应 Parser 实例)                │
└──────┬──────────────────┬──────────────────┬────────────────────┘
       │                  │                  │
       ▼                  ▼                  ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│ RegexParser  │  │  LlmParser   │  │HybridParser  │
│              │  │              │  │              │
│(Johnny 类)   │  │(Neil/Gauls) │  │              │
└──────┬───────┘  └──────┬───────┘  └──────┬───────┘
       │                 │                 │
       │                 ▼                 │
       │        ┌────────────────┐         │
       │        │  LLM Pipeline  │         │
       │        │ (分类→提取)     │         │
       │        └────────┬───────┘         │
       │                 │                 │
       └─────────────────┼─────────────────┘
                         ▼
                   ParseResult
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Result Router                                │
│ ┌───────────┐  ┌──────────────┐  ┌───────────┐  ┌────────────┐  │
│ │  Signal   │  │    Update    │  │ Discarded │  │   Failed   │  │
│ └─────┬─────┘  └──────┬───────┘  └─────┬─────┘  └─────┬──────┘  │
└───────┼──────────────────┼────────────────┼──────────────┼──────┘
        │                  ▼                │              │
        │         ┌────────────────┐        │              │
        │         │  Update Linker │        │              │
        │         └────────┬───────┘        │              │
        ▼                  ▼                ▼              ▼
┌─────────────────────────────────────────────────────────────────┐
│              Event Bus  (signal.parsed, update.parsed,          │
│                 signal.discarded, signal.failed, ...)           │
└─────────────────────────────────────────────────────────────────┘
                         │
                         ▼
              (下游:Risk / Approval / Execution)
二、目录结构
src/signal/domain/signals/
├── index.ts                        # 模块对外导出(组合根的入口)
│
├── ingestion/                      # 第一段:从 Discord 到 Bundle
│   ├── raw-message-store.ts        # Raw message 持久化 + 重放器
│   ├── pre-pipeline/
│   │   ├── index.ts                # Pipeline 编排器
│   │   ├── types.ts                # IMessageFilter 接口
│   │   └── filters/
│   │       ├── author.ts           # KOL 白名单检查
│   │       ├── duplicate.ts        # messageId 幂等
│   │       ├── noise.ts            # 空消息、纯分隔符
│   │       └── url-blocklist.ts    # 广告域名过滤
│   └── aggregator/
│       ├── index.ts                # MessageAggregator
│       ├── types.ts                # AggregatorConfig、BundleCloseReason
│       └── window.ts               # 滑动窗口状态机
│
├── parsing/                        # 第二段:从 Bundle 到 ParseResult
│   ├── dispatcher.ts               # ParserDispatcher:按策略路由
│   ├── types.ts                    # IParser 接口 + ParseResult 联合类型
│   ├── registry.ts                 # ParserRegistry:按 name 注册和查找
│   ├── common/
│   │   ├── signal-schema.ts        # 共享的 Signal Zod schema
│   │   ├── update-schema.ts        # 共享的 PositionUpdate Zod schema
│   │   └── parse-context.ts        # ParseContext 类型定义(喂给 parser 的上下文)
│   ├── regex/
│   │   ├── index.ts                # RegexStructuredParser
│   │   ├── types.ts                # RegexConfig 配置类型
│   │   └── patterns/
│   │       └── johnny.ts           # Johnny 的匹配规则(可扩展到其他机器人)
│   ├── llm/
│   │   ├── index.ts                # LlmParser(两层 pipeline)
│   │   ├── classifier/
│   │   │   ├── index.ts            # 第一层:分类器
│   │   │   ├── prompt.ts           # System prompt 模板
│   │   │   ├── few-shot.ts         # Few-shot 样本加载器
│   │   │   └── schema.ts           # 分类输出 Zod schema
│   │   ├── extractor/
│   │   │   ├── index.ts            # 第二层:结构化提取器
│   │   │   ├── prompt-builder.ts   # 动态构建 prompt(结合 KOL hints)
│   │   │   ├── vision.ts           # 图片处理(attachment → data URL/URL)
│   │   │   └── confidence.ts       # Confidence 阈值逻辑
│   │   ├── session-logger.ts       # LLM 调用轨迹落盘
│   │   └── providers/
│   │       ├── types.ts            # ILlmProvider 抽象
│   │       └── openrouter.ts       # OpenRouter 实现(可换其他)
│   ├── hybrid/
│   │   └── index.ts                # HybridParser:regex + LLM 组合
│   └── errors.ts                   # ParseError 分类:retriable / permanent
│
├── linking/                        # 第三段:Update → Signal 关联
│   ├── index.ts                    # UpdateLinker
│   ├── types.ts                    # LinkStrategy 枚举
│   ├── strategies/
│   │   ├── by-external-id.ts       # 按 Discord messageId 回链(Johnny 用)
│   │   └── by-kol-symbol.ts        # 按 KOL + symbol + 时间窗(Neil/Gauls 用)
│   └── signal-index.ts             # Still-open signal 的内存索引
│
├── kol/                            # 第四段:KOL 配置管理
│   ├── registry.ts                 # KolRegistry:加载 + 热重载
│   ├── types.ts                    # KolConfig 类型
│   ├── schema.ts                   # KolConfig 的 Zod schema
│   └── hints-store.ts              # parsingHints 的读写(支持 dashboard 编辑)
│
└── types.ts                        # 本模块对外的所有公共类型(给 shared/types.ts 再导出)

三、每个模块的接口契约
我只讲接口形状和职责,不讲实现细节。
1. ingestion/raw-message-store.ts
RawMessage:
  messageId: string              // 稳定主键
  eventType: 'create' | 'update'  // Discord 事件类型
  timestamp: string
  channelId: string
  authorId: string
  text: string
  attachments: Attachment[]
  replyTo?: { messageId: string; authorId: string }
  editedAt?: string
  
Attachment:
  url: string
  contentType: string
  width?: number
  height?: number

IRawMessageStore:
  append(message: RawMessage): Promise<void>
  query(filters: { dateRange?, authorId?, channelId? }): AsyncIterable<RawMessage>
  replay(dateRange): AsyncIterable<RawMessage>   // 按时间顺序重放
职责:持久化 + 提供重放能力。不做任何过滤、解析、转发。
2. ingestion/pre-pipeline/
IMessageFilter:
  name: string
  apply(message: RawMessage, ctx: FilterContext): Promise<FilterResult>

FilterResult:
  | { pass: true }
  | { pass: false; reason: string }     // 被过滤时的原因,用于日志

FilterContext:
  kolRegistry: IKolRegistry              // 注入 KOL 注册表
  recentMessageIds: Set<string>          // 近期 ID 缓存,用于去重
  now: Date

MessagePrePipeline:
  constructor(filters: IMessageFilter[])
  process(message: RawMessage): Promise<FilterResult>   // 短路式:任一 filter 返回 fail 就停
设计要点:

Filter 顺序可配置,性能优化时把便宜的放前面(author 检查 > duplicate 检查 > noise 检查 > url 检查)
每个 filter 都是纯函数(除了 FilterContext 里的状态),好测试
失败原因要结构化,不要扔错误消息字符串,用枚举或明确的 reason code

3. ingestion/aggregator/
AggregatorConfig:
  idleTimeoutMs: number              // 滑动窗口长度,默认 30000
  maxDurationMs: number              // 安全网,默认 120000
  perKolOverrides?: Record<string, Partial<AggregatorConfig>>

BundleCloseReason:
  | 'idle_timeout'                   // 窗口正常超时关闭
  | 'max_duration'                   // 触发安全网
  | 'forced_flush'                   // 外部强制关闭(shutdown 时)

MessageBundle:
  id: string                         // ULID
  kolId: string
  channelId: string
  messages: RawMessage[]
  openedAt: string
  closedAt: string
  closeReason: BundleCloseReason

IMessageAggregator:
  ingest(message: RawMessage): Promise<void>
  onBundleClosed(handler: (bundle: MessageBundle) => Promise<void>): void
  flushAll(): Promise<void>          // 优雅关闭用
设计要点:

每个 KOL 独立窗口。内部用 Map<kolId, ActiveWindow> 维护
onBundleClosed 是回调注册而不是 return Promise——因为 aggregator 的"输出"是异步流式的
flushAll 是优雅 shutdown 的契约,让所有未关闭的 bundle 提早交付

4. parsing/types.ts —— 核心接口
这是整个 parser 架构的脊柱。
ParseResult:
  | { kind: 'signal'; signal: Signal; meta: ParseMeta }
  | { kind: 'update'; update: PositionUpdate; meta: ParseMeta }
  | { kind: 'discarded'; reason: DiscardReason; meta: ParseMeta }
  | { kind: 'failed'; error: ParseError; meta: ParseMeta }

ParseMeta:
  parserName: string                 // 哪个 parser 处理的
  bundleId: string
  kolId: string
  startedAt: string
  completedAt: string
  llmCalls?: LlmCallRecord[]         // 如果用了 LLM,记录调用
  
DiscardReason:
  | 'not_a_signal'       // 分类器判定非信号(闲聊、广告、教学等)
  | 'low_confidence'     // LLM confidence 低于阈值
  | 're_entry_hint'      // 补单提示,记录但不下单
  | 'duplicate_signal'   // 和历史 signal 内容重复(hash 撞)
  | 'update_no_link'     // 是 update 但关联不上

ParseError:
  code: 'llm_timeout' | 'llm_invalid_output' | 'regex_no_match' | 'schema_validation' | 'unknown'
  message: string
  retriable: boolean
  cause?: unknown

ParseContext:
  bundle: MessageBundle
  kol: KolConfig
  now: Date
  // 依赖注入:parser 不自己 new 这些
  llmProvider?: ILlmProvider
  sessionLogger?: ISessionLogger

IParser:
  name: string                       // 'regex_structured' | 'llm_text' | 'llm_vision' | 'hybrid'
  parse(ctx: ParseContext): Promise<ParseResult>
关键设计决策:

ParseResult 是联合类型,不是抛异常。Parser 失败、丢弃、成功都是"正常"的返回值。异常留给真·bug(比如空指针)。
ParseMeta 始终存在。不管成功失败都要有,dashboard 需要展示"这个 bundle 被哪个 parser 怎么处理了"。
Parser 不持有状态。每次 parse() 用 ParseContext 注入依赖。同一个 parser 实例可以并发处理多个 bundle。
Parser 不做 symbol 映射。signal.symbol 保留原始写法("BTC"、"HYPE"),broker 层负责转 CCXT 格式。

5. parsing/dispatcher.ts
IParserRegistry:
  register(parser: IParser): void
  get(name: string): IParser
  list(): IParser[]

ParserDispatcher:
  constructor(registry: IParserRegistry, kolRegistry: IKolRegistry)
  dispatch(bundle: MessageBundle): Promise<ParseResult>
  
  // 内部逻辑:
  //   kol = kolRegistry.get(bundle.kolId)
  //   parser = registry.get(kol.parsingStrategy)
  //   ctx = buildContext(bundle, kol)
  //   return parser.parse(ctx)
职责边界:Dispatcher 只路由,不做业务。它不判断 confidence、不发事件、不持久化。这些是 Result Router 的事。
6. parsing/regex/
RegexConfig:
  name: string                       // 'johnny' | 'futuristic_signals_bot' | ...
  openPattern: RegExp                // 开仓消息正则
  updatePatterns: Array<{            // 多种 update 消息模式
    name: string
    pattern: RegExp
    builder: (match, bundle, kol) => Partial<PositionUpdate>
  }>
  signalBuilder: (match, bundle, kol) => Partial<Signal>
  messageIdExtractor?: (match) => string    // 从 URL 里提 externalMessageId

RegexStructuredParser implements IParser:
  constructor(configs: RegexConfig[])
  // parse() 内部:
  //   遍历 configs,试图匹配每条消息
  //   open 匹配成功 → 返回 signal
  //   update 匹配成功 → 返回 update
  //   都没匹配 → 返回 discarded (not_a_signal)
设计要点:

RegexConfig 是数据,不是代码。加一个新机器人类 KOL = 加一个 config,不改 parser
signalBuilder / builder 用 callback 而不是声明式映射,因为总有些 KOL 的字段需要小逻辑(比如判断 emoji 是 Long/Short/Spot)
confidence 固定 1.0 写在 builder 里
匹配失败时 discarded,不报错(因为机器人也可能发非信号消息)

7. parsing/llm/
这部分最复杂,所以展开最细。
ILlmProvider:
  classify(input: ClassifyInput): Promise<ClassifyOutput>
  extract(input: ExtractInput): Promise<ExtractOutput>
  
  // 两个方法的原因:不同任务用不同模型(小模型分类、大模型+vision 提取)
  // Provider 内部知道哪个任务用哪个模型

ClassifyInput:
  bundle: MessageBundle
  kol: KolConfig
  systemPrompt: string
  fewShots: FewShotExample[]

ClassifyOutput:
  classification: ClassificationLabel
  confidence: number
  reasoning: string
  rawResponse: unknown               // 原始 LLM 响应,审计用

ClassificationLabel:
  | 'new_signal'
  | 'position_update'  
  | 'chitchat'
  | 'advertisement'
  | 'education'
  | 'stream_notice'
  | 're_entry_hint'
  | 'macro_analysis'     // Gauls 的宏观帖
  | 'recap'              // 复盘/吹嘘

ExtractInput:
  bundle: MessageBundle
  kol: KolConfig
  targetKind: 'signal' | 'update'
  schema: ZodSchema                  // 目标 schema(signal or update)
  includeImages: boolean

ExtractOutput:
  data: unknown                      // 待 schema 验证
  confidence: number
  reasoning: string
  extractedFrom: 'text_only' | 'image_only' | 'text_and_image'
  priceFieldConfidence?: Record<string, 'high' | 'medium' | 'low'>
  rawResponse: unknown
  tokensUsed: { prompt: number; completion: number }

ISessionLogger:
  logCall(record: LlmCallRecord): Promise<void>
  
LlmCallRecord:
  bundleId: string
  phase: 'classify' | 'extract'
  model: string
  request: unknown                   // 完整 request payload
  response: unknown                  // 完整 response payload
  latencyMs: number
  tokensUsed: { prompt: number; completion: number }
  errorIfAny?: string
  timestamp: string

LlmParser implements IParser:
  constructor(opts: {
    provider: ILlmProvider
    sessionLogger: ISessionLogger
    classifier: IClassifier
    extractor: IExtractor
    confidenceThreshold: number      // 全局阈值,KOL 级别可覆盖
  })
  
  // parse() 内部:
  //   1. classifier.classify(bundle, kol) → ClassificationLabel
  //   2. 根据 label 分支:
  //      - chitchat/ad/education/stream_notice/macro_analysis/recap → discarded(not_a_signal)
  //      - re_entry_hint → discarded(re_entry_hint)
  //      - new_signal → extractor.extract(kind='signal')
  //      - position_update → extractor.extract(kind='update')
  //   3. 提取后 confidence < threshold → discarded(low_confidence)
  //   4. 否则返回 signal 或 update
为什么 Classifier 和 Extractor 拆成两个对象而不是 LlmParser 内部私有方法:

独立测试。分类器的 eval set 独立,可以单独跑准确率
独立替换。将来可能分类器换成规则引擎(不用 LLM),extractor 继续用 LLM
独立配置。分类器用小模型、extractor 用大模型,这种配置放在各自对象里更清晰

IClassifier:
  classify(ctx: ParseContext): Promise<ClassifyOutput>

IExtractor:
  extract<T>(ctx: ParseContext, kind: 'signal' | 'update', schema: ZodSchema<T>): Promise<ExtractResult<T>>

ExtractResult<T>:
  | { ok: true; data: T; meta: ExtractMeta }
  | { ok: false; error: ParseError; meta: ExtractMeta }
8. parsing/llm/classifier/prompt.ts + few-shot.ts
ClassifierPromptConfig:
  systemTemplate: string             // 带 {{kol_name}} 等占位符
  labels: Array<{
    name: ClassificationLabel
    description: string
    positiveExamples: FewShotExample[]
    negativeExamples: FewShotExample[]
  }>

FewShotExample:
  bundle: MessageBundle              // 原始 bundle
  expectedLabel: ClassificationLabel
  reasoning?: string                 // 可选的解释

PromptBuilder:
  build(ctx: ParseContext, config: ClassifierPromptConfig): BuiltPrompt

BuiltPrompt:
  system: string
  messages: Array<{ role: 'user' | 'assistant'; content: string | ContentPart[] }>
设计要点:

Few-shot 样本按标签组织,而不是一个大列表。这样你加新 KOL 时只需要往对应 label 下塞几条
Few-shot 支持每个 KOL 独立的样本(通过 KOL 配置里的 parsingHints.exampleMessages)+ 共享样本(所有 KOL 共用的经典 case)
PromptBuilder 是纯函数,不做 I/O

9. parsing/llm/extractor/prompt-builder.ts
ExtractorPromptBuilder:
  build(ctx: ParseContext, targetKind: 'signal' | 'update', schema: ZodSchema): BuiltPrompt
  
  // 内部:
  //   1. 取 kol.parsingHints.style 作为 KOL 风格描述
  //   2. 取 kol.parsingHints.vocabulary 作为术语词典
  //   3. 按 targetKind 选对应的 few-shot 样本
  //   4. 把 bundle 的文字消息拼接(保留顺序 + 时间戳)
  //   5. 把 bundle 的图片 attachment 转成 vision API 能吃的格式
  //   6. 在 prompt 末尾加 confidence 打分规则、priceFieldConfidence 要求
关键:Prompt 是动态构建的,不是静态模板。同一个 extractor 处理 Neil 和 Gauls 时,看到的 prompt 完全不同(因为 parsingHints 不同)。但schema 是共享的——所有 KOL 的信号都符合同一个 Signal 结构。
10. parsing/llm/extractor/confidence.ts
ConfidenceConfig:
  globalThreshold: number            // 默认 0.7
  perKolOverrides?: Record<string, number>
  perFieldWeights?: {                // 字段级别的权重,用于加权 confidence
    entry: number
    stopLoss: number
    takeProfits: number
  }

ConfidenceEvaluator:
  evaluate(extraction: ExtractOutput, kol: KolConfig): ConfidenceVerdict

ConfidenceVerdict:
  | { ok: true; overallConfidence: number }
  | { ok: false; overallConfidence: number; reason: 'below_threshold' | 'critical_field_low' }
设计要点:

Confidence 不是 LLM 单一数字,而是多维度加权。比如 TP 价格的 priceFieldConfidence 是 low,就算总体 confidence 是 0.85 也要拒绝
每个 KOL 可以有自己的阈值(Gauls 的紧止损场景可能要求更高阈值)

11. parsing/hybrid/
HybridParser implements IParser:
  constructor(opts: {
    regexParser: RegexStructuredParser    // 先跑 regex
    llmParser: LlmParser                  // 再补 LLM
    fieldMergeStrategy: 'regex_priority' | 'llm_priority' | 'highest_confidence'
  })
  
  // parse() 内部:
  //   1. regex 试图提取字段 → regexFields (可能不完整)
  //   2. llm 提取 → llmFields
  //   3. 按 strategy 合并字段
  //   4. 如果合并后仍有关键字段缺失 → failed
用途:给"半结构化" KOL——比如某 KOL 开仓总是用 #LONG $BTC Entry: 50000 这种格式但夹杂自然语言。MVP 不需要,框架里留着。
12. linking/ —— Update Linker
LinkStrategy:
  | 'by_external_id'    // 优先策略:消息 URL 里的 messageId
  | 'by_kol_symbol'     // 回退策略:同 KOL + 同 symbol + 最近 open

ILinkStrategy:
  name: LinkStrategy
  tryLink(update: PositionUpdate, index: ISignalIndex): LinkResult

LinkResult:
  | { linked: true; signalId: string; confidence: 'exact' | 'inferred' }
  | { linked: false; reason: string }

ISignalIndex:
  // 内存索引,持久化从 data/signals/signals.jsonl 重建
  findByExternalId(id: string): Signal | null
  findOpenByKolAndSymbol(kolId: string, symbol: string, before: Date): Signal[]
  markClosed(signalId: string): void
  add(signal: Signal): void

UpdateLinker:
  constructor(strategies: ILinkStrategy[], index: ISignalIndex)
  link(update: PositionUpdate): Promise<LinkResult>
  
  // 按策略顺序尝试,第一个成功就返回
  // 全部失败 → unlinked
关键设计:

策略按优先级排列。Johnny 的 update 先尝试 by_external_id(成功率 100%),Neil 的 update 直接跳过这个策略走 by_kol_symbol
Index 是独立组件。它维护"还没平仓的 signal"的内存映射,下游平仓成功后调 markClosed
找不到关联时返回 unlinked,绝不瞎猜。这是硬约束,下游收到 unlinked update 不会触发任何交易动作

13. kol/registry.ts
KolConfig:
  id: string
  label: string
  enabled: boolean
  parsingStrategy: 'regex_structured' | 'llm_text' | 'llm_vision' | 'hybrid'
  parsingHints?: ParsingHints        // 仅 LLM parser 用
  regexConfigName?: string           // 仅 regex parser 用,指向 RegexConfig
  confidenceOverride?: number
  riskMultiplier: number
  maxOpenPositions: number
  defaultSymbolQuote: string
  defaultContractType: 'perpetual' | 'spot'

ParsingHints:
  style: string
  vocabulary?: Record<string, string>
  imagePolicy?: 'required' | 'optional' | 'ignore'
  classifierExamples?: FewShotExample[]     // 专属的分类样本
  extractorExamples?: FewShotExample[]      // 专属的提取样本
  fieldDefaults?: Partial<Signal>           // 填充 LLM 没给出的字段

IKolRegistry:
  get(kolId: string): KolConfig | null
  list(): KolConfig[]
  onChange(handler: (kolId: string, newConfig: KolConfig) => void): void   // 热重载通知
  
  // 注册表内部监听文件变化,自动重载 + 触发 onChange
设计要点:

所有 KOL 特定的"知识"都进 ParsingHints,代码里不硬编码任何 KOL 的特定逻辑
热重载是 onChange 回调模式,parser、classifier、extractor 都订阅
Dashboard 编辑 few-shot 样本 → 写到 kols.json → 文件变化 → registry 重载 → 下次 parse 用新样本。整条链路不重启进程


四、核心数据流(详细版)
我把一条 Gauls 的 BTC 开仓信号从进来到发事件,每一步数据变化写出来。
Step 1  Discord 收到消息
        ↓
        RawMessage {
          messageId: "1494595238...",
          eventType: "create",
          authorId: "gauls_discord_id",
          text: "$BTC Buying Setup:\n👉 Entry: CMP and 73900\n👉 TP: 78700\n👉 SL: 73289",
          attachments: [{ url: "...", contentType: "image/png" }]
        }

Step 2  RawMessageStore.append(msg) → data/raw-messages/2026-04-17.jsonl

Step 3  PrePipeline.process(msg)
        ├─ AuthorFilter: kolRegistry 里有 gauls_discord_id? → pass
        ├─ DuplicateFilter: messageId 见过? → pass
        ├─ NoiseFilter: 文字 > 10 chars? → pass  
        └─ UrlFilter: 含广告域名? → pass
        ↓
        FilterResult { pass: true }

Step 4  Aggregator.ingest(msg)
        ├─ 找到或创建 gauls 的 ActiveWindow
        ├─ 加入 bundle,重置 idle timer (30s)
        └─ 30s 内无新消息 → close bundle
        ↓
        MessageBundle {
          id: "01HX...",
          kolId: "gauls_discord_id",
          messages: [msg],
          closeReason: "idle_timeout"
        }

Step 5  Dispatcher.dispatch(bundle)
        ├─ kol = kolRegistry.get("gauls_discord_id")
        ├─ kol.parsingStrategy = "llm_text"
        ├─ parser = parserRegistry.get("llm_text")
        └─ parser.parse(ctx)

Step 6  LlmParser.parse(ctx)
        ├─ Classifier.classify(ctx)
        │    ├─ PromptBuilder.build(ctx, classifierConfig)
        │    ├─ provider.classify(input)  [小模型调用]
        │    ├─ sessionLogger.logCall(...)
        │    └─ ClassifyOutput {
        │         classification: "new_signal",
        │         confidence: 0.92
        │       }
        │
        ├─ label == "new_signal" → 进入 extractor
        │
        ├─ Extractor.extract(ctx, "signal", SignalSchema)
        │    ├─ PromptBuilder.build(ctx, "signal", schema)
        │    ├─ provider.extract(input)  [大模型 + vision 调用]
        │    ├─ sessionLogger.logCall(...)
        │    ├─ schema.safeParse(rawResponse.data)
        │    └─ ExtractResult {
        │         ok: true,
        │         data: { side: "long", symbol: "BTC", entry: { type: "market" }, 
        │                 stopLoss: { price: "73289", ... }, takeProfits: [{ level: 1, price: "78700" }],
        │                 confidence: 0.88, extractedFrom: "text_only" }
        │       }
        │
        ├─ ConfidenceEvaluator.evaluate(extraction, kol)
        │    └─ 0.88 >= 0.7 → ok
        │
        └─ 返回 ParseResult { kind: "signal", signal, meta }

Step 7  ResultRouter 收到 ParseResult
        ├─ kind == "signal" → 写入 data/signals/signals.jsonl
        ├─ signalIndex.add(signal)
        └─ eventLog.append("signal.parsed", { signal, meta })

Step 8  下游 (RiskModule / ApprovalQueue) 订阅 "signal.parsed" 事件,继续处理

五、扩展点(这个架构最有价值的部分)
这个架构允许你在不改核心代码的前提下做这些事:
扩展 1:加一个新 KOL(新机器人类型)
步骤:

在 parsing/regex/patterns/ 下加一个 new-bot.ts,定义 RegexConfig
在 RegexStructuredParser 构造时传入这个 config
在 kols.json 里加 KOL entry,parsingStrategy: "regex_structured", regexConfigName: "new_bot"
不改任何已有代码

扩展 2:加一个新 KOL(新人类 KOL)
步骤:

在 kols.json 里加 KOL entry
写 parsingHints.style + 几个 few-shot 样本
不改任何代码,不重启进程(热重载)

扩展 3:把分类器从 LLM 换成规则引擎
步骤:

实现一个新的 IClassifier 类,内部用关键词 + 正则判断
在组合根把 LlmParser 构造参数里的 classifier 换掉
不改 extractor、不改 parser 接口

扩展 4:加一个新 LLM 提供商(比如直连 Anthropic)
步骤:

在 parsing/llm/providers/ 下加 anthropic.ts,实现 ILlmProvider
在组合根换 provider 实例
不改 parser / classifier / extractor

扩展 5:加 Telegram 信号源(以后可能)
步骤:

加一个 connectors/telegram-source/,产出 RawMessage(eventType 改成 'telegram_create')
所有下游代码不用动,因为 RawMessage 是统一入口

扩展 6:加新的信号字段(比如 leverage 建议)
步骤:

在 common/signal-schema.ts 里加字段(可选字段)
相关 KOL 的 parsingHints.extractorExamples 里加展示该字段的样本
LLM 下次就会提取新字段
不相关 KOL 的样本不变,字段留空
不改 parser 实现


六、给执行模型的交付清单
如果你要让另一个 AI 模型基于这个架构写代码,你需要明确地给它这些东西:
必须给的输入

这份架构文档(就是上面这些)
已有的 shared/types.ts(Signal、PositionUpdate、MessageBundle 等类型)
OpenAlice 的以下文件作为参考:

core/event-log.ts
core/session.ts
core/config.ts
domain/trading/brokers/types.ts(IBroker 的多实现模式参考)


三个 KOL 的真实历史消息(Neil、Johnny、Gauls 各导出 1-2 周)作为测试数据
技术栈约束:TypeScript 严格模式、禁用 any、decimal.js 处理金额、Zod 做 schema、Vercel AI SDK + OpenRouter

必须规定的输出

每个模块一个 PR / 一批文件。不要一次性产出所有代码
每个 Parser 实现必须附带单元测试。用真实历史消息做 fixture
所有接口优先实现,再写具体类。比如先有 IParser 的测试桩,再写 LlmParser
组合根(main.ts)最后写。前面所有模块都能独立测试

推荐的实现顺序
第 1 批: 类型和接口
  - types.ts (所有模块的接口定义)
  - common/signal-schema.ts, update-schema.ts
  - kol/types.ts, schema.ts

第 2 批: 基础设施(从 OpenAlice lift)
  - event-log
  - session logger
  - config loader
  - kol registry

第 3 批: ingestion 层
  - raw-message-store
  - pre-pipeline + 4 个 filter
  - aggregator

第 4 批: parsing 层(从最简单的开始)
  - parsing/dispatcher
  - parsing/regex (先做最简单的,无 LLM)
  - parsing/llm/providers/openrouter
  - parsing/llm/classifier
  - parsing/llm/extractor
  - parsing/llm/index (LlmParser 组合 classifier + extractor)
  - parsing/hybrid

第 5 批: linking 层
  - signal-index
  - 两种 LinkStrategy
  - UpdateLinker

第 6 批: 组合根
  - 把所有模块 wire 起来
  - 集成测试:重放历史数据,验证完整流水线
每个模块的"完成标准"
给执行模型强调:每个模块必须有:

TypeScript 类型定义(无 any)
至少一个接口 + 一个实现
单元测试(用真实历史数据做 fixture 优先)
模块 README(说明"为什么存在、对外接口、依赖、边界情况")
不持久化状态(状态通过依赖注入)


七、两个值得强调的架构哲学
讲完具体的东西,最后说两件我觉得这个架构里最重要的思想,不写下来容易被执行模型"优化掉":
哲学 1:ParseResult 是联合类型,不是异常
这是这个架构的灵魂。传统做法是"解析成功返回对象,失败抛异常"。这里坚决不这样,因为:

Parser 的"失败"大多是业务正常路径(闲聊不是信号,不是"错误")
联合类型让下游必须处理所有情况(TypeScript 的 discriminated union 会强制你写 switch)
事件日志里 signal.discarded 是一等公民,不是"错误的副产品"

执行模型很容易把 discarded 和 failed 合并成一个 error case,不要让它这样做。这会让 dashboard 丢失"被过滤了什么"的关键审计信息。
哲学 2:Parser 不知道"KOL"是什么
Parser 的 parse(ctx) 方法通过 ParseContext.kol 拿到 KOL 配置,但它不应该写 if (kol.id === 'neil') 这种代码。所有 KOL 特定逻辑都通过 parsingHints 和 few-shot 注入。
这样的好处是:代码里没有 KOL 名字,KOL 是数据、不是代码。你加第 100 个 KOL 时 grep 代码完全找不到它的名字——这正是你想要的。
执行模型很容易写出 if (kol.style === 'neil_style') 这种捷径,不要让它这样做。

