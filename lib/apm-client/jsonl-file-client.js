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
const { normalizeHost } = require('./s3-uploader');

const DEFAULT_FLUSH_INTERVAL_MS = 1000;
const DEFAULT_ROTATION_SCHEDULE = 'daily';
const DEFAULT_MAX_LOCAL_RETENTION_DAYS = 0;
const DEFAULT_MAX_BUFFER_SIZE = 10000;

const DEFAULT_CHANNEL = 'default';  // used when opts.defaultChannel is not set

/**
 * A channel-aware JSONL file client. Routes records to ChannelWriter instances
 * based on channel name. Each channel gets its own file, buffer, and rotation
 * lifecycle. The default channel is named 'default' unless overridden via
 * opts.defaultChannel.
 */
class JsonlFileClient extends EventEmitter {
  constructor(opts) {
    super();

    this._baseDir = opts.logDir || process.cwd();
    this._baseName = opts.logFilePrefix || 'tracelog';
    this._defaultChannel = opts.defaultChannel || DEFAULT_CHANNEL;
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
          ...(opts.serviceNodeName && {
            node: { configured_name: opts.serviceNodeName },
          }),
          agent: { name: 'tracelog', version: require('../../package').version },
        },
        process: {
          pid: process.pid,
          title: process.title,
          argv: process.argv,
        },
        system: {
          // Normalized the same way as the host in S3 keys, so a viewer
          // can correlate metadata with key-derived hosts using one rule.
          hostname: normalizeHost(os.hostname()),
          architecture: os.arch(),
          platform: os.platform(),
        },
        ...(opts.globalLabels && { labels: opts.globalLabels }),
      },
      s3Uploader: opts.s3Uploader || null,
      // Lets writers hold their first write (bounded) until the async
      // cloud-metadata fetch resolves, so metadata lines include `cloud`.
      metadataReady: () => this._cloudMetadataReady,
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
    this._getWriter(this._defaultChannel);

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
    this._getWriter(this._defaultChannel).send('transaction', transaction, cb);
  }

  sendSpan(span, cb) {
    this._getWriter(this._defaultChannel).send('span', span, cb);
  }

  sendError(error, cb) {
    this._getWriter(this._defaultChannel).send('error', error, cb);
  }

  sendMetricSet(metricset, cb) {
    this._getWriter(this._defaultChannel).send('metricset', metricset, cb);
  }

  sendEvent(event, cb) {
    this._getWriter(this._defaultChannel).send('event', event, cb);
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
      // Not forced: while the (bounded) wait for async cloud metadata is
      // pending, records stay buffered. destroy() is the path that must
      // never hold records back.
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
