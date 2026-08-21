/*
 * Copyright Red Thread Labs LLC. All rights reserved.
 * Licensed under the BSD 2-Clause License; you may not use this file except in
 * compliance with the BSD 2-Clause License.
 */

// An ESM service issuing an S3 command, for s3-client-esm.test.js. Run as:
//
//   node --experimental-loader <repo>/loader.mjs -r <repo>/start.js use-s3-client.mjs
//
// The AWS SDK is CommonJS, reached here through a hoisted static `import` —
// the shape a real ESM service has, and the one that produced HTTP
// transactions with no S3 spans inside them.

import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

import apm from '../../../../../index.js';

const trans = apm.startTransaction('s3-caller');
const client = new S3Client({
  region: 'us-east-1',
  endpoint: 'http://127.0.0.1:1', // nothing listens here; the span is the point
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  maxAttempts: 1,
  requestHandler: { requestTimeout: 500, connectionTimeout: 500 },
});

try {
  await client.send(
    new PutObjectCommand({ Bucket: 'a-bucket', Key: 'a-key', Body: 'hi' }),
  );
} catch {
  // expected: the connection is refused
}
trans.end();

apm.flush(() => {
  apm.destroy();
  process.exit(0);
});
