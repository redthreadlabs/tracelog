# Tracelog

Node.js APM instrumentation that writes traces to local JSONL files, with automatic rotation and optional S3 upload.

Forked from [elastic-apm-node](https://github.com/elastic/apm-agent-nodejs) v4.15.0. All 43 auto-instrumentation modules are preserved (Express, Fastify, Koa, PostgreSQL, MongoDB, Redis, AWS SDK, etc.), but instead of shipping data to an Elastic APM server, everything is written to timestamped `.jsonl` files on disk with time-based and size-based rotation.

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
  logDir: '/var/log/myapp',
  defaultChannel: 'server',
  s3Bucket: 'my-traces',
  s3Region: 'us-east-1',
});
```

S3 keys follow a fixed layout designed for prefix scans and per-channel
lifecycle rules: `{channel}/{interval}/{host}[_{seq}][_current].jsonl[.gz]`
(see CONFIG.md).

Or use the auto-start entry point with environment variables:

```bash
TRACELOG_SERVICE_NAME=my-api \
node -r tracelog/start app.js
```

That's it. Tracelog will automatically instrument your HTTP servers, database clients, and other modules, writing transaction, span, error, and metric data to the JSONL file. If `s3Bucket` is set, completed (rotated) files are gzipped and uploaded to S3, then deleted locally.

## Custom events

Tracelog adds a custom **event** type that has no equivalent in Elastic APM or OpenTelemetry. Events are free-form records for anything that isn't a trace, error, or metric — user analytics, audit logs, client-side telemetry from mobile or browser apps, or structured log lines.

```js
// Single event
apm.captureEvent('page_view', {
  message: 'User viewed dashboard',
  level: 'info',
  user: { id: 'u-abc123', username: 'jane_doe' },
  client: { name: 'duiduidui-ios', version: '2.4.1' },
  params: { page: '/dashboard', referrer: '/home' },
});
```

Events support standardized fields for user identity (`user`), client environment (`client`), severity (`level`), timing (`duration`), and an open-ended `params` object for anything else. Only `type` is required.

For server endpoints that receive batches of events from client devices, use `captureEvents`:

```js
// Batch — e.g. from a mobile app uploading queued events
app.post('/events', (req, res) => {
  apm.captureEvents(req.body.events, () => res.sendStatus(202));
});
```

Each event in the batch is individually filtered (via `addEventFilter`) and written as a separate JSONL line. See **[SCHEMA.md](SCHEMA.md)** for the full event schema.

## Output format

Each line is a self-contained JSON object with one top-level key identifying the event type. There are six event types: `metadata`, `transaction`, `span`, `error`, `metricset`, and `event`. Files start with a metadata line:

```jsonl
{"metadata":{"service":{"name":"my-api","version":"1.0.0"},"process":{"pid":1234},"system":{"hostname":"ip-10-0-1-42"},"cloud":{"provider":"aws","instance":{"id":"i-0abc123"},"availability_zone":"us-east-1a"}}}
{"transaction":{"id":"abc123","trace_id":"def456","name":"GET /users","type":"request","duration":42.5,"result":"HTTP 2xx","sampled":true,"outcome":"success","span_count":{"started":1}}}
{"span":{"id":"ghi789","transaction_id":"abc123","trace_id":"def456","parent_id":"abc123","name":"SELECT * FROM users","type":"db","subtype":"postgresql","duration":12.3,"sync":true,"outcome":"success"}}
{"error":{"id":"err001","timestamp":1709740800000000,"exception":{"message":"Something broke","type":"TypeError","handled":false,"stacktrace":[...]}}}
{"metricset":{"timestamp":1709740800000000,"samples":{"system.process.cpu.total.norm.pct":{"value":0.023},"nodejs.memory.heap.used.bytes":{"value":52428800}}}}
{"event":{"type":"page_view","timestamp":1719484200000,"message":"User viewed dashboard","level":"info","user":{"id":"u-abc123","username":"jane_doe"},"client":{"name":"duiduidui-ios","version":"2.4.1","os":{"name":"iOS","version":"18.2"},"device":{"model":"iPhone 16 Pro","type":"phone"}},"params":{"page":"/dashboard"}}}
```

For the complete schema of every field in each event type, see **[SCHEMA.md](SCHEMA.md)**.

## Configuration

All options can be set via `require('tracelog').start({...})`, via environment variables, or in a `tracelog.config.js` file.

| Option | Env Var | Default | Description |
|--------|---------|---------|-------------|
| `serviceName` | `TRACELOG_SERVICE_NAME` | from package.json | Name of your service |
| `serviceVersion` | `TRACELOG_SERVICE_VERSION` | from package.json | Version of your service |
| `environment` | `TRACELOG_ENVIRONMENT` | `NODE_ENV` or `development` | Deployment environment |
| `logDir` | `TRACELOG_LOG_DIR` | `.` (cwd) | Directory for JSONL output files |
| `logFilePrefix` | `TRACELOG_LOG_FILE_PREFIX` | `tracelog` | Filename prefix (files are named `{prefix}-{date}.jsonl`) |
| `logMaxFileSize` | — | `104857600` (100MB) | Rotate when file exceeds this size in bytes |
| `logRotationSchedule` | `TRACELOG_LOG_ROTATION_SCHEDULE` | `daily` | Time-based rotation: `daily` or `hourly` |
| `s3Bucket` | `TRACELOG_S3_BUCKET` | — | S3 bucket for log upload (disabled if not set) |
| `active` | `TRACELOG_ACTIVE` | `true` | Enable/disable the agent entirely |
| `logLevel` | `TRACELOG_LOG_LEVEL` | `info` | Agent log level |

For the complete list of all configuration options (instrumentation, sampling, error capture, stack traces, span compression, metrics, S3 upload, cloud, and more), see **[CONFIG.md](CONFIG.md)**.

## Filtering

Filter functions let you modify or drop events before they are written. Return the (possibly modified) object to keep it, or return a falsy value to drop it.

```js
const apm = require('tracelog').start({ serviceName: 'my-api' });

// Drop all debug-level custom events
apm.addEventFilter((event) => {
  return event.level === 'debug' ? false : event;
});

// Redact user emails from custom events
apm.addEventFilter((event) => {
  if (event.user) event.user.email = '[REDACTED]';
  return event;
});
```

Available filter methods: `addFilter(fn)` (adds to all types), `addTransactionFilter(fn)`, `addSpanFilter(fn)`, `addErrorFilter(fn)`, `addEventFilter(fn)`, `addMetadataFilter(fn)`.

## Auto-instrumented modules

Express, Fastify, Koa, Hapi, Connect, Restify, HTTP/HTTPS, fetch/undici, PostgreSQL, MySQL, MongoDB, Redis, Elasticsearch, Cassandra, Memcached, AWS SDK (v2 & v3), GraphQL, Apollo Server, Kafka, WebSockets, generic-pool, Knex, Tedious (MSSQL), Handlebars, Pug, and more.

## License

[BSD-2-Clause](LICENSE) — forked from Elastic APM Node.js Agent.
