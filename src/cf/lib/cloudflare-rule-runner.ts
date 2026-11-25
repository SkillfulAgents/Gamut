/**
 * Proxy rules on Cloudflare. A Worker cannot start the child processes the local runner uses
 * (sandbox.ts), so each evaluation loads the rule as a Dynamic Worker: a new isolate with no
 * network and no bindings, under a CPU limit, that runs the same program as the local runner
 * (rule-program.ts). Nothing is kept between evaluations, and whatever the rule's code does, only
 * a string comes back.
 */
import { RULE_HELPERS_SOURCE } from '@shared/lib/proxy/rules/helpers-source'
import { parseRunnerResult, RUN_RULE_SOURCE, type RuleOutcome } from '@shared/lib/proxy/rules/rule-program'
import type { RuleRunner } from '@shared/lib/proxy/rules/sandbox'

/** What of the Worker Loader binding this runner uses (developers.cloudflare.com/dynamic-workers/api-reference). */
export interface RuleWorkerLoader {
  load(code: RuleWorkerCode): { getEntrypoint(): { fetch(request: Request): Promise<Response> } }
}
export interface RuleWorkerCode {
  compatibilityDate: string
  mainModule: string
  modules: Record<string, string>
  globalOutbound: null
  limits: { cpuMs: number; subRequests: number }
}

/** How long past the CPU limit a load and its call may take before the answer is "timeout". */
const LOAD_GRACE_MS = 5_000

// The rule's own source is a module by itself, so it can only define a value. Loading the Worker
// compiles it; only a POST calls `define`, so a syntax check (GET) runs none of the rule's code.
const ruleModule = (code: string) => `export function define() { return (\n${code}\n) }`
const MAIN_MODULE = `import { define } from './rule.js'
const helpers = ${RULE_HELPERS_SOURCE}
const run = ${RUN_RULE_SOURCE}
export default {
  async fetch(request) {
    if (request.method !== 'POST') return new Response('')
    let rule
    // A definition that throws leaves the rule undefined; the program reports it.
    try { rule = define() } catch (_) {}
    return new Response(run(rule, await request.text(), helpers))
  },
}`

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))
const isSyntaxError = (error: unknown) => error instanceof Error && error.name === 'SyntaxError'

export function createCloudflareRuleRunner(loader: RuleWorkerLoader): RuleRunner {
  // The definition and the call each get the timeout, as in the local runner.
  const call = (code: string, timeoutMs: number, request: Request) => loader.load({
    compatibilityDate: '2026-07-01',
    mainModule: 'main.js',
    modules: { 'main.js': MAIN_MODULE, 'rule.js': ruleModule(code) },
    globalOutbound: null,
    limits: { cpuMs: 2 * timeoutMs, subRequests: 0 },
  }).getEntrypoint().fetch(request)

  return {
    async checkSyntax(code) {
      try {
        await call(code, 1, new Request('http://rule/'))
        return null
      } catch (error) {
        // Any other failure says nothing about the code: the run answers for it.
        return isSyntaxError(error) ? messageOf(error) : null
      }
    },
    async run(code, inputJson, { timeoutMs }): Promise<RuleOutcome> {
      let overdue: ReturnType<typeof setTimeout> | undefined
      try {
        const answer = call(code, timeoutMs, new Request('http://rule/', { method: 'POST', body: inputJson })).then(response => response.text())
        // A rule that runs out of memory can leave its call unanswered.
        const late = new Promise<'timeout'>((resolve) => { overdue = setTimeout(() => resolve('timeout'), 2 * timeoutMs + LOAD_GRACE_MS) })
        return parseRunnerResult(await Promise.race([answer, late]))
      } catch (error) {
        if (isSyntaxError(error)) return { result: 'invalid_code', detail: messageOf(error) }
        if (/CPU time limit/i.test(messageOf(error))) return { result: 'timeout' }
        return { result: 'threw', detail: 'the rule crashed or ran out of memory' }
      } finally {
        clearTimeout(overdue)
      }
    },
  }
}
