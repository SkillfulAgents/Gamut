/**
 * Proxy rules on Cloudflare. A Worker cannot start the child processes the local runner uses
 * (sandbox.ts), so each rule runs as a Dynamic Worker: an isolate of its own with no network and
 * no bindings, under a CPU limit, that runs the same program as the local runner (rule-program.ts).
 * Whatever the rule's code does, only a string comes back.
 *
 * A rule's Worker is loaded by an id made from its code, so Cloudflare counts one Dynamic Worker
 * per rule per day, not one per evaluation, and may keep its isolate warm. Each evaluation defines
 * the rule again, so nothing the rule keeps in its closure survives; what it writes on a global may.
 */
import { RULE_HELPERS_SOURCE } from '@shared/lib/proxy/rules/helpers-source'
import { parseRunnerResult, RUN_RULE_SOURCE, type RuleOutcome } from '@shared/lib/proxy/rules/rule-program'
import type { RuleRunner } from '@shared/lib/proxy/rules/sandbox'

/** What of the Worker Loader binding this runner uses (developers.cloudflare.com/dynamic-workers/api-reference). */
export interface RuleWorkerLoader {
  get(id: string, code: () => Promise<RuleWorkerCode>): {
    getEntrypoint(name: null, options: { limits: { cpuMs: number; subRequests: number } }): { fetch(request: Request): Promise<Response> }
  }
}
export interface RuleWorkerCode {
  compatibilityDate: string
  mainModule: string
  modules: Record<string, string>
  globalOutbound: null
}

/** How long past the CPU limit a load and its call may take before the answer is "timeout". */
const LOAD_GRACE_MS = 5_000
/** A syntax check runs none of the rule's code: this covers starting its Worker. */
const SYNTAX_CHECK_CPU_MS = 50

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

/** The same id for the same Worker, and a new one when the rule or the program around it changes. */
async function workerId(code: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${MAIN_MODULE}\n${code}`))
  return `rule-${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))
const isSyntaxError = (error: unknown) => error instanceof Error && error.name === 'SyntaxError'

export function createCloudflareRuleRunner(loader: RuleWorkerLoader): RuleRunner {
  const call = async (code: string, cpuMs: number, request: Request) => loader.get(await workerId(code), async () => ({
    compatibilityDate: '2026-07-01',
    mainModule: 'main.js',
    modules: { 'main.js': MAIN_MODULE, 'rule.js': ruleModule(code) },
    globalOutbound: null,
  })).getEntrypoint(null, { limits: { cpuMs, subRequests: 0 } }).fetch(request)

  return {
    async checkSyntax(code) {
      try {
        await call(code, SYNTAX_CHECK_CPU_MS, new Request('http://rule/'))
        return null
      } catch (error) {
        // Any other failure says nothing about the code: the run answers for it.
        return isSyntaxError(error) ? messageOf(error) : null
      }
    },
    async run(code, inputJson, { timeoutMs }): Promise<RuleOutcome> {
      let overdue: ReturnType<typeof setTimeout> | undefined
      try {
        // The definition and the call each get the timeout, as in the local runner.
        const answer = call(code, 2 * timeoutMs, new Request('http://rule/', { method: 'POST', body: inputJson })).then(response => response.text())
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
