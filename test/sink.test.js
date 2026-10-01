/*
 * Copyright Red Thread Labs LLC. All rights reserved.
 * Licensed under the BSD 2-Clause License; you may not use this file except in
 * compliance with the BSD 2-Clause License.
 */

'use strict';

// Sink selection (`sink: file | callback | both`, `TRACELOG_SINK`) and the
// agent's `onBatch` / `sinkDropCount` API.

const test = require('tape');
const fs = require('fs');
const os = require('os');
const path = require('path');

const Agent = require('../lib/agent');
const { CallbackClient } = require('../lib/apm-client/callback-client');
const { JsonlFileClient } = require('../lib/apm-client/jsonl-file-client');
const { TeeClient } = require('../lib/apm-client/tee-client');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tracelog-sink-test-'));
}

function agentOpts(extra) {
  return {
    serviceName: 'test-sink',
    cloudProvider: 'none',
    centralConfig: false,
    captureExceptions: false,
    metricsInterval: '0s',
    logLevel: 'off',
    logFlushIntervalMs: 60000,
    ...extra,
  };
}

function readAllLines(dir) {
  const lines = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.jsonl')) continue;
    const text = fs.readFileSync(path.join(dir, file), 'utf8').trim();
    if (text) lines.push(...text.split('\n').map(JSON.parse));
  }
  return lines;
}

function capture() {
  const batches = [];
  const handler = (records, origin) => {
    batches.push({ records, origin });
  };
  const kinds = () => batches.flatMap((b) => b.records.map((r) => r.kind));
  return { batches, handler, kinds };
}

test('the default sink is the file sink', (t) => {
  const dir = tmpDir();
  const agent = new Agent().start(agentOpts({ logDir: dir }));
  t.ok(agent._apmClient instanceof JsonlFileClient, 'JsonlFileClient');
  agent.destroy();
  t.end();
});

test('an invalid sink falls back to file', (t) => {
  const dir = tmpDir();
  const agent = new Agent().start(agentOpts({ logDir: dir, sink: 'kafka' }));
  t.ok(agent._apmClient instanceof JsonlFileClient, 'JsonlFileClient');
  agent.destroy();
  t.end();
});

test('TRACELOG_SINK selects the sink', (t) => {
  process.env.TRACELOG_SINK = 'callback';
  const agent = new Agent().start(agentOpts());
  delete process.env.TRACELOG_SINK;
  t.ok(agent._apmClient instanceof CallbackClient, 'CallbackClient');
  agent.destroy();
  t.end();
});

test('sink callback: the handler gets transactions and nothing is written', (t) => {
  const dir = tmpDir();
  const { batches, handler, kinds } = capture();
  const agent = new Agent().start(
    agentOpts({ sink: 'callback', logDir: dir, defaultChannel: 'server' }),
  );
  agent.onBatch(handler);

  agent.startTransaction('GET /things', 'request').end();
  agent.flush(() => {
    t.deepEqual(kinds(), ['transaction'], 'one transaction');
    t.equal(batches[0].records[0].record.name, 'GET /things');
    t.equal(batches[0].origin.channel, 'server', 'origin names the channel');
    t.equal(batches[0].origin.service.name, 'test-sink');
    t.deepEqual(fs.readdirSync(dir), [], 'no files written');
    agent.destroy();
    t.end();
  });
});

test('records written before onBatch are buffered for the handler', (t) => {
  const { batches, handler, kinds } = capture();
  const agent = new Agent().start(agentOpts({ sink: 'callback' }));

  agent.writeEvent('app.boot', { message: 'up' });
  agent.flush(() => {
    t.equal(batches.length, 0, 'no handler yet');
    agent.onBatch(handler);
    agent.flush(() => {
      t.deepEqual(kinds(), ['event'], 'the early event arrived');
      t.equal(batches[0].records[0].record.type, 'app.boot');
      t.ok(batches[0].origin, 'with the origin');
      agent.destroy();
      t.end();
    });
  });
});

test('onBatch before start registers the handler', (t) => {
  const { handler, kinds } = capture();
  const agent = new Agent();
  agent.onBatch(handler);
  agent.start(agentOpts({ sink: 'callback' }));
  agent.writeEvent('app.boot');
  agent.flush(() => {
    t.deepEqual(kinds(), ['event']);
    agent.destroy();
    t.end();
  });
});

test('the returned function and onBatch(null) remove the handler', (t) => {
  const { batches, handler } = capture();
  const agent = new Agent().start(agentOpts({ sink: 'callback' }));
  const unsubscribe = agent.onBatch(handler);
  unsubscribe();
  agent.writeEvent('app.boot');
  agent.flush(() => {
    t.equal(batches.length, 0, 'unsubscribed');
    agent.onBatch(handler);
    agent.onBatch(null);
    agent.flush(() => {
      t.equal(batches.length, 0, 'onBatch(null)');
      t.throws(() => agent.onBatch('nope'), TypeError, 'non-function rejected');
      agent.destroy();
      t.end();
    });
  });
});

test('sink both: the file sink writes as today and the handler gets every record', (t) => {
  const dir = tmpDir();
  const { handler, kinds } = capture();
  const agent = new Agent().start(agentOpts({ sink: 'both', logDir: dir }));
  t.ok(agent._apmClient instanceof TeeClient, 'TeeClient');
  agent.onBatch(handler);

  agent.startTransaction('GET /both', 'request').end();
  agent.writeEvent('thing.done');
  agent.flush(() => {
    t.deepEqual(kinds(), ['transaction', 'event'], 'the handler got both');
    const lines = readAllLines(dir);
    t.ok(lines[0].metadata, 'the file starts with metadata');
    t.ok(lines.some((l) => l.transaction && l.transaction.name === 'GET /both'), 'file has the transaction');
    t.ok(lines.some((l) => l.event && l.event.type === 'thing.done'), 'file has the event');
    agent.destroy();
    t.end();
  });
});

test('channels: writeEvent and client ingest reach the handler with the channel', (t) => {
  const { batches, handler } = capture();
  const agent = new Agent().start(agentOpts({ sink: 'callback' }));
  agent.onBatch(handler);

  const ch = agent.getChannel('client');
  ch.writeRecordOrigin({
    lifetime_id: 'a'.repeat(16),
    service: { name: 'web', version: '1' },
    runtime: { name: 'browser', version: '1' },
  });
  ch.writeClientEvents([
    { type: 'page.view', timestamp: 1700000000000000, level: 'info', message: '' },
  ]);
  ch.writeEvent('audit.project.create', { context: { labels: { a: 1 } } });

  agent.flush(() => {
    t.equal(batches.length, 1, 'one batch for the channel');
    t.equal(batches[0].origin.channel, 'client');
    t.deepEqual(
      batches[0].records.map((r) => r.kind),
      ['metadata', 'event', 'event'],
    );
    t.equal(batches[0].records[0].record.lifetime_id, 'a'.repeat(16));
    t.equal(batches[0].records[2].record.type, 'audit.project.create');
    agent.destroy();
    t.end();
  });
});

test('sinkDropCount counts records dropped from a full queue', (t) => {
  const { handler } = capture();
  const agent = new Agent().start(
    agentOpts({ sink: 'callback', sinkMaxQueueSize: 2, sinkBatchSize: 100 }),
  );
  t.equal(agent.sinkDropCount, 0, 'starts at zero');
  for (let i = 0; i < 5; i++) agent.writeEvent('e' + i);
  t.equal(agent.sinkDropCount, 3, 'three dropped');
  agent.onBatch(handler);
  agent.destroy();
  t.end();
});

test('sinkDropCount is 0 with the file sink', (t) => {
  const dir = tmpDir();
  const agent = new Agent().start(agentOpts({ logDir: dir }));
  t.equal(agent.sinkDropCount, 0);
  agent.destroy();
  t.end();
});
