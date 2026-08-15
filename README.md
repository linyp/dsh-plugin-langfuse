# dsh-plugin-langfuse

English | [中文](README.zh.md)

[Langfuse](https://langfuse.com) observability for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`): exports each agent session as an OpenTelemetry trace tree — turn → trace, model step → generation, tool call → tool span, with GenAI semantic-convention and `langfuse.*` attributes — to Langfuse's OTLP endpoint.

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

The bundled patch disables the base profile's `session-telemetry-otel` row (the telemetry seam accepts exactly one backend per context; a duplicate load throws) and mounts this backend in `FULL` mode when a Langfuse key is present, `DISABLED` otherwise. `LANGFUSE_TELEMETRY_MODE=FEEDBACK_ONLY` narrows sharing to feedback-gated release.

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
| `processor` | Passed verbatim to `BatchSpanProcessor` (`scheduledDelayMillis`, `maxQueueSize`, `maxExportBatchSize`, …); batching, retry, and loss policy are the SDK's documented behavior. |
| `maxAttributeChars` | Serialized-payload ceiling per span attribute (default 32768); longer payloads are clipped with an `…[clipped]` marker while the canonical session log keeps the full bytes. |
| `shutdownTimeoutMillis` | Plugin-owned outer deadline on the SDK's shutdown drain (default 3000). |

Misconfiguration fails loud at plugin load: a missing/malformed/non-http(s) `url`, missing credentials, ambiguous double auth, a non-positive `maxExportBatchSize` (the SDK would hang on shutdown), an invalid `correlation` shape or empty `correlation.userId`/`sessionId`, or an unknown `mode` all throw before any transport is constructed.

## Correlating with an embedding host

A host application that embeds the dsh runtime and already emits its own traces into the same Langfuse project can steer this plugin's identity so both views group under one Langfuse user/session — the host typically injects its ids as env vars when spawning the runtime:

```yaml
config:
  correlation:
    userId: !!js process.env.HOST_USER_ID
    sessionId: !!js process.env.HOST_SESSION_ID
```

- The resolved `langfuse.session.id`/`langfuse.user.id` ride **every** exported span — turn, generation, and tool — because Langfuse's v4 query model filters and aggregates per observation, not only per trace ([propagation contract](https://langfuse.com/integrations/native/opentelemetry#important-propagating-trace-attributes-to-all-spans)).
- `sessionId` defaults to the dsh session id, and the original dsh session id always stays on the turn root as `dsh.session.id` — the pointer back into `$DSH_HOME/sessions` for local diagnosis.
- **Per-turn dynamic override**: a `turn/start` record carrying `langfuse.user.id`/`langfuse.session.id` attributes overrides the static config for that turn — a deployment injects them through a `session-telemetry/record` waterfall listener. The snapshot is locked at `turn/start`; identity attributes on later records are ignored. Precedence: record attributes > `correlation` config > dsh session id.
- A dynamic mapping must be deterministic and rebuildable from the dsh session id, and must survive for as long as the session can still trigger a `FEEDBACK_ONLY` replay — otherwise the replayed tree exports under a different identity than live capture would have.
- Static `correlation` values bypass the redaction waterfall: the waterfall transforms records, and these values never transit one.
- Delivery semantics are unchanged: correlation is identity, not dedup — duplicates remain possible (see decision 4).

## What appears in Langfuse

| dsh session event | Langfuse concept |
|---|---|
| session (`session.id`) | session (`langfuse.session.id` on every exported observation/span) |
| `turn/start` / `turn/end` | trace root observation (root span; error end reasons set span status ERROR) |
| `step/start` / `step/end` + `request/header` + `assistant/message` | **generation** — model, provider, output, `gen_ai.usage.*` tokens (input/output/cache-read/reasoning); the latest assistant message also becomes the root observation's overall output |
| first `assistant/chunk` of a step | `langfuse.observation.completion_start_time` (time-to-first-token) |
| `tool/call` + `tool/result` | tool span (arguments as input, result as output, `isError` → status ERROR) |
| `user/message` | root observation input; deprecated trace input is retained for legacy evaluator compatibility |
| `agent-error` ops record | exception event + status ERROR on the open turn |
| every other event type (todo, plan, compaction, hooks, plugin events) | point-in-time span event on the open turn |

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

The export pipeline is the plain OTel traces SDK (`BasicTracerProvider` → `BatchSpanProcessor` → `OTLPTraceExporter`), the same SDK family and configuration surface as the official backend, with attributes following the OTel GenAI semantic conventions plus Langfuse's documented `langfuse.*` property mapping. The Langfuse v5 SDK (`@langfuse/otel`, `@langfuse/client`) was considered and deferred: it is itself OTel-based, so it adds a vendor dependency without changing the wire format, and the features that would justify it (scores from `feedback/record`, prompt management) are deferred work. Adopting it later is a change inside this package only.

### 3. A folding projection, because the seam hands over a flat stream and Langfuse needs a tree

The seam's records mirror session-log events one-to-one; Langfuse needs trace → observation hierarchy. `SessionSpanFolder` is a state machine keyed by `(session.id, turn, step)` that folds records into open OTel spans. Its contract-critical choices:

- **Timestamps always come from the record's `time`, never the wall clock**, so live capture and `FEEDBACK_ONLY` canonical-log replay produce identical trees (span start/end times are explicit — the OTel API supports historical stamps).
- **`seq` gaps are routine, never a loss signal**: the seam ships only the first `assistant/chunk` per step (the stream-started signal; its time is the first-token time). The folder relies on this instead of counting.
- **Severity is the seam's pre-mapped value**; the folder maps `error` onto span status and never re-derives event semantics.
- **Tool spans are children of their step's generation span**: the harness defines a step as one model request *plus the tools it calls* — `tool/call` and `tool/result` land inside the step's boundaries — so the generation span temporally contains its tool executions. A call whose step is no longer open (crash-window replay) falls back to the turn span.
- **Overall turn input/output live on the root observation for Langfuse v4**: `user/message` supplies its input, and each completed assistant message replaces its output so the final message remains at turn end. Deprecated `langfuse.trace.input/output` aliases are emitted only for legacy trace-level evaluator compatibility.
- **Unknown event types land as span events on the open turn** — the event vocabulary is merge-extensible, and dropping unknown types would silently thin the timeline.
- **Force-end sweeps** close still-open spans (marked `dsh.force_ended`) on a next `turn/start` with an open predecessor, on the session's ops `shutdown` record, and on backend shutdown — teardown never abandons started spans inside the SDK queue.

### 4. Delivery semantics: at-most-once handoff, duplicates possible

Inherited from the seam: the cursor marks *handed off*, not delivered; whatever sits in the SDK batch queue at crash time is lost, and a cursor-less re-adoption (hot reload) may re-hand a prefix, producing duplicate spans. Receivers correlate on `langfuse.session.id` + `dsh.turn` + `dsh.event.seq`. A durable outbox is deliberately out of scope, matching the seam's own stance.

### 5. What leaves the machine

In uploading modes, span attributes carry user and assistant message content, tool arguments and results, and model/usage metadata, as returned by the `session-telemetry/record` waterfall. **This plugin ships no redaction rules**; a deployment exporting beyond a trusted boundary mounts its own waterfall listener. Provider API keys are structurally absent (they are constructor parameters, never session events). Serialized payloads are clipped at `maxAttributeChars` per attribute (default 32768); the canonical log keeps the full bytes.

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
```

The e2e follows the official repository's REAL-composition pattern (`@deepseek-ai/dsh-app-boot` + `@deepseek-ai/dsh-loader-smoke`): the fixture `cordis.yml` loads the **built** `lib/index.js` — the same file a deployment loads — and assertions run against the wire, not against internals.

When `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` are present, the same e2e command also runs a Cloud round trip and checks the v4 Observations API for root input/output and per-observation user/session correlation. Without keys, that test self-skips.

## Version compatibility

DeepSeek Harness is in developer preview with no compatibility promises; this plugin pins exact `@deepseek-ai/dsh-*` versions.

| dsh-plugin-langfuse | @deepseek-ai/dsh-* |
|---|---|
| 0.1.x | 0.1.0-rc.6 |

## Known limitations and deferred work

- **`feedback/record` → Langfuse score** is deferred; it needs `@langfuse/client` or the public ingestion API (decision 2).
- **Subagent lineage** is not stitched: a forked session's trace tree starts at its inherited boundary; `session.parent_id`/`seed_length` ride the resource attributes but no trace links are created yet.
- **No durable delivery** (decision 4).
- **One backend per context**: running Langfuse *and* the official OTLP-logs backend simultaneously requires a multi-sink evolution of the upstream seam.

## License

[MIT](LICENSE)
