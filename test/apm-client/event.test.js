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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tracelog-event-test-'));
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
    flushIntervalMs: 60000,
    ...opts,
  });
}

// --- sendEvent basics ---

test('sendEvent writes event to JSONL file', (t) => {
  const dir = tmpDir();
  const client = makeClient(dir);

  client.sendEvent({
    type: 'page_view',
    timestamp: 1719484200000,
    message: 'User viewed dashboard',
  });
  client.flush();

  const files = listFiles(dir);
  t.equal(files.length, 1, 'one file created');

  const lines = readLines(path.join(dir, files[0]));
  t.equal(lines.length, 2, 'metadata + 1 event');
  t.ok(lines[0].metadata, 'first line is metadata');
  t.ok(lines[1].event, 'second line is event');
  t.equal(lines[1].event.type, 'page_view');
  t.equal(lines[1].event.timestamp, 1719484200000);
  t.equal(lines[1].event.message, 'User viewed dashboard');

  client.destroy();
  t.end();
});

test('sendEvent includes all standard fields', (t) => {
  const dir = tmpDir();
  const client = makeClient(dir);

  client.sendEvent({
    type: 'purchase',
    timestamp: 1719484200000,
    duration: 1250,
    message: 'User completed purchase',
    level: 'info',
    user: { id: 'u-abc123', email: 'jane@example.com', username: 'jane_doe' },
    client: {
      name: 'shaxpir-ios',
      version: '2.4.1',
      os: { name: 'iOS', version: '18.2' },
      device: { model: 'iPhone 16 Pro', type: 'phone' },
      runtime: { name: 'React Native', version: '0.76' },
    },
    params: { orderId: 'ord-999', amount: 49.99 },
  });
  client.flush();

  const files = listFiles(dir);
  const lines = readLines(path.join(dir, files[0]));
  const ev = lines[1].event;

  t.equal(ev.type, 'purchase');
  t.equal(ev.timestamp, 1719484200000);
  t.equal(ev.duration, 1250);
  t.equal(ev.message, 'User completed purchase');
  t.equal(ev.level, 'info');

  // User
  t.equal(ev.user.id, 'u-abc123');
  t.equal(ev.user.email, 'jane@example.com');
  t.equal(ev.user.username, 'jane_doe');

  // Client
  t.equal(ev.client.name, 'shaxpir-ios');
  t.equal(ev.client.version, '2.4.1');
  t.equal(ev.client.os.name, 'iOS');
  t.equal(ev.client.os.version, '18.2');
  t.equal(ev.client.device.model, 'iPhone 16 Pro');
  t.equal(ev.client.device.type, 'phone');
  t.equal(ev.client.runtime.name, 'React Native');
  t.equal(ev.client.runtime.version, '0.76');

  // Params
  t.equal(ev.params.orderId, 'ord-999');
  t.equal(ev.params.amount, 49.99);

  client.destroy();
  t.end();
});

test('sendEvent with minimal fields (type only)', (t) => {
  const dir = tmpDir();
  const client = makeClient(dir);

  client.sendEvent({ type: 'heartbeat', timestamp: 1000 });
  client.flush();

  const files = listFiles(dir);
  const lines = readLines(path.join(dir, files[0]));
  const ev = lines[1].event;

  t.equal(ev.type, 'heartbeat');
  t.equal(ev.timestamp, 1000);
  t.equal(ev.message, undefined, 'no message');
  t.equal(ev.level, undefined, 'no level');
  t.equal(ev.user, undefined, 'no user');
  t.equal(ev.client, undefined, 'no client');
  t.equal(ev.params, undefined, 'no params');

  client.destroy();
  t.end();
});

test('sendEvent as log line (message + level)', (t) => {
  const dir = tmpDir();
  const client = makeClient(dir);

  client.sendEvent({
    type: 'log',
    timestamp: Date.now(),
    message: 'Connection pool exhausted',
    level: 'error',
  });
  client.flush();

  const files = listFiles(dir);
  const lines = readLines(path.join(dir, files[0]));
  const ev = lines[1].event;

  t.equal(ev.type, 'log');
  t.equal(ev.level, 'error');
  t.equal(ev.message, 'Connection pool exhausted');

  client.destroy();
  t.end();
});

test('multiple events in same file', (t) => {
  const dir = tmpDir();
  const client = makeClient(dir);

  client.sendEvent({ type: 'page_view', timestamp: 1000, params: { page: '/home' } });
  client.sendEvent({ type: 'button_click', timestamp: 2000, params: { button: 'submit' } });
  client.sendEvent({ type: 'log', timestamp: 3000, message: 'debug info', level: 'debug' });
  client.flush();

  const files = listFiles(dir);
  const lines = readLines(path.join(dir, files[0]));
  t.equal(lines.length, 4, 'metadata + 3 events');
  t.equal(lines[1].event.type, 'page_view');
  t.equal(lines[2].event.type, 'button_click');
  t.equal(lines[3].event.type, 'log');

  client.destroy();
  t.end();
});

test('events interleaved with transactions and spans', (t) => {
  const dir = tmpDir();
  const client = makeClient(dir);

  client.sendTransaction({ name: 'tx1', type: 'request', duration: 10 });
  client.sendEvent({ type: 'analytics', timestamp: 1000, message: 'custom event' });
  client.sendSpan({ name: 'span1', type: 'db', duration: 5 });
  client.flush();

  const files = listFiles(dir);
  const lines = readLines(path.join(dir, files[0]));
  t.equal(lines.length, 4, 'metadata + 3 records');
  t.ok(lines[1].transaction, 'transaction');
  t.ok(lines[2].event, 'event');
  t.ok(lines[3].span, 'span');

  client.destroy();
  t.end();
});

// --- Batch sendEvent ---

test('batch of events written in order', (t) => {
  const dir = tmpDir();
  const client = makeClient(dir);

  const events = [
    { type: 'page_view', timestamp: 1000, params: { page: '/home' } },
    { type: 'button_click', timestamp: 2000, params: { button: 'submit' } },
    { type: 'log', timestamp: 3000, message: 'debug info', level: 'debug' },
    { type: 'purchase', timestamp: 4000, duration: 500, user: { id: 'u1' }, params: { amount: 9.99 } },
  ];

  for (const ev of events) {
    client.sendEvent(ev);
  }
  client.flush();

  const files = listFiles(dir);
  const lines = readLines(path.join(dir, files[0]));
  t.equal(lines.length, 5, 'metadata + 4 events');

  t.equal(lines[1].event.type, 'page_view');
  t.equal(lines[2].event.type, 'button_click');
  t.equal(lines[3].event.type, 'log');
  t.equal(lines[3].event.level, 'debug');
  t.equal(lines[4].event.type, 'purchase');
  t.equal(lines[4].event.duration, 500);
  t.equal(lines[4].event.user.id, 'u1');
  t.equal(lines[4].event.params.amount, 9.99);

  client.destroy();
  t.end();
});

test('batch with shared user and client across events', (t) => {
  const dir = tmpDir();
  const client = makeClient(dir);

  const user = { id: 'u-abc', email: 'test@example.com' };
  const clientEnv = { name: 'my-app', version: '1.0', os: { name: 'Android', version: '15' } };

  client.sendEvent({ type: 'session_start', timestamp: 1000, user, client: clientEnv });
  client.sendEvent({ type: 'page_view', timestamp: 2000, user, client: clientEnv, params: { page: '/home' } });
  client.sendEvent({ type: 'session_end', timestamp: 3000, user, client: clientEnv, duration: 2000 });
  client.flush();

  const files = listFiles(dir);
  const lines = readLines(path.join(dir, files[0]));

  for (let i = 1; i <= 3; i++) {
    t.equal(lines[i].event.user.id, 'u-abc', `event ${i} has user`);
    t.equal(lines[i].event.client.name, 'my-app', `event ${i} has client`);
  }

  client.destroy();
  t.end();
});

test('sendEvent ignored after destroy', (t) => {
  const dir = tmpDir();
  const client = makeClient(dir);

  client.sendEvent({ type: 'before', timestamp: 1000 });
  client.flush();
  client.destroy();

  client.sendEvent({ type: 'after', timestamp: 2000 });
  client.flush();

  const files = listFiles(dir);
  const lines = readLines(path.join(dir, files[0]));
  const events = lines.filter((l) => l.event);
  t.equal(events.length, 1, 'only pre-destroy event written');
  t.equal(events[0].event.type, 'before');

  t.end();
});
