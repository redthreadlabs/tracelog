/*
 * Copyright Red Thread Labs LLC. All rights reserved.
 * Licensed under the BSD 2-Clause License; you may not use this file except in
 * compliance with the BSD 2-Clause License.
 */

'use strict';

// The same instrumentation, reached the way an ESM service loads it: static
// `import` statements hooked by import-in-the-middle (loader.mjs), with the
// agent started from `-r start.js`. Hono is ESM-first, so this — not the
// CommonJS path — is how most Hono services will run.
//
// The assertions read the JSONL the agent actually wrote, so this also covers
// the file transport end to end.

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const test = require('tape');

const semver = require('semver');

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const FIXTURE = path.join(__dirname, 'fixtures', 'use-hono.mjs');

/** Read every record of `kind` out of the JSONL files in `dir`. */
function readRecords(dir, kind) {
  const records = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.jsonl')) {
      continue;
    }
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    for (const line of text.split('\n')) {
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

test('hono ESM: transactions are named from the matched route', (t) => {
  // import-in-the-middle needs the ESM loader hooks.
  if (!semver.satisfies(process.version, '>=14.0.0')) {
    t.comment(`SKIP node ${process.version} has no usable ESM loader hooks`);
    t.end();
    return;
  }

  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracelog-hono-esm-'));
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
      env: Object.assign({}, process.env, {
        NODE_NO_WARNINGS: '1', // silence the --experimental-loader notice
        TRACELOG_SERVICE_NAME: 'test-hono-esm',
        TRACELOG_LOG_DIR: logDir,
        TRACELOG_CLOUD_PROVIDER: 'none',
        TRACELOG_CENTRAL_CONFIG: 'false',
        TRACELOG_METRICS_INTERVAL: '0s',
        TRACELOG_LOG_LEVEL: 'off',
      }),
    },
    (err, stdout, stderr) => {
      t.error(err, `fixture ran cleanly${stderr ? `\nstderr: ${stderr}` : ''}`);

      const names = readRecords(logDir, 'transaction')
        .map((trans) => trans.name)
        .sort();
      t.deepEqual(
        names,
        ['GET /objects/:id', 'GET /users/:name', 'GET unknown route'],
        'ESM imports are instrumented: routes named, sub-app merged, 404 folded',
      );

      // NOTE: `setFramework` populates `frameworkName` in the agent's config,
      // but this fork's metadata record carries no framework field (that part
      // of the upstream payload went with the HTTP transport), so the CJS
      // test asserts the framework name and this one asserts only that a
      // well-formed metadata line opened the file.
      const metadata = readRecords(logDir, 'metadata')[0];
      t.equal(
        metadata && metadata.service.name,
        'test-hono-esm',
        'the JSONL opens with this service\'s metadata',
      );

      fs.rmSync(logDir, { recursive: true, force: true });
      t.end();
    },
  );
});
