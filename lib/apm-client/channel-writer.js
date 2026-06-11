/*
 * Copyright Red Thread Labs LLC. All rights reserved.
 * Licensed under the BSD 2-Clause License; you may not use this file except in
 * compliance with the BSD 2-Clause License.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ndjson = require('./ndjson');
const truncate = require('./truncate');

const DEFAULT_MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB
const DEFAULT_MAX_BUFFER_SIZE = 10000;

const ROTATION_SCHEDULES = {
  hourly: 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
};

/**
 * A ChannelWriter manages a single JSONL file stream for a named channel.
 * It handles buffering, rotation (time-based and size-based), metadata
 * writing, and S3 upload coordination.
 */
class ChannelWriter {
  /**
   * @param {Object} opts
   * @param {string} opts.channel - Channel name (e.g. 'server', 'client')
   * @param {string} opts.baseDir - Output directory
   * @param {string} opts.baseName - File prefix (e.g. 'tracelog')
   * @param {Object} opts.truncOpts - Truncation options
   * @param {Object} opts.metadata - Metadata object to write at start of each file
   * @param {Object} [opts.metadataFilters] - Metadata filter chain
   * @param {Object} [opts.s3Uploader] - S3 uploader instance
   * @param {number} [opts.maxFileSize] - Max file size before rotation
   * @param {number} [opts.maxBufferSize] - Max buffered lines before dropping oldest
   * @param {string|number} [opts.rotationSchedule] - 'daily', 'hourly', or ms
   * @param {number} [opts.maxLocalRetentionDays] - Auto-delete old files after N days
   * @param {Function} [opts.clock] - Clock provider for testability
   * @param {Object} [opts.logger] - Logger instance
   */
  constructor(opts) {
    this._channel = opts.channel;
    this._baseDir = opts.baseDir;
    this._baseName = `${opts.baseName}-${opts.channel}`;
    this._ext = '.jsonl';

    this._maxFileSize = opts.maxFileSize || DEFAULT_MAX_FILE_SIZE;
    this._maxBufferSize = opts.maxBufferSize || DEFAULT_MAX_BUFFER_SIZE;
    this._maxLocalRetentionDays = opts.maxLocalRetentionDays || 0;
    this._truncOpts = opts.truncOpts;
    this._metadata = opts.metadata;
    this._metadataFilters = opts.metadataFilters;
    this._extraMetadata = opts.extraMetadata || null;
    this._metadataReady = opts.metadataReady || null;
    this._s3Uploader = opts.s3Uploader || null;
    this._clock = opts.clock || (() => new Date());
    this._log = opts.logger || null;

    // How long flush() may hold the first write waiting for asynchronously
    // fetched metadata (e.g. cloud) before proceeding without it.
    this._metadataWaitDeadline = this._clock().getTime() + 10 * 1000;

    // Rotation schedule
    const schedule = opts.rotationSchedule || 'daily';
    if (typeof schedule === 'string' && ROTATION_SCHEDULES[schedule]) {
      this._rotationIntervalMs = ROTATION_SCHEDULES[schedule];
    } else if (typeof schedule === 'number' && schedule > 0) {
      this._rotationIntervalMs = schedule;
    } else {
      this._rotationIntervalMs = ROTATION_SCHEDULES.daily;
    }

    this._buffer = [];
    this._currentFileSize = 0;
    this._wroteMetadata = false;
    this._destroyed = false;

    // Track current time period and sequence number for file naming.
    this._currentPeriodLabel = this._getPeriodLabel(this._clock());
    this._currentSeqNum = 0;
    this._currentFilePath = this._buildFilePath(
      this._currentPeriodLabel,
      this._currentSeqNum,
    );

    // Resume existing file if present.
    this._resumeExistingFile();

    // Upload any orphaned files from previous runs.
    if (this._s3Uploader) {
      this._uploadOrphanedFiles();
    }
  }

  get channel() {
    return this._channel;
  }

  get currentFilePath() {
    return this._currentFilePath;
  }

  send(type, data, cb) {
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

      if (this._buffer.length >= this._maxBufferSize) {
        this._buffer.shift();
      }
      this._buffer.push(line);
    } catch (err) {
      if (this._log) {
        this._log.error('ChannelWriter[%s] serialize error: %s', this._channel, err.message);
      }
    }

    if (cb) {
      process.nextTick(cb);
    }
  }

  flush(opts) {
    if (this._buffer.length === 0) return;

    // Hold the first write of a file until asynchronously fetched metadata
    // (cloud) is ready, so the file's metadata line is complete. The wait
    // is bounded twice over: the fetcher's own timeout flips the readiness
    // flag, and the hard deadline covers a callback that never fires.
    if (
      !(opts && opts.force) &&
      this._metadataReady &&
      !this._wroteMetadata &&
      !this._metadataReady() &&
      this._clock().getTime() < this._metadataWaitDeadline
    ) {
      return;
    }

    try {
      this._checkTimeRotation();

      const lines = this._buffer;
      this._buffer = [];

      for (const line of lines) {
        if (this._currentFileSize >= this._maxFileSize) {
          this._rotate();
          this._currentSeqNum++;
          this._currentFilePath = this._buildFilePath(
            this._currentPeriodLabel,
            this._currentSeqNum,
          );
        }

        let output = '';
        if (!this._wroteMetadata) {
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
      if (this._log) {
        this._log.error('ChannelWriter[%s] flush error: %s', this._channel, err.message);
      }
    }
  }

  uploadCurrent() {
    if (this._s3Uploader) {
      this._s3Uploader.uploadCurrent(this._currentFilePath, {
        channel: this._channel,
        interval: this._currentPeriodLabel,
        seq: this._currentSeqNum,
      });
    }
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    // Force: never hold buffered records back at shutdown, even if
    // asynchronously fetched metadata never became ready.
    this.flush({ force: true });
    this.uploadCurrent();
  }

  setExtraMetadata(metadata) {
    this._extraMetadata = metadata;
  }

  // --- Internal methods ---

  _getMetadataLine() {
    let metadata = Object.assign({}, this._metadata);
    if (this._extraMetadata) {
      metadata = Object.assign(metadata, this._extraMetadata);
    }
    if (this._metadataFilters) {
      metadata = this._metadataFilters.process(metadata);
    }
    if (!metadata) return null;
    metadata.channel = this._channel;
    return ndjson.serialize({ metadata });
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
    this._currentFileSize = 0;
    this._wroteMetadata = false;

    if (this._s3Uploader && fs.existsSync(completedFilePath)) {
      this._s3Uploader.uploadCompleted(completedFilePath, {
        channel: this._channel,
        interval: this._currentPeriodLabel,
        seq: this._currentSeqNum,
      });
    }

    if (this._maxLocalRetentionDays > 0) {
      this._cleanupOldFiles();
    }
  }

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
        if (!file.startsWith(prefix) || !file.endsWith(this._ext)) continue;
        const filePath = path.join(this._baseDir, file);
        if (filePath === this._currentFilePath) continue;

        const withoutPrefix = file.slice(prefix.length);
        const withoutExt = withoutPrefix.slice(0, withoutPrefix.length - this._ext.length);
        const periodLabel = withoutExt.replace(/\.\d+$/, '');

        if (periodLabel <= cutoffLabel) {
          try { fs.unlinkSync(filePath); } catch (e) { /* ignore */ }
        }
      }
    } catch (e) { /* ignore */ }
  }

  _buildFilePath(periodLabel, seqNum) {
    const seq = seqNum > 0 ? `.${seqNum}` : '';
    return path.join(
      this._baseDir,
      `${this._baseName}-${periodLabel}${seq}${this._ext}`,
    );
  }

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

    const min = date.getMinutes();
    const intervalMinutes = Math.floor(this._rotationIntervalMs / (60 * 1000));
    const flooredMin = Math.floor(min / intervalMinutes) * intervalMinutes;
    return `${y}-${m}-${d}T${h}${_pad2(flooredMin)}`;
  }

  _resumeExistingFile() {
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
      this._wroteMetadata = true;
    } catch (e) {
      // File doesn't exist yet.
    }
  }

  _uploadOrphanedFiles() {
    try {
      const prefix = this._baseName + '-';
      const files = fs.readdirSync(this._baseDir);

      for (const file of files) {
        if (!file.startsWith(prefix) || !file.endsWith(this._ext)) continue;
        const filePath = path.join(this._baseDir, file);
        if (filePath === this._currentFilePath) continue;

        const withoutPrefix = file.slice(prefix.length);
        const withoutExt = withoutPrefix.slice(0, withoutPrefix.length - this._ext.length);
        const seqMatch = /\.(\d+)$/.exec(withoutExt);
        const periodLabel = withoutExt.replace(/\.\d+$/, '');

        if (periodLabel < this._currentPeriodLabel) {
          this._s3Uploader.uploadCompleted(filePath, {
            channel: this._channel,
            interval: periodLabel,
            seq: seqMatch ? parseInt(seqMatch[1], 10) : 0,
          });
        }
      }
    } catch (e) { /* ignore */ }
  }
}

function _pad2(n) {
  return String(n).padStart(2, '0');
}

module.exports = { ChannelWriter };
