# Tracelog

Node.js APM instrumentation that writes traces to local JSONL files.

Forked from [elastic-apm-node](https://github.com/elastic/apm-agent-nodejs) v4.15.0. All 43 auto-instrumentation modules are preserved (Express, Fastify, Koa, PostgreSQL, MongoDB, Redis, AWS SDK, etc.), but instead of shipping data to an Elastic APM server, everything is written to a `.jsonl` file on disk with automatic file rotation.

## Installation

```
npm install tracelog
```

## Usage

Start tracelog at the very top of your application, before importing anything else:

```js
require('tracelog').start({
  serviceName: 'my-api',
  serviceVersion: '1.0.0',
  logFilePath: '/var/log/myapp/traces.jsonl',
});
```

Or use the auto-start entry point with environment variables:

```bash
TRACELOG_SERVICE_NAME=my-api \
node -r tracelog/start app.js
```

That's it. Tracelog will automatically instrument your HTTP servers, database clients, and other modules, writing transaction, span, error, and metric data to the JSONL file.

## Output format

Each line is a self-contained JSON object. Files start with a metadata line:

```jsonl
{"metadata":{"service":{"name":"my-api","version":"1.0.0"},"process":{"pid":1234},"system":{"hostname":"ip-10-0-1-42"},"cloud":{"provider":"aws","instance":{"id":"i-0abc123"},"availability_zone":"us-east-1a"}}}
{"transaction":{"id":"abc123","trace_id":"def456","name":"GET /users","type":"request","duration":42.5,"result":"HTTP 2xx"}}
{"span":{"id":"ghi789","transaction_id":"abc123","name":"SELECT * FROM users","type":"db","subtype":"postgresql","duration":12.3}}
{"error":{"message":"Something broke","exception":{"type":"TypeError","stacktrace":[...]}}}
```

## Configuration

All options can be set via `require('tracelog').start({...})` or via environment variables.

### Output

| Option | Env Var | Default | Description |
|--------|---------|---------|-------------|
| `logFilePath` | — | `./tracelog.jsonl` | Path to the JSONL output file |
| `logMaxFileSize` | — | `104857600` (100MB) | Rotate when file exceeds this size in bytes |
| `logMaxFiles` | — | `10` | Number of rotated files to keep |
| `logFlushIntervalMs` | — | `1000` | How often to flush the write buffer (ms) |

### Service identity

| Option | Env Var | Default | Description |
|--------|---------|---------|-------------|
| `serviceName` | `TRACELOG_SERVICE_NAME` | from package.json | Name of your service |
| `serviceVersion` | `TRACELOG_SERVICE_VERSION` | from package.json | Version of your service |
| `serviceNodeName` | `TRACELOG_SERVICE_NODE_NAME` | — | Unique name for this service node/instance |
| `environment` | `TRACELOG_ENVIRONMENT` | `NODE_ENV` or `development` | Deployment environment (e.g. `production`, `staging`) |
| `frameworkName` | `TRACELOG_FRAMEWORK_NAME` | auto-detected | Name of the web framework |
| `frameworkVersion` | `TRACELOG_FRAMEWORK_VERSION` | auto-detected | Version of the web framework |
| `hostname` | `TRACELOG_HOSTNAME` | `os.hostname()` | Override the reported hostname |
| `globalLabels` | `TRACELOG_GLOBAL_LABELS` | — | Key-value pairs added to all events (e.g. `region=us-east-1,team=backend`) |

### Instrumentation

| Option | Env Var | Default | Description |
|--------|---------|---------|-------------|
| `active` | `TRACELOG_ACTIVE` | `true` | Enable/disable the agent entirely |
| `instrument` | `TRACELOG_INSTRUMENT` | `true` | Enable/disable auto-instrumentation of modules |
| `instrumentIncomingHTTPRequests` | `TRACELOG_INSTRUMENT_INCOMING_HTTP_REQUESTS` | `true` | Auto-create transactions for incoming HTTP requests |
| `disableInstrumentations` | `TRACELOG_DISABLE_INSTRUMENTATIONS` | `[]` | Comma-separated list of modules to skip (e.g. `express,pg`) |
| `addPatch` | `TRACELOG_ADD_PATCH` | — | Add custom instrumentation patches (`module=path` pairs) |
| `ignoreUrls` | — | — | Array of URL path patterns to ignore |
| `transactionIgnoreUrls` | `TRACELOG_TRANSACTION_IGNORE_URLS` | `[]` | Comma-separated URL patterns to ignore |
| `ignoreUserAgents` | — | — | Array of user-agent patterns to ignore |
| `ignoreMessageQueues` | `TRACELOG_IGNORE_MESSAGE_QUEUES` | `[]` | Message queue names to ignore |
| `usePathAsTransactionName` | `TRACELOG_USE_PATH_AS_TRANSACTION_NAME` | `false` | Use raw URL path as transaction name (instead of route pattern) |

### Sampling & limits

| Option | Env Var | Default | Description |
|--------|---------|---------|-------------|
| `transactionSampleRate` | `TRACELOG_TRANSACTION_SAMPLE_RATE` | `1.0` | Fraction of transactions to sample (0.0 to 1.0) |
| `transactionMaxSpans` | `TRACELOG_TRANSACTION_MAX_SPANS` | `500` | Max spans per transaction (-1 for unlimited) |
| `exitSpanMinDuration` | `TRACELOG_EXIT_SPAN_MIN_DURATION` | `0ms` | Minimum duration for exit spans; shorter ones are dropped |
| `longFieldMaxLength` | `TRACELOG_LONG_FIELD_MAX_LENGTH` | `10000` | Max length for long string fields (e.g. SQL statements) |

### Error capture

| Option | Env Var | Default | Description |
|--------|---------|---------|-------------|
| `captureExceptions` | `TRACELOG_CAPTURE_EXCEPTIONS` | `true` | Auto-capture uncaught exceptions |
| `captureErrorLogStackTraces` | `TRACELOG_CAPTURE_ERROR_LOG_STACK_TRACES` | `messages` | When to capture stack traces for logged errors: `messages` or `always` |
| `errorOnAbortedRequests` | `TRACELOG_ERROR_ON_ABORTED_REQUESTS` | `false` | Capture errors for aborted HTTP requests |
| `abortedErrorThreshold` | `TRACELOG_ABORTED_ERROR_THRESHOLD` | `25s` | Min request duration before an abort is considered an error |

### Request capture

| Option | Env Var | Default | Description |
|--------|---------|---------|-------------|
| `captureBody` | `TRACELOG_CAPTURE_BODY` | `off` | Capture HTTP request body: `off`, `all`, `errors`, `transactions` |
| `captureHeaders` | `TRACELOG_CAPTURE_HEADERS` | `true` | Capture HTTP request/response headers |
| `sanitizeFieldNames` | `TRACELOG_SANITIZE_FIELD_NAMES` | `[password, secret, *token*, *session*, *cookie*, ...]` | Patterns for header/body fields to redact |

### Stack traces

| Option | Env Var | Default | Description |
|--------|---------|---------|-------------|
| `stackTraceLimit` | `TRACELOG_STACK_TRACE_LIMIT` | `50` | Max stack frames to capture |
| `spanStackTraceMinDuration` | `TRACELOG_SPAN_STACK_TRACE_MIN_DURATION` | — | Min span duration to capture a stack trace (e.g. `5ms`). Set `-1ms` to always capture. |
| `sourceLinesErrorAppFrames` | `TRACELOG_SOURCE_LINES_ERROR_APP_FRAMES` | `5` | Lines of source context for app frames in errors |
| `sourceLinesErrorLibraryFrames` | `TRACELOG_SOURCE_LINES_ERROR_LIBRARY_FRAMES` | `5` | Lines of source context for library frames in errors |
| `sourceLinesSpanAppFrames` | `TRACELOG_SOURCE_LINES_SPAN_APP_FRAMES` | `0` | Lines of source context for app frames in spans |
| `sourceLinesSpanLibraryFrames` | `TRACELOG_SOURCE_LINES_SPAN_LIBRARY_FRAMES` | `0` | Lines of source context for library frames in spans |

### Span compression

| Option | Env Var | Default | Description |
|--------|---------|---------|-------------|
| `spanCompressionEnabled` | `TRACELOG_SPAN_COMPRESSION_ENABLED` | `true` | Compress consecutive similar spans into one |
| `spanCompressionExactMatchMaxDuration` | `TRACELOG_SPAN_COMPRESSION_EXACT_MATCH_MAX_DURATION` | `50ms` | Max duration for exact-match compression |
| `spanCompressionSameKindMaxDuration` | `TRACELOG_SPAN_COMPRESSION_SAME_KIND_MAX_DURATION` | `0ms` | Max duration for same-kind compression (0 = disabled) |

### Distributed tracing

| Option | Env Var | Default | Description |
|--------|---------|---------|-------------|
| `traceContinuationStrategy` | `TRACELOG_TRACE_CONTINUATION_STRATEGY` | `continue` | How to handle incoming trace context: `continue`, `restart`, `external` |

### Metrics

| Option | Env Var | Default | Description |
|--------|---------|---------|-------------|
| `metricsInterval` | `TRACELOG_METRICS_INTERVAL` | `30s` | How often to collect and write metrics (0 to disable) |
| `metricsLimit` | `TRACELOG_METRICS_LIMIT` | `1000` | Max unique metric sets per collection |
| `breakdownMetrics` | `TRACELOG_BREAKDOWN_METRICS` | `true` | Collect transaction breakdown timing metrics |
| `disableMetrics` | `TRACELOG_DISABLE_METRICS` | `[]` | Metric name patterns to disable |

### Cloud & infrastructure

| Option | Env Var | Default | Description |
|--------|---------|---------|-------------|
| `cloudProvider` | `TRACELOG_CLOUD_PROVIDER` | `auto` | Cloud metadata detection: `auto`, `aws`, `gcp`, `azure`, `none` |
| `containerId` | `TRACELOG_CONTAINER_ID` | auto-detected | Override container ID |
| `kubernetesNodeName` | `KUBERNETES_NODE_NAME` | — | Kubernetes node name |
| `kubernetesNamespace` | `KUBERNETES_NAMESPACE` | — | Kubernetes namespace |
| `kubernetesPodName` | `KUBERNETES_POD_NAME` | — | Kubernetes pod name |
| `kubernetesPodUID` | `KUBERNETES_POD_UID` | — | Kubernetes pod UID |

### Logging

| Option | Env Var | Default | Description |
|--------|---------|---------|-------------|
| `logLevel` | `TRACELOG_LOG_LEVEL` | `info` | Agent log level: `trace`, `debug`, `info`, `warning`, `error`, `critical`, `off` |
| `logger` | `TRACELOG_LOGGER` | built-in pino | Custom logger instance (must be pino-compatible). Set env var to `false` to disable. |

### Advanced

| Option | Env Var | Default | Description |
|--------|---------|---------|-------------|
| `contextManager` | `TRACELOG_CONTEXT_MANAGER` | auto | Async context tracking: `asynclocalstorage` or `asynchooks` |
| `contextPropagationOnly` | `TRACELOG_CONTEXT_PROPAGATION_ONLY` | `false` | Only propagate trace context, don't record anything |
| `configFile` | `TRACELOG_CONFIG_FILE` | `tracelog.config.js` | Path to a config file (JS module exporting an options object) |

## Auto-instrumented modules

Express, Fastify, Koa, Hapi, Connect, Restify, HTTP/HTTPS, fetch/undici, PostgreSQL, MySQL, MongoDB, Redis, Elasticsearch, Cassandra, Memcached, AWS SDK (v2 & v3), GraphQL, Apollo Server, Kafka, WebSockets, generic-pool, Knex, Tedious (MSSQL), Handlebars, Pug, and more.

## License

[BSD-2-Clause](LICENSE) — forked from Elastic APM Node.js Agent.
