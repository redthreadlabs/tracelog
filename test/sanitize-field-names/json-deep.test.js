/*
 * Copyright Red Thread Labs LLC. All rights reserved.
 * Licensed under the BSD 2-Clause License; you may not use this file except in
 * compliance with the BSD 2-Clause License.
 */

'use strict';

// Unit tests for JSON-aware deep body redaction (1.8.0). These exercise the
// filter directly — no HTTP server or framework needed.

const test = require('tape');

const {
  redactKeysFromBody,
} = require('../../lib/filters/sanitize-field-names');

// Compiled the way config/normalizers does for sanitizeFieldNames patterns;
// literal enough for these tests.
const REGEXES = [/^password$/i, /token/i, /^code$/i, /auth/i];

const JSON_HEADERS = { 'content-type': 'application/json' };
const FORM_HEADERS = { 'content-type': 'application/x-www-form-urlencoded' };

test('redacts matching keys at every depth of an object body', (t) => {
  const body = {
    email: 'jane@example.com',
    password: 'hunter2',
    nested: {
      refresh_token: 'abc',
      deeper: [{ code: '123456', keep: 'me' }],
    },
  };
  const out = redactKeysFromBody(body, JSON_HEADERS, REGEXES);
  t.equal(out.email, 'jane@example.com');
  t.equal(out.password, '[REDACTED]');
  t.equal(out.nested.refresh_token, '[REDACTED]');
  t.equal(out.nested.deeper[0].code, '[REDACTED]');
  t.equal(out.nested.deeper[0].keep, 'me');
  // original untouched
  t.equal(body.password, 'hunter2');
  t.end();
});

test('parses and embeds a JSON string body as a redacted object (1.9.0)', (t) => {
  const body = JSON.stringify({ user: { authorization: 'Bearer x' }, ok: 1 });
  const out = redactKeysFromBody(body, JSON_HEADERS, REGEXES);
  t.equal(typeof out, 'object', 'embedded, not re-stringified');
  t.equal(out.user.authorization, '[REDACTED]');
  t.equal(out.ok, 1);
  t.end();
});

test('handles +json content types and charset suffixes', (t) => {
  const body = { password: 'x' };
  for (const ct of [
    'application/json; charset=utf-8',
    'application/vnd.api+json',
    'APPLICATION/JSON',
  ]) {
    const out = redactKeysFromBody(body, { 'content-type': ct }, REGEXES);
    t.equal(out.password, '[REDACTED]', ct);
  }
  t.end();
});

test('leaves a malformed JSON string untouched', (t) => {
  const body = '{not json';
  t.equal(redactKeysFromBody(body, JSON_HEADERS, REGEXES), body);
  t.end();
});

test('arrays at the top level are traversed', (t) => {
  const body = [{ token: 'a' }, { fine: true }];
  const out = redactKeysFromBody(body, JSON_HEADERS, REGEXES);
  t.equal(out[0].token, '[REDACTED]');
  t.equal(out[1].fine, true);
  t.end();
});

test('redacts instead of recursing past the depth guard', (t) => {
  let body = { v: 'leaf' };
  for (let i = 0; i < 40; i++) body = { nest: body };
  const out = redactKeysFromBody(body, JSON_HEADERS, REGEXES);
  let cursor = out;
  let sawRedacted = false;
  for (let i = 0; i < 40 && cursor; i++) {
    if (cursor === '[REDACTED]') {
      sawRedacted = true;
      break;
    }
    cursor = cursor.nest;
  }
  t.ok(sawRedacted, 'deep nesting bottomed out at [REDACTED]');
  t.end();
});

test('circular references redact rather than throw', (t) => {
  const body = { name: 'x' };
  body.self = body;
  const out = redactKeysFromBody(body, JSON_HEADERS, REGEXES);
  t.equal(out.self, '[REDACTED]');
  t.equal(out.name, 'x');
  t.end();
});

test('form-urlencoded bodies embed as redacted objects (1.9.0)', (t) => {
  const out = redactKeysFromBody('password=x&keep=y', FORM_HEADERS, REGEXES);
  t.deepEqual(out, { password: '[REDACTED]', keep: 'y' });
  t.end();
});

test('non-JSON, non-form content types pass through', (t) => {
  const body = 'password=plaintext';
  const out = redactKeysFromBody(body, { 'content-type': 'text/plain' }, REGEXES);
  t.equal(out, body);
  t.end();
});
