/*
 * Copyright Elasticsearch B.V. and other contributors where applicable.
 * Copyright Red Thread Labs LLC. All rights reserved.
 * Licensed under the BSD 2-Clause License; you may not use this file except in
 * compliance with the BSD 2-Clause License.
 */

'use strict';

const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');

const Filters = require('object-filter-sequence');

const { ChannelWriter } = require('./channel-writer');

const DEFAULT_FLUSH_INTERVAL_MS = 1000;
const DEFAULT_ROTATION_SCHEDULE = 'daily';
const DEFAULT_MAX_LOCAL_RETENTION_DAYS = 0;
const DEFAULT_MAX_BUFFER_SIZE = 10000;

const DEFAULT_CHANNEL = 'default';

/**
 * A channel-aware JSONL file client. Routes records to ChannelWriter instances
 * based on channel name. Each channel gets its own file, buffer, and rotation
 * lifecycle. The default channel is 'default'.
 */
class JsonlFileClient extends EventEmitter {
  constructor(opts) {
    super();

    this._baseDir = opts.logDir || process.cwd();
    this._baseName = opts.logFilePrefix || 'tracelog';
    this._clock = opts.clock || (() => new Date());
    this._log = opts.logger || null;
    this._destroyed = false;

    // Ensure the output directory exists.
    fs.mkdirSync(this._baseDir, { recursive: true });

    // Shared config for all channel writers.
    this._writerOpts = {
      baseDir: this._baseDir,
      baseName: this._baseName,
      truncOpts: {
        truncateKeywordsAt:
          opts.truncateKeywordsAt != null ? opts.truncateKeywordsAt : 1024,
        truncateLongFieldsAt:
          opts.truncateLongFieldsAt != null ? opts.truncateLongFieldsAt : 10000,
        truncateErrorMessagesAt:
          opts.truncateErrorMessagesAt != null
            ? opts.truncateErrorMessagesAt
            : undefined,
      },
      metadata: {
        service: {
          name: opts.serviceName || 'unknown',
          version: opts.serviceVersion || undefined,
          environment: opts.environment || undefined,
          agent: { name: 'tracelog', version: require('../../package').version },
        },
        process: {
          pid: process.pid,
          title: process.title,
          argv: process.argv,
        },
        system: {
          hostname: os.hostname(),
          architecture: os.arch(),
          platform: os.platform(),
        },
        ...(opts.globalLabels && { labels: opts.globalLabels }),
      },
      s3Uploader: opts.s3Uploader || null,
      maxFileSize: opts.maxFileSize,
      maxBufferSize: opts.maxBufferSize || DEFAULT_MAX_BUFFER_SIZE,
      rotationSchedule: opts.rotationSchedule || DEFAULT_ROTATION_SCHEDULE,
      maxLocalRetentionDays:
        opts.maxLocalRetentionDays != null
          ? opts.maxLocalRetentionDays
          : DEFAULT_MAX_LOCAL_RETENTION_DAYS,
      clock: this._clock,
      logger: this._log,
    };

    this._metadataFilters = new Filters();
    this._extraMetadata = null;
    this._cloudMetadataReady = false;

    // Channel writers, keyed by channel name.
    this._writers = new Map();

    // Fetch cloud metadata asynchronously if a fetcher is provided.
    if (opts.cloudMetadataFetcher) {
      opts.cloudMetadataFetcher.getCloudMetadata((err, cloudMetadata) => {
        if (!err && cloudMetadata) {
          this._writerOpts.metadata.cloud = cloudMetadata;
        }
        this._cloudMetadataReady = true;
      });
    } else {
      this._cloudMetadataReady = true;
    }

    // Create the default channel eagerly.
    this._getWriter(DEFAULT_CHANNEL);

    // Start periodic flush of all channels.
    const flushIntervalMs = opts.flushIntervalMs || DEFAULT_FLUSH_INTERVAL_MS;
    this._flushTimer = setInterval(() => {
      for (const writer of this._writers.values()) {
        writer.flush();
      }
    }, flushIntervalMs);
    this._flushTimer.unref();

    // Start periodic S3 upload of current files for all channels.
    this._s3UploadIntervalMs = opts.s3UploadIntervalMs || 0;
    this._s3UploadTimer = null;
    if (opts.s3Uploader && this._s3UploadIntervalMs > 0) {
      this._s3UploadTimer = setInterval(() => {
        for (const writer of this._writers.values()) {
          writer.uploadCurrent();
        }
      }, this._s3UploadIntervalMs);
      this._s3UploadTimer.unref();
    }
  }

  // --- Channel management ---

  /**
   * Get or create a ChannelWriter for the given channel name.
   */
  _getWriter(channel) {
    if (!this._writers.has(channel)) {
      const writer = new ChannelWriter({
        ...this._writerOpts,
        channel,
        metadataFilters: this._metadataFilters,
        extraMetadata: this._extraMetadata,
      });
      this._writers.set(channel, writer);
    }
    return this._writers.get(channel);
  }

  // --- Public API (default channel) ---

  config(opts) {}

  addMetadataFilter(fn) {
    this._metadataFilters.push(fn);
  }

  setExtraMetadata(metadata) {
    this._extraMetadata = metadata;
    for (const writer of this._writers.values()) {
      writer.setExtraMetadata(metadata);
    }
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
    this._getWriter(DEFAULT_CHANNEL).send('transaction', transaction, cb);
  }

  sendSpan(span, cb) {
    this._getWriter(DEFAULT_CHANNEL).send('span', span, cb);
  }

  sendError(error, cb) {
    this._getWriter(DEFAULT_CHANNEL).send('error', error, cb);
  }

  sendMetricSet(metricset, cb) {
    this._getWriter(DEFAULT_CHANNEL).send('metricset', metricset, cb);
  }

  sendEvent(event, cb) {
    this._getWriter(DEFAULT_CHANNEL).send('event', event, cb);
  }

  // --- Channel-routed API ---

  sendToChannel(channel, type, data, cb) {
    this._getWriter(channel).send(type, data, cb);
  }

  // --- Lifecycle ---

  flush(opts, cb) {
    if (typeof opts === 'function') {
      cb = opts;
      opts = {};
    } else if (!opts) {
      opts = {};
    }

    for (const writer of this._writers.values()) {
      writer.flush();
    }

    if (cb) {
      process.nextTick(cb);
    }
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;

    if (this._flushTimer) {
      clearInterval(this._flushTimer);
      this._flushTimer = null;
    }
    if (this._s3UploadTimer) {
      clearInterval(this._s3UploadTimer);
      this._s3UploadTimer = null;
    }

    for (const writer of this._writers.values()) {
      writer.destroy();
    }
  }
}

module.exports = {
  JsonlFileClient,
};
