# Tracelog Configuration Reference

All options can be set via `require('tracelog').start({...})`, via environment variables, or in a `tracelog.config.js` file.

---

## Output & rotation

| Option | Env Var | Default | Description |
|--------|---------|---------|-------------|
| `logDir` | `TRACELOG_LOG_DIR` | `.` (cwd) | Directory for JSONL output files (see [File naming](#file-naming)) |
| `logFilePrefix` | `TRACELOG_LOG_FILE_PREFIX` | `tracelog` | Filename prefix (files are named `{prefix}-{date}.jsonl`) |
| `logMaxFileSize` | — | `104857600` (100MB) | Rotate when file exceeds this size in bytes |
| `logFlushIntervalMs` | — | `1000` | How often to flush the write buffer (ms) |
| `logRotationSchedule` | `TRACELOG_LOG_ROTATION_SCHEDULE` | `daily` | Time-based rotation: `daily`, `hourly` |
| `maxLocalRetentionDays` | `TRACELOG_MAX_LOCAL_RETENTION_DAYS` | `0` (disabled) | Auto-delete local log files older than N days on rotation. `0` disables cleanup. |
| `maxBufferSize` | `TRACELOG_MAX_BUFFER_SIZE` | `10000` | Max events buffered in memory before dropping oldest. Prevents unbounded memory growth. |

### File naming

Files are named with a timestamp derived from the rotation schedule:

```
tracelog-2026-03-06.jsonl           # daily rotation
tracelog-2026-03-06T14.jsonl        # hourly rotation
```

If a size-based rotation occurs within the same time period, a dot-numbered suffix is appended:

```
tracelog-2026-03-06.jsonl           # first file of the day
tracelog-2026-03-06.1.jsonl         # size rotation within same day
tracelog-2026-03-06.2.jsonl         # another size rotation
```

Every file starts with a `metadata` line as its first record.

## S3 upload

Set `s3Bucket` to enable automatic upload of log files to S3. Completed (rotated) files are gzipped before upload and deleted locally after a successful upload. The current (incomplete) file is uploaded as-is on a timer and on process exit.

| Option | Env Var | Default | Description |
|--------|---------|---------|-------------|
| `s3Bucket` | `TRACELOG_S3_BUCKET` | — | S3 bucket name. If not set, S3 upload is disabled. |
| `s3Region` | `TRACELOG_S3_REGION` | from AWS env | AWS region |
| `s3KeyTemplate` | `TRACELOG_S3_KEY_TEMPLATE` | `{serviceName}/{environment}/{date}/{hostname}-{pid}-{timestamp}.jsonl` | S3 key with variable substitution |
| `s3UploadIntervalMs` | `TRACELOG_S3_UPLOAD_INTERVAL_MS` | `300000` (5 min) | How often to upload the current (incomplete) file |
| `s3GzipCompleted` | `TRACELOG_S3_GZIP_COMPLETED` | `true` | Gzip completed (rotated) files before uploading to S3 |
| `s3GzipCurrent` | `TRACELOG_S3_GZIP_CURRENT` | `true` | Gzip the current (incomplete) file before uploading to S3 |
| `s3AccessKeyId` | `TRACELOG_S3_ACCESS_KEY_ID` | from AWS credential chain | AWS access key ID |
| `s3SecretAccessKey` | `TRACELOG_S3_SECRET_ACCESS_KEY` | from AWS credential chain | AWS secret access key |
| `s3SessionToken` | `TRACELOG_S3_SESSION_TOKEN` | — | AWS session token (for temporary credentials) |

### S3 key template variables

| Variable | Example | Description |
|----------|---------|-------------|
| `{serviceName}` | `my-api` | Service name |
| `{environment}` | `production` | Environment |
| `{hostname}` | `ip-10-0-1-42` | System hostname |
| `{pid}` | `12345` | Process ID |
| `{date}` | `2026-03-06` | Date (YYYY-MM-DD) |
| `{year}` | `2026` | Year |
| `{month}` | `03` | Month (zero-padded) |
| `{day}` | `06` | Day (zero-padded) |
| `{hour}` | `14` | Hour (zero-padded, 24h) |
| `{minute}` | `30` | Minute (zero-padded) |
| `{timestamp}` | `1709740800` | Unix timestamp (seconds) |
| `{filename}` | `tracelog-2026-03-06.jsonl` | Local filename |

Completed files automatically get `.gz` appended to the key.

## Service identity

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

## Instrumentation

| Option | Env Var | Default | Description |
|--------|---------|---------|-------------|
| `active` | `TRACELOG_ACTIVE` | `true` | Enable/disable the agent entirely |
| `instrument` | `TRACELOG_INSTRUMENT` | `true` | Enable/disable auto-instrumentation of modules |
| `instrumentIncomingHTTPRequests` | `TRACELOG_INSTRUMENT_INCOMING_HTTP_REQUESTS` | `true` | Auto-create transactions for incoming HTTP requests |
| `disableInstrumentations` | `TRACELOG_DISABLE_INSTRUMENTATIONS` | `[]` | Comma-separated list of modules to skip (e.g. `express,pg`) |
| `addPatch` | `TRACELOG_ADD_PATCH` | — | Add custom instrumentation patches (`module=path` pairs) |
| `ignoreUrls` | — | — | Array of URL path patterns to ignore |
| `transactionIgnoreUrls` | `TRACELOG_TRANSACTION_IGNORE_URLS` | `[]` | Comma-separated URL patterns to ignore |
| `transactionChannels` | — | `[]` | Route transactions to named channels by transaction-name pattern (see below) |
| `ignoreUserAgents` | — | — | Array of user-agent patterns to ignore |
| `ignoreMessageQueues` | `TRACELOG_IGNORE_MESSAGE_QUEUES` | `[]` | Message queue names to ignore |
| `usePathAsTransactionName` | `TRACELOG_USE_PATH_AS_TRANSACTION_NAME` | `false` | Use raw URL path as transaction name (instead of route pattern) |

### Transaction channel routing

`transactionChannels` takes an array of `{ pattern, channel }` rules. The
`pattern` is a wildcard expression (same syntax as `transactionIgnoreUrls`)
matched against the transaction *name*; the first matching rule wins. A
matching transaction — along with its spans and its breakdown metricsets —
is written to the named channel's JSONL file instead of the default channel.

```js
apm.start({
  // Keep internet-scanner noise out of the default channel, but retain it.
  transactionChannels: [
    { pattern: '* unknown route*', channel: 'unknown-route' },
  ],
});
```

Spans follow their transaction's channel only when the transaction already
has a *resolved* name (set via `startTransaction(name)`,
`transaction.name = ...`, or a framework default) by the time the span
ends. HTTP-framework transactions (e.g. Express) are typically named when
the request finishes — after their spans have ended — so their spans stay
on the default channel. Transaction payloads and breakdown metricsets are
unaffected: both are produced after the name is final and always follow
the rules.

## Sampling & limits

| Option | Env Var | Default | Description |
|--------|---------|---------|-------------|
| `transactionSampleRate` | `TRACELOG_TRANSACTION_SAMPLE_RATE` | `1.0` | Fraction of transactions to sample (0.0 to 1.0) |
| `transactionMaxSpans` | `TRACELOG_TRANSACTION_MAX_SPANS` | `500` | Max spans per transaction (-1 for unlimited) |
| `exitSpanMinDuration` | `TRACELOG_EXIT_SPAN_MIN_DURATION` | `0ms` | Minimum duration for exit spans; shorter ones are dropped |
| `longFieldMaxLength` | `TRACELOG_LONG_FIELD_MAX_LENGTH` | `10000` | Max length for long string fields (e.g. SQL statements) |

## Error capture

| Option | Env Var | Default | Description |
|--------|---------|---------|-------------|
| `captureExceptions` | `TRACELOG_CAPTURE_EXCEPTIONS` | `true` | Auto-capture uncaught exceptions |
| `captureErrorLogStackTraces` | `TRACELOG_CAPTURE_ERROR_LOG_STACK_TRACES` | `messages` | When to capture stack traces for logged errors: `messages` or `always` |
| `errorOnAbortedRequests` | `TRACELOG_ERROR_ON_ABORTED_REQUESTS` | `false` | Capture errors for aborted HTTP requests |
| `abortedErrorThreshold` | `TRACELOG_ABORTED_ERROR_THRESHOLD` | `25s` | Min request duration before an abort is considered an error |

## Request capture

| Option | Env Var | Default | Description |
|--------|---------|---------|-------------|
| `captureBody` | `TRACELOG_CAPTURE_BODY` | `off` | Capture HTTP request body: `off`, `all`, `errors`, `transactions` |
| `captureHeaders` | `TRACELOG_CAPTURE_HEADERS` | `true` | Capture HTTP request/response headers |
| `sanitizeFieldNames` | `TRACELOG_SANITIZE_FIELD_NAMES` | `[password, secret, *token*, *session*, *cookie*, ...]` | Patterns for header/body fields to redact |

## Stack traces

| Option | Env Var | Default | Description |
|--------|---------|---------|-------------|
| `stackTraceLimit` | `TRACELOG_STACK_TRACE_LIMIT` | `50` | Max stack frames to capture |
| `spanStackTraceMinDuration` | `TRACELOG_SPAN_STACK_TRACE_MIN_DURATION` | — | Min span duration to capture a stack trace (e.g. `5ms`). Set `-1ms` to always capture. |
| `sourceLinesErrorAppFrames` | `TRACELOG_SOURCE_LINES_ERROR_APP_FRAMES` | `5` | Lines of source context for app frames in errors |
| `sourceLinesErrorLibraryFrames` | `TRACELOG_SOURCE_LINES_ERROR_LIBRARY_FRAMES` | `5` | Lines of source context for library frames in errors |
| `sourceLinesSpanAppFrames` | `TRACELOG_SOURCE_LINES_SPAN_APP_FRAMES` | `0` | Lines of source context for app frames in spans |
| `sourceLinesSpanLibraryFrames` | `TRACELOG_SOURCE_LINES_SPAN_LIBRARY_FRAMES` | `0` | Lines of source context for library frames in spans |

## Span compression

| Option | Env Var | Default | Description |
|--------|---------|---------|-------------|
| `spanCompressionEnabled` | `TRACELOG_SPAN_COMPRESSION_ENABLED` | `true` | Compress consecutive similar spans into one |
| `spanCompressionExactMatchMaxDuration` | `TRACELOG_SPAN_COMPRESSION_EXACT_MATCH_MAX_DURATION` | `50ms` | Max duration for exact-match compression |
| `spanCompressionSameKindMaxDuration` | `TRACELOG_SPAN_COMPRESSION_SAME_KIND_MAX_DURATION` | `0ms` | Max duration for same-kind compression (0 = disabled) |

## Distributed tracing

| Option | Env Var | Default | Description |
|--------|---------|---------|-------------|
| `traceContinuationStrategy` | `TRACELOG_TRACE_CONTINUATION_STRATEGY` | `continue` | How to handle incoming trace context: `continue`, `restart`, `external` |

## Metrics

| Option | Env Var | Default | Description |
|--------|---------|---------|-------------|
| `metricsInterval` | `TRACELOG_METRICS_INTERVAL` | `30s` | How often to collect and write metrics (0 to disable) |
| `metricsLimit` | `TRACELOG_METRICS_LIMIT` | `1000` | Max unique metric sets per collection |
| `breakdownMetrics` | `TRACELOG_BREAKDOWN_METRICS` | `true` | Collect transaction breakdown timing metrics |
| `disableMetrics` | `TRACELOG_DISABLE_METRICS` | `[]` | Metric name patterns to disable |

## Cloud & infrastructure

| Option | Env Var | Default | Description |
|--------|---------|---------|-------------|
| `cloudProvider` | `TRACELOG_CLOUD_PROVIDER` | `auto` | Cloud metadata detection: `auto`, `aws`, `gcp`, `azure`, `none` |
| `containerId` | `TRACELOG_CONTAINER_ID` | auto-detected | Override container ID |
| `kubernetesNodeName` | `KUBERNETES_NODE_NAME` | — | Kubernetes node name |
| `kubernetesNamespace` | `KUBERNETES_NAMESPACE` | — | Kubernetes namespace |
| `kubernetesPodName` | `KUBERNETES_POD_NAME` | — | Kubernetes pod name |
| `kubernetesPodUID` | `KUBERNETES_POD_UID` | — | Kubernetes pod UID |

## Logging

| Option | Env Var | Default | Description |
|--------|---------|---------|-------------|
| `logLevel` | `TRACELOG_LOG_LEVEL` | `info` | Agent log level: `trace`, `debug`, `info`, `warning`, `error`, `critical`, `off` |
| `logger` | `TRACELOG_LOGGER` | built-in pino | Custom logger instance (must be pino-compatible). Set env var to `false` to disable. |

## Advanced

| Option | Env Var | Default | Description |
|--------|---------|---------|-------------|
| `contextManager` | `TRACELOG_CONTEXT_MANAGER` | auto | Async context tracking: `asynclocalstorage` or `asynchooks` |
| `contextPropagationOnly` | `TRACELOG_CONTEXT_PROPAGATION_ONLY` | `false` | Only propagate trace context, don't record anything |
| `configFile` | `TRACELOG_CONFIG_FILE` | `tracelog.config.js` | Path to a config file (JS module exporting an options object) |
