/*
 * Copyright Red Thread Labs LLC. All rights reserved.
 * Licensed under the BSD 2-Clause License; you may not use this file except in
 * compliance with the BSD 2-Clause License.
 */

'use strict';

// The same AWS SDK instrumentation, reached the way an ESM service loads it:
// a hoisted static `import` of the (CommonJS) SDK, with the agent preloaded
// through `-r start.js` and import-in-the-middle's loader.
//
// This is the shape that failed in production — HTTP transactions with no S3
// spans inside them — so the assertion is on the JSONL the agent actually
// wrote, not on in-process state.

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const test = require('tape');

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const FIXTURE = path.join(__dirname, 'fixtures', 'use-s3-client.mjs');

function readRecords(dir, kind) {
  const records = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.jsonl')) {
      continue;
    }
    for (const line of fs.readFileSync(path.join(dir, name), 'utf8').split('\n')) {
      if (!line.trim()) {
        continue;
      }
      const record = JSON.parse(line);
      if (record[kind]) {
        records.push(record[kind]);
      }
    }
  }
  return records;
}

/** Run the fixture with extra env, then hand the caller its JSONL directory. */
function runFixture(t, extraEnv, done) {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracelog-s3-esm-'));
  execFile(
    process.execPath,
    [
      `--experimental-loader=${path.join(REPO_ROOT, 'loader.mjs')}`,
      '-r',
      path.join(REPO_ROOT, 'start.js'),
      FIXTURE,
    ],
    {
      cwd: __dirname,
      timeout: 30000,
      env: Object.assign(
        {},
        process.env,
        {
          NODE_NO_WARNINGS: '1',
          TRACELOG_SERVICE_NAME: 'test-s3-esm',
          TRACELOG_LOG_DIR: logDir,
          TRACELOG_CLOUD_PROVIDER: 'none',
          TRACELOG_CENTRAL_CONFIG: 'false',
          TRACELOG_METRICS_INTERVAL: '0s',
          TRACELOG_LOG_LEVEL: 'off',
        },
        extraEnv,
      ),
    },
    (err, stdout, stderr) => {
      t.error(err, `fixture ran cleanly${stderr ? `\nstderr: ${stderr}` : ''}`);
      const spans = readRecords(logDir, 'span');
      fs.rmSync(logDir, { recursive: true, force: true });
      done(spans);
    },
  );
}

test('aws-sdk v3 ESM: an S3 command produces an s3 exit span', (t) => {
  runFixture(t, {}, (spans) => {
    const s3Span = spans.find((s) => s.subtype === 's3');
    t.ok(
      s3Span,
      `an s3 span was recorded (got: ${JSON.stringify(
        spans.map((s) => `${String(s.type)}/${String(s.subtype)}`),
      )})`,
    );
    if (s3Span) {
      t.equal(s3Span.name, 'S3 PutObject a-bucket', 'span.name');
      t.equal(s3Span.type, 'storage', 'span.type');
    }
    t.end();
  });
});

// The configuration that shipped broken: with an upload bucket set, the agent
// builds an S3Uploader from inside start(), one step before instrumentation
// installs its hooks. While that uploader built its S3 client eagerly, it
// pulled the AWS SDK in too early to be patched and the application lost every
// AWS span — with no error anywhere, and with every other test still passing.
test('aws-sdk v3 ESM: ...even when the agent has its own upload bucket', (t) => {
  runFixture(
    t,
    {
      TRACELOG_S3_BUCKET: 'a-bucket-that-does-not-exist',
      TRACELOG_S3_REGION: 'us-east-1',
    },
    (spans) => {
      t.ok(
        spans.find((s) => s.subtype === 's3'),
        `an s3 span was recorded (got: ${JSON.stringify(
          spans.map((s) => `${String(s.type)}/${String(s.subtype)}`),
        )})`,
      );
      t.end();
    },
  );
});
