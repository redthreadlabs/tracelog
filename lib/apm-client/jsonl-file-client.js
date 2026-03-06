/*
 * Copyright Elasticsearch B.V. and other contributors where applicable.
 * Copyright Shaxpir Inc. All rights reserved.
 * Licensed under the BSD 2-Clause License; you may not use this file except in
 * compliance with the BSD 2-Clause License.
 */

'use strict';

const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

const Filters = require('object-filter-sequence');

const ndjson = require('./ndjson');
const truncate = require('./truncate');

const DEFAULT_MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB
const DEFAULT_MAX_FILES = 10;
const DEFAULT_FLUSH_INTERVAL_MS = 1000;

class JsonlFileClient extends EventEmitter {
  constructor(opts) {
    super();

    this._filePath = opts.filePath || path.join(process.cwd(), 'tracelog.jsonl');
    this._maxFileSize = opts.maxFileSize || DEFAULT_MAX_FILE_SIZE;
    this._maxFiles = opts.maxFiles || DEFAULT_MAX_FILES;
    this._flushIntervalMs = opts.flushIntervalMs || DEFAULT_FLUSH_INTERVAL_MS;
    this._log = opts.logger || null;

    this._truncOpts = {
      truncateKeywordsAt:
        opts.truncateKeywordsAt != null ? opts.truncateKeywordsAt : 1024,
      truncateLongFieldsAt:
        opts.truncateLongFieldsAt != null ? opts.truncateLongFieldsAt : 10000,
      truncateErrorMessagesAt:
        opts.truncateErrorMessagesAt != null
          ? opts.truncateErrorMessagesAt
          : undefined,
    };

    this._metadata = {
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
    };

    if (opts.globalLabels) {
      this._metadata.labels = opts.globalLabels;
    }

    this._extraMetadata = null;
    this._metadataFilters = new Filters();
    this._buffer = [];
    this._currentFileSize = 0;
    this._wroteMetadata = false;
    this._destroyed = false;
    this._cloudMetadataReady = false;

    // Fetch cloud metadata asynchronously if a fetcher is provided
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

    // Initialize file size tracking
    try {
      const stat = fs.statSync(this._filePath);
      this._currentFileSize = stat.size;
      this._wroteMetadata = true; // Existing file, assume metadata already written
    } catch (e) {
      // File doesn't exist yet, that's fine
    }

    // Start periodic flush
    this._flushTimer = setInterval(() => {
      this._flushBuffer();
    }, this._flushIntervalMs);
    this._flushTimer.unref();
  }

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
    this._send('transaction', transaction, cb);
  }

  sendSpan(span, cb) {
    this._send('span', span, cb);
  }

  sendError(error, cb) {
    this._send('error', error, cb);
  }

  sendMetricSet(metricset, cb) {
    this._send('metricset', metricset, cb);
  }

  flush(opts, cb) {
    if (typeof opts === 'function') {
      cb = opts;
      opts = {};
    } else if (!opts) {
      opts = {};
    }

    this._flushBuffer();

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

    this._flushBuffer();
  }

  _send(type, data, cb) {
    if (this._destroyed) {
      if (cb) process.nextTick(cb);
      return;
    }

    try {
      // Truncate the data
      const truncated = truncate[type]
        ? truncate[type](data, this._truncOpts)
        : data;

      const obj = {};
      obj[type] = truncated;
      const line = ndjson.serialize(obj);
      this._buffer.push(line);
    } catch (err) {
      this.emit('error', err);
    }

    if (cb) {
      process.nextTick(cb);
    }
  }

  _getMetadataLine() {
    let metadata = Object.assign({}, this._metadata);
    if (this._extraMetadata) {
      metadata = Object.assign(metadata, this._extraMetadata);
    }

    // Apply metadata filters
    metadata = this._metadataFilters.process(metadata);
    if (!metadata) return null;

    return ndjson.serialize({ metadata });
  }

  _flushBuffer() {
    if (this._buffer.length === 0) return;

    try {
      // Check if rotation is needed before writing
      if (this._currentFileSize >= this._maxFileSize) {
        this._rotate();
      }

      let output = '';

      // Write metadata at the start of a new file.
      // If cloud metadata hasn't arrived yet, defer the metadata line
      // until the next flush when it should be ready.
      if (!this._wroteMetadata) {
        if (!this._cloudMetadataReady) {
          // Buffer events but hold off on writing until cloud metadata arrives
          return;
        }
        const metadataLine = this._getMetadataLine();
        if (metadataLine) {
          output += metadataLine;
        }
        this._wroteMetadata = true;
      }

      output += this._buffer.join('');
      this._buffer = [];

      // Ensure the directory exists
      const dir = path.dirname(this._filePath);
      fs.mkdirSync(dir, { recursive: true });

      fs.appendFileSync(this._filePath, output, 'utf8');
      this._currentFileSize += Buffer.byteLength(output, 'utf8');
    } catch (err) {
      this.emit('error', err);
    }
  }

  _rotate() {
    try {
      // Shift existing rotated files: .9 -> .10 (deleted), .8 -> .9, etc.
      for (let i = this._maxFiles - 1; i >= 1; i--) {
        const from = `${this._filePath}.${i}`;
        const to = `${this._filePath}.${i + 1}`;
        try {
          if (i + 1 > this._maxFiles) {
            fs.unlinkSync(from);
          } else {
            fs.renameSync(from, to);
          }
        } catch (e) {
          // File might not exist, that's fine
        }
      }

      // Rename current file to .1
      try {
        fs.renameSync(this._filePath, `${this._filePath}.1`);
      } catch (e) {
        // Current file might not exist
      }

      // Delete the oldest if it exceeds maxFiles
      try {
        fs.unlinkSync(`${this._filePath}.${this._maxFiles + 1}`);
      } catch (e) {
        // Might not exist
      }

      this._currentFileSize = 0;
      this._wroteMetadata = false;
    } catch (err) {
      this.emit('error', err);
    }
  }
}

module.exports = {
  JsonlFileClient,
};
