/*
 * Copyright Shaxpir Inc. All rights reserved.
 * Licensed under the BSD 2-Clause License; you may not use this file except in
 * compliance with the BSD 2-Clause License.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createGzip } = require('zlib');
const { pipeline } = require('stream');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

class S3Uploader {
  /**
   * @param {Object} opts
   * @param {string} opts.bucket - S3 bucket name
   * @param {string} opts.keyTemplate - S3 key template with {variable} placeholders
   * @param {string} [opts.region] - AWS region
   * @param {string} [opts.accessKeyId] - AWS access key ID
   * @param {string} [opts.secretAccessKey] - AWS secret access key
   * @param {string} [opts.sessionToken] - AWS session token
   * @param {string} opts.serviceName - Service name for template variables
   * @param {string} [opts.environment] - Environment for template variables
   * @param {Object} [opts.logger] - Logger instance
   * @param {Object} [opts.s3Client] - S3 client instance (must have a send() method).
   *   Defaults to a real S3Client from @aws-sdk/client-s3. Inject a mock for testing.
   * @param {Function} [opts.clock] - Clock provider for testability. Returns a Date.
   */
  constructor(opts) {
    this._bucket = opts.bucket;
    this._keyTemplate = opts.keyTemplate;
    this._serviceName = opts.serviceName || 'unknown';
    this._environment = opts.environment || 'development';
    this._log = opts.logger || null;

    // Clock provider for testability.
    this._clock = opts.clock || (() => new Date());

    // S3 client abstraction: inject a mock for testing, or use the real SDK.
    if (opts.s3Client) {
      this._s3 = opts.s3Client;
    } else {
      const clientOpts = {};
      if (opts.region) {
        clientOpts.region = opts.region;
      }
      if (opts.accessKeyId && opts.secretAccessKey) {
        clientOpts.credentials = {
          accessKeyId: opts.accessKeyId,
          secretAccessKey: opts.secretAccessKey,
        };
        if (opts.sessionToken) {
          clientOpts.credentials.sessionToken = opts.sessionToken;
        }
      }
      this._s3 = new S3Client(clientOpts);
    }

    this._pendingUploads = 0;
  }

  /**
   * Upload a completed (rotated) file: gzip it, upload, delete local on success.
   * @param {string} filePath - Path to the completed JSONL file
   */
  uploadCompleted(filePath) {
    if (!fs.existsSync(filePath)) return;

    const key = this._resolveKey(filePath) + '.gz';
    const gzPath = filePath + '.gz';

    this._pendingUploads++;

    // Gzip the file
    const readStream = fs.createReadStream(filePath);
    const gzip = createGzip();
    const writeStream = fs.createWriteStream(gzPath);

    pipeline(readStream, gzip, writeStream, (err) => {
      if (err) {
        this._logError('Failed to gzip %s: %s', filePath, err.message);
        this._pendingUploads--;
        return;
      }

      // Upload the gzipped file
      const body = fs.createReadStream(gzPath);
      const command = new PutObjectCommand({
        Bucket: this._bucket,
        Key: key,
        Body: body,
        ContentType: 'application/x-ndjson',
        ContentEncoding: 'gzip',
      });

      this._s3
        .send(command)
        .then(() => {
          if (this._log) {
            this._log.debug('Uploaded completed log to s3://%s/%s', this._bucket, key);
          }
          // Delete both the original and gzipped local files
          try { fs.unlinkSync(filePath); } catch (e) { /* ignore */ }
          try { fs.unlinkSync(gzPath); } catch (e) { /* ignore */ }
        })
        .catch((uploadErr) => {
          this._logError(
            'Failed to upload %s to S3: %s',
            filePath,
            uploadErr.message,
          );
          // Clean up the gzipped file but keep the original
          try { fs.unlinkSync(gzPath); } catch (e) { /* ignore */ }
        })
        .finally(() => {
          this._pendingUploads--;
        });
    });
  }

  /**
   * Upload the current (incomplete) file as-is, without gzip or deletion.
   * @param {string} filePath - Path to the current JSONL file
   * @param {Function} [cb] - Callback when upload completes
   */
  uploadCurrent(filePath, cb) {
    if (!fs.existsSync(filePath)) {
      if (cb) process.nextTick(cb);
      return;
    }

    const key = this._resolveKey(filePath);

    this._pendingUploads++;

    const body = fs.readFileSync(filePath);
    const command = new PutObjectCommand({
      Bucket: this._bucket,
      Key: key,
      Body: body,
      ContentType: 'application/x-ndjson',
    });

    this._s3
      .send(command)
      .then(() => {
        if (this._log) {
          this._log.debug('Uploaded current log to s3://%s/%s', this._bucket, key);
        }
      })
      .catch((err) => {
        this._logError(
          'Failed to upload current log to S3: %s',
          err.message,
        );
      })
      .finally(() => {
        this._pendingUploads--;
        if (cb) cb();
      });
  }

  /**
   * Resolve the S3 key from the template and file path.
   */
  _resolveKey(filePath) {
    const now = this._clock();
    const vars = {
      serviceName: this._serviceName,
      environment: this._environment,
      hostname: os.hostname(),
      pid: String(process.pid),
      date: _fmtDate(now),
      year: String(now.getFullYear()),
      month: _pad2(now.getMonth() + 1),
      day: _pad2(now.getDate()),
      hour: _pad2(now.getHours()),
      minute: _pad2(now.getMinutes()),
      timestamp: String(Math.floor(now.getTime() / 1000)),
      filename: path.basename(filePath),
    };

    return this._keyTemplate.replace(/\{(\w+)\}/g, (match, name) => {
      return vars[name] !== undefined ? vars[name] : match;
    });
  }

  _logError(fmt, ...args) {
    if (this._log) {
      this._log.error(fmt, ...args);
    }
  }
}

function _pad2(n) {
  return String(n).padStart(2, '0');
}

function _fmtDate(d) {
  return `${d.getFullYear()}-${_pad2(d.getMonth() + 1)}-${_pad2(d.getDate())}`;
}

module.exports = { S3Uploader };
