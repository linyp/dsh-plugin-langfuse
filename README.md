# dsh-plugin-langfuse

English | [中文](README.zh.md)

[Langfuse](https://langfuse.com) observability for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`): exports each agent session as an OpenTelemetry trace tree — turn → trace, model step → generation, tool call → tool span, with GenAI semantic-convention and `langfuse.*` attributes — to Langfuse's OTLP endpoint.

This is a community plugin (`dsh-plugin` topic), not part of the official repository. It implements the harness's public telemetry seam (`@deepseek-ai/dsh-session-telemetry`) as an alternative backend to the official OTLP-logs exporter.

## Install

As a profile bundle (the package ships a `cordis.patch.yml` patch layer):

```sh
dsh plugin --profile web add dsh-plugin-langfuse
export LANGFUSE_PUBLIC_KEY=pk-lf-…
export LANGFUSE_SECRET_KEY=sk-lf-…
# optional, defaults to https://cloud.langfuse.com
export LANGFUSE_HOST=https://us.cloud.langfuse.com
```

The bundled patch disables the base profile's `session-telemetry-otel` row (the telemetry seam accepts exactly one backend per context; a duplicate load throws) and mounts this backend in `FULL` mode when a Langfuse key is present, `DISABLED` otherwise. `LANGFUSE_TELEMETRY_MODE=FEEDBACK_ONLY` narrows sharing to feedback-gated release.

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
| `exporter` | The complete `OTLPExporterNodeConfigBase` object, passed verbatim to the OTLP/HTTP trace exporter. `url` is required outside `DISABLED` and must be the **full traces path** (`…/api/public/otel/v1/traces`). |
| `auth` | Langfuse project key pair, turned into the endpoint's Basic-auth header. Mutually exclusive with an explicit `exporter.headers` authorization; uploading modes require exactly one of the two. |
| `processor` | Passed verbatim to `BatchSpanProcessor` (`scheduledDelayMillis`, `maxQueueSize`, `maxExportBatchSize`, …); batching, retry, and loss policy are the SDK's documented behavior. |
| `shutdownTimeoutMillis` | Plugin-owned outer deadline on the SDK's shutdown drain (default 3000). |

Misconfiguration fails loud at plugin load: a missing/malformed/non-http(s) `url`, missing credentials, ambiguous double auth, a non-positive `maxExportBatchSize` (the SDK would hang on shutdown), or an unknown `mode` all throw before any transport is constructed.

## What appears in Langfuse

| dsh session event | Langfuse concept |
|---|---|
| session (`session.id`) | session (`langfuse.session.id` on every trace) |
| `turn/start` / `turn/end` | trace (root span; error end reasons set span status ERROR) |
| `step/start` / `step/end` + `request/header` + `assistant/message` | **generation** — model, provider, output, `gen_ai.usage.*` tokens (input/output/cache-read/reasoning) |
| first `assistant/chunk` of a step | `langfuse.observation.completion_start_time` (time-to-first-token) |
| `tool/call` + `tool/result` | tool span (arguments as input, result as output, `isError` → status ERROR) |
| `user/message` | trace input |
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
- **Tool spans are children of the turn, not the generation**: tool execution happens after the model stream that requested it has completed, so nesting them under the step span would fabricate a containment that does not exist in time.
- **Unknown event types land as span events on the open turn** — the event vocabulary is merge-extensible, and dropping unknown types would silently thin the timeline.
- **Force-end sweeps** close still-open spans (marked `dsh.force_ended`) on a next `turn/start` with an open predecessor, on the session's ops `shutdown` record, and on backend shutdown — teardown never abandons started spans inside the SDK queue.

### 4. Delivery semantics: at-most-once handoff, duplicates possible

Inherited from the seam: the cursor marks *handed off*, not delivered; whatever sits in the SDK batch queue at crash time is lost, and a cursor-less re-adoption (hot reload) may re-hand a prefix, producing duplicate spans. Receivers correlate on `langfuse.session.id` + `dsh.turn` + `dsh.event.seq`. A durable outbox is deliberately out of scope, matching the seam's own stance.

### 5. What leaves the machine

In uploading modes, span attributes carry user and assistant message content, tool arguments and results, and model/usage metadata, as returned by the `session-telemetry/record` waterfall. **This plugin ships no redaction rules**; a deployment exporting beyond a trusted boundary mounts its own waterfall listener. Provider API keys are structurally absent (they are constructor parameters, never session events). Serialized payloads are clipped at 32 KiB per attribute; the canonical log keeps the full bytes.

## Testing

```sh
npm test                       # unit: folding projection + config fail-loud paths
npm run build && npm run test:e2e   # REAL composition: boots a real dsh app via the
                               # Loader (mock model, real bash round trip) and asserts
                               # the OTLP payload a mock Langfuse collector received
```

The e2e follows the official repository's REAL-composition pattern (`@deepseek-ai/dsh-app-boot` + `@deepseek-ai/dsh-loader-smoke`): the fixture `cordis.yml` loads the **built** `lib/index.js` — the same file a deployment loads — and assertions run against the wire, not against internals.

## Version compatibility

DeepSeek Harness is in developer preview with no compatibility promises; this plugin pins exact `@deepseek-ai/dsh-*` versions.

| dsh-plugin-langfuse | @deepseek-ai/dsh-* |
|---|---|
| 0.1.x | 0.1.0-rc.6 |

## Known limitations and deferred work

- **`feedback/record` → Langfuse score** is deferred; it needs `@langfuse/client` or the public ingestion API (decision 2).
- **Subagent lineage** is not stitched: a forked session's trace tree starts at its inherited boundary; `session.parent_id`/`seed_length` ride the resource attributes but no trace links are created yet.
- **No durable delivery** (decision 4).
- **Attribute clip budget is fixed** at 32 KiB; promote to config when a deployment needs a different budget.
- **One backend per context**: running Langfuse *and* the official OTLP-logs backend simultaneously requires a multi-sink evolution of the upstream seam.

## License

[MIT](LICENSE)
