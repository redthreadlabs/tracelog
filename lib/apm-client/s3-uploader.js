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
const { pipeline, Transform, Writable } = require('stream');
const { StringDecoder } = require('string_decoder');
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

// Every log object gets a tiny JSON sidecar at `<logkey>.meta.json` carrying
// the facts the gzipped body hides: uncompressed size, record count, and an
// hourly interval×kind histogram of the records inside. The histogram matters
// because buffered remote clients (tracelog-client) can land records from a
// past day in today's file — so a file's nominal interval is a filing label,
// not a truthful description of its contents. The viewer reads these into its
// size ledger for deterministic memory/cache accounting and factual rollups,
// and falls back to estimation for files written before sidecars existed.
const SIDECAR_VERSION = 1;
const SIDECAR_SUFFIX = '.meta.json';

function _pad2(n) {
  return String(n).padStart(2, '0');
}

/** epoch-ms → UTC hour-bucket label 'YYYY-MM-DDTHH' (matches the viewer). */
function _hourBucket(ms) {
  const d = new Date(ms);
  return (
    `${d.getUTCFullYear()}-${_pad2(d.getUTCMonth() + 1)}-${_pad2(d.getUTCDate())}` +
    `T${_pad2(d.getUTCHours())}`
  );
}

function _safeSize(p) {
  try {
    return fs.statSync(p).size;
  } catch (e) {
    return 0;
  }
}

/**
 * Derives a log file's sidecar histogram by parsing its NDJSON lines. The file
 * on disk is the source of truth: counts come from the exact bytes being
 * uploaded, so they cannot drift from the object, and a restart (which wipes
 * any in-memory write-time counters) or an orphaned file from a crashed run is
 * handled for free — we just re-derive from the file.
 *
 * Tolerant by design: an unparseable line is skipped (not a record); a record
 * with a missing/garbage timestamp is counted as `malformed` rather than
 * forced into an interval. Append-only safe: addChunk may be fed successive
 * tails of a growing current file, since every line is newline-terminated so
 * chunk/offset boundaries always land between lines.
 */
class MetaAccumulator {
  constructor() {
    this.offset = 0; // bytes consumed so far (for incremental current parsing)
    this.records = 0;
    this.malformed = 0;
    this.intervals = Object.create(null); // { 'YYYY-MM-DDTHH': { kind: count } }
    this._partial = '';
  }

  addChunk(text) {
    if (!text) return;
    const s = this._partial + text;
    let start = 0;
    let nl;
    while ((nl = s.indexOf('\n', start)) !== -1) {
      this._addLine(s.slice(start, nl));
      start = nl + 1;
    }
    this._partial = s.slice(start);
  }

  flushPartial() {
    if (this._partial) {
      this._addLine(this._partial);
      this._partial = '';
    }
  }

  _addLine(line) {
    const t = line.trim();
    if (!t) return;
    let obj;
    try {
      obj = JSON.parse(t);
    } catch (e) {
      return; // corrupt line — not a countable record (the viewer skips it too)
    }
    if (!obj || typeof obj !== 'object') return;
    const kind = Object.keys(obj)[0];
    if (!kind || kind === 'metadata') return; // the file's metadata line
    this.records++;
    const body = obj[kind];
    const tsUs =
      body &&
      typeof body.timestamp === 'number' &&
      isFinite(body.timestamp) &&
      body.timestamp > 0
        ? body.timestamp
        : 0;
    if (!tsUs) {
      this.malformed++;
      return;
    }
    const bucket = _hourBucket(tsUs / 1000); // serialized timestamps are epoch-µs
    const byKind =
      this.intervals[bucket] || (this.intervals[bucket] = Object.create(null));
    byKind[kind] = (byKind[kind] || 0) + 1;
  }

  /**
   * The sidecar object for this file. records === malformed + Σ(intervals).
   *
   * Keys are emitted in a fixed, sorted order at every level — top-level fields
   * in schema order, interval buckets and their kinds sorted lexically — so the
   * same contents always serialize to byte-identical JSON regardless of the
   * order records arrived in. That makes a sidecar's ETag a reliable
   * sameness check.
   */
  toMeta(interval, bytes, compressed) {
    const intervals = Object.create(null);
    for (const hour of Object.keys(this.intervals).sort()) {
      const src = this.intervals[hour];
      const sorted = Object.create(null);
      for (const kind of Object.keys(src).sort()) sorted[kind] = src[kind];
      intervals[hour] = sorted;
    }
    return {
      v: SIDECAR_VERSION,
      interval,
      bytes,
      compressed,
      records: this.records,
      malformed: this.malformed,
      intervals,
    };
  }
}

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

    // Incremental sidecar accumulators for in-progress current files, keyed by
    // their S3 key. Each periodic uploadCurrent parses only the newly-appended
    // bytes; a restart drops this map, so the next upload re-parses the file
    // from byte 0 once and resumes incremental — the file always wins.
    this._currentAccs = new Map();
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

    // Count records while the bytes stream through to gzip — one read pass,
    // no extra memory. StringDecoder keeps multi-byte chars whole across chunk
    // boundaries.
    const acc = new MetaAccumulator();
    const decoder = new StringDecoder('utf8');
    const readStream = fs.createReadStream(filePath);
    const counter = new Transform({
      transform(chunk, enc, cb) {
        try { acc.addChunk(decoder.write(chunk)); } catch (e) { /* never break upload */ }
        cb(null, chunk);
      },
    });
    const gzip = createGzip();
    const writeStream = fs.createWriteStream(gzPath);

    pipeline(readStream, counter, gzip, writeStream, (err) => {
      if (err) {
        this._logError('Failed to gzip %s: %s', filePath, err.message);
        this._pendingUploads--;
        return;
      }
      try { acc.addChunk(decoder.end()); acc.flushPartial(); } catch (e) { /* ignore */ }

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
          this._uploadSidecar(key, vars.interval, _safeSize(filePath), _safeSize(gzPath), acc);
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

    // Count records in a streaming pass (no gzip here), then upload the file.
    const acc = new MetaAccumulator();
    const decoder = new StringDecoder('utf8');
    const sink = new Writable({
      write(chunk, enc, cb) {
        try { acc.addChunk(decoder.write(chunk)); } catch (e) { /* ignore */ }
        cb();
      },
    });

    pipeline(fs.createReadStream(filePath), sink, (err) => {
      if (err) {
        this._logError('Failed to read %s: %s', filePath, err.message);
        this._pendingUploads--;
        return;
      }
      try { acc.addChunk(decoder.end()); acc.flushPartial(); } catch (e) { /* ignore */ }

      const bytes = _safeSize(filePath);
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
          this._uploadSidecar(key, vars.interval, bytes, bytes, acc);
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

    // The current snapshot is finalized — stop tracking its incremental meta.
    this._currentAccs.delete(key);

    // Delete the snapshot object and its sidecar (best-effort, both).
    for (const k of [key, key + SIDECAR_SUFFIX]) {
      this._pendingUploads++;
      this._s3
        .send(new DeleteObjectCommand({ Bucket: this._bucket, Key: k }))
        .then(() => {
          if (this._log) {
            this._log.debug('Deleted stale current log s3://%s/%s', this._bucket, k);
          }
        })
        .catch(() => { /* best-effort */ })
        .finally(() => {
          this._pendingUploads--;
        });
    }
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
    const acc = this._currentAcc(key, rawBody);

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
          this._uploadSidecar(key, vars.interval, rawBody.length, compressed.length, acc);
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
    const acc = this._currentAcc(key, rawBody);

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
        this._uploadSidecar(key, vars.interval, rawBody.length, rawBody.length, acc);
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
   * The incremental sidecar accumulator for an in-progress current file. Parses
   * only bytes appended since the last upload; re-derives from byte 0 when this
   * key is first seen (or after a restart drops the map, or if the file ever
   * shrank). Offsets land on newline boundaries, so tail slices never split a
   * line or a multi-byte char.
   * @param {string} key - the current snapshot's S3 key
   * @param {Buffer} rawBody - the full current file contents
   */
  _currentAcc(key, rawBody) {
    let acc = this._currentAccs.get(key);
    if (!acc || rawBody.length < acc.offset) {
      acc = new MetaAccumulator();
      this._currentAccs.set(key, acc);
    }
    if (rawBody.length > acc.offset) {
      acc.addChunk(rawBody.toString('utf8', acc.offset));
      acc.offset = rawBody.length;
    }
    return acc;
  }

  /**
   * Upload the metadata sidecar for a just-uploaded log object. Best-effort and
   * fully decoupled: a failure here never affects the log upload — the viewer
   * just falls back to estimating that file's size.
   */
  _uploadSidecar(objectKey, interval, bytes, compressed, acc) {
    let body;
    try {
      body = JSON.stringify(acc.toMeta(interval, bytes, compressed));
    } catch (e) {
      return; // never let sidecar serialization affect the run
    }

    this._pendingUploads++;
    this._s3
      .send(new PutObjectCommand({
        Bucket: this._bucket,
        Key: objectKey + SIDECAR_SUFFIX,
        Body: body,
        ContentType: 'application/json',
      }))
      .then(() => {
        if (this._log) {
          this._log.debug('Uploaded sidecar s3://%s/%s%s', this._bucket, objectKey, SIDECAR_SUFFIX);
        }
      })
      .catch((err) => {
        if (this._log) {
          this._log.debug('Sidecar upload failed for %s: %s', objectKey, err.message);
        }
      })
      .finally(() => {
        this._pendingUploads--;
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

module.exports = { S3Uploader, normalizeHost, MetaAccumulator };
