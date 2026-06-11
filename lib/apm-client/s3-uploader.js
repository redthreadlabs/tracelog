/*
 * Copyright Red Thread Labs LLC. All rights reserved.
 * Licensed under the BSD 2-Clause License; you may not use this file except in
 * compliance with the BSD 2-Clause License.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
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
   * @param {boolean} [opts.gzipCompleted=true] - Gzip completed files before upload
   * @param {boolean} [opts.gzipCurrent=true] - Gzip current files before upload
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
    this._gzipCompleted = opts.gzipCompleted !== false;
    this._gzipCurrent = opts.gzipCurrent !== false;
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
   * Upload a completed (rotated) file, then delete local on success.
   * @param {string} filePath - Path to the completed JSONL file
   * @param {Object} vars - Template variables (channel, interval)
   */
  uploadCompleted(filePath, vars) {
    if (!fs.existsSync(filePath)) return;

    if (this._gzipCompleted) {
      this._uploadCompletedGzipped(filePath, vars);
    } else {
      this._uploadCompletedRaw(filePath, vars);
    }
  }

  _uploadCompletedGzipped(filePath, vars) {
    const key = this._resolveKey(vars) + '.gz';
    const gzPath = filePath + '.gz';

    this._pendingUploads++;

    const readStream = fs.createReadStream(filePath);
    const gzip = createGzip();
    const writeStream = fs.createWriteStream(gzPath);

    pipeline(readStream, gzip, writeStream, (err) => {
      if (err) {
        this._logError('Failed to gzip %s: %s', filePath, err.message);
        this._pendingUploads--;
        return;
      }

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
          try { fs.unlinkSync(filePath); } catch (e) { /* ignore */ }
          try { fs.unlinkSync(gzPath); } catch (e) { /* ignore */ }
        })
        .catch((uploadErr) => {
          this._logError(
            'Failed to upload %s to S3: %s',
            filePath,
            uploadErr.message,
          );
          try { fs.unlinkSync(gzPath); } catch (e) { /* ignore */ }
        })
        .finally(() => {
          this._pendingUploads--;
        });
    });
  }

  _uploadCompletedRaw(filePath, vars) {
    const key = this._resolveKey(vars);

    this._pendingUploads++;

    const body = fs.createReadStream(filePath);
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
          this._log.debug('Uploaded completed log to s3://%s/%s', this._bucket, key);
        }
        try { fs.unlinkSync(filePath); } catch (e) { /* ignore */ }
      })
      .catch((uploadErr) => {
        this._logError(
          'Failed to upload %s to S3: %s',
          filePath,
          uploadErr.message,
        );
      })
      .finally(() => {
        this._pendingUploads--;
      });
  }

  /**
   * Upload the current (incomplete) file without deletion.
   * Uses a stable S3 key (based on the filename, not a timestamp) so that
   * each upload overwrites the previous snapshot instead of creating duplicates.
   * @param {string} filePath - Path to the current JSONL file
   * @param {Function} [cb] - Callback when upload completes
   */
  /**
   * Upload the current (incomplete) file without deletion.
   * Uses 'current' as the interval so periodic uploads overwrite the same object.
   * @param {string} filePath - Path to the current JSONL file
   * @param {Object} vars - Template variables (channel); interval is set to 'current'
   * @param {Function} [cb] - Callback when upload completes
   */
  uploadCurrent(filePath, vars, cb) {
    if (typeof vars === 'function') {
      cb = vars;
      vars = {};
    }
    if (!fs.existsSync(filePath)) {
      if (cb) process.nextTick(cb);
      return;
    }

    const currentVars = { ...vars, interval: 'current' };
    const rawBody = fs.readFileSync(filePath);

    if (this._gzipCurrent) {
      this._uploadCurrentGzipped(filePath, rawBody, currentVars, cb);
    } else {
      this._uploadCurrentRaw(filePath, rawBody, currentVars, cb);
    }
  }

  _uploadCurrentGzipped(filePath, rawBody, vars, cb) {
    const key = this._resolveKey(vars) + '.gz';

    this._pendingUploads++;

    zlib.gzip(rawBody, (err, compressed) => {
      if (err) {
        this._logError('Failed to gzip current log: %s', err.message);
        this._pendingUploads--;
        if (cb) cb();
        return;
      }

      const command = new PutObjectCommand({
        Bucket: this._bucket,
        Key: key,
        Body: compressed,
        ContentType: 'application/x-ndjson',
        ContentEncoding: 'gzip',
      });

      this._s3
        .send(command)
        .then(() => {
          if (this._log) {
            this._log.debug('Uploaded current log to s3://%s/%s', this._bucket, key);
          }
        })
        .catch((uploadErr) => {
          this._logError(
            'Failed to upload current log to S3: %s',
            uploadErr.message,
          );
        })
        .finally(() => {
          this._pendingUploads--;
          if (cb) cb();
        });
    });
  }

  _uploadCurrentRaw(filePath, rawBody, vars, cb) {
    const key = this._resolveKey(vars);

    this._pendingUploads++;

    const command = new PutObjectCommand({
      Bucket: this._bucket,
      Key: key,
      Body: rawBody,
      ContentType: 'application/x-ndjson',
    });

    this._s3
      .send(command)
      .then(() => {
        if (this._log) {
          this._log.debug('Uploaded current log to s3://%s/%s', this._bucket, key);
        }
      })
      .catch((uploadErr) => {
        this._logError(
          'Failed to upload current log to S3: %s',
          uploadErr.message,
        );
      })
      .finally(() => {
        this._pendingUploads--;
        if (cb) cb();
      });
  }

  /**
   * Resolve an S3 key from the template.
   *
   * @param {Object} vars - Template variables:
   *   - {string} channel - Channel name (e.g. 'server', 'client')
   *   - {string} interval - Period label (e.g. '2026-03-17') or 'current'
   */
  _resolveKey(vars) {
    const allVars = {
      serviceName: this._serviceName,
      environment: this._environment,
      hostname: os.hostname(),
      ...vars,
    };

    return this._keyTemplate.replace(/\{(\w+)\}/g, (match, name) => {
      return allVars[name] !== undefined ? allVars[name] : match;
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
