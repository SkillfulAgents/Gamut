// Starts the auth suite's dev servers side by side and prints "auth e2e
// servers ready" once every one of them answers. playwright.auth.config.ts
// runs this as its one webServer: given one entry per server, Playwright starts
// them one after another and waits for each, which took ~72 s for eleven
// servers in CI.
//
// AUTH_E2E_SERVERS is a JSON array of { name, command, url }. A server counts
// as up when its url answers 200-403, Playwright's own rule. A url that already
// answers before anything starts is an error, as reuseExistingServer: false
// makes it for a webServer entry: the tests would hit a stale server.
//
// The servers stay in this process's group, which Playwright kills at the end
// of the run. If one exits, the whole group is killed, so a failed boot leaves
// no server behind.
import { spawn } from 'node:child_process'

const servers = JSON.parse(process.env.AUTH_E2E_SERVERS ?? '[]')
if (!Array.isArray(servers) || servers.length === 0) {
  console.error('[auth-servers] AUTH_E2E_SERVERS lists no servers')
  process.exit(1)
}

async function isUp(url) {
  try {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(2_000) })
    return response.status >= 200 && response.status < 404
  } catch {
    return false
  }
}

function prefixLines(name, write) {
  let pending = ''
  return (chunk) => {
    pending += chunk.toString()
    const lines = pending.split('\n')
    pending = lines.pop() ?? ''
    for (const line of lines) write(`[${name}] ${line}\n`)
  }
}

function killGroup() {
  // Signal 0's group is this process's own: the launcher and every server.
  process.kill(0, 'SIGKILL')
}

for (const server of servers) {
  if (await isUp(server.url)) {
    console.error(`[auth-servers] ${server.url} already answers: stop whatever is running on it first`)
    process.exit(1)
  }
}

for (const server of servers) {
  const child = spawn(server.command, { shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', prefixLines(server.name, (line) => process.stdout.write(line)))
  child.stderr.on('data', prefixLines(server.name, (line) => process.stderr.write(line)))
  child.on('exit', (code, signal) => {
    console.error(`[auth-servers] ${server.name} exited (${signal ?? `code ${code}`})`)
    killGroup()
  })
}

const startedAt = Date.now()
const waiting = new Set(servers)
while (waiting.size > 0) {
  await new Promise((resolve) => setTimeout(resolve, 250))
  const ready = await Promise.all([...waiting].map(async (server) => ((await isUp(server.url)) ? server : null)))
  for (const server of ready) if (server) waiting.delete(server)
}
console.log(`auth e2e servers ready: ${servers.length} in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`)
