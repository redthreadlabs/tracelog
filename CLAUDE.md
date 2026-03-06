# Tracelog

Tracelog is a fork of [elastic-apm-node](https://github.com/elastic/apm-agent-nodejs) that writes APM instrumentation data to local JSONL files instead of shipping to an Elastic APM server.

- **Origin**: Forked from `elastic-apm-node` v4.15.0 (BSD-2-Clause). The full instrumentation layer (43 module patchers), async context tracking, and data model are preserved.
- **License**: BSD-2-Clause. Existing source files retain their Elasticsearch copyright headers.

## Architecture

```
index.js                    # Entry point, exports singleton Agent
lib/agent.js                # Main Agent class — public API, lifecycle
lib/config/                 # Configuration parsing (schema.js, config.js)
lib/instrumentation/        # Module patching (RITM/IITM hooks), run context
  index.js                  # Instrumentation manager, MODULE_PATCHERS list
  transaction.js            # Transaction model
  span.js                   # Span model
  generic-span.js           # Shared base for Transaction/Span
  run-context/              # AsyncLocalStorage-based context tracking
  modules/                  # 43 module patchers (express, pg, mongodb, etc.)
lib/apm-client/
  apm-client.js             # Client factory — creates JsonlFileClient or NoopApmClient
  jsonl-file-client.js      # JSONL file transport (buffering, rotation, truncation)
  noop-apm-client.js        # No-op client for contextPropagationOnly mode
  s3-uploader.js            # S3 upload (gzip, completed/current file handling)
  ndjson.js                 # NDJSON serialization utility
  truncate.js               # Field truncation for APM data model
lib/cloud-metadata/         # AWS/Azure/GCP instance metadata detection
lib/errors.js               # Error capture and encoding
lib/tracecontext/           # W3C Trace Context (traceparent/tracestate)
lib/metrics/                # System and runtime metrics collection
lib/filters/                # Sensitive data filtering
lib/stacktraces.js          # Stack trace capture and parsing
```

## Key conventions

- **CommonJS** (`require`/`module.exports`), not ESM.
- **Node.js >= 14.17.0** required.
- **No TypeScript source** — all source is plain JavaScript. Types in `index.d.ts` and `types/`.
- **Strict mode** — every source file uses `'use strict';`.
- **Copyright headers** — BSD-2-Clause header at top. New files include both Elasticsearch and Shaxpir Inc. lines.
- **Test framework** — `tape`.

## Data flow

```
User code / auto-instrumentation
  → Agent.startTransaction() / startSpan() / captureError() / captureEvent()
    → Objects tracked via RunContext (AsyncLocalStorage)
      → end() / flush()
        → Apply filters (transaction/span/error/event filters)
          → JsonlFileClient.sendTransaction/sendSpan/sendError/sendEvent()
            → Truncate fields, serialize as NDJSON, buffer in memory
              → Periodic flush (default 1s) appends to timestamped .jsonl file
                → Time-based rotation (daily/hourly) or size-based rotation
                  → S3Uploader.uploadCompleted() → gzip, upload, delete local
                  → S3Uploader.uploadCurrent() on timer and destroy()
```

## JSONL event types

Six record types: `metadata`, `transaction`, `span`, `error`, `metricset`, `event`. See [SCHEMA.md](SCHEMA.md) for full field documentation.

## Configuration

See [CONFIG.md](CONFIG.md) for the full reference. Key tracelog-specific options: `logDir`, `logFilePrefix`, `logRotationSchedule`, `maxLocalRetentionDays`, `maxBufferSize`, `s3Bucket`, `s3GzipCompleted`, `s3GzipCurrent`.

## Removed from upstream

- HTTP transport to APM server (replaced with JSONL file writer)
- Lambda and Azure Functions support
- OpenTelemetry bridge and metrics
- Central config polling from APM server
- Elastic-specific CI/CD, Docker, docs, and examples
- All `ELASTIC_APM_*` env vars renamed to `TRACELOG_*`
- Config file default renamed from `elastic-apm-node.js` to `tracelog.config.js`

## Development

```bash
npm install           # Install dependencies
npm test              # Run tests (tape)
npm run lint          # ESLint
```

### Quick smoke test

```js
const apm = require('.');
apm.start({ serviceName: 'test', logDir: '/tmp', cloudProvider: 'none' });
const t = apm.startTransaction('test');
t.end();
apm.flush(() => {
  const fs = require('fs');
  const files = fs.readdirSync('/tmp').filter(f => f.startsWith('tracelog-'));
  console.log(fs.readFileSync('/tmp/' + files[0], 'utf8'));
  apm.destroy();
});
```
