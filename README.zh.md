# dsh-plugin-langfuse

[English](README.md) | 中文

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）提供 [Langfuse](https://langfuse.com) 可观测性：把每个 turn 导出为 OpenTelemetry trace（模型 step → generation、工具调用 → tool span），按 session 分组，把 canonical feedback 记录成 Langfuse Score，并保留 fork/subagent 血缘。

这是一个社区插件（`dsh-plugin` topic），不属于官方仓库。它实现 harness 的公开 telemetry seam（`@deepseek-ai/dsh-session-telemetry`），作为官方 OTLP-logs 导出器之外的另一个后端。

## 安装

以下命令假设已安装 `dsh` CLI。如果你是从官方仓库[源码 checkout](https://github.com/deepseek-ai/deepseek-harness) 运行 harness，把每条命令改为在 checkout 根目录执行 `pnpm dsh …`（先跑它的 `pnpm run build`）—— 命令相同，profile 也是同一个 `web`。

作为 profile bundle 安装（包内附带 `cordis.patch.yml` patch 层）：

```sh
dsh plugin --profile web add dsh-plugin-langfuse
export LANGFUSE_PUBLIC_KEY=pk-lf-…
export LANGFUSE_SECRET_KEY=sk-lf-…
# 可选，默认 https://cloud.langfuse.com（EU 区）；注意插件读取的是
# LANGFUSE_HOST，而不是 Langfuse SDK 惯用的 LANGFUSE_BASE_URL
export LANGFUSE_HOST=https://us.cloud.langfuse.com
dsh web                        # 即 dsh --profile web 的别名
```

附带的 patch 会禁用 base profile 的 `session-telemetry-otel` 行（telemetry seam 每个 context 只接受一个后端；重复加载会抛错），并在存在 Langfuse key 时以 `FULL` 模式挂载本后端，否则为 `DISABLED`。两个项目密钥都存在时，它还会启用 feedback Score。设置 `LANGFUSE_TELEMETRY_MODE=FEEDBACK_ONLY` 可将共享收窄为反馈门控释放。

bundle 层和环境变量都在启动时读取：安装后必须重启已在运行的实例，且启动 shell 里要带上这些变量。`dsh --profile web --dump-config` 可以不启动就查看组合结果 —— 应出现一个 `# == dsh-plugin-langfuse` 层，它 patch 掉 base 的 telemetry 行并新增 env 驱动模式的 `session-telemetry-langfuse` 行。跑完下一轮对话后，trace 出现在 **`LANGFUSE_HOST` 所指区域**的 Langfuse 控制台 —— 密钥按区域隔离，US 区项目在 EU 控制台上什么都看不到。`dsh plugin --profile web remove dsh-plugin-langfuse` 会同时移除依赖和对应的层。

也可以作为显式 `cordis.yml` 行挂载：

```yaml
- id: session-telemetry-langfuse
  name: dsh-plugin-langfuse
  config:
    mode: FULL                 # FULL | FEEDBACK_ONLY | DISABLED（默认）
    exporter:                  # 原样透传给 SDK 的 OTLP/HTTP trace exporter
      url: https://cloud.langfuse.com/api/public/otel/v1/traces
    auth:
      publicKey: !!js process.env.LANGFUSE_PUBLIC_KEY
      secretKey: !!js process.env.LANGFUSE_SECRET_KEY
    feedbackScores:             # 可选；显式配置时默认关闭
      enabled: true
      url: https://cloud.langfuse.com/api/public/scores
      maxQueueSize: 256
      requestTimeoutMillis: 3000
    content:                    # 可选：隐私/内容控制
      turnInputMode: user       # none | user | user-and-context
      cwdMode: omit             # omit | basename | full
      toolMetaAllowlist: []     # 精确匹配 tool-result meta 顶层键
    metadata:                   # 可选：Langfuse 静态分组
      environment: production
      tags: [dsh]
    health:
      warningIntervalMillis: 60000
      maxErrorChars: 1000
    processor: {}              # 可选；原样透传给 BatchSpanProcessor
    shutdownTimeoutMillis: 3000
```

## 配置

| 字段 | 含义 |
|---|---|
| `mode` | `FULL` 实时导出每个会话；`FEEDBACK_ONLY` 仅在用户记录反馈时重放并导出 canonical 会话日志；`DISABLED`（默认）不构造任何东西，没有数据离开进程。词汇与同意语义来自 seam，与官方后端完全一致。 |
| `exporter` | 完整的 `OTLPExporterNodeConfigBase` 对象，传给 OTLP/HTTP trace exporter。非 `DISABLED` 模式下 `url` 必填，且必须是**完整的 traces 路径**（`…/api/public/otel/v1/traces`）。插件默认附带 `x-langfuse-ingestion-version: 4` 请求头——缺少它新 span 不会实时进入 Langfuse 的 v4 数据模型。无论显式条目来自普通 `exporter.headers` 对象还是 `HeadersFactory` 的返回值，均按任意大小写识别并优先采用。 |
| `auth` | Langfuse 项目密钥对，转换为端点的 Basic-auth 请求头。与显式的 `exporter.headers` authorization 互斥；上传模式要求两者恰好提供其一。 |
| `correlation` | 宿主身份关联：`userId`/`sessionId` 以 `langfuse.user.id`/`langfuse.session.id` 盖在每个导出 span 上，让嵌入方宿主的 trace 和本插件的 trace 归入同一个 Langfuse user/session。见[与嵌入宿主关联](#与嵌入宿主关联)。 |
| `feedbackScores` | 可选：把 canonical `feedback/record` 导出为 session-level TEXT Score。`enabled` 默认 `false`；`url` 必须是完整的 `…/api/public/scores` 路径。`maxQueueSize` 默认 256，`requestTimeoutMillis` 默认 3000。有界内存队列与 trace 故障隔离，并在 shutdown 时 best-effort 排空。bundle profile 在两个项目密钥都存在时启用它。 |
| `content` | 导出内容策略。`turnInputMode` 默认 `user`（只聚合真人消息）；`user-and-context` 还包括插件注入上下文，`none` 省略根 input。`cwdMode` 默认 `omit`；`basename` 只导出末级目录，`full` 导出完整路径。`toolMetaAllowlist` 默认为空，只允许明确列出的 `tool/result.meta` 顶层键。 |
| `metadata` | 可选的 Langfuse 静态 `environment` 与 `tags`，传播到每个 observation 以支持 v4 查询。environment 遵循 Langfuse 的小写 `a-z0-9-_` 格式、不能以 `langfuse` 开头且最长 40 字符；最多 50 个 tag，每个最长 200 字符。 |
| `health` | 投递诊断。`warningIntervalMillis` 默认 60000，用于持续失败告警限频（`0` 表示首次告警后不再重复）；`maxErrorChars` 默认 1000，作用于凭据/URL 清洗后的错误文本。这些设置不会增加重试或改变 SDK 缓冲语义。 |
| `processor` | 原样透传给 `BatchSpanProcessor`（`scheduledDelayMillis`、`maxQueueSize`、`maxExportBatchSize` 等）；批处理、重试、丢失策略均为 SDK 的文档化行为。 |
| `maxAttributeChars` | 每个 span 属性的序列化 payload 上限（默认 32768）；超长部分以 `…[clipped]` 标记裁剪，canonical 会话日志保留完整字节。 |
| `shutdownTimeoutMillis` | 插件持有的 SDK shutdown 排水外层截止时间（默认 3000）。 |

错误配置在插件加载时即失败：exporter URL 缺失/畸形/非 http(s)、凭据缺失、双重鉴权歧义、非正的 `maxExportBatchSize`（SDK 会在 shutdown 时挂死）、非法的 correlation/content/metadata/health、启用 Score 却没有合法 URL/队列/超时、未知 `mode`，全部在构造任何传输之前抛出。

### 投递状态

`LangfuseSessionTelemetryBackend.status()` 同步返回脱离内部状态的快照：整体与分通道状态、trace 批次/span 成功失败数、连续失败数、最近时间、已清洗的最近错误，以及 Score 的 queued/delivered/dropped/skipped/failed 计数。状态包括 `disabled`、`starting`、`healthy`、`degraded`、`stopped`；Score 始终是独立通道。OTel SDK 不公开 `BatchSpanProcessor` 队列深度，因此 `traces.queuedBySdk` 明确为 `unknown`。首次失败、限频后的持续失败和恢复也会写日志，且不会带 Authorization 或 Langfuse key。

在标准 Harness 交互 profile 中，可以直接在对话界面查看同一份快照：

```text
/langfuse status
/langfuse status --json
```

第一种格式适合人工阅读；`--json` 返回稳定 envelope，包含插件版本、会话分享策略和完整的 `status()` 快照。该命令只读本地状态：不会访问 Langfuse、重试投递、检查凭据或强制执行 SDK flush。只要 profile 组合了 Harness `commands` 服务（包括标准 `web` profile）就会注册该命令；未组合这一可选服务的纯 telemetry/headless context 仍能正常加载后端，只是不注册命令。`starting` 表示尚无 trace 导出批次完成，并不表示命令正在探测 endpoint。即使处于 `DISABLED` 模式，只要命令服务存在也会注册，因此可以用 `/langfuse status` 确认当前没有分享任何数据。

## 与嵌入宿主关联

把 dsh 运行时嵌入自身、且已向同一 Langfuse 项目发送自有 trace 的宿主应用，可以操控本插件的身份标识，让两套视图归入同一个 Langfuse user/session——宿主通常在 spawn 运行时进程时以环境变量注入自己的 id：

```yaml
config:
  correlation:
    userId: !!js process.env.HOST_USER_ID
    sessionId: !!js process.env.HOST_SESSION_ID
```

- 解析出的 `langfuse.session.id`/`langfuse.user.id` 会盖在**每个**导出 span 上——turn、generation、tool、compaction——因为 Langfuse v4 的查询模型按 observation 而非仅按 trace 过滤与聚合（[属性传播合约](https://langfuse.com/integrations/native/opentelemetry#important-propagating-trace-attributes-to-all-spans)）。
- `sessionId` 默认取 dsh session id；原始 dsh session id 始终以 `dsh.session.id` 留在每个逻辑根上——这是回查 `$DSH_HOME/sessions` 本地日志的指针。
- **按轮动态覆盖**：`turn/start` record 上携带的 `langfuse.user.id`/`langfuse.session.id` 属性覆盖该轮的静态配置——部署方通过 `session-telemetry/record` waterfall listener 注入。快照在 `turn/start` 时锁定；之后 record 上的身份属性一律忽略。优先级：record 属性 > `correlation` 配置 > dsh session id。
- 动态映射必须可从 dsh session id 确定性重建，且至少存活到该会话不再可能触发 `FEEDBACK_ONLY` 重放为止——否则重放出的树会带上与实时捕获不同的身份。
- 静态 `correlation` 值不经过脱敏 waterfall：waterfall 只变换 record，而这些值从不途经 record。
- 投递语义不变：correlation 是身份而非去重——重复仍然可能（见决策 5）。

## Langfuse 中会看到什么

| dsh 会话事件 | Langfuse 概念 |
|---|---|
| session（`session.id`） | session（每个导出的 observation/span 都带 `langfuse.session.id`） |
| `turn/start` / `turn/end` | trace 根 observation（root span；错误结束原因置 span 状态为 ERROR） |
| `step/start` / `step/end` + `request/header` + `request/context` + `assistant/message` | **generation** —— 模型、provider、安全的请求参数/context window、输出、规范的 `gen_ai.usage.*` token（input/output/cache-read/cache-creation/reasoning）；最新一条 assistant message 同时成为根 observation 的整体输出。中断输出会保留部分内容，并在两层 observation 标记 `dsh.assistant.interrupted=true`，但不会把中断误判为错误 |
| `llm/retry` / `llm/retry-started` | 现有 generation 上的结构化 scheduled/started event，包含 retry id/attempt/policy/delay 与裁剪后的失败详情；当前 Harness 事件合约没有逐 attempt usage 生命周期，因此不伪造 generation |
| step 的首个 `assistant/chunk` | `langfuse.observation.completion_start_time`（首 token 时间） |
| `tool/call` + `tool/result` | tool span（参数为 input，完整 result content 数组为 output，结构化 error name/code/outcome，`isError` → 状态 ERROR；私有 `meta` 除非 allowlist 明确允许，否则省略） |
| `approval/asked` + `approval/decided` | 可计时的 approval 内部 span；`callId` 能解析时挂在对应 tool 下，否则挂在当前 generation/turn；未闭合审批强制以 ERROR 收尾 |
| `user/message` | 按 `content.turnInputMode` 聚合为根 observation input；同时保留已弃用的 trace input，以兼容旧版 evaluator |
| `session/title` / `subagent/descriptor` / `agent-preset/selected` | 会话语义状态，用于当前/后续 observation 的 `langfuse.trace.name` 与安全浏览 metadata，不改变稳定 span name 或 ID |
| `session/end-seed` | 在 seed 边界关闭继承但缺少配对 end 的 compaction，并标记 incomplete/ERROR |
| `feedback/record` | `feedbackScores.enabled` 时成为 session-level `dsh_user_feedback` TEXT Score；只有 canonical 且经过 waterfall 的文本有资格发送 |
| fork child session | 独立的 child turn trace，并带可查询的 parent/seed metadata；进程内仍保留父 turn context 时附加指向它的 OTel Link |
| `agent-error` ops 记录 | 开放 turn 上的 `agent-error` span event + 状态 ERROR |
| `compaction/start` + `compaction/summary` + `compaction/end` | 一个覆盖完整压缩事务的 **generation**；能找到所属 turn 时作为其子节点，否则成为稳定的独立 trace；包含 provider/model/usage 与被遮蔽范围、事件数、token 数统计 |
| `compaction/prune` | 带裁剪范围、事件数和 token 数统计的时间点 span event |
| 其他所有事件类型（todo、plan、hooks、插件事件） | 开放 turn 上的时间点 span event |

Token 计量遵循 OpenTelemetry GenAI 的 inclusive-total 契约。DSH 报告的是互斥输入 buckets（`inputTokens` 仅包含未缓存输入），因此导出的 `gen_ai.usage.input_tokens` 会重建为 `inputTokens + cacheReadTokens + cacheWriteTokens`；cache read/write 与 reasoning 继续作为规范的明细属性。Langfuse 随后只需执行一次归一化，即可得到互斥 usage buckets。

## 架构决策

### 1. 实现 telemetry seam 后端，而非在 agent-loop 或 LLM 层埋点

Harness 的规则是 **model-visible ⟺ logged**：所有进入模型请求的内容都可以从 canonical 会话日志重建，且新行为以插件形式落在文档化扩展点上，绝不改 agent-loop。telemetry seam（`@deepseek-ai/dsh-session-telemetry`）正是为"把会话记录交给上报 SDK"而建的扩展点。实现它的 `SessionTelemetryBackend`，免费且保证一致地获得：

- 捕获*所有*模型可见内容 —— 包括本包从未听说过的 subagent、workflow、compaction 和插件事件；
- `session-telemetry/record` 脱敏 waterfall（部署自装的清洗规则作用于导出副本；canonical 日志永不改写）；
- `FEEDBACK_ONLY` 同意语义（用户记录反馈前不出境任何数据，且只有已提交的 canonical 事件才算同意）；
- handoff cursor、adoption 扫描和 teardown 排水。

直接在 LLM adapter 或 agent loop 埋点意味着重复实现上述全部、与日志漂移，并在 loop 变更时立即破裂。

### 2. 用原生 OTel traces SDK，而非 Langfuse SDK —— 根源是信号类型不匹配

官方 `session-telemetry-otel` 后端喂不了 Langfuse：它导出 OTLP **logs**，而 Langfuse 的 OTLP 端点（`/api/public/otel`）**只接受 traces**，走 OTLP/HTTP（JSON 或 protobuf；不支持 gRPC），Basic 鉴权。这个不匹配——而不是缺一个 URL——正是本插件存在的原因。

Trace 管线使用原生 OTel traces SDK（`BasicTracerProvider` → `BatchSpanProcessor` → `OTLPTraceExporter`），与官方后端同一 SDK 家族、同一配置面；属性遵循 OTel GenAI 语义约定加 Langfuse 文档化的 `langfuse.*` 属性映射。Feedback Score 使用小型原生 HTTP transport，而不再初始化第二套 tracing SDK，因此可以复用异步/自定义鉴权合约，并隔离 trace 与 Score 的故障。将来可在不改变 telemetry seam 或公开配置的前提下，把该内部 transport 换成 Langfuse SDK。

### 3. 折叠投影 —— 因为 seam 交来扁平流，而 Langfuse 需要树

seam 的记录与会话日志事件一一对应；Langfuse 需要 trace → observation 层级。`SessionSpanFolder` 是按 `(session.id, turn, step, compactionId)` 键控的状态机，把记录折叠进开放的 OTel span。契约关键的选择：

- **时间戳永远取记录的 `time`，绝不取墙钟**，因此实时捕获与 `FEEDBACK_ONLY` 的 canonical 日志重放产出完全相同的树（span 起止时间显式指定 —— OTel API 支持历史时间戳）。
- **`seq` 空洞是常态，绝不是丢失信号**：seam 每个 step 只发首个 `assistant/chunk`（流已启动信号；其时间即首 token 时间）。折叠器依赖这一点而非计数。
- **severity 用 seam 预映射的值**；折叠器把 `error` 映射到 span 状态，绝不重新推导事件语义。
- **tool span 是其 step 的 generation span 的子节点**：harness 定义 step 为一次模型请求*加上它调用的工具* —— `tool/call` 与 `tool/result` 都落在 step 边界之内 —— 因此 generation span 在时间上包含它的工具执行。step 已不再开放的调用（崩溃窗口重放）回退挂到 turn span。
- **整轮 input/output 按 Langfuse v4 合约放在根 observation 上**：`user/message` 提供 input；每条完成的 assistant message 覆盖 output，因此 turn 结束时保留最后一条回复。已弃用的 `langfuse.trace.input/output` 别名仅用于兼容旧版 trace-level evaluator。
- **未知事件类型落为开放 turn 上的 span event** —— 事件词汇表是 merge-extensible 的，丢弃未知类型会悄悄稀释时间线。
- **Compaction 是从 `compaction/start` 到 `compaction/end` 的单个事务 Generation**。它的时长有意包含 provider 调用外围的编排时间，不标成纯模型延迟。`compaction/summary` 用压缩摘要、provider/model/usage 与聚合后的 shadow 统计补全 span；provider `rawOutput` 和完整 `shadowedSeqs` 列表永不导出。与其配对的替换型 `user/message`（`source.plugin=compact`）仍是模型可见上下文，但不会覆盖 turn 的真人输入。所属 turn 缺失时生成稳定的独立 trace；生命周期记录缺失或畸形时降级为时间点事件或 ERROR span，不伪造时长。
- **强制收尾扫描**在三处关闭仍开放的 span（标记 `dsh.force_ended`）：新 `turn/start` 到来而前一个 turn 未闭合、会话的 ops `shutdown` 记录、后端 shutdown —— teardown 绝不把已开始的 span 遗弃在 SDK 队列里。

### 4. 稳定身份、feedback Score 与 fork 血缘

- 分别对 `(dsh session id, turn)` 与 `(dsh session id, compaction id)` 做带版本的 SHA-256 派生，使实时导出与 `FEEDBACK_ONLY` 重放得到稳定的 32 位十六进制 Trace ID。合法的 W3C `traceparent` 仍优先用于分布式追踪；确定性 ID 保留为可查询 metadata。
- Canonical feedback 经有界单 worker 队列成为 session-level `dsh_user_feedback` TEXT Score。它使用确定性 Score ID，以同一个 ID 重试瞬时失败，且永不阻塞或破坏 agent loop。源事件没有 rating 或目标 turn，因此插件不会推测这些语义。
- 每个 child turn 都带直接父 session、seed boundary 和可解析的父 Trace ID metadata。若有界进程内 registry 仍保存已完成父 turn 的根 SpanContext，child root 还会携带一个 OTel Link。父 context 缺失、淘汰或跨进程时降级为 metadata 和 `dsh.lineage.linked=false`，绝不伪造 context。

### 5. 投递语义：at-most-once handoff，可能重复

继承自 seam：cursor 标记的是*已交接*而非已送达；崩溃时留在 SDK 批处理队列里的数据会丢失；无 cursor 的重新收养（热重载）可能重发前缀，产生重复 span。接收端以 `langfuse.session.id` + `dsh.turn` + `dsh.event.seq` 关联。持久化 outbox 有意不做，与 seam 自身的立场一致。

### 6. 什么数据离开本机

上传模式下，span 属性携带用户与助手消息内容、工具参数与结果、compaction 摘要与聚合 shadow 统计、模型/用量元数据，以 `session-telemetry/record` waterfall 的返回值为准。Compaction provider `rawOutput` 和完整 `shadowedSeqs` 列表会被明确排除。**本插件不带任何脱敏规则**；导出跨越信任边界的部署需自行挂载 waterfall listener。Provider API key 结构性缺席（它们是构造参数，从不是会话事件）。序列化 payload 每属性按 `maxAttributeChars` 裁剪（默认 32768）；canonical 日志保留完整字节。

## Model Experience

无。本插件仅通过 telemetry seam 观察会话流并把折叠出的 span 交给 OTel SDK，从不向模型请求贡献任何内容。

#### KV Cache 影响

无。本插件既不组装也不发送 provider 请求。

## 测试

```sh
npm test                       # 单元：status 命令 + 折叠投影 + 配置 fail-loud 路径
npm run build && npm run test:e2e   # REAL composition：经 Loader 启动真实 dsh 应用
                               # （mock 模型 + 真实 bash 往返），断言 mock Langfuse
                               # collector 在 wire 上实际收到的 OTLP payload
npm run test:e2e:cloud         # opt-in 真实 Langfuse 往返；从 .env 加载凭据
npm run test:package           # npm pack + 空 consumer 安装/import + bundle 组合
```

e2e 沿用官方仓库的 REAL-composition 模式（`@deepseek-ai/dsh-app-boot` + `@deepseek-ai/dsh-loader-smoke`）：fixture `cordis.yml` 加载**构建产物** `lib/index.js` —— 与部署加载的是同一个文件 —— 断言针对 wire（包括 retry payload、approval/tool-error metadata、完整独立 compaction 与 seed-boundary orphan compaction），而非内部实现。

status 命令测试覆盖人工/JSON 格式、严格参数处理、Harness 命令注册、`recordInput: false`、disabled 模式诊断，以及缺少可选命令服务的 headless 组合。另一个本地 e2e 使用真实 `OTLPTraceExporter` 与 `BatchSpanProcessor`，依次触发 HTTP 503 和 200，并验证公开 backend status 从 degraded 恢复为 healthy；backend 单元测试还会独立锁定 observer 到 `status()` 的接线。

`npm run test:e2e:cloud` 会加载 gitignored 的 `.env`，并且只运行 opt-in 的 Langfuse Cloud 往返测试。先把 `.env.example` 复制为 `.env`，再填入 `LANGFUSE_PUBLIC_KEY`、`LANGFUSE_SECRET_KEY` 和匹配区域的 `LANGFUSE_HOST`。测试会通过 v4 Observations API 校验根 input/output、usage、逐 observation 关联、parent/child metadata、独立 compaction 的身份/摘要/usage、approval outcome 与结构化 tool error，并通过 Scores API 回读 feedback；它还会验证 retry 生命周期不会生成重复 generation。retry event payload 本身由本地 raw-OTLP wire 测试锁定，因为 Observations API 返回 observation，但不返回其内嵌的 OTel span event。通用的 `npm run test:e2e` 在这些变量已导出时仍会执行 Cloud case，否则自行跳过。设置 `LANGFUSE_REQUIRE_TOTAL_COST=1` 后，还会要求当前官方 `deepseek-v4-flash` step generation 的 `totalCost` 为有限正数；`LANGFUSE_E2E_COST_MODEL` 可选择采用相同价格的隔离测试别名。这是对测试项目 Langfuse 模型计价配置的 opt-in 验证，插件本身不会硬编码价格。

## 版本兼容

DeepSeek Harness 处于 developer preview，无兼容承诺；本插件精确锁定 `@deepseek-ai/dsh-*` 版本。

| dsh-plugin-langfuse | @deepseek-ai/dsh-* |
|---|---|
| 0.1.x | 0.1.0-rc.6 |
| 0.2.x | 0.1.0-rc.6 |
| 0.3.x | 0.1.0-rc.7 |
| 0.4.x | 0.1.0-rc.8 |
| 0.5.0 | 0.1.0-rc.8 |
| 0.5.1 | 0.1.1-rc.1 |

独立的 **Upstream compatibility canary** 工作流会把所有 `@deepseek-ai/*` 依赖解析到最新发布版本。Pull request 与 `main` push 只做预警；每周定时和手动触发严格失败，并依次运行 typecheck、单测、构建、REAL-composition e2e 与 package smoke。失败运行会保留解析后的 manifest 和 lockfile，便于复现。

## 已知限制与延后工作

- **Feedback 仅为 TEXT/session-level**：当前 DSH 事件不带数值 rating 或目标 turn/observation，因此插件不会自行推测。
- **不保证 UI 渲染 OTel Link**：parent/seed metadata 是稳定且可通过 API 查询的 lineage 合约；Langfuse 未必把 Link 显示成可点击边。
- **无持久化投递**（决策 5）：OTel batch 与 Score 队列都在内存中，进程崩溃可能丢失已接收但未 flush 的数据。
- **每个 context 只能有一个后端**：同时运行 Langfuse 和官方 OTLP-logs 后端需要上游 seam 演进出 multi-sink。
- **辅助 LLM 调用尚未映射为 generation**：title/search 请求事件缺少完整配对的 completion/failure/usage 生命周期，0.5.x 不会伪造 observation。
- **通用轮次外事件仍仅留在日志**：title/preset/descriptor 会保留为语义状态，但插件不会创建长寿命 session trace，也不会为任意点事件逐条创建 trace。

## 许可证

[MIT](LICENSE)
