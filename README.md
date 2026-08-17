# dsh-plugin-langfuse

English | [中文](README.zh.md)

[Langfuse](https://langfuse.com) observability for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`): exports each turn as an OpenTelemetry trace — model step → generation, tool call → tool span — groups turns by session, records canonical feedback as Langfuse Scores, and preserves fork/subagent lineage.

This is a community plugin (`dsh-plugin` topic), not part of the official repository. It implements the harness's public telemetry seam (`@deepseek-ai/dsh-session-telemetry`) as an alternative backend to the official OTLP-logs exporter.

## Install

The commands below assume the installed `dsh` CLI. Running the official harness from a [source checkout](https://github.com/deepseek-ai/deepseek-harness) instead? Run each of them as `pnpm dsh …` from the checkout root (after its `pnpm run build`) — same commands, same `web` profile.

As a profile bundle (the package ships a `cordis.patch.yml` patch layer):

```sh
dsh plugin --profile web add dsh-plugin-langfuse
export LANGFUSE_PUBLIC_KEY=pk-lf-…
export LANGFUSE_SECRET_KEY=sk-lf-…
# optional, defaults to https://cloud.langfuse.com (EU region); note the plugin
# reads LANGFUSE_HOST, not the Langfuse SDK's LANGFUSE_BASE_URL
export LANGFUSE_HOST=https://us.cloud.langfuse.com
dsh web                        # alias for: dsh --profile web
```

The bundled patch disables the base profile's `session-telemetry-otel` row (the telemetry seam accepts exactly one backend per context; a duplicate load throws) and mounts this backend in `FULL` mode when a Langfuse key is present, `DISABLED` otherwise. It also enables feedback Scores when both project keys are present. `LANGFUSE_TELEMETRY_MODE=FEEDBACK_ONLY` narrows sharing to feedback-gated release.

Both the bundle layer and the env vars are read at boot: an already-running instance must be restarted after installing, from a shell that has the variables set. `dsh --profile web --dump-config` shows the composed result without booting — a `# == dsh-plugin-langfuse` layer that patches the base telemetry row and adds `session-telemetry-langfuse` with its env-driven mode. After the next turn, traces appear in the Langfuse console **of the region `LANGFUSE_HOST` points at** — keys are region-scoped, so a US project shows nothing on the EU console. `dsh plugin --profile web remove dsh-plugin-langfuse` removes both the dependency and the layer.

Or as an explicit `cordis.yml` row:

```yaml
- id: session-telemetry-langfuse
  name: dsh-plugin-langfuse
  config:
    mode: FULL                 # FULL | FEEDBACK_ONLY | DISABLED (default)
    exporter:                  # passed verbatim to the SDK's OTLP/HTTP trace exporter
      url: https://cloud.langfuse.com/api/public/otel/v1/traces
    auth:
      publicKey: !!js process.env.LANGFUSE_PUBLIC_KEY
      secretKey: !!js process.env.LANGFUSE_SECRET_KEY
    feedbackScores:             # optional; disabled by default for explicit rows
      enabled: true
      url: https://cloud.langfuse.com/api/public/scores
      maxQueueSize: 256
      requestTimeoutMillis: 3000
    processor: {}              # optional; passed verbatim to BatchSpanProcessor
    shutdownTimeoutMillis: 3000
```

## Config

| Field | Meaning |
|---|---|
| `mode` | `FULL` exports every session live; `FEEDBACK_ONLY` replays and exports the canonical session log only when the user records feedback; `DISABLED` (default) constructs nothing and nothing leaves the process. The vocabulary and consent semantics are the seam's, identical to the official backend. |
| `exporter` | The complete `OTLPExporterNodeConfigBase` object, passed to the OTLP/HTTP trace exporter. `url` is required outside `DISABLED` and must be the **full traces path** (`…/api/public/otel/v1/traces`). The plugin defaults an `x-langfuse-ingestion-version: 4` header — without it new spans do not land on Langfuse's v4 data model in real time. An explicit entry (any casing) wins, whether supplied in a plain `exporter.headers` object or returned by a `HeadersFactory`. |
| `auth` | Langfuse project key pair, turned into the endpoint's Basic-auth header. Mutually exclusive with an explicit `exporter.headers` authorization; uploading modes require exactly one of the two. |
| `correlation` | Host-identity correlation: `userId`/`sessionId` stamped as `langfuse.user.id`/`langfuse.session.id` on every exported span so an embedding host's traces and this plugin's group under one Langfuse user/session. See [Correlating with an embedding host](#correlating-with-an-embedding-host). |
| `feedbackScores` | Optional session-level TEXT Score export for canonical `feedback/record` events. `enabled` defaults to `false`; `url` must be the full `…/api/public/scores` path. `maxQueueSize` defaults to 256 and `requestTimeoutMillis` to 3000. The bounded in-memory queue is failure-isolated from tracing and drains best-effort on shutdown. The bundled profile enables it when both project keys exist. |
| `processor` | Passed verbatim to `BatchSpanProcessor` (`scheduledDelayMillis`, `maxQueueSize`, `maxExportBatchSize`, …); batching, retry, and loss policy are the SDK's documented behavior. |
| `maxAttributeChars` | Serialized-payload ceiling per span attribute (default 32768); longer payloads are clipped with an `…[clipped]` marker while the canonical session log keeps the full bytes. |
| `shutdownTimeoutMillis` | Plugin-owned outer deadline on the SDK's shutdown drain (default 3000). |

Misconfiguration fails loud at plugin load: a missing/malformed/non-http(s) exporter URL, missing credentials, ambiguous double auth, a non-positive `maxExportBatchSize` (the SDK would hang on shutdown), an invalid `correlation` shape or empty `correlation.userId`/`sessionId`, an enabled Score sink without a valid URL/queue/timeout, or an unknown `mode` all throw before any transport is constructed.

## Correlating with an embedding host

A host application that embeds the dsh runtime and already emits its own traces into the same Langfuse project can steer this plugin's identity so both views group under one Langfuse user/session — the host typically injects its ids as env vars when spawning the runtime:

```yaml
config:
  correlation:
    userId: !!js process.env.HOST_USER_ID
    sessionId: !!js process.env.HOST_SESSION_ID
```

- The resolved `langfuse.session.id`/`langfuse.user.id` ride **every** exported span — turn, generation, tool, and compaction — because Langfuse's v4 query model filters and aggregates per observation, not only per trace ([propagation contract](https://langfuse.com/integrations/native/opentelemetry#important-propagating-trace-attributes-to-all-spans)).
- `sessionId` defaults to the dsh session id, and the original dsh session id stays on each logical root as `dsh.session.id` — the pointer back into `$DSH_HOME/sessions` for local diagnosis.
- **Per-turn dynamic override**: a `turn/start` record carrying `langfuse.user.id`/`langfuse.session.id` attributes overrides the static config for that turn — a deployment injects them through a `session-telemetry/record` waterfall listener. The snapshot is locked at `turn/start`; identity attributes on later records are ignored. Precedence: record attributes > `correlation` config > dsh session id.
- A dynamic mapping must be deterministic and rebuildable from the dsh session id, and must survive for as long as the session can still trigger a `FEEDBACK_ONLY` replay — otherwise the replayed tree exports under a different identity than live capture would have.
- Static `correlation` values bypass the redaction waterfall: the waterfall transforms records, and these values never transit one.
- Delivery semantics are unchanged: correlation is identity, not dedup — duplicates remain possible (see decision 5).

## What appears in Langfuse

| dsh session event | Langfuse concept |
|---|---|
| session (`session.id`) | session (`langfuse.session.id` on every exported observation/span) |
| `turn/start` / `turn/end` | trace root observation (root span; error end reasons set span status ERROR) |
| `step/start` / `step/end` + `request/header` + `assistant/message` | **generation** — model, provider, output, canonical `gen_ai.usage.*` tokens (input/output/cache-read/cache-creation/reasoning); the latest assistant message also becomes the root observation's overall output |
| first `assistant/chunk` of a step | `langfuse.observation.completion_start_time` (time-to-first-token) |
| `tool/call` + `tool/result` | tool span (arguments as input, result as output, `isError` → status ERROR) |
| `user/message` | root observation input; deprecated trace input is retained for legacy evaluator compatibility |
| `feedback/record` | session-level `dsh_user_feedback` TEXT Score when `feedbackScores.enabled`; only the post-waterfall canonical text is eligible |
| forked child session | independent child turn trace plus queryable parent/seed metadata; an OTel Link points to the completed parent turn when its in-process context is retained |
| `agent-error` ops record | `agent-error` span event + status ERROR on the open turn |
| `compaction/start` + `compaction/summary` + `compaction/end` | one **generation** spanning the whole compaction transaction; child of its owning turn when available, otherwise a stable standalone trace; includes provider/model/usage and shadowed range/count/token statistics |
| `compaction/prune` | point-in-time span event with the pruned range/count/token statistics |
| every other event type (todo, plan, hooks, plugin events) | point-in-time span event on the open turn |

Token accounting follows the OpenTelemetry GenAI inclusive-total contract. DSH reports mutually exclusive input buckets (`inputTokens` is uncached input), so the exported `gen_ai.usage.input_tokens` is reconstructed as `inputTokens + cacheReadTokens + cacheWriteTokens`; cache read/write and reasoning remain canonical detail attributes. Langfuse can then normalize them into mutually exclusive usage buckets exactly once.

## Architecture decisions

### 1. A telemetry-seam backend, not agent-loop or LLM-layer instrumentation

The harness's rule is **model-visible ⟺ logged**: everything that reaches a model request is reconstructable from the canonical session log, and new behavior lands as a plugin on documented extension points, never as agent-loop changes. The telemetry seam (`@deepseek-ai/dsh-session-telemetry`) is exactly the extension point built for handing session records to a reporting SDK. Implementing its `SessionTelemetryBackend` buys, for free and with guaranteed consistency:

- capture of *everything* model-visible — including subagent, workflow, compaction, and plugin events this package has never heard of;
- the `session-telemetry/record` redaction waterfall (deployment-owned scrub rules apply to the exported copy; the canonical log is never rewritten);
- `FEEDBACK_ONLY` consent semantics (nothing leaves until the user records feedback, and only the committed canonical event is consent);
- the handoff cursor, adoption sweeps, and teardown draining.

Instrumenting the LLM adapter or agent loop directly would duplicate all of that, drift from the log, and break the moment the loop changes.

### 2. Plain OTel traces SDK, not the Langfuse SDK — because of a signal-type mismatch

The official `session-telemetry-otel` backend cannot feed Langfuse: it exports OTLP **logs**, and Langfuse's OTLP endpoint (`/api/public/otel`) accepts **traces only**, over OTLP/HTTP (JSON or protobuf; no gRPC), with Basic auth. That mismatch — not a missing URL — is why this plugin exists.

The trace pipeline is the plain OTel traces SDK (`BasicTracerProvider` → `BatchSpanProcessor` → `OTLPTraceExporter`), the same SDK family and configuration surface as the official backend, with attributes following the OTel GenAI semantic conventions plus Langfuse's documented `langfuse.*` property mapping. Feedback Scores use a small native-HTTP transport instead of a second tracing SDK so the plugin can reuse its async/custom auth contract and keep trace versus Score failures isolated. The Langfuse SDK can replace that internal transport later without changing the telemetry seam or public configuration.

### 3. A folding projection, because the seam hands over a flat stream and Langfuse needs a tree

The seam's records mirror session-log events one-to-one; Langfuse needs trace → observation hierarchy. `SessionSpanFolder` is a state machine keyed by `(session.id, turn, step, compactionId)` that folds records into open OTel spans. Its contract-critical choices:

- **Timestamps always come from the record's `time`, never the wall clock**, so live capture and `FEEDBACK_ONLY` canonical-log replay produce identical trees (span start/end times are explicit — the OTel API supports historical stamps).
- **`seq` gaps are routine, never a loss signal**: the seam ships only the first `assistant/chunk` per step (the stream-started signal; its time is the first-token time). The folder relies on this instead of counting.
- **Severity is the seam's pre-mapped value**; the folder maps `error` onto span status and never re-derives event semantics.
- **Tool spans are children of their step's generation span**: the harness defines a step as one model request *plus the tools it calls* — `tool/call` and `tool/result` land inside the step's boundaries — so the generation span temporally contains its tool executions. A call whose step is no longer open (crash-window replay) falls back to the turn span.
- **Overall turn input/output live on the root observation for Langfuse v4**: `user/message` supplies its input, and each completed assistant message replaces its output so the final message remains at turn end. Deprecated `langfuse.trace.input/output` aliases are emitted only for legacy trace-level evaluator compatibility.
- **Unknown event types land as span events on the open turn** — the event vocabulary is merge-extensible, and dropping unknown types would silently thin the timeline.
- **Compaction is one transaction Generation** from `compaction/start` through `compaction/end`. Its duration deliberately includes orchestration around the provider call and is not labeled as pure model latency. `compaction/summary` enriches the span with the compacted summary, provider/model/usage, and aggregate shadow statistics; provider `rawOutput` and the full `shadowedSeqs` list are never exported. The paired replacement `user/message` (`source.plugin=compact`) remains model-visible context but never overwrites the turn's human input. A missing owner becomes a stable standalone trace, while missing/malformed lifecycle records degrade to point events or an ERROR span rather than fabricated timing.
- **Force-end sweeps** close still-open spans (marked `dsh.force_ended`) on a next `turn/start` with an open predecessor, on the session's ops `shutdown` record, and on backend shutdown — teardown never abandons started spans inside the SDK queue.

### 4. Stable identity, feedback Scores, and fork lineage

- Versioned SHA-256 identities derived from `(dsh session id, turn)` and `(dsh session id, compaction id)` supply stable 32-hex Trace IDs across live export and `FEEDBACK_ONLY` replay. A valid W3C `traceparent` still wins for distributed tracing; the deterministic ID remains queryable metadata.
- Canonical feedback becomes a session-level `dsh_user_feedback` TEXT Score through a bounded single-worker queue. It uses a deterministic Score ID, retries transient failures with the same ID, and never blocks or fails the agent loop. Because the source event has no rating or target turn, the plugin deliberately does not invent one.
- Every child turn carries direct parent session, seed boundary, and resolved parent Trace ID metadata. If the completed parent root SpanContext remains in the bounded in-process registry, the child root also contains one OTel Link. Missing/evicted/cross-process parents degrade to metadata with `dsh.lineage.linked=false`; no context is fabricated.

### 5. Delivery semantics: at-most-once handoff, duplicates possible

Inherited from the seam: the cursor marks *handed off*, not delivered; whatever sits in the SDK batch queue at crash time is lost, and a cursor-less re-adoption (hot reload) may re-hand a prefix, producing duplicate spans. Receivers correlate on `langfuse.session.id` + `dsh.turn` + `dsh.event.seq`. A durable outbox is deliberately out of scope, matching the seam's own stance.

### 6. What leaves the machine

In uploading modes, span attributes carry user and assistant message content, tool arguments and results, compaction summaries and aggregate shadow statistics, and model/usage metadata, as returned by the `session-telemetry/record` waterfall. Compaction provider `rawOutput` and full `shadowedSeqs` lists are deliberately omitted. **This plugin ships no redaction rules**; a deployment exporting beyond a trusted boundary mounts its own waterfall listener. Provider API keys are structurally absent (they are constructor parameters, never session events). Serialized payloads are clipped at `maxAttributeChars` per attribute (default 32768); the canonical log keeps the full bytes.

## Model Experience

None, as this plugin only observes the session stream through the telemetry seam and hands folded spans to the OTel SDK; it never contributes to a model request.

#### KV Cache effect

None; this plugin neither assembles nor sends a provider request.

## Testing

```sh
npm test                       # unit: folding projection + config fail-loud paths
npm run build && npm run test:e2e   # REAL composition: boots a real dsh app via the
                               # Loader (mock model, real bash round trip) and asserts
                               # the OTLP payload a mock Langfuse collector received
npm run test:package           # npm pack + empty-consumer install/import + bundle composition
```

The e2e follows the official repository's REAL-composition pattern (`@deepseek-ai/dsh-app-boot` + `@deepseek-ai/dsh-loader-smoke`): the fixture `cordis.yml` loads the **built** `lib/index.js` — the same file a deployment loads — and assertions run against the wire, including a standalone compaction trace, not against internals.

When `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` are present, the same e2e command also runs a Cloud round trip and checks the v4 Observations API for root input/output, usage, per-observation correlation, parent/child metadata, standalone compaction identity/summary/usage, and the Scores API for feedback readback. Without keys, that test self-skips.

## Version compatibility

DeepSeek Harness is in developer preview with no compatibility promises; this plugin pins exact `@deepseek-ai/dsh-*` versions.

| dsh-plugin-langfuse | @deepseek-ai/dsh-* |
|---|---|
| 0.1.x | 0.1.0-rc.6 |
| 0.2.x | 0.1.0-rc.6 |
| 0.3.x | 0.1.0-rc.7 |

The separate **Upstream compatibility canary** workflow resolves every `@deepseek-ai/*` dependency to its newest published version. Pull requests and `main` pushes are advisory; the weekly schedule and manual dispatch are strict and run typecheck, unit tests, build, REAL-composition e2e, and package smoke. Failed runs retain the resolved manifest and lockfile for reproduction.

## Known limitations and deferred work

- **Feedback is TEXT/session-level only**: the current DSH event carries no numeric rating or target turn/observation, so the plugin does not infer one.
- **OTel Link UI rendering is not guaranteed**: parent/seed metadata is the stable, API-queryable lineage contract; Langfuse may not render the Link as a clickable edge.
- **No durable delivery** (decision 5): OTel batching and the Score queue are in memory, so a process crash can lose accepted-but-unflushed data.
- **One backend per context**: running Langfuse *and* the official OTLP-logs backend simultaneously requires a multi-sink evolution of the upstream seam.

## License

[MIT](LICENSE)
