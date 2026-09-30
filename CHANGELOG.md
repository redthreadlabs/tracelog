# Changelog

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
