/**
 * Real Claude Code and Codex signing in to the auth-mode server with OAuth,
 * headlessly: the CLI runs on a pseudo-terminal in a throwaway home and
 * config dir, prints the authorization URL, the test opens it in Chromium,
 * signs in and approves, and the redirect reaches the CLI (its own loopback
 * listener, or pasted back on its terminal for Claude Code's `--no-browser`).
 *
 * Where each stores the tokens, so nothing reaches the machine's own setup:
 * - Codex: `mcp_oauth_credentials_store = "file"` in its config, so the tokens
 *   are `$CODEX_HOME/.credentials.json`, never the OS keyring.
 * - Claude Code: plaintext `$CLAUDE_CONFIG_DIR/.credentials.json` on Linux
 *   (CI). On macOS it writes the login keychain and has no file-only switch;
 *   with a throwaway HOME there is no keychain, so it cannot keep the client
 *   it registered and the sign-in fails. On macOS the spec therefore runs it
 *   in a Linux container when MCP_OAUTH_CLAUDE_DOCKER_IMAGE names an image
 *   with `claude` and `node` (the agent-container base image has both), and
 *   skips it otherwise. It never touches the real keychain.
 */
import { spawn, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Browser } from '@playwright/test'
import { consentInBrowser } from './browser-consent'
import type { Person } from './oauth-app'
import { claudeBin, codexBin, scratchHome } from '../../harness/agent-clis'

const PTY = path.join(__dirname, 'pty-run.py')
// eslint-disable-next-line no-control-regex -- the URL ends where a terminal escape starts
const AUTHORIZE_URL = /(http:\/\/localhost:\d+\/api\/auth\/oauth2\/authorize\?[^\s\u001b\u0007\]]+)/

export interface PtyRun {
  code: number | null
  output: string
  /** The authorization URL the CLI printed, when it printed one. */
  authorizeUrl: URL | null
  callback: URL | null
}

/** Strip terminal control sequences, so the output reads as text. */
export function plain(text: string): string {
  return text
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;?<>=]*[A-Za-z]/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b[78()][A-Z0-9]?/g, '')
    .replace(/[ \t]+/g, ' ')
}

export function redact(text: string): string {
  return text
    .replace(/code=[^&\s"]+/g, 'code=[redacted]')
    .replace(/(access_token|refresh_token|accessToken|refreshToken)("?\s*[:=]\s*"?)[^"\s,]+/g, '$1$2[redacted]')
}

/**
 * Run a CLI on a pty. When it prints a Gamut authorization URL, approve it in
 * the browser as `person`; `paste` sends the callback back on the terminal
 * (for `--no-browser`), otherwise the browser follows it to the CLI's listener.
 */
export function runSigningIn(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; browser: Browser; person: Person; paste: boolean; timeoutMs?: number; readOnly?: boolean },
): Promise<PtyRun> {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', ['-I', PTY, command, ...args], { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'] })
    let output = ''
    let authorizeUrl: URL | null = null
    let callback: URL | null = null
    let started = false
    const onData = (chunk: Buffer) => {
      output += chunk.toString('utf8')
      const match = AUTHORIZE_URL.exec(output)
      if (!match || started) return
      started = true
      authorizeUrl = new URL(match[1])
      consentInBrowser(options.browser, match[1], options.person, { follow: !options.paste, readOnly: options.readOnly }).then(({ callback: back }) => {
        callback = back
        if (options.paste) child.stdin.write(`${back.href}\r`)
      }, (error: unknown) => {
        output += `\n[test] consent failed: ${String(error)}\n`
        child.kill('SIGTERM')
      })
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 150_000)
    child.on('error', reject)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, output, authorizeUrl, callback })
    })
  })
}

export function runPlain(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', ['-I', PTY, command, ...args], { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { output += chunk })
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 180_000)
    child.on('error', reject)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, output })
    })
  })
}

// ── Codex ────────────────────────────────────────────────────────────────────

export function codexOAuthHome(label: string) {
  const dirs = scratchHome(label)
  // File store: the tokens stay in this throwaway CODEX_HOME.
  fs.writeFileSync(path.join(dirs.config, 'config.toml'), 'mcp_oauth_credentials_store = "file"\n')
  return dirs
}

export function codexOAuthEnv(dirs: ReturnType<typeof scratchHome>): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, HOME: dirs.home, CODEX_HOME: dirs.config, STUB_API_KEY: 'stub-key-not-a-secret', BROWSER: 'true' }
}

export function codexCredentials(dirs: ReturnType<typeof scratchHome>): Record<string, any> {
  return JSON.parse(fs.readFileSync(path.join(dirs.config, '.credentials.json'), 'utf8'))
}

/** Make the stored access token look expired, so the next connection refreshes it. */
export function expireCodexToken(dirs: ReturnType<typeof scratchHome>): void {
  const file = path.join(dirs.config, '.credentials.json')
  const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, Record<string, unknown>>
  for (const entry of Object.values(stored)) entry.expires_at = Date.now() - 60_000
  fs.writeFileSync(file, JSON.stringify(stored))
}

export { codexBin }

// ── Claude Code ──────────────────────────────────────────────────────────────

export interface ClaudeRunner {
  mode: 'native' | 'docker'
  dirs: ReturnType<typeof scratchHome>
  /** The command and arguments that run `claude <args>` with this runner's environment. */
  command(args: string[], extraEnv?: Record<string, string>): { command: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string }
  credentialsFile: string
  version(): string | null
}

/** How this machine can run Claude Code's OAuth flow, or why it cannot. */
export function claudeRunner(label: string, ports: { server: number; stub?: number }): ClaudeRunner | { skip: string } {
  const image = process.env.MCP_OAUTH_CLAUDE_DOCKER_IMAGE
  const dirs = scratchHome(label)
  const base = {
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
    ANTHROPIC_API_KEY: 'stub-key-not-a-secret',
  }
  if (process.platform !== 'darwin' && !image) {
    return {
      mode: 'native',
      dirs,
      credentialsFile: path.join(dirs.config, '.credentials.json'),
      command: (args, extraEnv = {}) => ({
        command: claudeBin(),
        args,
        cwd: dirs.project,
        env: { PATH: process.env.PATH, HOME: dirs.home, CLAUDE_CONFIG_DIR: dirs.config, ...base, ...extraEnv },
      }),
      version: () => {
        const result = spawnSync(claudeBin(), ['--version'], { encoding: 'utf8', timeout: 30_000 })
        return result.status === 0 ? result.stdout.trim() : null
      },
    }
  }
  if (!image) return { skip: 'Claude Code on macOS keeps MCP OAuth tokens only in the login keychain; set MCP_OAUTH_CLAUDE_DOCKER_IMAGE to run it in a Linux container instead' }
  const forwards = [`node /harness/forward.mjs ${ports.server} host.docker.internal ${ports.server} &`, ...(ports.stub ? [`node /harness/forward.mjs ${ports.stub} host.docker.internal ${ports.stub} &`] : [])].join(' ')
  return {
    mode: 'docker',
    dirs,
    credentialsFile: path.join(dirs.config, '.credentials.json'),
    command: (args, extraEnv = {}) => {
      const env = { HOME: '/work/home', CLAUDE_CONFIG_DIR: '/work/config', ...base, ...extraEnv }
      const quoted = args.map((arg) => `'${arg.replace(/'/g, `'\\''`)}'`).join(' ')
      return {
        command: 'docker',
        args: [
          'run', '--rm', '-i', '-t',
          '-v', `${dirs.root}:/work`,
          '-v', `${__dirname}:/harness:ro`,
          ...Object.entries(env).flatMap(([name, value]) => ['-e', `${name}=${value}`]),
          '--entrypoint', 'sh', image,
          '-c', `${forwards} sleep 1; mkdir -p /work/project; cd /work/project && claude ${quoted}`,
        ],
        cwd: dirs.project,
        env: { PATH: process.env.PATH, HOME: process.env.HOME },
      }
    },
    version: () => {
      const result = spawnSync('docker', ['run', '--rm', '--entrypoint', 'claude', image, '--version'], { encoding: 'utf8', timeout: 120_000 })
      return result.status === 0 ? result.stdout.trim() : null
    },
  }
}

export function claudeCredentials(runner: ClaudeRunner): Record<string, any> {
  return JSON.parse(fs.readFileSync(runner.credentialsFile, 'utf8'))
}

export function expireClaudeToken(runner: ClaudeRunner): void {
  const stored = claudeCredentials(runner)
  for (const entry of Object.values(stored.mcpOAuth as Record<string, Record<string, unknown>>)) entry.expiresAt = Date.now() - 60_000
  fs.writeFileSync(runner.credentialsFile, JSON.stringify(stored))
}

