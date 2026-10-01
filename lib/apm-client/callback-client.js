/*
 * Copyright Elasticsearch B.V. and other contributors where applicable.
 * Copyright Red Thread Labs LLC. All rights reserved.
 * Licensed under the BSD 2-Clause License; you may not use this file except in
 * compliance with the BSD 2-Clause License.
 */

'use strict';

const EventEmitter = require('events');

const Filters = require('object-filter-sequence');

const ndjson = require('./ndjson');
const truncate = require('./truncate');
const { buildOrigin, buildTruncOpts } = require('./origin');

const DEFAULT_FLUSH_CADENCE_MS = 1000;
const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_MAX_QUEUE_SIZE = 5000;
const DEFAULT_CHANNEL = 'default';
const METADATA_WAIT_MS = 10 * 1000;

/**
 * The direct sink: hands batches of wire records to an in-process handler
 * instead of writing files. Nothing touches the disk.
 *
 * A batch is delivered when the queue holds `batchSize` records or on the
 * flush cadence, whichever comes first, as one
 * `handler(records, origin)` call per channel: `records` is an array of
 * `{ kind, record }` (the record is exactly what the file sink would write
 * under that kind's key), and `origin` is the file sink's `metadata` header
 * for that channel (its `channel` field names the channel).
 *
 * The queue is bounded by `maxQueueSize` across all channels. Beyond it the
 * oldest record is dropped and counted (`dropCount`, and a `drop` event).
 * Until a handler is set, records wait in the same bounded queue.
 *
 * A handler may return a promise: the next batch waits for it, and records
 * arriving meanwhile queue (bounded). A throw or rejection is emitted as
 * `error`; that batch is not retried.
 */
class CallbackClient extends EventEmitter {
  constructor(opts) {
    super();

    this._defaultChannel = opts.defaultChannel || DEFAULT_CHANNEL;
    this._clock = opts.clock || (() => new Date());
    this._log = opts.logger || null;
    this._truncOpts = buildTruncOpts(opts);
    this._metadata = buildOrigin(opts);
    this._metadataFilters = new Filters();
    this._extraMetadata = null;
    this._batchSize = opts.batchSize > 0 ? opts.batchSize : DEFAULT_BATCH_SIZE;
    this._maxQueueSize =
      opts.maxQueueSize > 0 ? opts.maxQueueSize : DEFAULT_MAX_QUEUE_SIZE;

    this._queue = [];
    this._dropCount = 0;
    this._handler = opts.handler || null;
    this._draining = null;
    this._drainScheduled = false;
    this._destroyed = false;

    // Hold the first delivery (bounded) until cloud metadata resolves, so
    // the origin includes `cloud` — the file sink's rule for its header.
    this._metadataWaitDeadline = this._clock().getTime() + METADATA_WAIT_MS;
    this._cloudMetadataReady = false;
    if (opts.cloudMetadataFetcher) {
      opts.cloudMetadataFetcher.getCloudMetadata((err, cloudMetadata) => {
        if (!err && cloudMetadata) {
          this._metadata.cloud = cloudMetadata;
        }
        this._cloudMetadataReady = true;
      });
    } else {
      this._cloudMetadataReady = true;
    }

    const cadenceMs = opts.flushIntervalMs || DEFAULT_FLUSH_CADENCE_MS;
    this._flushHandle = setInterval(() => this._startDrain(false), cadenceMs);
    this._flushHandle.unref();
  }

  get dropCount() {
    return this._dropCount;
  }

  get queueSize() {
    return this._queue.length;
  }

  /**
   * Set (or, with null, remove) the batch handler. Queued records are
   * delivered to a new handler on the next tick.
   */
  setHandler(handler) {
    this._handler = typeof handler === 'function' ? handler : null;
    if (this._handler && this._queue.length > 0) {
      this._scheduleDrain();
    }
  }

  // --- The client interface the agent calls ---

  config(opts) {}

  addMetadataFilter(fn) {
    this._metadataFilters.push(fn);
  }

  setExtraMetadata(metadata) {
    this._extraMetadata = metadata;
  }

  supportsKeepingUnsampledTransaction() {
    return true;
  }

  lambdaStart() {}
  lambdaShouldRegisterTransactions() {
    return true;
  }
  lambdaRegisterTransaction(trans, awsRequestId) {}

  sendTransaction(transaction, cb) {
    this._send(this._defaultChannel, 'transaction', transaction, cb);
  }

  sendSpan(span, cb) {
    this._send(this._defaultChannel, 'span', span, cb);
  }

  sendError(error, cb) {
    this._send(this._defaultChannel, 'error', error, cb);
  }

  sendMetricSet(metricset, cb) {
    this._send(this._defaultChannel, 'metricset', metricset, cb);
  }

  sendEvent(event, cb) {
    this._send(this._defaultChannel, 'event', event, cb);
  }

  sendToChannel(channel, kind, data, cb) {
    this._send(channel, kind, data, cb);
  }

  /**
   * Deliver every record queued now to the handler, then call `cb` (after
   * a returned promise settles). Without a handler, or while the first
   * delivery waits for cloud metadata, records stay queued.
   */
  flush(opts, cb) {
    if (typeof opts === 'function') {
      cb = opts;
    }
    const drained = this._draining
      ? this._draining.then(() => this._startDrain(false))
      : this._startDrain(false);
    drained.then(() => {
      if (cb) cb();
    });
  }

  /**
   * Stop the cadence and hand every queued record to the handler now. A
   * promise the handler returns is not awaited: destroy is synchronous.
   */
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    if (this._flushHandle) {
      clearInterval(this._flushHandle);
      this._flushHandle = null;
    }
    while (this._handler && this._queue.length > 0) {
      for (const [channel, records] of this._takeBatch()) {
        try {
          const result = this._call(channel, records);
          if (result && typeof result.then === 'function') {
            result.then(null, (err) => this._reportHandlerError(err));
          }
        } catch (err) {
          this._reportHandlerError(err);
        }
      }
    }
  }

  // --- Internals ---

  _send(channel, kind, data, cb) {
    if (!this._destroyed) {
      try {
        const truncated = truncate[kind]
          ? truncate[kind](data, this._truncOpts)
          : data;
        if (this._queue.length >= this._maxQueueSize) {
          this._queue.shift();
          this._dropCount++;
          this.emit('drop', this._dropCount);
        }
        this._queue.push({ channel, kind, line: ndjson.serialize(truncated) });
        if (this._handler && this._queue.length >= this._batchSize) {
          this._scheduleDrain();
        }
      } catch (err) {
        if (this._log) {
          this._log.error('CallbackClient serialize error: %s', err.message);
        }
      }
    }
    if (cb) process.nextTick(cb);
  }

  _scheduleDrain() {
    if (this._drainScheduled) return;
    this._drainScheduled = true;
    process.nextTick(() => {
      this._drainScheduled = false;
      this._startDrain(false);
    });
  }

  _startDrain(force) {
    if (!this._draining) {
      this._draining = this._drain(force).then(() => {
        this._draining = null;
      });
    }
    return this._draining;
  }

  _metadataReady() {
    return (
      this._cloudMetadataReady ||
      this._clock().getTime() >= this._metadataWaitDeadline
    );
  }

  // Deliver the records queued when the drain starts, a batch at a time.
  // Records that arrive meanwhile wait for the next drain.
  async _drain(force) {
    let budget = this._queue.length;
    while (budget > 0 && this._handler && this._queue.length > 0) {
      if (!force && !this._metadataReady()) return;
      const before = this._queue.length;
      const groups = this._takeBatch();
      budget -= before - this._queue.length;
      for (const [channel, records] of groups) {
        try {
          const result = this._call(channel, records);
          if (result && typeof result.then === 'function') {
            await result;
          }
        } catch (err) {
          this._reportHandlerError(err);
        }
      }
    }
  }

  // Take up to batchSize records off the queue, grouped by channel in
  // arrival order: [[channel, records], ...].
  _takeBatch() {
    const entries = this._queue.splice(0, this._batchSize);
    const groups = new Map();
    for (const entry of entries) {
      let records = groups.get(entry.channel);
      if (!records) {
        records = [];
        groups.set(entry.channel, records);
      }
      records.push({ kind: entry.kind, record: JSON.parse(entry.line) });
    }
    return groups;
  }

  _call(channel, records) {
    const handler = this._handler;
    if (!handler) return null;
    return handler(records, this._origin(channel));
  }

  _origin(channel) {
    let metadata = Object.assign({}, this._metadata);
    if (this._extraMetadata) {
      metadata = Object.assign(metadata, this._extraMetadata);
    }
    metadata = this._metadataFilters.process(metadata);
    if (!metadata) return null;
    metadata.channel = channel;
    return JSON.parse(ndjson.serialize(metadata));
  }

  _reportHandlerError(err) {
    if (this.listenerCount('error') > 0) {
      this.emit('error', err);
    } else if (this._log) {
      this._log.error('CallbackClient handler error: %s', err && err.message);
    }
  }
}

module.exports = {
  CallbackClient,
  DEFAULT_BATCH_SIZE,
  DEFAULT_MAX_QUEUE_SIZE,
};
