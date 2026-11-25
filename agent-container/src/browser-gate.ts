/**
 * Who may use a session's tab at the moment, by session id. The session's
 * agent-browser commands run side by side; a saved-session operation for it
 * (browser-session.ts) runs alone: a restore reloads the session's tab, and a
 * command meanwhile would act on a page being replaced. Other sessions'
 * commands never wait for it: each one's instance is pinned to its own tab,
 * so neither the page a restore replaces nor the tab a capture opens of its
 * own is theirs. Operations run one at a time, whoever's: they read and
 * write site state the sessions share.
 *
 * An operation waits for its session's commands under way to finish; a
 * command of that session that starts after it asked waits for it. The live
 * view polls every few seconds, and an operation that waited for a quiet
 * moment might never get one.
 */

interface Gate {
  commands: number
  operation: Promise<void> | null
  idle: Array<() => void>
}

/** One per session that ever used the browser: a few small objects for a container's life. */
const gates = new Map<string, Gate>()

function gateOf(session: string): Gate {
  let gate = gates.get(session)
  if (!gate) {
    gate = { commands: 0, operation: null, idle: [] }
    gates.set(session, gate)
  }
  return gate
}

/** Run an agent-browser command (CLI or daemon socket) of a session's, once no operation of its is waiting or running. */
export async function browserCommand<T>(session: string, work: () => Promise<T>): Promise<T> {
  const gate = gateOf(session)
  while (gate.operation) await gate.operation
  gate.commands++
  try {
    return await work()
  } finally {
    gate.commands--
    if (gate.commands === 0) for (const wake of gate.idle.splice(0)) wake()
  }
}

/** The operations asked for, in turn. */
let operations: Promise<unknown> = Promise.resolve()

/** Run a saved-session operation alone: no command of its session and no other operation meanwhile. */
export async function browserAlone<T>(session: string, work: () => Promise<T>): Promise<T> {
  const gate = gateOf(session)
  while (gate.operation) await gate.operation
  let done = () => {}
  gate.operation = new Promise<void>((resolve) => { done = resolve })
  const turn = operations.then(async () => {
    while (gate.commands > 0) await new Promise<void>((resolve) => gate.idle.push(resolve))
    return work()
  })
  operations = turn.catch(() => {})
  try {
    return await turn
  } finally {
    gate.operation = null
    done()
  }
}
