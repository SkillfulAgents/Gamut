import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCloudflareRuleRunner, type RuleWorkerCode, type RuleWorkerLoader } from './cloudflare-rule-runner'

/**
 * A loader that runs the Worker's two modules as one function, in this process: the rule module
 * in place of its import, and the handler returned in place of the default export, in strict mode
 * as a module is. As with the
 * real loader, code that does not compile fails the request, not the load.
 */
const loaded: RuleWorkerCode[] = []
const loader: RuleWorkerLoader = {
  load(code) {
    loaded.push(code)
    return {
      getEntrypoint: () => ({
        async fetch(request) {
          const rule = code.modules['rule.js'].replace('export function define', 'function define')
          const main = code.modules['main.js'].replace("import { define } from './rule.js'", rule).replace('export default', 'return')
          // eslint-disable-next-line no-new-func -- stands in for the loader compiling the Worker
          return (new Function(`"use strict"; ${main}`)() as { fetch(request: Request): Promise<Response> }).fetch(request)
        },
      }),
    }
  },
}
const failing = (error: Error): RuleWorkerLoader => ({ load: () => ({ getEntrypoint: () => ({ fetch: () => Promise.reject(error) }) }) })
const runner = createCloudflareRuleRunner(loader)
const run = (code: string, input: unknown = {}) => runner.run(code, JSON.stringify(input), { timeoutMs: 50, pool: 'evaluate' })

afterEach(() => {
  loaded.length = 0
  vi.useRealTimers()
})

describe('Cloudflare rule runner', () => {
  it('runs the same program as the local runner', async () => {
    expect(await run('() => true')).toEqual({ result: 'true' })
    expect(await run('(req) => req.amount === 5', { amount: 4 })).toEqual({ result: 'false' })
    expect(await run('(req, h) => h.toNumber("12.5") === 12.5')).toEqual({ result: 'true' })
    expect(await run('async () => true')).toEqual({ result: 'non_boolean', detail: 'promise' })
    expect(await run('() => { throw new Error("boom") }')).toEqual({ result: 'threw', detail: 'Error: boom' })
    expect(await run('42')).toEqual({ result: 'invalid_code', detail: 'rule is not a function' })
    expect(await run('(() => { throw new Error("at definition") })()')).toEqual({ result: 'invalid_code', detail: 'rule is not a function' })
    expect((await run('(req) => { req.path = "x"; return true }', { path: '/a' })).result).toBe('threw')
  })

  it('loads each rule with no network, no subrequests and a CPU limit of twice the timeout', async () => {
    await run('() => true')
    expect(loaded).toHaveLength(1)
    expect(loaded[0]).toMatchObject({ mainModule: 'main.js', globalOutbound: null, limits: { cpuMs: 100, subRequests: 0 } })
    expect(loaded[0].modules['rule.js']).toContain('() => true')
  })

  it('checks syntax by loading the rule, without running it', async () => {
    expect(await runner.checkSyntax('() => true')).toBeNull()
    expect(await runner.checkSyntax('(() => { throw new Error("ran") })()')).toBeNull()
    expect(await runner.checkSyntax('() => {')).toMatch(/./)
    expect((await run('() => {')).result).toBe('invalid_code')
  })

  it('reads a failed load as the code, the time or a crash', async () => {
    const cpu = createCloudflareRuleRunner(failing(new Error('Worker exceeded CPU time limit.')))
    expect(await cpu.run('() => true', '{}', { timeoutMs: 50, pool: 'evaluate' })).toEqual({ result: 'timeout' })
    const crash = createCloudflareRuleRunner(failing(new Error('Worker exceeded memory limit.')))
    expect(await crash.run('() => true', '{}', { timeoutMs: 50, pool: 'evaluate' })).toEqual({ result: 'threw', detail: 'the rule crashed or ran out of memory' })
    // A failure that is not the code's leaves the syntax unknown, and the run answers.
    expect(await crash.checkSyntax('() => true')).toBeNull()
  })

  it('answers timeout for a call that never returns', async () => {
    vi.useFakeTimers()
    const silent = createCloudflareRuleRunner({ load: () => ({ getEntrypoint: () => ({ fetch: () => new Promise<Response>(() => {}) }) }) })
    const outcome = silent.run('() => true', '{}', { timeoutMs: 50, pool: 'evaluate' })
    await vi.advanceTimersByTimeAsync(5_200)
    expect(await outcome).toEqual({ result: 'timeout' })
  })
})
