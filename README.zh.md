# dsh-plugin-langfuse

[English](README.md) | 中文

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）提供 [Langfuse](https://langfuse.com) 可观测性：把每个 agent 会话导出为 OpenTelemetry trace 树 —— turn → trace、模型 step → generation、工具调用 → tool span，附带 GenAI 语义约定和 `langfuse.*` 属性 —— 发送到 Langfuse 的 OTLP 端点。

这是一个社区插件（`dsh-plugin` topic），不属于官方仓库。它实现 harness 的公开 telemetry seam（`@deepseek-ai/dsh-session-telemetry`），作为官方 OTLP-logs 导出器之外的另一个后端。

## 安装

作为 profile bundle 安装（包内附带 `cordis.patch.yml` patch 层）：

```sh
dsh plugin --profile web add dsh-plugin-langfuse
export LANGFUSE_PUBLIC_KEY=pk-lf-…
export LANGFUSE_SECRET_KEY=sk-lf-…
# 可选，默认 https://cloud.langfuse.com
export LANGFUSE_HOST=https://us.cloud.langfuse.com
```

附带的 patch 会禁用 base profile 的 `session-telemetry-otel` 行（telemetry seam 每个 context 只接受一个后端；重复加载会抛错），并在存在 Langfuse key 时以 `FULL` 模式挂载本后端，否则为 `DISABLED`。设置 `LANGFUSE_TELEMETRY_MODE=FEEDBACK_ONLY` 可将共享收窄为反馈门控释放。

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
    processor: {}              # 可选；原样透传给 BatchSpanProcessor
    shutdownTimeoutMillis: 3000
```

## 配置

| 字段 | 含义 |
|---|---|
| `mode` | `FULL` 实时导出每个会话；`FEEDBACK_ONLY` 仅在用户记录反馈时重放并导出 canonical 会话日志；`DISABLED`（默认）不构造任何东西，没有数据离开进程。词汇与同意语义来自 seam，与官方后端完全一致。 |
| `exporter` | 完整的 `OTLPExporterNodeConfigBase` 对象，原样透传给 OTLP/HTTP trace exporter。非 `DISABLED` 模式下 `url` 必填，且必须是**完整的 traces 路径**（`…/api/public/otel/v1/traces`）。 |
| `auth` | Langfuse 项目密钥对，转换为端点的 Basic-auth 请求头。与显式的 `exporter.headers` authorization 互斥；上传模式要求两者恰好提供其一。 |
| `processor` | 原样透传给 `BatchSpanProcessor`（`scheduledDelayMillis`、`maxQueueSize`、`maxExportBatchSize` 等）；批处理、重试、丢失策略均为 SDK 的文档化行为。 |
| `maxAttributeChars` | 每个 span 属性的序列化 payload 上限（默认 32768）；超长部分以 `…[clipped]` 标记裁剪，canonical 会话日志保留完整字节。 |
| `shutdownTimeoutMillis` | 插件持有的 SDK shutdown 排水外层截止时间（默认 3000）。 |

错误配置在插件加载时即失败：`url` 缺失/畸形/非 http(s)、凭据缺失、双重鉴权歧义、非正的 `maxExportBatchSize`（SDK 会在 shutdown 时挂死）、未知 `mode`，全部在构造任何传输之前抛出。

## Langfuse 中会看到什么

| dsh 会话事件 | Langfuse 概念 |
|---|---|
| session（`session.id`） | session（每条 trace 带 `langfuse.session.id`） |
| `turn/start` / `turn/end` | trace（root span；错误结束原因置 span 状态为 ERROR） |
| `step/start` / `step/end` + `request/header` + `assistant/message` | **generation** —— 模型、provider、输出、`gen_ai.usage.*` token（input/output/cache-read/reasoning） |
| step 的首个 `assistant/chunk` | `langfuse.observation.completion_start_time`（首 token 时间） |
| `tool/call` + `tool/result` | tool span（参数为 input，结果为 output，`isError` → 状态 ERROR） |
| `user/message` | trace input |
| `agent-error` ops 记录 | 开放 turn 上的 exception 事件 + 状态 ERROR |
| 其他所有事件类型（todo、plan、compaction、hooks、插件事件） | 开放 turn 上的时间点 span event |

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

导出管线是原生 OTel traces SDK（`BasicTracerProvider` → `BatchSpanProcessor` → `OTLPTraceExporter`），与官方后端同一 SDK 家族、同一配置面；属性遵循 OTel GenAI 语义约定加 Langfuse 文档化的 `langfuse.*` 属性映射。Langfuse v5 SDK（`@langfuse/otel`、`@langfuse/client`）经评估后延后采用：它本身也基于 OTel，引入 vendor 依赖却不改变 wire 格式；而真正需要它的功能（`feedback/record` → score、prompt 管理）属于延后工作。将来采用它只是本包内部的变更。

### 3. 折叠投影 —— 因为 seam 交来扁平流，而 Langfuse 需要树

seam 的记录与会话日志事件一一对应；Langfuse 需要 trace → observation 层级。`SessionSpanFolder` 是按 `(session.id, turn, step)` 键控的状态机，把记录折叠进开放的 OTel span。契约关键的选择：

- **时间戳永远取记录的 `time`，绝不取墙钟**，因此实时捕获与 `FEEDBACK_ONLY` 的 canonical 日志重放产出完全相同的树（span 起止时间显式指定 —— OTel API 支持历史时间戳）。
- **`seq` 空洞是常态，绝不是丢失信号**：seam 每个 step 只发首个 `assistant/chunk`（流已启动信号；其时间即首 token 时间）。折叠器依赖这一点而非计数。
- **severity 用 seam 预映射的值**；折叠器把 `error` 映射到 span 状态，绝不重新推导事件语义。
- **tool span 是其 step 的 generation span 的子节点**：harness 定义 step 为一次模型请求*加上它调用的工具* —— `tool/call` 与 `tool/result` 都落在 step 边界之内 —— 因此 generation span 在时间上包含它的工具执行。step 已不再开放的调用（崩溃窗口重放）回退挂到 turn span。
- **未知事件类型落为开放 turn 上的 span event** —— 事件词汇表是 merge-extensible 的，丢弃未知类型会悄悄稀释时间线。
- **强制收尾扫描**在三处关闭仍开放的 span（标记 `dsh.force_ended`）：新 `turn/start` 到来而前一个 turn 未闭合、会话的 ops `shutdown` 记录、后端 shutdown —— teardown 绝不把已开始的 span 遗弃在 SDK 队列里。

### 4. 投递语义：at-most-once handoff，可能重复

继承自 seam：cursor 标记的是*已交接*而非已送达；崩溃时留在 SDK 批处理队列里的数据会丢失；无 cursor 的重新收养（热重载）可能重发前缀，产生重复 span。接收端以 `langfuse.session.id` + `dsh.turn` + `dsh.event.seq` 关联。持久化 outbox 有意不做，与 seam 自身的立场一致。

### 5. 什么数据离开本机

上传模式下，span 属性携带用户与助手消息内容、工具参数与结果、模型/用量元数据，以 `session-telemetry/record` waterfall 的返回值为准。**本插件不带任何脱敏规则**；导出跨越信任边界的部署需自行挂载 waterfall listener。Provider API key 结构性缺席（它们是构造参数，从不是会话事件）。序列化 payload 每属性按 `maxAttributeChars` 裁剪（默认 32768）；canonical 日志保留完整字节。

## Model Experience

无。本插件仅通过 telemetry seam 观察会话流并把折叠出的 span 交给 OTel SDK，从不向模型请求贡献任何内容。

#### KV Cache 影响

无。本插件既不组装也不发送 provider 请求。

## 测试

```sh
npm test                       # 单元：折叠投影 + 配置 fail-loud 路径
npm run build && npm run test:e2e   # REAL composition：经 Loader 启动真实 dsh 应用
                               # （mock 模型 + 真实 bash 往返），断言 mock Langfuse
                               # collector 在 wire 上实际收到的 OTLP payload
```

e2e 沿用官方仓库的 REAL-composition 模式（`@deepseek-ai/dsh-app-boot` + `@deepseek-ai/dsh-loader-smoke`）：fixture `cordis.yml` 加载**构建产物** `lib/index.js` —— 与部署加载的是同一个文件 —— 断言针对 wire，而非内部实现。

## 版本兼容

DeepSeek Harness 处于 developer preview，无兼容承诺；本插件精确锁定 `@deepseek-ai/dsh-*` 版本。

| dsh-plugin-langfuse | @deepseek-ai/dsh-* |
|---|---|
| 0.1.x | 0.1.0-rc.6 |

## 已知限制与延后工作

- **`feedback/record` → Langfuse score** 延后；需要 `@langfuse/client` 或 public ingestion API（决策 2）。
- **Subagent 血缘未拼接**：fork 出的会话其 trace 树从继承边界开始；`session.parent_id`/`seed_length` 随属性携带，但尚未创建 trace link。
- **无持久化投递**（决策 4）。
- **每个 context 只能有一个后端**：同时运行 Langfuse 和官方 OTLP-logs 后端需要上游 seam 演进出 multi-sink。

## 许可证

[MIT](LICENSE)
