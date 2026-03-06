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
const DEFAULT_FLUSH_INTERVAL_MS = 1000;
const DEFAULT_ROTATION_SCHEDULE = 'daily';
const DEFAULT_MAX_LOCAL_RETENTION_DAYS = 0; // 0 = no cleanup
const DEFAULT_MAX_BUFFER_SIZE = 10000; // max events buffered before dropping oldest
const DEFAULT_S3_KEY_TEMPLATE =
  '{serviceName}/{environment}/{date}/{hostname}-{pid}-{timestamp}.jsonl';

// Map rotation schedule names to millisecond intervals.
const ROTATION_SCHEDULES = {
  hourly: 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
};

class JsonlFileClient extends EventEmitter {
  constructor(opts) {
    super();

    // Base path is used to derive timestamped file names.
    // e.g. /var/log/myapp/tracelog.jsonl -> /var/log/myapp/tracelog
    const filePath = opts.filePath || path.join(process.cwd(), 'tracelog.jsonl');
    const ext = path.extname(filePath); // .jsonl
    this._baseDir = path.dirname(filePath);
    this._baseName = path.basename(filePath, ext);
    this._ext = ext || '.jsonl';

    this._maxFileSize = opts.maxFileSize || DEFAULT_MAX_FILE_SIZE;
    this._flushIntervalMs = opts.flushIntervalMs || DEFAULT_FLUSH_INTERVAL_MS;
    this._maxLocalRetentionDays =
      opts.maxLocalRetentionDays != null
        ? opts.maxLocalRetentionDays
        : DEFAULT_MAX_LOCAL_RETENTION_DAYS;
    this._maxBufferSize = opts.maxBufferSize || DEFAULT_MAX_BUFFER_SIZE;
    this._log = opts.logger || null;

    // Clock provider for testability. Must return a Date instance.
    this._clock = opts.clock || (() => new Date());

    // Rotation schedule
    const schedule = opts.rotationSchedule || DEFAULT_ROTATION_SCHEDULE;
    if (typeof schedule === 'string' && ROTATION_SCHEDULES[schedule]) {
      this._rotationIntervalMs = ROTATION_SCHEDULES[schedule];
    } else if (typeof schedule === 'number' && schedule > 0) {
      this._rotationIntervalMs = schedule;
    } else {
      this._rotationIntervalMs = ROTATION_SCHEDULES.daily;
    }

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

    // S3 uploader (optional)
    this._s3Uploader = opts.s3Uploader || null;
    this._s3UploadIntervalMs = opts.s3UploadIntervalMs || 0;
    this._s3UploadTimer = null;

    // Track current time period and sequence number for file naming.
    this._currentPeriodLabel = this._getPeriodLabel(this._clock());
    this._currentSeqNum = 0;
    this._currentFilePath = this._buildFilePath(
      this._currentPeriodLabel,
      this._currentSeqNum,
    );

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

    // If the current file already exists, pick up where we left off.
    this._resumeExistingFile();

    // Ensure the output directory exists.
    fs.mkdirSync(this._baseDir, { recursive: true });

    // Upload any orphaned files from previous runs to S3.
    if (this._s3Uploader) {
      this._uploadOrphanedFiles();
    }

    // Start periodic flush.
    this._flushTimer = setInterval(() => {
      this._flushBuffer();
    }, this._flushIntervalMs);
    this._flushTimer.unref();

    // Start periodic S3 upload of current file.
    if (this._s3Uploader && this._s3UploadIntervalMs > 0) {
      this._s3UploadTimer = setInterval(() => {
        this._s3Uploader.uploadCurrent(this._currentFilePath);
      }, this._s3UploadIntervalMs);
      this._s3UploadTimer.unref();
    }
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

  sendEvent(event, cb) {
    this._send('event', event, cb);
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
    if (this._s3UploadTimer) {
      clearInterval(this._s3UploadTimer);
      this._s3UploadTimer = null;
    }

    this._flushBuffer();

    // Final upload of the current (incomplete) file.
    if (this._s3Uploader) {
      this._s3Uploader.uploadCurrent(this._currentFilePath);
    }
  }

  // --- Internal methods ---

  _send(type, data, cb) {
    if (this._destroyed) {
      if (cb) process.nextTick(cb);
      return;
    }

    try {
      const truncated = truncate[type]
        ? truncate[type](data, this._truncOpts)
        : data;

      const obj = {};
      obj[type] = truncated;
      const line = ndjson.serialize(obj);

      // Backpressure: drop oldest events if buffer is full.
      if (this._buffer.length >= this._maxBufferSize) {
        this._buffer.shift();
      }
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

    metadata = this._metadataFilters.process(metadata);
    if (!metadata) return null;

    return ndjson.serialize({ metadata });
  }

  _flushBuffer() {
    if (this._buffer.length === 0) return;

    try {
      // Check if the time period has rolled over.
      this._checkTimeRotation();

      // Drain the buffer, rotating when the file exceeds maxFileSize.
      const lines = this._buffer;
      this._buffer = [];

      for (const line of lines) {
        // Check size-based rotation before each line.
        if (this._currentFileSize >= this._maxFileSize) {
          this._rotate();
          this._currentSeqNum++;
          this._currentFilePath = this._buildFilePath(
            this._currentPeriodLabel,
            this._currentSeqNum,
          );
        }

        // Write metadata at the start of a new file.
        let output = '';
        if (!this._wroteMetadata) {
          if (!this._cloudMetadataReady) {
            // Put remaining lines back and wait for cloud metadata.
            this._buffer.unshift(line);
            return;
          }
          const metadataLine = this._getMetadataLine();
          if (metadataLine) {
            output += metadataLine;
          }
          this._wroteMetadata = true;
        }

        output += line;
        fs.appendFileSync(this._currentFilePath, output, 'utf8');
        this._currentFileSize += Buffer.byteLength(output, 'utf8');
      }
    } catch (err) {
      this.emit('error', err);
    }
  }

  _checkTimeRotation() {
    const now = this._clock();
    const periodLabel = this._getPeriodLabel(now);
    if (periodLabel !== this._currentPeriodLabel) {
      this._rotate();
      this._currentPeriodLabel = periodLabel;
      this._currentSeqNum = 0;
      this._currentFilePath = this._buildFilePath(periodLabel, 0);
    }
  }

  _rotate() {
    const completedFilePath = this._currentFilePath;

    // Reset state for the new file.
    this._currentFileSize = 0;
    this._wroteMetadata = false;

    // Upload the completed file to S3 (async: gzip, upload, delete).
    if (this._s3Uploader && fs.existsSync(completedFilePath)) {
      this._s3Uploader.uploadCompleted(completedFilePath);
    }

    // Clean up old local files if retention is configured.
    if (this._maxLocalRetentionDays > 0) {
      this._cleanupOldFiles();
    }
  }

  /**
   * Delete local log files older than maxLocalRetentionDays.
   * Determines file age by parsing the date from the filename rather than
   * relying on filesystem mtime.
   */
  _cleanupOldFiles() {
    try {
      const cutoff = new Date(
        this._clock().getTime() -
          this._maxLocalRetentionDays * 24 * 60 * 60 * 1000,
      );
      const cutoffLabel = this._getPeriodLabel(cutoff);
      const prefix = this._baseName + '-';
      const files = fs.readdirSync(this._baseDir);

      for (const file of files) {
        if (!file.startsWith(prefix) || !file.endsWith(this._ext)) {
          continue;
        }

        const filePath = path.join(this._baseDir, file);

        // Skip the current file.
        if (filePath === this._currentFilePath) {
          continue;
        }

        // Extract the period label from the filename.
        // e.g. "tracelog-2026-06-10.jsonl" -> "2026-06-10"
        // e.g. "tracelog-2026-06-10.2.jsonl" -> "2026-06-10"
        const withoutPrefix = file.slice(prefix.length);
        const withoutExt = withoutPrefix.slice(
          0,
          withoutPrefix.length - this._ext.length,
        );
        // Strip any ".N" sequence suffix
        const periodLabel = withoutExt.replace(/\.\d+$/, '');

        if (periodLabel <= cutoffLabel) {
          try {
            fs.unlinkSync(filePath);
            if (this._log) {
              this._log.debug('Deleted old log file: %s', file);
            }
          } catch (e) {
            // File may have been deleted by S3 uploader; ignore.
          }
        }
      }
    } catch (e) {
      // Directory read failure; not critical.
    }
  }

  /**
   * Build the timestamped file path.
   * e.g. /var/log/myapp/tracelog-2026-03-06T14.jsonl
   *      /var/log/myapp/tracelog-2026-03-06T14.1.jsonl (size rotation)
   */
  _buildFilePath(periodLabel, seqNum) {
    const seq = seqNum > 0 ? `.${seqNum}` : '';
    return path.join(
      this._baseDir,
      `${this._baseName}-${periodLabel}${seq}${this._ext}`,
    );
  }

  /**
   * Generate the period label for a given timestamp based on the rotation schedule.
   * - daily:  '2026-03-06'
   * - hourly: '2026-03-06T14'
   * - custom intervals less than daily include the hour.
   */
  _getPeriodLabel(date) {
    const y = date.getFullYear();
    const m = _pad2(date.getMonth() + 1);
    const d = _pad2(date.getDate());

    if (this._rotationIntervalMs >= 24 * 60 * 60 * 1000) {
      return `${y}-${m}-${d}`;
    }

    const h = _pad2(date.getHours());

    if (this._rotationIntervalMs >= 60 * 60 * 1000) {
      return `${y}-${m}-${d}T${h}`;
    }

    // Sub-hourly: include minutes, floored to the interval boundary.
    const min = date.getMinutes();
    const intervalMinutes = Math.floor(this._rotationIntervalMs / (60 * 1000));
    const flooredMin = Math.floor(min / intervalMinutes) * intervalMinutes;
    return `${y}-${m}-${d}T${h}${_pad2(flooredMin)}`;
  }

  /**
   * On startup, check if there's an existing file for the current period
   * and resume appending to it.
   */
  _resumeExistingFile() {
    // Find the highest sequence number for the current period.
    let seq = 0;
    while (true) {
      const candidate = this._buildFilePath(this._currentPeriodLabel, seq + 1);
      if (fs.existsSync(candidate)) {
        seq = seq + 1;
      } else {
        break;
      }
    }

    this._currentSeqNum = seq;
    this._currentFilePath = this._buildFilePath(
      this._currentPeriodLabel,
      this._currentSeqNum,
    );

    try {
      const stat = fs.statSync(this._currentFilePath);
      this._currentFileSize = stat.size;
      this._wroteMetadata = true; // Existing file, assume metadata already written.
    } catch (e) {
      // File doesn't exist yet, that's fine.
    }
  }

  /**
   * On startup, find any orphaned log files from previous runs (files from
   * older time periods) and upload them to S3 as completed files.
   */
  _uploadOrphanedFiles() {
    try {
      const prefix = this._baseName + '-';
      const files = fs.readdirSync(this._baseDir);

      for (const file of files) {
        if (!file.startsWith(prefix) || !file.endsWith(this._ext)) {
          continue;
        }

        const filePath = path.join(this._baseDir, file);

        // Skip the current file — it's still being written to.
        if (filePath === this._currentFilePath) {
          continue;
        }

        // Extract the period label from the filename.
        const withoutPrefix = file.slice(prefix.length);
        const withoutExt = withoutPrefix.slice(
          0,
          withoutPrefix.length - this._ext.length,
        );
        const periodLabel = withoutExt.replace(/\.\d+$/, '');

        // Only upload files from older periods (not current).
        if (periodLabel < this._currentPeriodLabel) {
          if (this._log) {
            this._log.debug('Uploading orphaned log file: %s', file);
          }
          this._s3Uploader.uploadCompleted(filePath);
        }
      }
    } catch (e) {
      // Directory read failure; not critical.
    }
  }
}

function _pad2(n) {
  return String(n).padStart(2, '0');
}

module.exports = {
  JsonlFileClient,
};
