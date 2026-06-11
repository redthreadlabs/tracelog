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
const {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
} = require('@aws-sdk/client-s3');

// S3 key layout is FIXED (not configurable): it is the contract between
// tracelog and the in-browser log viewer, which scans the bucket with
// prefix listings. Channel comes before interval so that prefix-scoped
// lifecycle rules work and a date-range scan within a channel is a single
// lexicographically-ordered listing:
//
//   {channel}/{interval}/{host}[_{seq}][_current].jsonl[.gz]
//
//   server/2026-06-11/172.31.27.225.jsonl.gz
//   server/2026-06-11/172.31.27.225_current.jsonl.gz
//   server/2026-06-11/172.31.27.225_1.jsonl.gz
//
// There is no serviceName segment: buckets are per-service/per-env, channel
// names are the top-level namespace (the default channel's name is set via
// the `defaultChannel` config), and the service name is recorded in every
// file's metadata line. The basename is underscore-delimited (hostnames
// cannot contain underscores): host, then a numeric size-rotation seq when
// > 0, then the literal 'current' for the live file. A host that died
// mid-interval leaves its final '_current' upload in place, interval intact.

class S3Uploader {
  /**
   * @param {Object} opts
   * @param {string} opts.bucket - S3 bucket name
   * @param {string} [opts.region] - AWS region
   * @param {string} [opts.accessKeyId] - AWS access key ID
   * @param {string} [opts.secretAccessKey] - AWS secret access key
   * @param {string} [opts.sessionToken] - AWS session token
   * @param {boolean} [opts.gzipCompleted=true] - Gzip completed files before upload
   * @param {boolean} [opts.gzipCurrent=true] - Gzip current files before upload
   * @param {Object} [opts.logger] - Logger instance
   * @param {Object} [opts.s3Client] - S3 client instance (must have a send() method).
   *   Defaults to a real S3Client from @aws-sdk/client-s3. Inject a mock for testing.
   * @param {Function} [opts.clock] - Clock provider for testability. Returns a Date.
   * @param {string} [opts.host] - Host label override (for testing). Defaults to
   *   the normalized os.hostname().
   */
  constructor(opts) {
    this._bucket = opts.bucket;
    this._host = opts.host || normalizeHost(os.hostname());
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
   * Upload a completed (rotated) file, then delete local on success. Also
   * deletes the now-superseded '_current' snapshot object for the same
   * interval/seq, so only hosts that died mid-interval leave one behind.
   * @param {string} filePath - Path to the completed JSONL file
   * @param {Object} vars - Key variables (channel, interval, seq)
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
    const key = this._buildKey(vars) + '.gz';
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
          this._deleteStaleCurrent(vars);
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
    const key = this._buildKey(vars);

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
        this._deleteStaleCurrent(vars);
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
   * Delete the '_current' snapshot object superseded by a successful
   * completed upload of the same channel/interval/seq. Best-effort:
   * missing objects and failures are ignored.
   */
  _deleteStaleCurrent(vars) {
    let key = this._buildKey({ ...vars, current: true });
    if (this._gzipCurrent) {
      key += '.gz';
    }

    this._pendingUploads++;
    this._s3
      .send(new DeleteObjectCommand({ Bucket: this._bucket, Key: key }))
      .then(() => {
        if (this._log) {
          this._log.debug('Deleted stale current log s3://%s/%s', this._bucket, key);
        }
      })
      .catch(() => { /* best-effort */ })
      .finally(() => {
        this._pendingUploads--;
      });
  }

  /**
   * Upload the current (incomplete) file without deletion. The key keeps
   * the file's real interval and carries a '_current' basename suffix, so
   * periodic uploads overwrite the same object, and the snapshot sorts
   * beside its finalized siblings.
   * @param {string} filePath - Path to the current JSONL file
   * @param {Object} vars - Key variables (channel, interval, seq)
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

    const currentVars = { ...vars, current: true };
    const rawBody = fs.readFileSync(filePath);

    if (this._gzipCurrent) {
      this._uploadCurrentGzipped(filePath, rawBody, currentVars, cb);
    } else {
      this._uploadCurrentRaw(filePath, rawBody, currentVars, cb);
    }
  }

  _uploadCurrentGzipped(filePath, rawBody, vars, cb) {
    const key = this._buildKey(vars) + '.gz';

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
    const key = this._buildKey(vars);

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
   * Build the S3 key for a log file (see the layout contract above).
   *
   * @param {Object} vars - Key variables:
   *   - {string} channel - Channel name (e.g. 'server', 'client')
   *   - {string} interval - Period label (e.g. '2026-03-17')
   *   - {number} [seq] - Size-rotation sequence number within the interval
   *   - {boolean} [current] - True for the live (incomplete) file snapshot
   */
  _buildKey(vars) {
    let basename = this._host;
    if (vars.seq > 0) {
      basename += `_${vars.seq}`;
    }
    if (vars.current) {
      basename += '_current';
    }
    return `${vars.channel}/${vars.interval}/${basename}.jsonl`;
  }

  _logError(fmt, ...args) {
    if (this._log) {
      this._log.error(fmt, ...args);
    }
  }
}

/**
 * Normalize a hostname into the host label used in S3 keys. EC2 internal
 * hostnames (ip-A-B-C-D or ip-A-B-C-D.ec2.internal etc.) become the dotted
 * IP address, which avoids embedding hyphens in the basename; any other
 * hostname is used as-is.
 */
function normalizeHost(hostname) {
  const m = /^ip-(\d{1,3})-(\d{1,3})-(\d{1,3})-(\d{1,3})(\..*)?$/.exec(hostname);
  if (m) {
    return `${m[1]}.${m[2]}.${m[3]}.${m[4]}`;
  }
  return hostname;
}

module.exports = { S3Uploader, normalizeHost };
