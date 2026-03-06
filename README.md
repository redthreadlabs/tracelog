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
TRACELOG_LOG_FILE_PATH=/var/log/myapp/traces.jsonl \
node -r tracelog/start app.js
```

That's it. Tracelog will automatically instrument your HTTP servers, database clients, and other modules, writing transaction, span, error, and metric data to the JSONL file.

## Configuration

| Option | Env Var | Default | Description |
|--------|---------|---------|-------------|
| `serviceName` | `ELASTIC_APM_SERVICE_NAME` | from package.json | Name of your service |
| `serviceVersion` | `ELASTIC_APM_SERVICE_VERSION` | from package.json | Version of your service |
| `environment` | `ELASTIC_APM_ENVIRONMENT` | `development` | Environment name |
| `logFilePath` | — | `./tracelog.jsonl` | Path to JSONL output file |
| `logMaxFileSize` | — | `104857600` (100MB) | Rotate when file exceeds this size |
| `logMaxFiles` | — | `10` | Number of rotated files to keep |
| `logFlushIntervalMs` | — | `1000` | Buffer flush interval (ms) |
| `cloudProvider` | `ELASTIC_APM_CLOUD_PROVIDER` | `auto` | Cloud metadata: `auto`, `aws`, `gcp`, `azure`, `none` |
| `disableSend` | `ELASTIC_APM_DISABLE_SEND` | `false` | Disable all output (context propagation only) |

All other [elastic-apm-node configuration options](https://www.elastic.co/guide/en/apm/agent/nodejs/current/configuration.html) (sampling, span limits, filtering, etc.) are also supported.

## Output format

Each line is a self-contained JSON object. Files start with a metadata line:

```jsonl
{"metadata":{"service":{"name":"my-api","version":"1.0.0"},"process":{"pid":1234},"system":{"hostname":"ip-10-0-1-42"},"cloud":{"provider":"aws","instance":{"id":"i-0abc123"},"availability_zone":"us-east-1a"}}}
{"transaction":{"id":"abc123","trace_id":"def456","name":"GET /users","type":"request","duration":42.5,"result":"HTTP 2xx"}}
{"span":{"id":"ghi789","transaction_id":"abc123","name":"SELECT * FROM users","type":"db","subtype":"postgresql","duration":12.3}}
{"error":{"message":"Something broke","exception":{"type":"TypeError","stacktrace":[...]}}}
```

## Auto-instrumented modules

Express, Fastify, Koa, Hapi, Connect, Restify, HTTP/HTTPS, fetch/undici, PostgreSQL, MySQL, MongoDB, Redis, Elasticsearch, Cassandra, Memcached, AWS SDK (v2 & v3), GraphQL, Apollo Server, Kafka, WebSockets, generic-pool, Knex, Tedious (MSSQL), Handlebars, Pug, and more.

## License

[BSD-2-Clause](LICENSE) — forked from Elastic APM Node.js Agent.
