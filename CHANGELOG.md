# Changelog

## 1.21.1

- deps: `@redthreadlabs/tracelog-schema` ^0.6.0 -> ^0.7.0. The context
  sanitizer keeps a visitor that carries `kind` alone (no persistent id).

## 1.21.0

- A direct sink. `sink: 'file' | 'callback' | 'both'` (`TRACELOG_SINK`,
  default `file`, so nothing changes for existing users) selects where
  batches go. `callback` hands each batch to the handler registered with
  `apm.onBatch((records, origin) => …)` and writes nothing to disk; `both`
  runs the file sink exactly as before and also hands every batch to the
  handler (`TeeClient`, a small composite of the two clients).
- `records` is an array of `{ kind, record }` — the record exactly as the
  file sink writes it under that kind's key — and `origin` is the channel's
  `metadata` header (service, process, system, cloud, labels, `channel`),
  handed with every batch. One handler call per channel per batch.
- Batching: a batch is delivered when `sinkBatchSize` records are queued
  (`TRACELOG_SINK_BATCH_SIZE`, default 500) or on the flush cadence
  (`logFlushIntervalMs`), and on `flush()`, whose callback waits for an
  async handler. A batch holds at most `sinkBatchSize` records.
- A bounded queue: `sinkMaxQueueSize` (`TRACELOG_SINK_MAX_QUEUE_SIZE`,
  default 5000) across channels; beyond it the oldest record is dropped,
  counted in `apm.sinkDropCount`, emitted as the client's `drop` event and
  logged as a warning (at most once a minute). Records queue there until a
  handler is registered, so `onBatch` may come after `start()` — the usual
  case with a preloaded agent.
- `apm.onBatch(null)`, or the function `onBatch` returns, removes the
  handler. `index.d.ts` declares `onBatch`, `sinkDropCount`, `SinkRecord`,
  `SinkOrigin`, `BatchHandler` and the three options.
- The writer's origin and truncation options are built in one place
  (`lib/apm-client/origin.js`) for both sinks; with `both` the cloud
  metadata is fetched once.
- Known, unchanged: `npm test` as a whole fails (a missing
  `test/_mock_apm_server` and `npm run lint` on ESLint 9's config); the
  self-contained suites pass, including the new
  `test/apm-client/callback-client.test.js` and `test/sink.test.js`.

## 1.20.0

- `writeEvent(type, { message, level, timestamp, error, context })` and
  `writeEvents([{ type, …, context }])` (agent and channel) take a
  `context`: the tracelog-schema `RecordContext` (`labels`, `user`,
  `visitor`, `visit`, `actor`, `page`, `campaign`, `geo`, `entity`),
  filtered by the schema's `sanitizeContext` and written as the event's
  `context`. A single write inside a transaction keeps stamping `trace_id`
  and `transaction_id` on the record, not in `labels`. A server can now
  write its own analytics events without going through `writeClientEvents`.
- Deprecated: the `params`, `user` and `client` event options. They are
  still written as before for this minor and are removed in the next; when
  no `context` is given, `params` is also written as `context.labels` and
  `user.id` as `context.user.id`.
- `index.d.ts` declares `Channel.writeClientEvents`,
  `Channel.writeRecordOrigin` and the `context` event option (typed as the
  schema's `RecordContext`).
- SCHEMA.md documents the server event's `context`.
- Known, unchanged: `npm test` as a whole fails (a missing
  `test/_mock_apm_server` and `npm run lint` on ESLint 9's config); the
  self-contained suites pass.

## 1.19.1

- deps: `@redthreadlabs/tracelog-schema` ^0.5.1 -> ^0.6.0. Client ingest
  imports `sanitizeContext` from the schema; `lib/client-context.js` is
  deleted. No behaviour change.

## 1.19.0

- Client ingest keeps the tracelog-schema 0.6.0 analytics context on events,
  transactions and spans: `visitor`, `visit`, `actor`, `page`, `campaign`,
  `geo` and `entity`, beside `labels` (primitive values) and `user.id`.
  Malformed sub-objects are dropped whole; unknown keys are dropped.
- `writeRecordOrigin` keeps `origin.schema`, the schema version a client
  batch was written against.
- The filter is `lib/client-context.js`, a twin of tracelog-schema 0.6.0's
  `sanitizeContext`. When the dependency pin moves to `^0.6.0`, the agent
  imports `sanitizeContext` from the schema and the twin is deleted.
- Client-ingested `context.user` keeps `id` only (it dropped `email` and
  `username`, which no ingesting server sends).
- SCHEMA.md: transaction, span and error context say `context.labels` (not
  `tags`), and a new section documents client-ingested records, their
  context and the in-stream origin.
