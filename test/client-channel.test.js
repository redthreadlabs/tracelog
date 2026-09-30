/*
 * Copyright Red Thread Labs LLC. All rights reserved.
 * Licensed under the BSD 2-Clause License; you may not use this file except in
 * compliance with the BSD 2-Clause License.
 */

'use strict';

// The client-ingest channel API: writeClientEvents / writeRecordOrigin forward
// the schema-0.4.0 record shapes as-is, and writeTransaction/writeSpan pass the
// new lifetime_id join key + context.labels through validation.

const test = require('tape');

const Agent = require('../lib/agent');
const { CapturingTransport } = require('./_capturing_transport');

const testAgentOpts = {
  serviceName: 'test-client-channel',
  cloudProvider: 'none',
  centralConfig: false,
  captureExceptions: false,
  metricsInterval: '0s',
  logLevel: 'off',
  transport() {
    return new CapturingTransport();
  },
};

const HEX16 = 'a'.repeat(16);
const HEX16B = 'b'.repeat(16);
const HEX32 = 'c'.repeat(32);

test('writeClientEvents forwards the new event shape as-is (labels/locale/lifetime_id, µs)', (t) => {
  const agent = new Agent().start(testAgentOpts);
  agent.getChannel('client').writeClientEvents([
    {
      type: 'auth',
      timestamp: 1700000000000000, // epoch µs, forwarded unchanged
      level: 'warn',
      message: 'login failed',
      locale: 'en-US',
      lifetime_id: HEX16,
      context: { labels: { attempt: 2, ok: false, who: 'x' }, user: { id: 'u1' } },
      tz_offset: -300,
      error: { message: 'bad creds', code: 401 },
    },
  ]);

  const evs = agent._apmClient.channels.client.events;
  t.equal(evs.length, 1, 'one event forwarded');
  const e = evs[0];
  t.equal(e.timestamp, 1700000000000000, 'µs timestamp preserved (no ×1000)');
  t.equal(e.level, 'warn');
  t.equal(e.locale, 'en-US');
  t.equal(e.lifetime_id, HEX16);
  t.deepEqual(e.context, { labels: { attempt: 2, ok: false, who: 'x' }, user: { id: 'u1' } }, 'labels + user under context');
  t.equal(e.error.code, '401', 'error code stringified');
  t.equal(e.params, undefined, 'no legacy params');
  t.equal(e.duration, undefined, 'events carry no duration');
  agent.destroy();
  t.end();
});

test('writeClientEvents defaults a bad level/type and skips non-objects', (t) => {
  const agent = new Agent().start(testAgentOpts);
  agent.getChannel('client').writeClientEvents([{ level: 'nonsense' }, null]);
  const evs = agent._apmClient.channels.client.events;
  t.equal(evs.length, 1, 'the null input is skipped');
  t.equal(evs[0].level, 'info', 'invalid level → info');
  t.equal(evs[0].type, 'client-log', 'missing type → client-log');
  agent.destroy();
  t.end();
});

test('writeRecordOrigin writes a metadata record carrying the RecordOrigin', (t) => {
  const agent = new Agent().start(testAgentOpts);
  agent.getChannel('client').writeRecordOrigin({
    lifetime_id: HEX16,
    service: { name: 'duiduidui-app', version: '2.6.0' },
    runtime: { name: 'react-native', version: '0.85' },
    os: { name: 'iOS', version: '18' },
    device: {
      id: 'install-abc', model: 'iPhone15', brand: 'Apple', type: 'phone', year_class: 2022,
      screen: { width: 393, height: 852, pixel_ratio: 3 },
    },
    bogus: 'dropped',
  });

  const metas = agent._apmClient.channels.client.metadatas;
  t.equal(metas.length, 1, 'one metadata record written');
  const o = metas[0];
  t.equal(o.lifetime_id, HEX16, 'lifetime_id is the join key');
  t.deepEqual(o.service, { name: 'duiduidui-app', version: '2.6.0' });
  t.deepEqual(o.runtime, { name: 'react-native', version: '0.85' });
  t.equal(o.device.id, 'install-abc', 'opaque device id preserved');
  t.equal(o.device.year_class, 2022, 'numeric device field preserved');
  t.deepEqual(o.device.screen, { width: 393, height: 852, pixel_ratio: 3 });
  t.equal(o.bogus, undefined, 'unknown fields stripped');
  agent.destroy();
  t.end();
});

test('writeRecordOrigin rejects a non-origin (no service/runtime → nothing written)', (t) => {
  const agent = new Agent().start(testAgentOpts);
  agent.getChannel('client').writeRecordOrigin({ junk: true });
  const metas = (agent._apmClient.channels.client || {}).metadatas || [];
  t.equal(metas.length, 0, 'an empty origin writes nothing');
  agent.destroy();
  t.end();
});

test('client transaction/span pass lifetime_id through and keep context.labels', (t) => {
  const agent = new Agent().start(testAgentOpts);
  const ch = agent.getChannel('client');
  ch.writeTransaction({
    id: HEX16, trace_id: HEX32, name: 'req', type: 'app',
    timestamp: 1700000000000000, duration: 12, outcome: 'success',
    lifetime_id: HEX16, context: { labels: { route: '/x' }, user: { id: 'u1' } },
  });
  ch.writeSpan({
    id: HEX16B, trace_id: HEX32, transaction_id: HEX16, parent_id: HEX16,
    name: 'db', type: 'db', timestamp: 1700000000000000, duration: 4, outcome: 'success',
    lifetime_id: HEX16, context: { labels: { rows: 3 } },
  });

  const tr = agent._apmClient.channels.client.transactions[0];
  const sp = agent._apmClient.channels.client.spans[0];
  t.equal(tr.lifetime_id, HEX16, 'transaction lifetime_id passes validation');
  t.deepEqual(tr.context.labels, { route: '/x' }, 'transaction labels survive (not tags)');
  t.deepEqual(tr.context.user, { id: 'u1' }, 'transaction user survives');
  t.equal(tr.context.tags, undefined, 'no legacy tags key');
  t.equal(sp.lifetime_id, HEX16, 'span lifetime_id passes validation');
  t.deepEqual(sp.context.labels, { rows: 3 }, 'span labels survive');
  agent.destroy();
  t.end();
});

// --- Analytics context (tracelog-schema 0.6.0) ---

const fs = require('fs');
const os = require('os');
const path = require('path');
const { JsonlFileClient } = require('../lib/apm-client/jsonl-file-client');

const FULL_CONTEXT = {
  labels: { dwell_ms: 5200, ok: true, name: 'run.click' },
  user: { id: 'u_1' },
  visitor: { id: 'v_abc', kind: 'human' },
  visit: { id: 'vis_1', n: 3 },
  actor: { agent: { name: 'claude-code', version: '2.1.280' }, via: 'mcp' },
  page: {
    url: 'https://docs.example.com/reference/ops?x=1',
    path: '/reference/ops',
    title: 'Ops',
    referrer: 'https://www.google.com/',
    release: '0.170.0',
  },
  campaign: { source: 'hn', medium: 'social', name: 'launch', term: 'interp', content: 'top' },
  geo: { country: 'US', region: 'OR', city: 'Portland' },
  entity: { project: 'proj_1', docs_page: '/reference/ops' },
};

const FULL_ORIGIN = {
  lifetime_id: HEX16,
  schema: '0.6.0',
  service: { name: 'mechbench-web', version: '1.0.0' },
  runtime: { name: 'browser', version: 'chrome-140' },
};

function writeFullBatch(ch) {
  ch.writeRecordOrigin(FULL_ORIGIN);
  ch.writeClientEvents([
    {
      type: 'page.view', timestamp: 1700000000000000, level: 'info', message: 'page.view',
      lifetime_id: HEX16, context: FULL_CONTEXT,
    },
  ]);
  ch.writeTransaction({
    id: HEX16, trace_id: HEX32, name: 'page-load', type: 'app',
    timestamp: 1700000000000000, duration: 812, outcome: 'success',
    lifetime_id: HEX16, context: FULL_CONTEXT,
  });
  ch.writeSpan({
    id: HEX16B, trace_id: HEX32, transaction_id: HEX16, parent_id: HEX16,
    name: 'ttfb', type: 'app', timestamp: 1700000000000000, duration: 90, outcome: 'success',
    lifetime_id: HEX16, context: FULL_CONTEXT,
  });
}

test('client records keep every analytics context sub-object; origin keeps schema', (t) => {
  const agent = new Agent().start(testAgentOpts);
  writeFullBatch(agent.getChannel('client'));
  const ch = agent._apmClient.channels.client;
  t.deepEqual(ch.events[0].context, FULL_CONTEXT, 'event context unchanged');
  t.deepEqual(ch.transactions[0].context, FULL_CONTEXT, 'transaction context unchanged');
  t.deepEqual(ch.spans[0].context, FULL_CONTEXT, 'span context unchanged');
  t.equal(ch.metadatas[0].schema, '0.6.0', 'origin.schema kept');
  agent.destroy();
  t.end();
});

test('a batch carrying every analytics field round-trips to the NDJSON lines unchanged', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracelog-analytics-'));
  const agent = new Agent().start({
    ...testAgentOpts,
    transport() {
      return new JsonlFileClient({
        logDir: dir, serviceName: 'test-client-channel', serviceVersion: '1.0.0',
        environment: 'test', flushIntervalMs: 60000,
      });
    },
  });
  writeFullBatch(agent.getChannel('client'));
  agent._apmClient.flush();

  const file = fs.readdirSync(dir).find((f) => f.includes('-client-'));
  t.ok(file, 'the client channel wrote a file');
  const lines = fs.readFileSync(path.join(dir, file), 'utf8').trim().split('\n').map(JSON.parse);
  const origin = lines.find((l) => l.metadata && l.metadata.lifetime_id === HEX16);
  t.deepEqual(origin && origin.metadata, FULL_ORIGIN, 'the in-stream origin line, schema included');
  const event = lines.find((l) => l.event).event;
  const transaction = lines.find((l) => l.transaction).transaction;
  const span = lines.find((l) => l.span).span;
  t.deepEqual(event.context, FULL_CONTEXT, 'event line context unchanged');
  t.equal(event.type, 'page.view');
  t.deepEqual(transaction.context, FULL_CONTEXT, 'transaction line context unchanged');
  t.deepEqual(span.context, FULL_CONTEXT, 'span line context unchanged');
  agent.destroy();
  fs.rmSync(dir, { recursive: true, force: true });
  t.end();
});

test('malformed analytics sub-objects are dropped, the rest kept', (t) => {
  const agent = new Agent().start(testAgentOpts);
  agent.getChannel('client').writeClientEvents([
    {
      type: 'verb.call',
      context: {
        labels: { noun: 'run', nested: { x: 1 } },
        visitor: { id: 'v1', kind: 'robot' },
        actor: { via: 'cli', agent: { name: 'mechbench-cli', version: '0.51.0' }, extra: 1 },
        entity: { run: 'run_1', n: 7 },
        tags: { legacy: 1 },
      },
    },
  ]);
  const e = agent._apmClient.channels.client.events[0];
  t.deepEqual(e.context, {
    labels: { noun: 'run' },
    actor: { via: 'cli', agent: { name: 'mechbench-cli', version: '0.51.0' } },
    entity: { run: 'run_1' },
  });
  agent.destroy();
  t.end();
});

test('a server writeEvent with every context field lands under context, trace ids on the record', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracelog-server-event-'));
  const agent = new Agent().start({
    ...testAgentOpts,
    transport() {
      return new JsonlFileClient({
        logDir: dir, serviceName: 'test-client-channel', serviceVersion: '1.0.0',
        environment: 'test', flushIntervalMs: 60000,
      });
    },
  });
  const trans = agent.startTransaction('POST /projects', 'request');
  agent.writeEvent('audit.project.create', { message: 'created', level: 'info', context: FULL_CONTEXT });
  agent.getChannel('audit').writeEvent('audit.project.create', { context: FULL_CONTEXT });
  trans.end();
  agent._apmClient.flush();

  const read = (match) => {
    const file = fs.readdirSync(dir).find(match);
    return fs.readFileSync(path.join(dir, file), 'utf8').trim().split('\n').map(JSON.parse)
      .filter((l) => l.event).map((l) => l.event);
  };
  const [server] = read((f) => !f.includes('-audit-'));
  const [routed] = read((f) => f.includes('-audit-'));
  for (const [name, ev] of [['server', server], ['channel', routed]]) {
    t.deepEqual(ev.context, FULL_CONTEXT, `${name}: every context field under context`);
    t.equal(ev.trace_id, trans.traceId, `${name}: trace_id on the record`);
    t.equal(ev.transaction_id, trans.id, `${name}: transaction_id on the record`);
    t.equal(ev.context.labels.trace_id, undefined, `${name}: no trace ids in labels`);
    t.equal(ev.params, undefined, `${name}: no params`);
  }
  t.equal(server.type, 'audit.project.create');
  t.equal(server.message, 'created');
  agent.destroy();
  fs.rmSync(dir, { recursive: true, force: true });
  t.end();
});
