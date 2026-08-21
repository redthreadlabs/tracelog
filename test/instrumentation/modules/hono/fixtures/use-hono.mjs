/*
 * Copyright Red Thread Labs LLC. All rights reserved.
 * Licensed under the BSD 2-Clause License; you may not use this file except in
 * compliance with the BSD 2-Clause License.
 */

// An ESM Hono app, for hono-esm.test.js. Run as:
//
//   node --experimental-loader=<repo>/loader.mjs -r <repo>/start.js use-hono.mjs
//
// The imports below are static, so they are hoisted above every statement in
// this file and are resolved before any of it runs — which is the whole reason
// the loader (not just `-r start.js`) is needed to instrument them.

import { Hono } from 'hono';
import { serve } from '@hono/node-server';

import apm from '../../../../../index.js';

const objects = new Hono();
objects.get('/:id', (c) => c.text('one'));

const app = new Hono();
app.get('/users/:name', (c) => c.text('user'));
app.route('/objects', objects);

const server = serve({ fetch: app.fetch, port: 0 }, async (info) => {
  const base = `http://127.0.0.1:${info.port}`;
  for (const p of ['/users/jane', '/objects/abc', '/wp-login.php']) {
    const res = await fetch(base + p);
    await res.text(); // an unread body holds its socket open
  }
  server.close();
  // Land the buffered records on disk before the process exits.
  apm.flush(() => {
    apm.destroy();
    process.exit(0);
  });
});
