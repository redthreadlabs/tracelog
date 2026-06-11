# Tracelog JSONL Schema

Each line in a tracelog `.jsonl` file is a self-contained JSON object with exactly one top-level key identifying the event type. There are six event types: `metadata`, `transaction`, `span`, `error`, `metricset`, and `event`.

All `timestamp` fields — on every record kind, with no exceptions — are in
**microseconds** since Unix epoch. All `duration` fields are in
**milliseconds**.

Context/sub-objects with no content are omitted entirely; no record kind
serializes empty `{}` placeholder objects.

All string fields are subject to truncation (see [Truncation](#truncation) at the bottom).

---

## metadata

Written once at the start of each new file. Describes the service, process, system, and (optionally) cloud environment.

```jsonl
{"metadata":{...}}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `service` | object | yes | Service identity |
| `service.name` | string | yes | Service name |
| `service.version` | string | no | Service version |
| `service.environment` | string | no | Deployment environment (e.g. `production`) |
| `service.node` | object | no | Service node info (when `serviceNodeName` is configured) |
| `service.node.configured_name` | string | no | The configured node name |
| `service.agent` | object | yes | Agent info |
| `service.agent.name` | string | yes | Always `"tracelog"` |
| `service.agent.version` | string | yes | Tracelog package version |
| `process` | object | yes | Process info |
| `process.pid` | integer | yes | Process ID |
| `process.title` | string | yes | Process title (`process.title`) |
| `process.argv` | string[] | yes | Process arguments |
| `system` | object | yes | Host system info |
| `system.hostname` | string | yes | Hostname, normalized the same way as the host in S3 keys (EC2-internal names become the dotted IP) |
| `system.architecture` | string | yes | CPU architecture (e.g. `x64`, `arm64`) |
| `system.platform` | string | yes | OS platform (e.g. `linux`, `darwin`) |
| `labels` | object | no | Global labels from `globalLabels` config. Arbitrary key-value pairs. |
| `cloud` | object | no | Cloud infrastructure metadata (only if `cloudProvider` is not `none`) |
| `cloud.provider` | string | yes | `aws`, `gcp`, or `azure` |
| `cloud.account.id` | string | no | Cloud account ID |
| `cloud.account.name` | string | no | Account name (GCP/Azure) |
| `cloud.instance.id` | string | no | Instance ID |
| `cloud.instance.name` | string | no | Instance name |
| `cloud.machine.type` | string | no | Machine/instance type |
| `cloud.project.id` | string | no | Project ID (GCP) |
| `cloud.project.name` | string | no | Project name (GCP/Azure) |
| `cloud.availability_zone` | string | no | Availability zone |
| `cloud.region` | string | no | Region |

---

## transaction

Represents a top-level unit of work (e.g. an incoming HTTP request, a background job).

```jsonl
{"transaction":{...}}
```

### Core fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | 16-char hex ID |
| `trace_id` | string | yes | 32-char hex trace ID |
| `parent_id` | string | no | Parent span/transaction ID (if this is a child) |
| `name` | string | yes | Transaction name (e.g. `GET /users/:id`) |
| `type` | string | yes | Transaction type (e.g. `request`, `custom`) |
| `duration` | number | yes | Duration in milliseconds |
| `timestamp` | integer | yes | Start time in microseconds since epoch |
| `result` | string | yes | Result string (e.g. `HTTP 2xx`, `success`) |
| `sampled` | boolean | yes | Whether full details were captured |
| `outcome` | string | yes | `success`, `failure`, or `unknown`. HTTP transactions derive it from the status code; manually ended transactions derive it from a result of `success`/`failure`/`error` explicitly passed to `end()`, unless `setOutcome()` was called. |
| `sample_rate` | number | no | Sampling rate [0.0 .. 1.0]. Omitted if not available from tracestate. |

### Span count

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `span_count.started` | integer | yes | Number of spans created |
| `span_count.dropped` | integer | no | Number of spans dropped (only present if > 0) |

### Context (only present when `sampled` is `true`)

Context members with no content are omitted; `context` itself is omitted
when every member is empty.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `context.request` | object | no | HTTP request details (see [HTTP Request](#http-request)) |
| `context.response` | object | no | HTTP response details (see [HTTP Response](#http-response)) |
| `context.user` | object | no | User identity (see [User](#user)) |
| `context.tags` | object | no | User-defined labels (string/number/boolean values) |
| `context.custom` | object | no | Arbitrary custom context data |
| `context.service` | object | no | Service context overrides |
| `context.cloud` | object | no | Cloud context (e.g. cloud origin for incoming requests) |
| `context.message` | object | no | Message queue context (see [Message](#message)) |

### Optional top-level fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `faas` | object | no | Function-as-a-Service fields |
| `faas.coldstart` | boolean | no | Whether this was a cold start |
| `faas.id` | string | no | Function ID |
| `faas.name` | string | no | Function name |
| `faas.execution` | string | no | Execution/request ID |
| `faas.version` | string | no | Function version |
| `faas.trigger.type` | string | no | Trigger type |
| `faas.trigger.request_id` | string | no | Trigger request ID |
| `dropped_spans_stats` | array | no | Aggregate stats for dropped spans (see below) |
| `links` | array | no | Trace links (see [Links](#links)) |
| `otel` | object | no | OpenTelemetry attributes (see [OTel](#otel)) |

### dropped_spans_stats (array items)

Only present on transactions that dropped spans due to `transactionMaxSpans`.

| Field | Type | Description |
|-------|------|-------------|
| `destination_service_resource` | string | Destination service resource |
| `service_target_type` | string | Target service type |
| `service_target_name` | string | Target service name |
| `outcome` | string | `success`, `failure`, or `unknown` |
| `duration.count` | integer | Number of dropped spans |
| `duration.sum.us` | integer | Total duration in microseconds |

---

## span

Represents a unit of work within a transaction (e.g. a database query, an outgoing HTTP call).

```jsonl
{"span":{...}}
```

### Core fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | 16-char hex span ID |
| `trace_id` | string | yes | 32-char hex trace ID |
| `transaction_id` | string | yes | Parent transaction ID |
| `parent_id` | string | yes | Immediate parent span or transaction ID |
| `name` | string | yes | Span name (e.g. `SELECT FROM users`, `GET example.com`) |
| `type` | string | yes | Span type (e.g. `db`, `external`, `cache`, `template`, `custom`) |
| `subtype` | string | no | Subtype (e.g. `postgresql`, `http`, `redis`, `elasticsearch`) |
| `action` | string | no | Action (e.g. `query`, `connect`, `exec`) |
| `duration` | number | yes | Duration in milliseconds |
| `timestamp` | integer | yes | Start time in microseconds since epoch |
| `sync` | boolean | yes | Whether the span executed synchronously |
| `outcome` | string | yes | `success`, `failure`, or `unknown` |
| `sample_rate` | number | no | Sampling rate [0.0 .. 1.0] |

### Context (optional)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `context.db` | object | no | Database context |
| `context.db.type` | string | no | Database type (e.g. `sql`, `redis`, `mongodb`) |
| `context.db.instance` | string | no | Database name |
| `context.db.statement` | string | no | Query/statement text |
| `context.db.rows_affected` | integer | no | Number of affected rows |
| `context.http` | object | no | HTTP client context |
| `context.http.url` | string | no | Target URL |
| `context.http.status_code` | integer | no | Response status code |
| `context.http.method` | string | no | HTTP method |
| `context.http.response` | object | no | Response details (status_code, headers, etc.) |
| `context.destination` | object | no | Destination details |
| `context.destination.address` | string | no | IP or hostname |
| `context.destination.port` | integer | no | Port number |
| `context.destination.service.type` | string | no | Destination service type |
| `context.destination.service.name` | string | no | Destination service name |
| `context.destination.service.resource` | string | no | Destination service resource |
| `context.service.target` | object | no | Service target |
| `context.service.target.type` | string | no | Target type (e.g. `postgresql`, `redis`) |
| `context.service.target.name` | string | no | Target name (e.g. database name) |
| `context.message` | object | no | Message queue context (see [Message](#message)) |
| `context.tags` | object | no | User-defined labels |

### Stack trace (optional)

Present only if `spanStackTraceMinDuration` is configured and the span's duration exceeds it.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `stacktrace` | array | no | Array of stack frames |
| `stacktrace[].filename` | string | yes | Relative file path |
| `stacktrace[].abs_path` | string | yes | Absolute file path |
| `stacktrace[].function` | string | yes | Function name |
| `stacktrace[].lineno` | integer | yes | Line number |
| `stacktrace[].library_frame` | boolean | yes | `true` if from node_modules or Node.js core |
| `stacktrace[].pre_context` | string[] | no | Lines before the context line (if source context enabled) |
| `stacktrace[].context_line` | string | no | The source line itself |
| `stacktrace[].post_context` | string[] | no | Lines after the context line |

### Composite span (optional)

Present only on compressed/composite spans (when `spanCompressionEnabled` is `true` and consecutive similar spans were merged).

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `composite.compression_strategy` | string | yes | `exact_match` or `same_kind` |
| `composite.count` | integer | yes | Number of compressed spans (>= 2) |
| `composite.sum` | number | yes | Total duration in milliseconds |

### Other optional fields

| Field | Type | Description |
|-------|------|-------------|
| `links` | array | Trace links (see [Links](#links)) |
| `otel` | object | OpenTelemetry attributes (see [OTel](#otel)) |

---

## error

Represents a captured exception or log error message.

```jsonl
{"error":{...}}
```

### Core fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | 16-char hex error ID |
| `timestamp` | integer | yes | Capture time in microseconds since epoch |
| `trace_id` | string | no | Associated trace ID |
| `parent_id` | string | no | Associated span/transaction ID |
| `transaction_id` | string | no | Associated transaction ID |
| `culprit` | string | no | File/function where the error originated |

### Transaction info (optional)

Present when the error occurred within a transaction.

| Field | Type | Description |
|-------|------|-------------|
| `transaction.name` | string | Transaction name |
| `transaction.type` | string | Transaction type |
| `transaction.sampled` | boolean | Whether the transaction was sampled |

### Exception (optional)

Present when the error was captured from an `Error` object (e.g. `captureError(new Error(...))`).

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `exception.message` | string | yes | Error message |
| `exception.type` | string | yes | Error class name (e.g. `TypeError`, `RangeError`) |
| `exception.code` | string | no | Error code (e.g. `ECONNREFUSED`, MySQL error codes) |
| `exception.module` | string | no | Module where the error originated |
| `exception.handled` | boolean | yes | Whether the error was handled or uncaught |
| `exception.attributes` | object | no | Additional non-standard properties from the Error object |
| `exception.stacktrace` | array | no | Stack frames (same structure as [span stacktrace](#stack-trace-optional)) |

### Log (optional)

Present when the error was captured from a string message (e.g. `captureError('something broke')`), or as a secondary message alongside an exception.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `log.message` | string | yes | Log message |
| `log.param_message` | string | no | Original message template (before parameter interpolation) |
| `log.level` | string | no | Log level |
| `log.logger_name` | string | no | Logger name |
| `log.stacktrace` | array | no | Stack frames at the call site |

### Context (optional)

Same structure as [transaction context](#context-only-present-when-sampled-is-true): `request`, `response`, `user`, `tags`, `custom`, `service`, `message`, `cloud`.

---

## metricset

Periodic system and runtime metrics, plus breakdown timing metrics for transactions/spans.

```jsonl
{"metricset":{...}}
```

### Core fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `timestamp` | integer | yes | Collection time in microseconds since epoch |
| `tags` | object | no | Dimension labels for this metric set |
| `samples` | object | yes | Metric values (see below) |

### Samples

Each key in `samples` is a metric name. Each value is an object:

| Field | Type | Description |
|-------|------|-------------|
| `value` | number | The metric value (for gauges and counters) |

### Dimension fields (optional)

Breakdown metrics include these additional fields as dimensions (alongside `tags`):

| Field | Type | Description |
|-------|------|-------------|
| `transaction.name` | string | Associated transaction name |
| `transaction.type` | string | Associated transaction type |
| `span.type` | string | Span type (e.g. `db`, `app`, `external`) |
| `span.subtype` | string | Span subtype |

### Built-in metric names

**System metrics** (Linux only):

| Metric | Description |
|--------|-------------|
| `system.cpu.total.norm.pct` | Total system CPU usage (0.0 - 1.0) |
| `system.memory.actual.free` | Available memory in bytes |
| `system.memory.total` | Total memory in bytes |
| `system.process.cpu.total.norm.pct` | Process CPU usage (0.0 - 1.0) |
| `system.process.cpu.system.norm.pct` | Process system CPU usage |
| `system.process.cpu.user.norm.pct` | Process user CPU usage |
| `system.process.memory.size` | Process virtual memory size |
| `system.process.memory.rss.bytes` | Process resident set size |

**System metrics** (non-Linux, e.g. macOS):

| Metric | Description |
|--------|-------------|
| `system.process.cpu.total.norm.pct` | Process CPU usage (0.0 - 1.0) |
| `system.process.cpu.system.norm.pct` | Process system CPU usage |
| `system.process.cpu.user.norm.pct` | Process user CPU usage |

**Node.js runtime metrics** (all platforms):

| Metric | Description |
|--------|-------------|
| `nodejs.handles.active` | Number of active handles |
| `nodejs.requests.active` | Number of active requests |
| `nodejs.eventloop.delay.avg.ms` | Average event loop delay in ms |
| `nodejs.memory.heap.allocated.bytes` | V8 heap total size |
| `nodejs.memory.heap.used.bytes` | V8 heap used size |
| `nodejs.memory.external.bytes` | V8 external memory |
| `nodejs.memory.arrayBuffers.bytes` | ArrayBuffer memory |

**Breakdown metrics** (when `breakdownMetrics` is enabled):

| Metric | Description |
|--------|-------------|
| `span.self_time.count` | Number of spans of this type |
| `span.self_time.sum.us` | Total self-time in microseconds |

These are emitted with `transaction.name`, `transaction.type`, `span.type`, and optionally `span.subtype` as dimensions.

---

## event

A custom event for recording arbitrary application-level occurrences: user analytics, log lines, client-side events from mobile or browser apps, etc.

```jsonl
{"event":{...}}
```

### Core fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | yes | Event category (e.g. `page_view`, `button_click`, `purchase`, `log`) |
| `timestamp` | integer | yes | Time of the event in microseconds since epoch (the `writeEvent` API accepts milliseconds, e.g. `Date.now()`) |
| `duration` | number | no | Duration in milliseconds (e.g. page load time, action duration) |
| `message` | string | no | Human-readable description; doubles as a log line |
| `level` | string | yes | Severity level: `debug`, `info`, `warn`, `error`, `fatal`. Defaults to `info`. |
| `trace_id` | string | no | Trace ID of the transaction that was active when the event was written (single-event writes only; batch writes never stamp trace context) |
| `transaction_id` | string | no | ID of the active transaction (see `trace_id`) |

### Error (optional)

Attached error details, safely extracted from an `Error` instance, a string,
or an error-like plain object (e.g. an error that crossed a process boundary
as `{message, code}`).

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `error.message` | string | yes | Error message. For message-less objects, a bounded JSON representation. |
| `error.type` | string | no | Error class name (`err.name`) or `type` field |
| `error.code` | string | no | Error code (`err.code`), stringified |
| `error.stack` | string | no | Stack trace when present |

### User (optional)

Identity of the end-user who triggered the event.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `user.id` | string | no | Unique user identifier |
| `user.email` | string | no | User email address |
| `user.username` | string | no | Display name or username |

### Client (optional)

Describes the client environment where the event originated (e.g. a mobile app, browser).

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `client.name` | string | no | App/client name (e.g. `duiduidui-ios`, `duiduidui-web`) |
| `client.version` | string | no | App version |
| `client.os.name` | string | no | OS name (e.g. `iOS`, `Android`, `Windows`) |
| `client.os.version` | string | no | OS version |
| `client.device.model` | string | no | Device model (e.g. `iPhone 16 Pro`, `Pixel 9`) |
| `client.device.type` | string | no | Device type (e.g. `phone`, `tablet`, `desktop`) |
| `client.runtime.name` | string | no | Client runtime (e.g. `React Native`, `Chrome`) |
| `client.runtime.version` | string | no | Runtime version |

### Params (optional)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `params` | object | no | Open-ended key-value data specific to this event type |

---

## Shared sub-objects

### HTTP Request

| Field | Type | Description |
|-------|------|-------------|
| `method` | string | HTTP method |
| `http_version` | string | HTTP version |
| `url.protocol` | string | URL scheme (e.g. `https:`) |
| `url.hostname` | string | Hostname |
| `url.port` | string | Port |
| `url.pathname` | string | Path |
| `url.search` | string | Query string |
| `url.hash` | string | Fragment |
| `url.raw` | string | Raw URL |
| `url.full` | string | Full URL |
| `headers` | object | HTTP headers (values are strings) |
| `body` | string/object | Request body (if `captureBody` enabled) |
| `socket.remote_address` | string | Client IP address |
| `cookies` | object | Parsed cookies |

### HTTP Response

| Field | Type | Description |
|-------|------|-------------|
| `status_code` | integer | HTTP status code |
| `headers` | object | Response headers |
| `finished` | boolean | Whether the response finished |
| `headers_sent` | boolean | Whether headers were sent |

### User

| Field | Type | Description |
|-------|------|-------------|
| `id` | string/integer | User ID |
| `email` | string | User email |
| `username` | string | Username |

### Message

| Field | Type | Description |
|-------|------|-------------|
| `queue.name` | string | Queue/topic name |
| `body` | string | Message body |
| `headers` | object | Message headers |
| `age.ms` | integer | Message age in milliseconds |
| `routing_key` | string | Routing key |

### Links

Array of trace links, each with:

| Field | Type | Description |
|-------|------|-------------|
| `trace_id` | string | Linked trace ID |
| `span_id` | string | Linked span ID |

### OTel

| Field | Type | Description |
|-------|------|-------------|
| `span_kind` | string | OpenTelemetry span kind |
| `attributes` | object | OpenTelemetry attributes |

---

## Truncation

All string fields are truncated to prevent unbounded growth:

| Category | Max length | Examples |
|----------|-----------|----------|
| Keyword fields | 1024 chars | `id`, `trace_id`, `name`, `type`, `subtype`, `result`, URL parts, tag values |
| Long fields | Configurable via `longFieldMaxLength` (default: 10000) | `db.statement`, `request.body`, `message.body`, error messages |
| General strings | 1024 chars | All other string fields |

Truncation is Unicode-safe and will not split surrogate pairs.
