/*
 * Copyright Elasticsearch B.V. and other contributors where applicable.
 * Licensed under the BSD 2-Clause License; you may not use this file except in
 * compliance with the BSD 2-Clause License.
 */

'use strict';

const path = require('path');

const errorStackParser = require('error-stack-parser');
const semver = require('semver');


const CONTAINS_R_TRACELOG_START =
  /(-r\s+|--require\s*=?\s*).*tracelog\/start/;

/**
 * Determine the 'service.agent.activation_method' metadata value from an Error
 * stack collected at `Agent.start()` time. Spec:
 * https://github.com/elastic/apm/blob/main/specs/agents/metadata.md#activation-method
 *
 * @param {Error} startStack - An Error object with a captured stack trace.
 *    The `stackTraceLimit` for the stack should be at least 15 -- higher
 *    that the default of 10.
 * @returns {string} one of the following values:
 *    - "unknown"
 *    - "require":
 *         require('tracelog').start(...)
 *         require('tracelog/start')
 *    - "import":
 *         import 'tracelog/start.js'
 *         import apm from 'tracelog'; apm.start()
 *    - "aws-lambda-layer": `NODE_OPTIONS` using Agent installed at /opt/nodejs/node_modules/tracelog
 *    - "k8s-attach": `NODE_OPTIONS` using Agent, and `TRACELOG_ACTIVATION_METHOD=K8S_ATTACH` in env
 *    - "env-attach": Fallback for any other usage of NODE_OPTIONS='-r tracelog/start'
 *    - "preload": For usage of `node -r tracelog/start` without `NODE_OPTIONS`.
 */
function agentActivationMethodFromStartStack(startStack, log) {
  /* @param {require('stackframe').StackFrame[]} frames */
  let frames;
  try {
    frames = errorStackParser.parse(startStack);
  } catch (parseErr) {
    log.trace(
      parseErr,
      'could not determine metadata.service.agent.activation_method',
    );
    return 'unknown';
  }
  if (frames.length < 2) {
    return 'unknown';
  }

  // frames[0].fileName = "$topDir/lib/agent.js"
  //    at Agent.start (/Users/trentm/tmp/asdf/node_modules/tracelog/lib/agent.js:241:11)
  const topDir = path.dirname(path.dirname(frames[0].fileName));

  // If this was a preload (i.e. using `-r tracelog/start`), then
  // there will be a frame with `functionName` equal to:
  // - node >=12: 'loadPreloadModules'
  // - node <12: 'preloadModules'
  const functionName = semver.gte(process.version, '12.0.0', {
    includePrerelease: true,
  })
    ? 'loadPreloadModules'
    : 'preloadModules';
  let isPreload = false;
  for (let i = frames.length - 1; i >= 2; i--) {
    if (frames[i].functionName === functionName) {
      isPreload = true;
      break;
    }
  }
  if (isPreload) {
    return 'preload';
  }

  // To tell if tracelog was `import`d or `require`d we look for a
  // frame with `functionName` equal to 'ModuleJob.run'. This has consistently
  // been the name of this method back to at least Node v8.
  const esmImportFunctionName = 'ModuleJob.run';
  if (esmImportFunctionName) {
    for (let i = frames.length - 1; i >= 2; i--) {
      if (frames[i].functionName === esmImportFunctionName) {
        return 'import';
      }
    }
  }

  // Otherwise this was a manual `require(...)` of the agent in user code.
  return 'require';
}

module.exports = {
  agentActivationMethodFromStartStack,
};
