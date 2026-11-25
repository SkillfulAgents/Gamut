/**
 * What a rule runner executes, wherever it runs the rule's code (sandbox.ts): the function that
 * calls a rule on its input, and how its answer reads back.
 */

export type RuleOutcome =
  | { result: 'true' }
  | { result: 'false' }
  | { result: 'non_boolean'; detail: string }
  | { result: 'threw'; detail: string }
  | { result: 'timeout' }
  | { result: 'invalid_code'; detail: string }

/**
 * A function expression, compiled where the rule runs. Called with the rule's value, the input as
 * a JSON string and the helpers, it returns the outcome as a string for `parseRunnerResult`.
 */
export const RUN_RULE_SOURCE = `(function (rule, inputJson, helpers) {
  'use strict'
  function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      Object.freeze(value)
      for (var key of Object.keys(value)) deepFreeze(value[key])
    }
    return value
  }
  try {
    var input = deepFreeze(JSON.parse(inputJson))
    if (typeof rule !== 'function') return 'invalid_code:rule is not a function'
    var result = rule(input, helpers)
    if (result === true) return 'true'
    if (result === false) return 'false'
    var kind = result === null ? 'null' : typeof result
    if (kind === 'object' && typeof result.then === 'function') kind = 'promise'
    return 'non_boolean:' + kind
  } catch (error) {
    var message
    try {
      message = error && typeof error === 'object' && typeof error.message === 'string'
        ? String(error.name || 'Error') + ': ' + error.message
        : String(error)
    } catch (_) {
      message = 'unprintable error'
    }
    return 'threw:' + message.slice(0, 500)
  }
})`

export function parseRunnerResult(raw: string): RuleOutcome {
  if (raw === 'true') return { result: 'true' }
  if (raw === 'false') return { result: 'false' }
  if (raw === 'timeout') return { result: 'timeout' }
  const colon = raw.indexOf(':')
  const kind = colon === -1 ? raw : raw.slice(0, colon)
  const detail = colon === -1 ? '' : raw.slice(colon + 1)
  if (kind === 'non_boolean') return { result: 'non_boolean', detail }
  if (kind === 'invalid_code') return { result: 'invalid_code', detail }
  return { result: 'threw', detail }
}
