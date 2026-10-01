/*
 * Copyright Red Thread Labs LLC. All rights reserved.
 * Licensed under the BSD 2-Clause License; you may not use this file except in
 * compliance with the BSD 2-Clause License.
 */

'use strict';

const test = require('tape');

const { CallbackClient } = require('../../lib/apm-client/callback-client');

function makeClient(opts = {}) {
  return new CallbackClient({
    serviceName: 'test-svc',
    serviceVersion: '1.0.0',
    environment: 'test',
    flushIntervalMs: 60000, // large so the tests control delivery
    ...opts,
  });
}

function capture() {
  const batches = [];
  const handler = (records, origin) => {
    batches.push({ records, origin });
  };
  return { batches, handler };
}

test('flush hands queued records to the handler as { kind, record }', (t) => {
  const { batches, handler } = capture();
  const client = makeClient({ handler });

  client.sendTransaction({ name: 'tx1', type: 'request', duration: 10 });
  client.sendSpan({ name: 'sp1', type: 'db', duration: 2 });
  client.sendError({ id: 'e1', exception: { message: 'boom' } });
  client.sendMetricSet({ samples: { 'a.b': { value: 1 } } });
  client.sendEvent({ type: 'page.view', level: 'info', message: '' });

  client.flush(() => {
    t.equal(batches.length, 1, 'one batch');
    t.deepEqual(
      batches[0].records.map((r) => r.kind),
      ['transaction', 'span', 'error', 'metricset', 'event'],
      'kinds in arrival order',
    );
    t.equal(batches[0].records[0].record.name, 'tx1', 'the record itself');
    t.equal(client.queueSize, 0, 'queue drained');
    client.destroy();
    t.end();
  });
});

test('the origin is the file sink metadata header, with the channel', (t) => {
  const { batches, handler } = capture();
  const client = makeClient({ handler, defaultChannel: 'server' });

  client.sendTransaction({ name: 'tx1' });
  client.flush(() => {
    const origin = batches[0].origin;
    t.equal(origin.channel, 'server', 'channel named');
    t.equal(origin.service.name, 'test-svc');
    t.equal(origin.service.version, '1.0.0');
    t.equal(origin.service.agent.name, 'tracelog');
    t.ok(origin.system.hostname, 'system.hostname');
    t.equal(origin.process.pid, process.pid);
    client.destroy();
    t.end();
  });
});

test('extra metadata and metadata filters apply to the origin', (t) => {
  const { batches, handler } = capture();
  const client = makeClient({ handler });
  client.setExtraMetadata({ framework: { name: 'hono' } });
  client.addMetadataFilter((m) => {
    m.labels = { tier: 'api' };
    return m;
  });

  client.sendTransaction({ name: 'tx1' });
  client.flush(() => {
    t.equal(batches[0].origin.framework.name, 'hono');
    t.deepEqual(batches[0].origin.labels, { tier: 'api' });
    client.destroy();
    t.end();
  });
});

test('one batch per channel, the channel on each origin', (t) => {
  const { batches, handler } = capture();
  const client = makeClient({ handler });

  client.sendTransaction({ name: 'server-tx' });
  client.sendToChannel('client', 'event', { type: 'page.view' });
  client.sendToChannel('client', 'metadata', { lifetime_id: 'a'.repeat(16) });
  client.sendSpan({ name: 'server-span' });

  client.flush(() => {
    t.equal(batches.length, 2, 'two batches');
    t.equal(batches[0].origin.channel, 'default');
    t.deepEqual(
      batches[0].records.map((r) => r.record.name),
      ['server-tx', 'server-span'],
    );
    t.equal(batches[1].origin.channel, 'client');
    t.deepEqual(
      batches[1].records.map((r) => r.kind),
      ['event', 'metadata'],
      'an in-stream client origin arrives as a metadata record',
    );
    client.destroy();
    t.end();
  });
});

test('batching by count: batchSize records deliver without a flush', (t) => {
  const { batches, handler } = capture();
  const client = makeClient({ handler, batchSize: 3 });

  client.sendSpan({ name: 's1' });
  client.sendSpan({ name: 's2' });
  setImmediate(() => {
    t.equal(batches.length, 0, 'below the batch size, nothing yet');
    client.sendSpan({ name: 's3' });
    client.sendSpan({ name: 's4' });
    setImmediate(() => {
      t.ok(batches.length >= 1, 'delivered once the batch size was reached');
      t.equal(batches[0].records.length, 3, 'a batch holds batchSize records');
      client.destroy();
      t.end();
    });
  });
});

test('flush delivers a long queue in batchSize batches', (t) => {
  const { batches, handler } = capture();
  const client = makeClient({ batchSize: 4 });
  for (let i = 0; i < 10; i++) client.sendSpan({ name: 's' + i });
  client.setHandler(handler);
  client.flush(() => {
    t.deepEqual(
      batches.map((b) => b.records.length),
      [4, 4, 2],
      'three batches of at most four',
    );
    client.destroy();
    t.end();
  });
});

test('batching by interval: the cadence delivers', (t) => {
  const { batches, handler } = capture();
  const client = makeClient({ handler, flushIntervalMs: 20 });

  client.sendTransaction({ name: 'tx1' });
  setTimeout(() => {
    t.equal(batches.length, 1, 'delivered on the cadence');
    client.destroy();
    t.end();
  }, 80);
});

test('the bounded queue drops the oldest and counts the drops', (t) => {
  const { batches, handler } = capture();
  const client = makeClient({ maxQueueSize: 3, batchSize: 100 });
  const drops = [];
  client.on('drop', (count) => drops.push(count));

  for (let i = 1; i <= 5; i++) client.sendSpan({ name: 's' + i });
  t.equal(client.queueSize, 3, 'queue at its cap');
  t.equal(client.dropCount, 2, 'two dropped');
  t.deepEqual(drops, [1, 2], 'a drop event per dropped record');

  client.setHandler(handler);
  client.flush(() => {
    t.deepEqual(
      batches[0].records.map((r) => r.record.name),
      ['s3', 's4', 's5'],
      'the oldest were dropped',
    );
    client.destroy();
    t.end();
  });
});

test('records buffer until a handler is set', (t) => {
  const { batches, handler } = capture();
  const client = makeClient();

  client.sendTransaction({ name: 'early' });
  client.flush(() => {
    t.equal(client.queueSize, 1, 'flush without a handler keeps records');
    client.setHandler(handler);
    setImmediate(() => {
      t.equal(batches.length, 1, 'delivered once the handler arrives');
      t.equal(batches[0].records[0].record.name, 'early');
      t.ok(batches[0].origin, 'the first batch carries the origin');
      client.destroy();
      t.end();
    });
  });
});

test('setHandler(null) stops delivery and records queue again', (t) => {
  const { batches, handler } = capture();
  const client = makeClient({ handler });
  client.setHandler(null);
  client.sendSpan({ name: 's1' });
  client.flush(() => {
    t.equal(batches.length, 0, 'no handler, no delivery');
    t.equal(client.queueSize, 1);
    client.destroy();
    t.end();
  });
});

test('flush waits for an async handler', (t) => {
  const seen = [];
  const client = makeClient({
    handler: (records) =>
      new Promise((resolve) => {
        setTimeout(() => {
          seen.push(records.length);
          resolve();
        }, 10);
      }),
  });
  client.sendSpan({ name: 's1' });
  client.sendSpan({ name: 's2' });
  client.flush(() => {
    t.deepEqual(seen, [2], 'the handler finished before flush called back');
    client.destroy();
    t.end();
  });
});

test('a throwing handler is reported as an error and delivery continues', (t) => {
  let calls = 0;
  const client = makeClient({
    batchSize: 1,
    handler: () => {
      calls++;
      if (calls === 1) throw new Error('db down');
    },
  });
  const errors = [];
  client.on('error', (err) => errors.push(err.message));
  client.sendSpan({ name: 's1' });
  client.sendSpan({ name: 's2' });
  client.flush(() => {
    t.equal(calls, 2, 'the second batch still delivered');
    t.deepEqual(errors, ['db down']);
    client.destroy();
    t.end();
  });
});

test('records are truncated and JSON-safe, like the file sink', (t) => {
  const { batches, handler } = capture();
  const client = makeClient({ handler, truncateKeywordsAt: 5 });
  client.sendTransaction({ name: 'abcdefghij', when: undefined });
  client.flush(() => {
    const record = batches[0].records[0].record;
    t.equal(record.name, 'abcde', 'keyword truncated');
    t.notOk('when' in record, 'undefined fields gone');
    client.destroy();
    t.end();
  });
});

test('holds delivery until cloud metadata resolves, then includes it', (t) => {
  const { batches, handler } = capture();
  let resolve;
  const client = makeClient({
    handler,
    cloudMetadataFetcher: {
      getCloudMetadata(cb) {
        resolve = cb;
      },
    },
  });
  client.sendTransaction({ name: 'tx1' });
  client.flush(() => {
    t.equal(batches.length, 0, 'held while cloud metadata is pending');
    resolve(null, { provider: 'aws', region: 'us-east-1' });
    client.flush(() => {
      t.equal(batches.length, 1, 'delivered once it resolved');
      t.equal(batches[0].origin.cloud.provider, 'aws');
      client.destroy();
      t.end();
    });
  });
});

test('destroy hands the queue to the handler and stops accepting', (t) => {
  const { batches, handler } = capture();
  const client = makeClient({
    handler,
    cloudMetadataFetcher: { getCloudMetadata() {} }, // never resolves
  });
  client.sendTransaction({ name: 'tx1' });
  client.destroy();
  t.equal(batches.length, 1, 'delivered at destroy despite pending metadata');
  client.sendTransaction({ name: 'late' });
  t.equal(client.queueSize, 0, 'nothing queued after destroy');
  t.end();
});
