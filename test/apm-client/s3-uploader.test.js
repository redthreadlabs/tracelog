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

const { S3Uploader } = require('../../lib/apm-client/s3-uploader');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tracelog-s3-test-'));
}

function makeMockS3() {
  return {
    uploads: [],
    send(command) {
      const input = command.input;
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
    keyTemplate:
      opts.keyTemplate ||
      '{serviceName}/{environment}/{date}/{filename}',
    serviceName: opts.serviceName || 'my-svc',
    environment: opts.environment || 'test',
    s3Client: mockS3,
    clock: opts.clock || (() => new Date('2026-06-15T14:30:00Z')),
    gzipCompleted: opts.gzipCompleted,
    gzipCurrent: opts.gzipCurrent,
    logger: opts.logger,
  });
}

// --- Key template resolution ---

test('s3 key template resolves variables', (t) => {
  const mockS3 = makeMockS3();
  const uploader = makeUploader(mockS3, {
    keyTemplate: '{serviceName}/{environment}/{date}/{hostname}-{pid}-{timestamp}.jsonl',
    clock: () => new Date('2026-06-15T14:30:00Z'),
    gzipCurrent: false,
  });

  const dir = tmpDir();
  const filePath = path.join(dir, 'tracelog-2026-06-15.jsonl');
  fs.writeFileSync(filePath, '{"metadata":{}}\n', 'utf8');

  uploader.uploadCurrent(filePath, () => {
    t.equal(mockS3.uploads.length, 1, 'one upload');
    const key = mockS3.uploads[0].Key;
    t.ok(key.startsWith('my-svc/test/2026-06-15/'), 'key has service/env/date prefix');
    t.ok(key.includes(os.hostname()), 'key contains hostname');
    t.ok(key.includes(String(process.pid)), 'key contains pid');
    t.ok(key.endsWith('.jsonl'), 'key ends with .jsonl');
    t.end();
  });
});

test('s3 key template supports {filename}', (t) => {
  const mockS3 = makeMockS3();
  const uploader = makeUploader(mockS3, {
    keyTemplate: 'logs/{filename}',
    gzipCurrent: false,
  });

  const dir = tmpDir();
  const filePath = path.join(dir, 'tracelog-2026-06-15.jsonl');
  fs.writeFileSync(filePath, '{"metadata":{}}\n', 'utf8');

  uploader.uploadCurrent(filePath, () => {
    t.equal(mockS3.uploads[0].Key, 'logs/tracelog-2026-06-15.jsonl');
    t.end();
  });
});

// --- uploadCurrent (gzip disabled) ---

test('uploadCurrent sends raw content when gzipCurrent is false', (t) => {
  const mockS3 = makeMockS3();
  const uploader = makeUploader(mockS3, { gzipCurrent: false });

  const dir = tmpDir();
  const filePath = path.join(dir, 'current.jsonl');
  const content = '{"metadata":{}}\n{"transaction":{"name":"tx1"}}\n';
  fs.writeFileSync(filePath, content, 'utf8');

  uploader.uploadCurrent(filePath, () => {
    t.equal(mockS3.uploads.length, 1, 'one upload');
    t.equal(mockS3.uploads[0].ContentType, 'application/x-ndjson');
    t.equal(mockS3.uploads[0].ContentEncoding, undefined, 'no gzip encoding');
    t.equal(mockS3.uploads[0].Bucket, 'test-bucket');
    t.equal(mockS3.uploads[0].Body.toString(), content, 'body matches file content');
    t.ok(!mockS3.uploads[0].Key.endsWith('.gz'), 'key has no .gz suffix');
    t.ok(fs.existsSync(filePath), 'file not deleted');
    t.end();
  });
});

// --- uploadCurrent (gzip enabled, default) ---

test('uploadCurrent gzips content by default', (t) => {
  const mockS3 = makeMockS3();
  const uploader = makeUploader(mockS3);

  const dir = tmpDir();
  const filePath = path.join(dir, 'current.jsonl');
  const content = '{"metadata":{}}\n{"transaction":{"name":"tx1"}}\n';
  fs.writeFileSync(filePath, content, 'utf8');

  uploader.uploadCurrent(filePath, () => {
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

  uploader.uploadCurrent('/tmp/does-not-exist.jsonl', () => {
    t.equal(mockS3.uploads.length, 0, 'no upload for missing file');
    t.end();
  });
});

// --- uploadCompleted (gzip enabled, default) ---

test('uploadCompleted gzips, uploads, and deletes local file', (t) => {
  const mockS3 = makeMockS3();
  const uploader = makeUploader(mockS3);

  const dir = tmpDir();
  const filePath = path.join(dir, 'completed.jsonl');
  const content = '{"metadata":{}}\n{"transaction":{"name":"done"}}\n';
  fs.writeFileSync(filePath, content, 'utf8');

  uploader.uploadCompleted(filePath);

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

// --- uploadCompleted (gzip disabled) ---

test('uploadCompleted sends raw content when gzipCompleted is false', (t) => {
  const mockS3 = makeMockS3();
  const uploader = makeUploader(mockS3, { gzipCompleted: false });

  const dir = tmpDir();
  const filePath = path.join(dir, 'completed-raw.jsonl');
  const content = '{"metadata":{}}\n{"transaction":{"name":"raw"}}\n';
  fs.writeFileSync(filePath, content, 'utf8');

  uploader.uploadCompleted(filePath);

  setTimeout(() => {
    t.equal(mockS3.uploads.length, 1, 'one upload');
    t.ok(!mockS3.uploads[0].Key.endsWith('.gz'), 'key has no .gz suffix');
    t.equal(mockS3.uploads[0].ContentEncoding, undefined, 'no gzip encoding');

    // Body is a stream that was read — should match content
    t.equal(mockS3.uploads[0].Body.toString(), content, 'body matches original');

    // Original file should be deleted on success
    t.ok(!fs.existsSync(filePath), 'original file deleted');

    t.end();
  }, 500);
});

test('uploadCompleted does nothing for non-existent file', (t) => {
  const mockS3 = makeMockS3();
  const uploader = makeUploader(mockS3);

  uploader.uploadCompleted('/tmp/does-not-exist.jsonl');

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

  uploader.uploadCompleted(filePath);

  setTimeout(() => {
    t.ok(errors.length > 0, 'error was logged');
    // Original file should be kept (not deleted on failure)
    t.ok(fs.existsSync(filePath), 'original file preserved on failure');
    // .gz file should be cleaned up
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

  uploader.uploadCurrent(filePath, () => {
    t.ok(errors.length > 0, 'error was logged');
    t.ok(fs.existsSync(filePath), 'file preserved on failure');
    t.end();
  });
});

// --- Clock ---

test('clock affects key template date variables', (t) => {
  const mockS3 = makeMockS3();
  const fixedDate = new Date('2030-12-25T08:45:00Z');
  const uploader = makeUploader(mockS3, {
    keyTemplate: '{year}/{month}/{day}/{hour}-{minute}.jsonl',
    clock: () => fixedDate,
    gzipCurrent: false,
  });

  const dir = tmpDir();
  const filePath = path.join(dir, 'test.jsonl');
  fs.writeFileSync(filePath, '{"metadata":{}}\n', 'utf8');

  // getHours()/getMinutes() return local time, so build the expected key
  // from the same Date object to avoid timezone mismatches.
  const expectedHour = String(fixedDate.getHours()).padStart(2, '0');
  const expectedMinute = String(fixedDate.getMinutes()).padStart(2, '0');
  const expectedKey = `2030/12/${fixedDate.getDate()}/${expectedHour}-${expectedMinute}.jsonl`;

  uploader.uploadCurrent(filePath, () => {
    t.equal(mockS3.uploads[0].Key, expectedKey);
    t.end();
  });
});
