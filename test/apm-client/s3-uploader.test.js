/*
 * Copyright Red Thread Labs LLC. All rights reserved.
 * Licensed under the BSD 2-Clause License; you may not use this file except in
 * compliance with the BSD 2-Clause License.
 */

'use strict';

const test = require('tape');
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');

const {
  S3Uploader,
  normalizeHost,
  MetaAccumulator,
} = require('../../lib/apm-client/s3-uploader');

// epoch-µs for a given UTC hour on 2026-06-15 (serialized timestamps are µs)
function tsAt(hour) {
  return Date.UTC(2026, 5, 15, hour) * 1000;
}

function jsonl(...objs) {
  return objs.map((o) => JSON.stringify(o)).join('\n') + '\n';
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tracelog-s3-test-'));
}

function makeMockS3() {
  return {
    uploads: [], // log objects only
    deletes: [], // log object deletes only
    sidecars: [], // *.meta.json puts
    sidecarDeletes: [], // *.meta.json deletes
    send(command) {
      const input = command.input;
      const isSidecar = input.Key && input.Key.endsWith('.meta.json');
      if (command.constructor.name === 'DeleteObjectCommand') {
        (isSidecar ? this.sidecarDeletes : this.deletes).push({
          Bucket: input.Bucket,
          Key: input.Key,
        });
        return Promise.resolve();
      }
      const bucket = isSidecar ? this.sidecars : this.uploads;
      let body = input.Body;
      // If body is a stream, read it; if buffer/string, keep as-is
      if (Buffer.isBuffer(body) || typeof body === 'string') {
        bucket.push({
          Bucket: input.Bucket,
          Key: input.Key,
          Body: body,
          ContentType: input.ContentType,
          ContentEncoding: input.ContentEncoding,
        });
        return Promise.resolve();
      }
      // Stream — read it into a buffer
      return new Promise((resolve, reject) => {
        const chunks = [];
        body.on('data', (chunk) => chunks.push(chunk));
        body.on('end', () => {
          bucket.push({
            Bucket: input.Bucket,
            Key: input.Key,
            Body: Buffer.concat(chunks),
            ContentType: input.ContentType,
            ContentEncoding: input.ContentEncoding,
          });
          resolve();
        });
        body.on('error', reject);
      });
    },
  };
}

function makeUploader(mockS3, opts = {}) {
  return new S3Uploader({
    bucket: opts.bucket || 'test-bucket',
    host: opts.host || '172.31.27.225',
    s3Client: mockS3,
    gzipCompleted: opts.gzipCompleted,
    gzipCurrent: opts.gzipCurrent,
    logger: opts.logger,
  });
}

const VARS = { channel: 'server', interval: '2026-06-15', seq: 0 };

// --- Host normalization ---

test('normalizeHost converts EC2 internal hostnames to dotted IPs', (t) => {
  t.equal(normalizeHost('ip-172-31-27-225.ec2.internal'), '172.31.27.225');
  t.equal(normalizeHost('ip-10-0-0-1'), '10.0.0.1');
  t.equal(
    normalizeHost('ip-10-1-2-3.us-west-2.compute.internal'),
    '10.1.2.3',
  );
  t.equal(normalizeHost('benjis-macbook.local'), 'benjis-macbook.local');
  t.equal(normalizeHost('ip-not-a-number-here'), 'ip-not-a-number-here');
  t.end();
});

// --- Key layout ---

test('uploadCompleted uses the fixed channel/interval/host layout', (t) => {
  const mockS3 = makeMockS3();
  const uploader = makeUploader(mockS3);

  const dir = tmpDir();
  const filePath = path.join(dir, 'completed.jsonl');
  fs.writeFileSync(filePath, '{"metadata":{}}\n', 'utf8');

  uploader.uploadCompleted(filePath, VARS);

  setTimeout(() => {
    t.equal(mockS3.uploads.length, 1, 'one upload');
    t.equal(
      mockS3.uploads[0].Key,
      'server/2026-06-15/172.31.27.225.jsonl.gz',
      'completed key matches contract',
    );
    t.end();
  }, 500);
});

test('uploadCompleted includes seq in the basename when > 0', (t) => {
  const mockS3 = makeMockS3();
  const uploader = makeUploader(mockS3);

  const dir = tmpDir();
  const filePath = path.join(dir, 'completed.1.jsonl');
  fs.writeFileSync(filePath, '{"metadata":{}}\n', 'utf8');

  uploader.uploadCompleted(filePath, { ...VARS, seq: 1 });

  setTimeout(() => {
    t.equal(
      mockS3.uploads[0].Key,
      'server/2026-06-15/172.31.27.225_1.jsonl.gz',
      'seq key matches contract',
    );
    t.equal(
      mockS3.deletes[0].Key,
      'server/2026-06-15/172.31.27.225_1_current.jsonl.gz',
      'stale current for the seq file deleted',
    );
    t.end();
  }, 500);
});

test('uploadCurrent keeps the real interval with a _current suffix', (t) => {
  const mockS3 = makeMockS3();
  const uploader = makeUploader(mockS3);

  const dir = tmpDir();
  const filePath = path.join(dir, 'current.jsonl');
  fs.writeFileSync(filePath, '{"metadata":{}}\n', 'utf8');

  uploader.uploadCurrent(filePath, VARS, () => {
    t.equal(mockS3.uploads.length, 1, 'one upload');
    t.equal(
      mockS3.uploads[0].Key,
      'server/2026-06-15/172.31.27.225_current.jsonl.gz',
      'current key matches contract',
    );
    t.ok(fs.existsSync(filePath), 'file not deleted');
    t.end();
  });
});

test('uploadCompleted deletes the superseded _current object on success', (t) => {
  const mockS3 = makeMockS3();
  const uploader = makeUploader(mockS3);

  const dir = tmpDir();
  const filePath = path.join(dir, 'completed.jsonl');
  fs.writeFileSync(filePath, '{"metadata":{}}\n', 'utf8');

  uploader.uploadCompleted(filePath, VARS);

  setTimeout(() => {
    t.equal(mockS3.deletes.length, 1, 'one delete issued');
    t.equal(
      mockS3.deletes[0].Key,
      'server/2026-06-15/172.31.27.225_current.jsonl.gz',
      'deleted the matching current snapshot',
    );
    t.end();
  }, 500);
});

test('uploadCompleted does not delete current snapshot on upload failure', (t) => {
  const deletes = [];
  const failingS3 = {
    send(command) {
      if (command.constructor.name === 'DeleteObjectCommand') {
        deletes.push(command.input.Key);
        return Promise.resolve();
      }
      return Promise.reject(new Error('S3 is down'));
    },
  };
  const uploader = makeUploader(failingS3, {
    logger: { debug() {}, error() {} },
  });

  const dir = tmpDir();
  const filePath = path.join(dir, 'fail.jsonl');
  fs.writeFileSync(filePath, '{"metadata":{}}\n', 'utf8');

  uploader.uploadCompleted(filePath, VARS);

  setTimeout(() => {
    t.equal(deletes.length, 0, 'no delete after failed upload');
    t.ok(fs.existsSync(filePath), 'original file preserved on failure');
    t.end();
  }, 500);
});

// --- Content handling ---

test('uploadCurrent sends raw content when gzipCurrent is false', (t) => {
  const mockS3 = makeMockS3();
  const uploader = makeUploader(mockS3, { gzipCurrent: false });

  const dir = tmpDir();
  const filePath = path.join(dir, 'current.jsonl');
  const content = '{"metadata":{}}\n{"transaction":{"name":"tx1"}}\n';
  fs.writeFileSync(filePath, content, 'utf8');

  uploader.uploadCurrent(filePath, VARS, () => {
    t.equal(mockS3.uploads.length, 1, 'one upload');
    t.equal(mockS3.uploads[0].ContentType, 'application/x-ndjson');
    t.equal(mockS3.uploads[0].ContentEncoding, undefined, 'no gzip encoding');
    t.equal(mockS3.uploads[0].Bucket, 'test-bucket');
    t.equal(mockS3.uploads[0].Body.toString(), content, 'body matches file content');
    t.equal(
      mockS3.uploads[0].Key,
      'server/2026-06-15/172.31.27.225_current.jsonl',
      'no .gz suffix',
    );
    t.end();
  });
});

test('uploadCurrent gzips content by default', (t) => {
  const mockS3 = makeMockS3();
  const uploader = makeUploader(mockS3);

  const dir = tmpDir();
  const filePath = path.join(dir, 'current.jsonl');
  const content = '{"metadata":{}}\n{"transaction":{"name":"tx1"}}\n';
  fs.writeFileSync(filePath, content, 'utf8');

  uploader.uploadCurrent(filePath, VARS, () => {
    t.equal(mockS3.uploads.length, 1, 'one upload');
    t.equal(mockS3.uploads[0].ContentEncoding, 'gzip', 'gzip encoding set');
    t.ok(mockS3.uploads[0].Key.endsWith('.gz'), 'key has .gz suffix');

    const decompressed = zlib.gunzipSync(mockS3.uploads[0].Body);
    t.equal(decompressed.toString(), content, 'decompressed body matches');
    t.ok(fs.existsSync(filePath), 'file not deleted');
    t.end();
  });
});

test('uploadCurrent does nothing for non-existent file', (t) => {
  const mockS3 = makeMockS3();
  const uploader = makeUploader(mockS3);

  uploader.uploadCurrent('/tmp/does-not-exist.jsonl', VARS, () => {
    t.equal(mockS3.uploads.length, 0, 'no upload for missing file');
    t.end();
  });
});

test('uploadCompleted gzips, uploads, and deletes local file', (t) => {
  const mockS3 = makeMockS3();
  const uploader = makeUploader(mockS3);

  const dir = tmpDir();
  const filePath = path.join(dir, 'completed.jsonl');
  const content = '{"metadata":{}}\n{"transaction":{"name":"done"}}\n';
  fs.writeFileSync(filePath, content, 'utf8');

  uploader.uploadCompleted(filePath, VARS);

  setTimeout(() => {
    t.equal(mockS3.uploads.length, 1, 'one upload');
    t.ok(mockS3.uploads[0].Key.endsWith('.gz'), 'key has .gz suffix');
    t.equal(mockS3.uploads[0].ContentEncoding, 'gzip', 'content-encoding is gzip');

    const decompressed = zlib.gunzipSync(mockS3.uploads[0].Body);
    t.equal(decompressed.toString(), content, 'decompressed body matches original');

    t.ok(!fs.existsSync(filePath), 'original file deleted');
    t.ok(!fs.existsSync(filePath + '.gz'), 'gz file deleted');

    t.end();
  }, 500);
});

test('uploadCompleted sends raw content when gzipCompleted is false', (t) => {
  const mockS3 = makeMockS3();
  const uploader = makeUploader(mockS3, { gzipCompleted: false });

  const dir = tmpDir();
  const filePath = path.join(dir, 'completed-raw.jsonl');
  const content = '{"metadata":{}}\n{"transaction":{"name":"raw"}}\n';
  fs.writeFileSync(filePath, content, 'utf8');

  uploader.uploadCompleted(filePath, VARS);

  setTimeout(() => {
    t.equal(mockS3.uploads.length, 1, 'one upload');
    t.equal(
      mockS3.uploads[0].Key,
      'server/2026-06-15/172.31.27.225.jsonl',
      'no .gz suffix',
    );
    t.equal(mockS3.uploads[0].ContentEncoding, undefined, 'no gzip encoding');
    t.equal(mockS3.uploads[0].Body.toString(), content, 'body matches original');
    t.ok(!fs.existsSync(filePath), 'original file deleted');
    t.end();
  }, 500);
});

test('uploadCompleted does nothing for non-existent file', (t) => {
  const mockS3 = makeMockS3();
  const uploader = makeUploader(mockS3);

  uploader.uploadCompleted('/tmp/does-not-exist.jsonl', VARS);

  setTimeout(() => {
    t.equal(mockS3.uploads.length, 0, 'no upload for missing file');
    t.end();
  }, 100);
});

// --- Error handling ---

test('uploadCompleted handles S3 upload failure gracefully', (t) => {
  const errors = [];
  const failingS3 = {
    send() {
      return Promise.reject(new Error('S3 is down'));
    },
  };
  const uploader = makeUploader(failingS3, {
    logger: {
      debug() {},
      error(fmt, ...args) {
        errors.push({ fmt, args });
      },
    },
  });

  const dir = tmpDir();
  const filePath = path.join(dir, 'fail.jsonl');
  fs.writeFileSync(filePath, '{"metadata":{}}\n', 'utf8');

  uploader.uploadCompleted(filePath, VARS);

  setTimeout(() => {
    t.ok(errors.length > 0, 'error was logged');
    t.ok(fs.existsSync(filePath), 'original file preserved on failure');
    t.ok(!fs.existsSync(filePath + '.gz'), 'gz file cleaned up on failure');
    t.end();
  }, 500);
});

test('uploadCurrent handles S3 upload failure gracefully', (t) => {
  const errors = [];
  const failingS3 = {
    send() {
      return Promise.reject(new Error('S3 is down'));
    },
  };
  const uploader = makeUploader(failingS3, {
    logger: {
      debug() {},
      error(fmt, ...args) {
        errors.push({ fmt, args });
      },
    },
  });

  const dir = tmpDir();
  const filePath = path.join(dir, 'fail-current.jsonl');
  fs.writeFileSync(filePath, '{"metadata":{}}\n', 'utf8');

  uploader.uploadCurrent(filePath, VARS, () => {
    t.ok(errors.length > 0, 'error was logged');
    t.ok(fs.existsSync(filePath), 'file preserved on failure');
    t.end();
  });
});

// --- Default host ---

test('host defaults to the normalized os.hostname()', (t) => {
  const mockS3 = makeMockS3();
  const uploader = new S3Uploader({
    bucket: 'test-bucket',
    s3Client: mockS3,
    gzipCurrent: false,
  });

  const dir = tmpDir();
  const filePath = path.join(dir, 'host.jsonl');
  fs.writeFileSync(filePath, '{"metadata":{}}\n', 'utf8');

  uploader.uploadCurrent(filePath, VARS, () => {
    t.equal(
      mockS3.uploads[0].Key,
      `server/2026-06-15/${normalizeHost(os.hostname())}_current.jsonl`,
      'key uses normalized hostname',
    );
    t.end();
  });
});

// --- Sidecar metadata: MetaAccumulator ---

test('MetaAccumulator buckets records by UTC hour and kind', (t) => {
  const acc = new MetaAccumulator();
  acc.addChunk(
    jsonl(
      { metadata: { channel: 'server' } }, // not a record
      { transaction: { timestamp: tsAt(0) } },
      { span: { timestamp: tsAt(0) } },
      { span: { timestamp: tsAt(0) } },
      { error: { timestamp: tsAt(23) } },
      { event: {} }, // missing timestamp -> malformed
      { transaction: { timestamp: 0 } }, // garbage timestamp -> malformed
    ),
  );
  acc.flushPartial();

  t.equal(acc.records, 6, 'six records (metadata line excluded)');
  t.equal(acc.malformed, 2, 'two records had no usable timestamp');
  t.deepEqual(
    { ...acc.intervals['2026-06-15T00'] },
    { transaction: 1, span: 2 },
    'hour 00 histogram by kind',
  );
  t.deepEqual({ ...acc.intervals['2026-06-15T23'] }, { error: 1 }, 'hour 23 histogram');

  let sum = 0;
  for (const hour of Object.keys(acc.intervals)) {
    for (const k of Object.keys(acc.intervals[hour])) sum += acc.intervals[hour][k];
  }
  t.equal(acc.records, acc.malformed + sum, 'records === malformed + Σ intervals');
  t.end();
});

test('MetaAccumulator skips corrupt JSON lines (not counted as records)', (t) => {
  const acc = new MetaAccumulator();
  acc.addChunk('{not valid json\n');
  acc.addChunk(jsonl({ transaction: { timestamp: tsAt(1) } }));
  acc.flushPartial();
  t.equal(acc.records, 1, 'only the valid record counts');
  t.equal(acc.malformed, 0, 'corrupt line is not a malformed record');
  t.end();
});

test('MetaAccumulator accumulates across incremental tail chunks', (t) => {
  const acc = new MetaAccumulator();
  const a = jsonl({ metadata: {} }, { transaction: { timestamp: tsAt(5) } });
  const b = jsonl({ span: { timestamp: tsAt(5) } });
  acc.addChunk(a);
  acc.offset = Buffer.byteLength(a);
  acc.addChunk(b);
  acc.offset += Buffer.byteLength(b);
  t.equal(acc.records, 2, 'records carried across chunks');
  t.deepEqual({ ...acc.intervals['2026-06-15T05'] }, { transaction: 1, span: 1 });
  t.end();
});

test('MetaAccumulator.toMeta serializes deterministically (stable ETag)', (t) => {
  // same records, different arrival order -> byte-identical sidecar JSON
  const a = new MetaAccumulator();
  a.addChunk(
    jsonl(
      { span: { timestamp: tsAt(3) } },
      { transaction: { timestamp: tsAt(1) } },
      { error: { timestamp: tsAt(1) } },
    ),
  );
  a.flushPartial();
  const b = new MetaAccumulator();
  b.addChunk(
    jsonl(
      { error: { timestamp: tsAt(1) } },
      { span: { timestamp: tsAt(3) } },
      { transaction: { timestamp: tsAt(1) } },
    ),
  );
  b.flushPartial();
  t.equal(
    JSON.stringify(a.toMeta('2026-06-15', 100, 50)),
    JSON.stringify(b.toMeta('2026-06-15', 100, 50)),
    'identical content -> identical bytes regardless of record order',
  );
  // and the keys are actually sorted
  const meta = a.toMeta('2026-06-15', 100, 50);
  t.deepEqual(Object.keys(meta.intervals), ['2026-06-15T01', '2026-06-15T03'], 'hours sorted');
  t.deepEqual(Object.keys(meta.intervals['2026-06-15T01']), ['error', 'transaction'], 'kinds sorted');
  t.end();
});

// --- Sidecar metadata: emission ---

test('uploadCompleted writes a .meta.json sidecar describing the file', (t) => {
  const mockS3 = makeMockS3();
  const uploader = makeUploader(mockS3);

  const dir = tmpDir();
  const filePath = path.join(dir, 'completed.jsonl');
  fs.writeFileSync(
    filePath,
    jsonl(
      { metadata: { channel: 'server' } },
      { transaction: { timestamp: tsAt(2) } },
      { span: { timestamp: tsAt(2) } },
      { event: {} },
    ),
    'utf8',
  );
  const uncompressed = fs.statSync(filePath).size;

  uploader.uploadCompleted(filePath, VARS);

  setTimeout(() => {
    t.equal(mockS3.uploads.length, 1, 'one log object uploaded');
    t.equal(mockS3.sidecars.length, 1, 'one sidecar uploaded');
    const sc = mockS3.sidecars[0];
    t.equal(
      sc.Key,
      'server/2026-06-15/172.31.27.225.jsonl.gz.meta.json',
      'sidecar key is <logkey>.meta.json',
    );
    t.equal(sc.ContentType, 'application/json', 'sidecar is plain json');
    t.equal(sc.ContentEncoding, undefined, 'sidecar is not gzip-encoded');
    const meta = JSON.parse(sc.Body.toString());
    t.equal(meta.v, 1, 'schema version');
    t.equal(meta.interval, '2026-06-15', 'file default interval recorded');
    t.equal(meta.bytes, uncompressed, 'uncompressed byte size is exact');
    t.ok(meta.compressed > 0 && meta.compressed < meta.bytes, 'compressed size recorded');
    t.equal(meta.records, 3, 'record count (metadata line excluded)');
    t.equal(meta.malformed, 1, 'malformed (timestamp-less) count');
    t.deepEqual(meta.intervals['2026-06-15T02'], { span: 1, transaction: 1 });
    t.end();
  }, 500);
});

test('uploadCurrent writes a sidecar, and finalizing deletes it', (t) => {
  const mockS3 = makeMockS3();
  const uploader = makeUploader(mockS3, { gzipCurrent: false });

  const dir = tmpDir();
  const filePath = path.join(dir, 'current.jsonl');
  fs.writeFileSync(
    filePath,
    jsonl({ metadata: {} }, { transaction: { timestamp: tsAt(7) } }),
    'utf8',
  );

  uploader.uploadCurrent(filePath, VARS, () => {
    t.equal(mockS3.sidecars.length, 1, 'current upload wrote a sidecar');
    const meta = JSON.parse(mockS3.sidecars[0].Body.toString());
    t.equal(meta.records, 1, 'one record in the current snapshot');
    t.deepEqual(meta.intervals['2026-06-15T07'], { transaction: 1 });

    const completed = path.join(dir, 'completed.jsonl');
    fs.writeFileSync(completed, jsonl({ metadata: {} }), 'utf8');
    uploader.uploadCompleted(completed, VARS);
    setTimeout(() => {
      t.ok(
        mockS3.sidecarDeletes.some((d) => d.Key.endsWith('_current.jsonl.meta.json')),
        'stale current sidecar deleted',
      );
      t.end();
    }, 500);
  });
});
