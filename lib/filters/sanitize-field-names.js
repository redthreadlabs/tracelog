/*
 * Copyright Elasticsearch B.V. and other contributors where applicable.
 * Licensed under the BSD 2-Clause License; you may not use this file except in
 * compliance with the BSD 2-Clause License.
 */

'use strict';
const querystring = require('querystring');

const HEADER_FORM_URLENCODED = 'application/x-www-form-urlencoded';
const REDACTED = require('../constants').REDACTED;

// Depth guard for deep JSON redaction. Far deeper than any sane request
// body; protects against adversarial nesting.
const MAX_REDACT_DEPTH = 32;

/**
 * Handles req.body as object or string
 *
 * Express provides multiple body parser middlewares with x-www-form-urlencoded
 * handling.  See http://expressjs.com/en/resources/middleware/body-parser.html
 *
 * @param {Object | String} body
 * @param {Object} requestHeaders
 * @param {Array<RegExp>} regexes
 * @returns {Object | String} a copy of the body with the redacted fields
 */
function redactKeysFromPostedFormVariables(body, requestHeaders, regexes) {
  // only redact from application/x-www-form-urlencoded
  if (HEADER_FORM_URLENCODED !== requestHeaders['content-type']) {
    return body;
  }

  // if body is a plain object, use redactKeysFromObject
  if (body !== null && !Buffer.isBuffer(body) && typeof body === 'object') {
    return redactKeysFromObject(body, regexes);
  }

  // if body is a string, use querystring to create object,
  // pass to redactKeysFromObject, and reserialize as string
  if (typeof body === 'string') {
    const objBody = redactKeysFromObject(querystring.parse(body), regexes);
    return querystring.stringify(objBody);
  }

  return body;
}

/**
 * Redact sensitive fields from a captured request body, returning a
 * structured value wherever the body is structured (since 1.9.0):
 *
 * - JSON content types (`application/json`, `application/*+json`, with or
 *   without a charset suffix) — **deep** redaction: any key at any depth
 *   matching the sanitizeFieldNames patterns is replaced, recursing through
 *   nested objects and arrays. The result is an **embedded object/array**,
 *   whether the body arrived parsed or as a JSON string. Strings that fail
 *   to parse are returned untouched as strings.
 * - `application/x-www-form-urlencoded` — also returned as an embedded,
 *   deep-redacted object (extended parsers can nest); historically this
 *   re-serialized to a query string.
 * - anything else — returned as-is.
 *
 * @param {Object | String} body
 * @param {Object} requestHeaders
 * @param {Array<RegExp>} regexes
 * @returns {Object | Array | String} redacted body, structured when possible
 */
function redactKeysFromBody(body, requestHeaders, regexes) {
  // Operate even without patterns: redactDeep also normalizes circulars and
  // pathological nesting, which must never reach the serializer.
  const res = Array.isArray(regexes) ? regexes : [];
  const contentType = String(requestHeaders['content-type'] || '');
  const mime = contentType.split(';')[0].trim().toLowerCase();

  // A body some middleware already parsed is structured data no matter what
  // the content-type header claims — deep-redact and embed it.
  if (body !== null && !Buffer.isBuffer(body) && typeof body === 'object') {
    return redactDeep(body, res, 0, new WeakSet());
  }

  if (typeof body !== 'string') {
    return body;
  }

  if (mime === HEADER_FORM_URLENCODED) {
    // querystring.parse returns a null-prototype object; copy to a plain one
    return redactDeep({ ...querystring.parse(body) }, res, 0, new WeakSet());
  }

  if (isJsonContentType(contentType)) {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch (_err) {
      return body; // claimed JSON but isn't; leave it alone
    }
    return redactDeep(parsed, res, 0, new WeakSet());
  }

  return body;
}

function isJsonContentType(contentType) {
  // 'application/json', 'application/json; charset=utf-8',
  // 'application/vnd.api+json', …
  const mime = contentType.split(';')[0].trim().toLowerCase();
  return mime === 'application/json' || mime.endsWith('+json');
}

function redactDeep(value, regexes, depth, seen) {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (depth >= MAX_REDACT_DEPTH || seen.has(value)) {
    return REDACTED; // too deep / circular: redact rather than risk leaking
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactDeep(item, regexes, depth + 1, seen));
  }

  const result = {};
  for (const key of Object.keys(value)) {
    const shouldRedact = regexes.some((regex) => regex.test(key));
    result[key] = shouldRedact
      ? REDACTED
      : redactDeep(value[key], regexes, depth + 1, seen);
  }
  return result;
}

/**
 * Returns a copy of the provided object. Each entry of the copy will have
 * its value REDACTEd if the key matches any of the regexes
 *
 * @param {Object} obj The source object be copied with redacted fields
 * @param {Array<RegExp>} regexes RegExps to check if the entry value needd to be redacted
 * @param {String} redactedStr The string to use for redacted values. Defaults to '[REDACTED]'.
 * @returns {Object} Copy of the source object with REDACTED entries or the original if falsy or regexes is not an array
 */
function redactKeysFromObject(obj, regexes, redactedStr = REDACTED) {
  if (!obj || !Array.isArray(regexes)) {
    return obj;
  }
  const result = {};
  for (const key of Object.keys(obj)) {
    const shouldRedact = regexes.some((regex) => regex.test(key));
    result[key] = shouldRedact ? redactedStr : obj[key];
  }
  return result;
}

module.exports = {
  redactKeysFromObject,
  redactKeysFromPostedFormVariables,
  redactKeysFromBody,
};
