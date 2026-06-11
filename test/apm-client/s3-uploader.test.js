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

const { S3Uploader, normalizeHost } = require('../../lib/apm-client/s3-uploader');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tracelog-s3-test-'));
}

function makeMockS3() {
  return {
    uploads: [],
    deletes: [],
    send(command) {
      const input = command.input;
      if (command.constructor.name === 'DeleteObjectCommand') {
        this.deletes.push({ Bucket: input.Bucket, Key: input.Key });
        return Promise.resolve();
      }
      let body = input.Body;
      // If body is a stream, read it; if buffer/string, keep as-is
      if (Buffer.isBuffer(body) || typeof body === 'string') {
        this.uploads.push({
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
          this.uploads.push({
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
