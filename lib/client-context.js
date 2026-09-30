/*
 * Copyright Red Thread Labs LLC. All rights reserved.
 * Licensed under the BSD 2-Clause License; you may not use this file except in
 * compliance with the BSD 2-Clause License.
 */

'use strict';

// The ingest filter for an untrusted client record context: a line-for-line
// twin of tracelog-schema 0.6.0's `sanitizeContext`, kept here until the
// agent's pin reaches ^0.6.0 and imports it from the schema instead.

const VISITOR_KINDS = ['human', 'agent', 'system'];
const VIAS = ['browser', 'fetch', 'cli', 'mcp', 'thread', 'edge', 'server'];
const CAMPAIGN_KEYS = ['source', 'medium', 'name', 'term', 'content'];
const GEO_KEYS = ['country', 'region', 'city'];

function isVisitorKind(value) {
  return typeof value === 'string' && VISITOR_KINDS.includes(value);
}

function isVia(value) {
  return typeof value === 'string' && VIAS.includes(value);
}

function isBag(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value) {
  return typeof value === 'string';
}

function nonEmpty(value) {
  return Object.keys(value).length > 0 ? value : undefined;
}

function pickStrings(input, keys) {
  const out = {};
  for (const k of keys) {
    if (isString(input[k])) out[k] = input[k];
  }
  return nonEmpty(out);
}

function sanitizeLabels(input) {
  if (!isBag(input)) return undefined;
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (isString(v) || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) {
      out[k] = v;
    }
  }
  return nonEmpty(out);
}

function sanitizeVisitor(input) {
  if (!isBag(input) || !isString(input.id) || !input.id || !isVisitorKind(input.kind)) return undefined;
  return { id: input.id, kind: input.kind };
}

function sanitizeVisit(input) {
  if (!isBag(input) || !isString(input.id) || !input.id) return undefined;
  const visit = { id: input.id };
  if (typeof input.n === 'number' && Number.isFinite(input.n)) visit.n = input.n;
  return visit;
}

function sanitizeActor(input) {
  if (!isBag(input) || !isVia(input.via)) return undefined;
  const actor = { via: input.via };
  if (isBag(input.agent) && isString(input.agent.name) && input.agent.name) {
    actor.agent = { name: input.agent.name };
    if (isString(input.agent.version)) actor.agent.version = input.agent.version;
  }
  return actor;
}

function sanitizePage(input) {
  if (!isBag(input) || !isString(input.url) || !isString(input.path)) return undefined;
  const page = { url: input.url, path: input.path };
  for (const k of ['title', 'referrer', 'release']) {
    if (isString(input[k])) page[k] = input[k];
  }
  return page;
}

function sanitizeEntity(input) {
  if (!isBag(input)) return undefined;
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (isString(v)) out[k] = v;
  }
  return nonEmpty(out);
}

// Keep the typed sub-objects with their typed fields, primitive values in
// `labels`, strings in `entity`, and `user.id`; drop everything else,
// including a sub-object missing a required field. Undefined when nothing
// survives. String lengths are bounded later by the writer's truncation.
function sanitizeContext(input) {
  if (!isBag(input)) return undefined;
  const ctx = {};

  const labels = sanitizeLabels(input.labels);
  if (labels) ctx.labels = labels;

  if (isBag(input.user) && isString(input.user.id)) ctx.user = { id: input.user.id };

  const visitor = sanitizeVisitor(input.visitor);
  if (visitor) ctx.visitor = visitor;

  const visit = sanitizeVisit(input.visit);
  if (visit) ctx.visit = visit;

  const actor = sanitizeActor(input.actor);
  if (actor) ctx.actor = actor;

  const page = sanitizePage(input.page);
  if (page) ctx.page = page;

  const campaign = isBag(input.campaign) ? pickStrings(input.campaign, CAMPAIGN_KEYS) : undefined;
  if (campaign) ctx.campaign = campaign;

  const geo = isBag(input.geo) ? pickStrings(input.geo, GEO_KEYS) : undefined;
  if (geo) ctx.geo = geo;

  const entity = sanitizeEntity(input.entity);
  if (entity) ctx.entity = entity;

  return nonEmpty(ctx);
}

module.exports = { sanitizeContext, isVisitorKind, isVia };
