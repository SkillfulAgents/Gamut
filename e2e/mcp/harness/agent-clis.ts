/**
 * Real agent CLIs (Claude Code, Codex) run against the server, each in a
 * throwaway home and config directory so nothing of the machine's own setup is
 * read or changed, and pointed at a stub model (stub-models.ts) so a turn needs
 * no account and makes no model call.
 *
 * The binaries come from CLAUDE_BIN / CODEX_BIN, else `claude` / `codex` on
 * PATH. CI installs pinned versions (see .github/workflows/test.yml).
 */
import { spawn, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

export interface RunResult {
  code: number | null
  stdout: string
  stderr: string
}

export function claudeBin(): string {
  return process.env.CLAUDE_BIN ?? 'claude'
}

export function codexBin(): string {
  return process.env.CODEX_BIN ?? 'codex'
}

/** The binary's `--version`, or null when it is not installed. */
export function versionOf(bin: string): string | null {
  const result = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 30_000 })
  return result.status === 0 ? result.stdout.trim() : null
}

/** Run a command with no stdin (both CLIs read stdin when it is open). */
export function run(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 120_000)
    child.on('error', reject)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

/** A fresh directory tree for one CLI run: a home, a config dir, a project. */
export function scratchHome(label: string): { root: string; home: string; config: string; project: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `gamut-mcp-${label}-`))
  const dirs = { root, home: path.join(root, 'home'), config: path.join(root, 'config'), project: path.join(root, 'project') }
  for (const dir of [dirs.home, dirs.config, dirs.project]) fs.mkdirSync(dir, { recursive: true })
  return dirs
}

/** The environment Claude Code runs in: its own home and config dir, the stub as its API. */
export function claudeEnv(dirs: ReturnType<typeof scratchHome>, stubOrigin: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: dirs.home,
    CLAUDE_CONFIG_DIR: dirs.config,
    ANTHROPIC_BASE_URL: stubOrigin,
    ANTHROPIC_API_KEY: 'stub-key-not-a-secret',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
  }
}

/** The environment Codex runs in: its own CODEX_HOME, whose config names the stub provider. */
export function codexEnv(dirs: ReturnType<typeof scratchHome>): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: dirs.home,
    CODEX_HOME: dirs.config,
    STUB_API_KEY: 'stub-key-not-a-secret',
  }
}

/** A Codex config.toml with the stub as the model provider; the MCP setup is appended to it. */
export function codexStubConfig(stubOrigin: string): string {
  return [
    'model = "stub-model"',
    'model_provider = "stub"',
    '',
    '[model_providers.stub]',
    'name = "stub"',
    `base_url = "${stubOrigin}/v1"`,
    'wire_api = "responses"',
    'env_key = "STUB_API_KEY"',
    '',
  ].join('\n')
}

/** The JSON lines of a CLI's stream output. */
export function jsonLines(stdout: string): any[] {
  return stdout.split('\n').map((line) => line.trim()).filter((line) => line.startsWith('{')).map((line) => JSON.parse(line))
}
