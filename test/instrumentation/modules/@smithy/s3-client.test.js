/*
 * Copyright Red Thread Labs LLC. All rights reserved.
 * Licensed under the BSD 2-Clause License; you may not use this file except in
 * compliance with the BSD 2-Clause License.
 */

'use strict';

// AWS SDK v3 exit spans, for both module systems.
//
// The base client all `@aws-sdk/client-*` clients extend has moved: older
// SDKs put it in @smithy/smithy-client, newer ones dropped that package
// entirely and export it from a submodule of @smithy/core. When the SDK moved,
// the instrumentation silently stopped producing spans — an S3 call still
// showed up, but only as the IMDS credential fetch underneath it — so these
// tests assert on the span an S3 command actually produces.
//
// No network and no credentials: the command is pointed at a closed local
// port with retries disabled. The span is created when the command is issued,
// so it exists whether or not the call succeeds.

const test = require('tape');

const Agent = require('../../../../lib/agent');
const { CapturingTransport } = require('../../../_capturing_transport');

const agent = new Agent().start({
  serviceName: 'test-s3-client',
  cloudProvider: 'none',
  centralConfig: false,
  captureExceptions: false,
  metricsInterval: '0s',
  spanCompressionEnabled: false,
  logLevel: 'off',
  transport() {
    return new CapturingTransport();
  },
});

// Required after the agent starts, so the module hooks are in place.
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

test.onFinish(() => agent.destroy());

/** An S3 client that fails fast against a closed port. */
function offlineClient() {
  return new S3Client({
    region: 'us-east-1',
    endpoint: 'http://127.0.0.1:1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    maxAttempts: 1,
    requestHandler: { requestTimeout: 500, connectionTimeout: 500 },
  });
}

/** Resolve once the transport has captured `n` spans (or time out). A span is
 * encoded and sent a beat after the call it measures settles. */
async function waitForSpans(n, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (agent._apmClient.spans.length < n && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return agent._apmClient.spans;
}

test('aws-sdk v3: an S3 command produces an s3 exit span', async (t) => {
  agent._apmClient.clear();

  const trans = agent.startTransaction('s3-caller');
  const client = offlineClient();
  try {
    await client.send(
      new PutObjectCommand({ Bucket: 'a-bucket', Key: 'a-key', Body: 'hi' }),
    );
  } catch (_expected) {
    // Nothing is listening on port 1; the span is what matters.
  }
  trans.end();

  const spans = await waitForSpans(1);
  const s3Span = spans.find((s) => s.subtype === 's3');
  t.ok(
    s3Span,
    `an s3 span was recorded (got: ${JSON.stringify(
      spans.map((s) => `${String(s.type)}/${String(s.subtype)}`),
    )})`,
  );
  if (s3Span) {
    t.equal(s3Span.type, 'storage', 'span.type');
    t.equal(s3Span.action, 'PutObject', 'span.action names the command');
    t.equal(s3Span.name, 'S3 PutObject a-bucket', 'span.name names the bucket');
    t.equal(
      s3Span.context.destination.service.resource,
      'a-bucket',
      'destination resource is the bucket',
    );
    t.equal(s3Span.outcome, 'failure', 'a failed call is a failed span');
  }

  t.end();
});
