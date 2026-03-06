# Tracelog

Tracelog is a fork of [elastic-apm-node](https://github.com/elastic/apm-agent-nodejs) that writes APM instrumentation data to local JSONL files instead of shipping to an Elastic APM server.

## Project overview

- **Purpose**: Capture transactions, spans, errors, and metrics from Node.js applications and write them as JSONL (newline-delimited JSON) to disk, with file rotation and optional S3 upload (planned).
- **Origin**: Forked from `elastic-apm-node` v4.15.0 (BSD-2-Clause). The full instrumentation layer (43 module patchers), async context tracking, and data model are preserved. The HTTP transport was replaced with a JSONL file writer.
- **License**: BSD-2-Clause. Existing source files retain their Elasticsearch copyright headers as required.

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
  noop-apm-client.js        # No-op client for disableSend mode
  http-apm-client/          # Legacy HTTP client (kept for ndjson.js and truncate.js utils)
lib/cloud-metadata/         # AWS/Azure/GCP instance metadata detection
lib/errors.js               # Error capture and encoding
lib/tracecontext/           # W3C Trace Context (traceparent/tracestate)
lib/metrics/                # System and runtime metrics collection
lib/filters/                # Sensitive data filtering
lib/stacktraces.js          # Stack trace capture and parsing
```

## Key conventions

- **CommonJS** (`require`/`module.exports`), not ESM. The `type` in package.json is `"commonjs"`.
- **Node.js >= 14.17.0** required.
- **No TypeScript source** — all source is plain JavaScript. TypeScript types are in `index.d.ts` and `types/`.
- **Strict mode** — every source file uses `'use strict';`.
- **Copyright headers** — all source files must have the BSD-2-Clause copyright header at the top. New files should include both Elasticsearch and Shaxpir Inc. copyright lines.

## Data flow

```
User code / auto-instrumentation
  → Agent.startTransaction() / Agent.startSpan()
    → Transaction/Span objects created, tracked via RunContext (AsyncLocalStorage)
      → span.end() / trans.end()
        → _encode() builds JSON payload
          → Apply filters (span/transaction/error filters)
            → JsonlFileClient.sendTransaction/sendSpan/sendError()
              → Truncate fields, serialize as NDJSON
                → Buffer in memory
                  → Periodic flush (default 1s) appends to .jsonl file
                    → File rotation when maxFileSize exceeded
```

## Config options (tracelog-specific)

These are passed to `agent.start()` alongside the standard config options:

| Option | Default | Description |
|--------|---------|-------------|
| `logFilePath` | `./tracelog.jsonl` | Path to the JSONL output file |
| `logMaxFileSize` | `104857600` (100MB) | Rotate file when it exceeds this size in bytes |
| `logMaxFiles` | `10` | Number of rotated files to keep |
| `logFlushIntervalMs` | `1000` | Buffer flush interval in milliseconds |
| `cloudProvider` | `auto` | Cloud metadata detection: `auto`, `aws`, `gcp`, `azure`, or `none` |

## JSONL output format

Each line is a self-contained JSON object. Files begin with a metadata line:

```jsonl
{"metadata":{"service":{"name":"my-api","version":"1.0.0","agent":{"name":"tracelog"}},"process":{"pid":1234},"system":{"hostname":"..."},"cloud":{...}}}
{"transaction":{"id":"abc","trace_id":"def","name":"GET /users","duration":42.5,...}}
{"span":{"id":"ghi","transaction_id":"abc","name":"SELECT * FROM users","type":"db","subtype":"postgresql",...}}
{"error":{"message":"Something broke","exception":{"type":"TypeError","stacktrace":[...]}}}
```

## Removed from upstream

The following were removed from the Elastic APM agent:
- HTTP transport to APM server (replaced with JSONL file writer)
- Lambda and Azure Functions support
- OpenTelemetry bridge and metrics
- Central config polling from APM server
- Elastic-specific CI/CD, Docker, docs, and examples

## Development

```bash
npm install           # Install dependencies
npm test              # Run tests (tape)
npm run lint          # ESLint
```

## Testing changes

When modifying the JSONL client or agent, a quick smoke test:

```js
const apm = require('.');
apm.start({ serviceName: 'test', logFilePath: '/tmp/test.jsonl' });
const t = apm.startTransaction('test');
t.end();
apm.flush(() => {
  console.log(require('fs').readFileSync('/tmp/test.jsonl', 'utf8'));
  apm.destroy();
});
```

## Planned work

- S3 upload of rotated JSONL files
- Config schema cleanup (remove unused server-related options)
- TypeScript type updates for new config options
- README rewrite
- Test suite adaptation
