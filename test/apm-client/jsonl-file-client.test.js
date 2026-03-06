/*
 * Copyright Shaxpir Inc. All rights reserved.
 * Licensed under the BSD 2-Clause License; you may not use this file except in
 * compliance with the BSD 2-Clause License.
 */

'use strict';

const test = require('tape');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { JsonlFileClient } = require('../../lib/apm-client/jsonl-file-client');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tracelog-test-'));
}

function readLines(filePath) {
  return fs.readFileSync(filePath, 'utf8').trim().split('\n').map(JSON.parse);
}

function listFiles(dir) {
  try {
    return fs.readdirSync(dir).sort();
  } catch (e) {
    return [];
  }
}

function makeClient(dir, opts = {}) {
  return new JsonlFileClient({
    filePath: path.join(dir, 'tracelog.jsonl'),
    serviceName: opts.serviceName || 'test-svc',
    serviceVersion: '1.0.0',
    environment: 'test',
    flushIntervalMs: 60000, // large so we control flushes manually
    ...opts,
  });
}

// --- Basic functionality ---

test('writes metadata as first line', (t) => {
  const dir = tmpDir();
  const client = makeClient(dir);

  client.sendTransaction({ name: 'tx1', type: 'request', duration: 10 });
  client.flush();

  const files = listFiles(dir);
  t.equal(files.length, 1, 'one file created');

  const lines = readLines(path.join(dir, files[0]));
  t.equal(lines.length, 2, 'metadata + 1 transaction');
  t.ok(lines[0].metadata, 'first line is metadata');
  t.equal(lines[0].metadata.service.name, 'test-svc');
  t.ok(lines[1].transaction, 'second line is transaction');

  client.destroy();
  t.end();
});

test('writes transactions, spans, errors, metricsets', (t) => {
  const dir = tmpDir();
  const client = makeClient(dir);

  client.sendTransaction({ name: 'tx', type: 'request', duration: 10 });
  client.sendSpan({ name: 'span', type: 'db', duration: 5 });
  client.sendError({ id: 'err1', exception: { message: 'boom' } });
  client.sendMetricSet({ timestamp: 123, samples: {} });
  client.flush();

  const files = listFiles(dir);
  const lines = readLines(path.join(dir, files[0]));
  t.equal(lines.length, 5, 'metadata + 4 events');
  t.ok(lines[0].metadata);
  t.ok(lines[1].transaction);
  t.ok(lines[2].span);
  t.ok(lines[3].error);
  t.ok(lines[4].metricset);

  client.destroy();
  t.end();
});

// --- Daily rotation file naming ---

test('daily rotation produces date-stamped filename', (t) => {
  const dir = tmpDir();
  const clock = () => new Date('2026-06-15T10:30:00Z');
  const client = makeClient(dir, { clock, rotationSchedule: 'daily' });

  client.sendTransaction({ name: 'tx', type: 'request', duration: 10 });
  client.flush();

  const files = listFiles(dir);
  t.equal(files.length, 1);
  t.ok(files[0].includes('2026-06-15'), 'filename contains date');
  t.ok(!files[0].includes('T'), 'daily filename has no hour component');

  client.destroy();
  t.end();
});

// --- Hourly rotation file naming ---

test('hourly rotation produces date+hour filename', (t) => {
  const dir = tmpDir();
  const clock = () => new Date('2026-06-15T14:30:00Z');
  const client = makeClient(dir, { clock, rotationSchedule: 'hourly' });

  client.sendTransaction({ name: 'tx', type: 'request', duration: 10 });
  client.flush();

  const files = listFiles(dir);
  t.equal(files.length, 1);
  // Hour depends on local timezone, but the format should include T and an hour
  t.ok(/T\d{2}/.test(files[0]), 'filename includes Thh hour component');

  client.destroy();
  t.end();
});

// --- Time-based rotation ---

test('time-based rotation creates new file when period changes', (t) => {
  const dir = tmpDir();
  let now = new Date('2026-06-15T10:00:00Z');
  const clock = () => now;
  const client = makeClient(dir, { clock, rotationSchedule: 'daily' });

  client.sendTransaction({ name: 'day1', type: 'request', duration: 10 });
  client.flush();

  // Advance to the next day
  now = new Date('2026-06-16T10:00:00Z');
  client.sendTransaction({ name: 'day2', type: 'request', duration: 10 });
  client.flush();

  const files = listFiles(dir);
  t.equal(files.length, 2, 'two files after day change');

  // Both files should start with metadata
  for (const f of files) {
    const lines = readLines(path.join(dir, f));
    t.ok(lines[0].metadata, `${f} starts with metadata`);
  }

  client.destroy();
  t.end();
});

test('hourly rotation creates new file when hour changes', (t) => {
  const dir = tmpDir();
  let now = new Date('2026-06-15T10:00:00Z');
  const clock = () => now;
  const client = makeClient(dir, { clock, rotationSchedule: 'hourly' });

  client.sendTransaction({ name: 'h1', type: 'request', duration: 10 });
  client.flush();

  now = new Date('2026-06-15T11:00:00Z');
  client.sendTransaction({ name: 'h2', type: 'request', duration: 10 });
  client.flush();

  now = new Date('2026-06-15T12:00:00Z');
  client.sendTransaction({ name: 'h3', type: 'request', duration: 10 });
  client.flush();

  const files = listFiles(dir);
  t.equal(files.length, 3, 'three files for three hours');

  client.destroy();
  t.end();
});

// --- Size-based rotation ---

test('size-based rotation within same period uses dot suffix', (t) => {
  const dir = tmpDir();
  const clock = () => new Date('2026-06-15T10:00:00Z');
  const client = makeClient(dir, {
    clock,
    rotationSchedule: 'daily',
    maxFileSize: 200, // very small to trigger rotation
  });

  for (let i = 0; i < 10; i++) {
    client.sendTransaction({ name: `tx-${i}`, type: 'request', duration: 10 });
  }
  client.flush();

  const files = listFiles(dir);
  t.ok(files.length > 1, 'multiple files created due to size rotation');

  // Check naming pattern: base file + .1, .2, etc.
  const base = files.find((f) => !(/\.\d+\.jsonl$/.test(f)));
  t.ok(base, 'has a base file without sequence number');

  const numbered = files.filter((f) => /\.\d+\.jsonl$/.test(f));
  t.ok(numbered.length > 0, 'has dot-numbered files');

  // All files must start with metadata
  for (const f of files) {
    const lines = readLines(path.join(dir, f));
    t.ok(lines[0].metadata, `${f} starts with metadata`);
  }

  client.destroy();
  t.end();
});

// --- Combined time + size rotation ---

test('size rotation resets sequence when time period changes', (t) => {
  const dir = tmpDir();
  let now = new Date('2026-06-15T10:00:00Z');
  const clock = () => now;
  const client = makeClient(dir, {
    clock,
    rotationSchedule: 'daily',
    maxFileSize: 200,
  });

  // Fill up several size-rotated files in day 1
  for (let i = 0; i < 5; i++) {
    client.sendTransaction({ name: `d1-tx-${i}`, type: 'request', duration: 10 });
  }
  client.flush();

  const day1Files = listFiles(dir).filter((f) => f.includes('06-15'));
  t.ok(day1Files.length > 1, 'multiple files on day 1');

  // Advance to day 2
  now = new Date('2026-06-16T10:00:00Z');
  for (let i = 0; i < 5; i++) {
    client.sendTransaction({ name: `d2-tx-${i}`, type: 'request', duration: 10 });
  }
  client.flush();

  const allFiles = listFiles(dir);
  const day2Files = allFiles.filter((f) => f.includes('06-16'));
  t.ok(day2Files.length > 0, 'files created for day 2');

  // Day 2 should have its own base file (no leftover sequence from day 1)
  const day2Base = day2Files.find((f) => !(/\.\d+\.jsonl$/.test(f)));
  t.ok(day2Base, 'day 2 has a base file');

  client.destroy();
  t.end();
});

// --- Metadata on every new file ---

test('every rotated file starts with metadata', (t) => {
  const dir = tmpDir();
  let now = new Date('2026-06-15T10:00:00Z');
  const clock = () => now;
  const client = makeClient(dir, { clock, rotationSchedule: 'hourly' });

  // Write across 4 hours
  for (let h = 10; h <= 13; h++) {
    now = new Date(`2026-06-15T${h}:00:00Z`);
    client.sendTransaction({
      name: `h${h}`,
      type: 'request',
      duration: 10,
    });
    client.flush();
  }

  const files = listFiles(dir);
  t.equal(files.length, 4, 'four hourly files');

  for (const f of files) {
    const lines = readLines(path.join(dir, f));
    t.ok(lines[0].metadata, `${f} starts with metadata`);
    t.equal(
      lines[0].metadata.service.name,
      'test-svc',
      `${f} metadata has correct service name`,
    );
  }

  client.destroy();
  t.end();
});

// --- Resume existing file ---

test('resumes writing to existing file on startup', (t) => {
  const dir = tmpDir();
  const clock = () => new Date('2026-06-15T10:00:00Z');

  // First client writes some data
  const client1 = makeClient(dir, { clock });
  client1.sendTransaction({ name: 'tx1', type: 'request', duration: 10 });
  client1.flush();
  client1.destroy();

  // Second client should append to the same file
  const client2 = makeClient(dir, { clock });
  client2.sendTransaction({ name: 'tx2', type: 'request', duration: 20 });
  client2.flush();

  const files = listFiles(dir);
  t.equal(files.length, 1, 'still one file');

  const lines = readLines(path.join(dir, files[0]));
  // First client wrote metadata + tx1, second appended tx2 (no duplicate metadata)
  t.equal(lines.length, 3, 'metadata + 2 transactions');
  t.ok(lines[0].metadata, 'first line is metadata');
  t.equal(lines[1].transaction.name, 'tx1');
  t.equal(lines[2].transaction.name, 'tx2');

  client2.destroy();
  t.end();
});

// --- S3 uploader integration ---

test('calls s3Uploader.uploadCompleted on rotation', (t) => {
  const dir = tmpDir();
  let now = new Date('2026-06-15T10:00:00Z');
  const clock = () => now;

  const uploadedFiles = [];
  const mockUploader = {
    uploadCompleted(filePath) {
      uploadedFiles.push({ type: 'completed', filePath });
    },
    uploadCurrent(filePath) {
      uploadedFiles.push({ type: 'current', filePath });
    },
  };

  const client = makeClient(dir, {
    clock,
    rotationSchedule: 'daily',
    s3Uploader: mockUploader,
  });

  client.sendTransaction({ name: 'tx1', type: 'request', duration: 10 });
  client.flush();

  t.equal(uploadedFiles.length, 0, 'no uploads before rotation');

  // Trigger time rotation
  now = new Date('2026-06-16T10:00:00Z');
  client.sendTransaction({ name: 'tx2', type: 'request', duration: 10 });
  client.flush();

  const completed = uploadedFiles.filter((u) => u.type === 'completed');
  t.equal(completed.length, 1, 'one completed upload after rotation');
  t.ok(completed[0].filePath.includes('06-15'), 'uploaded the old day file');

  client.destroy();
  t.end();
});

test('calls s3Uploader.uploadCurrent on destroy', (t) => {
  const dir = tmpDir();
  const clock = () => new Date('2026-06-15T10:00:00Z');

  const uploadedFiles = [];
  const mockUploader = {
    uploadCompleted(filePath) {
      uploadedFiles.push({ type: 'completed', filePath });
    },
    uploadCurrent(filePath) {
      uploadedFiles.push({ type: 'current', filePath });
    },
  };

  const client = makeClient(dir, {
    clock,
    s3Uploader: mockUploader,
  });

  client.sendTransaction({ name: 'tx1', type: 'request', duration: 10 });
  client.flush();

  client.destroy();

  const current = uploadedFiles.filter((u) => u.type === 'current');
  t.equal(current.length, 1, 'uploadCurrent called on destroy');

  t.end();
});

// --- Orphaned file upload on startup ---

test('uploads orphaned files from previous runs on startup', (t) => {
  const dir = tmpDir();
  const clock = () => new Date('2026-06-15T10:00:00Z');

  // Simulate orphaned files from previous days.
  fs.writeFileSync(
    path.join(dir, 'tracelog-2026-06-13.jsonl'),
    '{"metadata":{}}\n{"transaction":{"name":"old1"}}\n',
  );
  fs.writeFileSync(
    path.join(dir, 'tracelog-2026-06-14.jsonl'),
    '{"metadata":{}}\n{"transaction":{"name":"old2"}}\n',
  );

  const uploadedFiles = [];
  const mockUploader = {
    uploadCompleted(filePath) {
      uploadedFiles.push(filePath);
    },
    uploadCurrent() {},
  };

  const client = makeClient(dir, {
    clock,
    rotationSchedule: 'daily',
    s3Uploader: mockUploader,
  });

  // Orphaned files from days 13 and 14 should be uploaded on startup.
  t.equal(uploadedFiles.length, 2, 'two orphaned files uploaded');
  t.ok(
    uploadedFiles.some((f) => f.includes('06-13')),
    'day 13 orphan uploaded',
  );
  t.ok(
    uploadedFiles.some((f) => f.includes('06-14')),
    'day 14 orphan uploaded',
  );

  client.destroy();
  t.end();
});

test('does not upload current period file as orphan', (t) => {
  const dir = tmpDir();
  const clock = () => new Date('2026-06-15T10:00:00Z');

  // Create a file for the current period (day 15)
  fs.writeFileSync(
    path.join(dir, 'tracelog-2026-06-15.jsonl'),
    '{"metadata":{}}\n',
  );

  const uploadedFiles = [];
  const mockUploader = {
    uploadCompleted(filePath) {
      uploadedFiles.push(filePath);
    },
    uploadCurrent() {},
  };

  const client = makeClient(dir, {
    clock,
    rotationSchedule: 'daily',
    s3Uploader: mockUploader,
  });

  t.equal(uploadedFiles.length, 0, 'current period file not uploaded as orphan');

  client.destroy();
  t.end();
});

// --- Destroy behavior ---

test('destroy stops accepting new events', (t) => {
  const dir = tmpDir();
  const client = makeClient(dir);

  client.sendTransaction({ name: 'before', type: 'request', duration: 10 });
  client.flush();
  client.destroy();

  // This should be silently ignored
  client.sendTransaction({ name: 'after', type: 'request', duration: 10 });
  client.flush();

  const files = listFiles(dir);
  const lines = readLines(path.join(dir, files[0]));
  const txLines = lines.filter((l) => l.transaction);
  t.equal(txLines.length, 1, 'only the pre-destroy transaction was written');
  t.equal(txLines[0].transaction.name, 'before');

  t.end();
});

// --- Cloud metadata deferred write ---

test('defers writing until cloud metadata is ready', (t) => {
  const dir = tmpDir();
  let resolveCloud;
  const cloudMetadataFetcher = {
    getCloudMetadata(cb) {
      resolveCloud = cb;
    },
  };

  const client = makeClient(dir, { cloudMetadataFetcher });

  client.sendTransaction({ name: 'tx1', type: 'request', duration: 10 });
  client.flush();

  // No files yet — cloud metadata not ready
  t.equal(listFiles(dir).length, 0, 'no file written while waiting for cloud');

  // Resolve cloud metadata
  resolveCloud(null, { provider: 'aws', region: 'us-east-1' });

  client.flush();

  const files = listFiles(dir);
  t.equal(files.length, 1, 'file written after cloud metadata resolved');

  const lines = readLines(path.join(dir, files[0]));
  t.ok(lines[0].metadata, 'first line is metadata');
  t.equal(lines[0].metadata.cloud.provider, 'aws', 'cloud metadata included');
  t.ok(lines[1].transaction, 'buffered transaction written');

  client.destroy();
  t.end();
});

// --- Local file retention ---

test('maxLocalRetentionDays deletes old files on rotation', (t) => {
  const dir = tmpDir();
  let now = new Date('2026-06-10T10:00:00Z');
  const clock = () => now;
  const client = makeClient(dir, {
    clock,
    rotationSchedule: 'daily',
    maxLocalRetentionDays: 3,
  });

  // Write data for days 10, 11, 12, 13, 14
  for (let day = 10; day <= 14; day++) {
    now = new Date(`2026-06-${day}T10:00:00Z`);
    client.sendTransaction({ name: `d${day}`, type: 'request', duration: 10 });
    client.flush();
  }

  const files = listFiles(dir);
  // Day 10 and 11 should be deleted (older than 3 days from day 14)
  // Days 12, 13, 14 should remain
  const hasDay10 = files.some((f) => f.includes('06-10'));
  const hasDay11 = files.some((f) => f.includes('06-11'));
  const hasDay12 = files.some((f) => f.includes('06-12'));
  const hasDay13 = files.some((f) => f.includes('06-13'));
  const hasDay14 = files.some((f) => f.includes('06-14'));

  t.ok(!hasDay10, 'day 10 file deleted (older than 3 days)');
  t.ok(!hasDay11, 'day 11 file deleted (older than 3 days)');
  t.ok(hasDay12, 'day 12 file kept');
  t.ok(hasDay13, 'day 13 file kept');
  t.ok(hasDay14, 'day 14 file kept (current)');

  client.destroy();
  t.end();
});

// --- Buffer backpressure ---

test('maxBufferSize drops oldest events when buffer is full', (t) => {
  const dir = tmpDir();
  const client = makeClient(dir, {
    maxBufferSize: 5,
    flushIntervalMs: 600000, // disable auto-flush
  });

  // Send 8 transactions but buffer only holds 5
  for (let i = 0; i < 8; i++) {
    client.sendTransaction({ name: `tx-${i}`, type: 'request', duration: 10 });
  }

  client.flush();

  const files = listFiles(dir);
  const lines = readLines(path.join(dir, files[0]));
  const txLines = lines.filter((l) => l.transaction);

  t.equal(txLines.length, 5, 'only 5 transactions written (buffer limit)');
  // The oldest 3 (tx-0, tx-1, tx-2) should have been dropped
  t.equal(txLines[0].transaction.name, 'tx-3', 'oldest kept is tx-3');
  t.equal(txLines[4].transaction.name, 'tx-7', 'newest is tx-7');

  client.destroy();
  t.end();
});

test('maxLocalRetentionDays 0 means no cleanup', (t) => {
  const dir = tmpDir();
  let now = new Date('2026-06-10T10:00:00Z');
  const clock = () => now;
  const client = makeClient(dir, {
    clock,
    rotationSchedule: 'daily',
    maxLocalRetentionDays: 0,
  });

  for (let day = 10; day <= 14; day++) {
    now = new Date(`2026-06-${day}T10:00:00Z`);
    client.sendTransaction({ name: `d${day}`, type: 'request', duration: 10 });
    client.flush();
  }

  const files = listFiles(dir);
  t.equal(files.length, 5, 'all 5 files kept when retention is 0');

  client.destroy();
  t.end();
});
