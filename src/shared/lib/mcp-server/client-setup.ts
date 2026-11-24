/**
 * The copy-ready setup the Settings page shows for each MCP client, built from
 * the endpoint URL and the installation token. Pure, so the page, its tests and
 * the live validation all use the same text.
 *
 * Claude Code and Codex: the syntax of the CLIs' own `--help` (Claude Code
 * 2.1.330, Codex 0.167.0), run against a live server. Cursor: its documented
 * `mcp.json` shape (not run: no Cursor binary in the validation environment).
 */

export const MCP_CLIENT_SERVER_NAME = 'gamut'

export type McpClientId = 'claude-code' | 'codex' | 'cursor' | 'claude-ai'

export interface McpClientSetup {
  id: McpClientId
  label: string
  /** What to do with `text`. */
  hint: string
  /** `shell` (a command to run), the file format to paste into, or `steps` (instructions). */
  language: 'shell' | 'toml' | 'json' | 'steps'
  text: string
}

/** Characters that something between sh, PowerShell and cmd.exe expands or escapes inside double quotes. */
const UNSAFE_IN_DOUBLE_QUOTES = /["$`\\!%]/

/**
 * One shell word for a command a person pastes. Double quotes when the value
 * holds nothing any of sh/bash/zsh, PowerShell and cmd.exe treats specially
 * inside them, since cmd.exe does not treat `'` as a quote (the desktop app
 * ships on Windows). Otherwise a POSIX single-quoted word, the only safe form
 * for such a value, which cmd.exe cannot take.
 */
export function shellQuote(value: string): string {
  if (!UNSAFE_IN_DOUBLE_QUOTES.test(value)) return `"${value}"`
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** A TOML basic string. */
function tomlString(value: string): string {
  return JSON.stringify(value)
}

export function claudeCodeSetup(endpointUrl: string, token: string): string {
  return `claude mcp add --transport http ${MCP_CLIENT_SERVER_NAME} ${shellQuote(endpointUrl)} --header ${shellQuote(`Authorization: Bearer ${token}`)}`
}

export function codexSetup(endpointUrl: string, token: string): string {
  return [
    `[mcp_servers.${MCP_CLIENT_SERVER_NAME}]`,
    `url = ${tomlString(endpointUrl)}`,
    `http_headers = { "Authorization" = ${tomlString(`Bearer ${token}`)} }`,
  ].join('\n')
}

export function cursorSetup(endpointUrl: string, token: string): string {
  return JSON.stringify({
    mcpServers: {
      [MCP_CLIENT_SERVER_NAME]: { url: endpointUrl, headers: { Authorization: `Bearer ${token}` } },
    },
  }, null, 2)
}

export function mcpClientSetups(endpointUrl: string, token: string): McpClientSetup[] {
  return [
    {
      id: 'claude-code',
      label: 'Claude Code',
      hint: 'Run in a terminal. Add -s user to make it available in every project.',
      language: 'shell',
      text: claudeCodeSetup(endpointUrl, token),
    },
    {
      id: 'codex',
      label: 'Codex',
      // An observation (Codex 0.167): exec runs without approvals, and Codex
      // asks approval for tools not marked read-only that reach the open world.
      hint: 'Add to ~/.codex/config.toml. Seen with Codex 0.167: codex exec refuses invoke_agent and ask_team_brain, which need approval, unless this server sets default_tools_approval_mode.',
      language: 'toml',
      text: codexSetup(endpointUrl, token),
    },
    {
      id: 'cursor',
      label: 'Cursor',
      hint: 'Add to ~/.cursor/mcp.json (or .cursor/mcp.json in a project).',
      language: 'json',
      text: cursorSetup(endpointUrl, token),
    },
  ]
}

/**
 * Auth mode: the same clients with no token in the setup. Each signs in
 * through the workspace's own OAuth server the first time it connects (the
 * browser opens on Gamut's consent screen), so the setup is the URL alone.
 * Claude Code and Codex: their own `--help` (2.1.330, 0.167.0), run against a
 * live server. Cursor and claude.ai: their documented setup (not run here).
 */
export function claudeCodeOAuthSetup(endpointUrl: string): string {
  return `claude mcp add --transport http ${MCP_CLIENT_SERVER_NAME} ${shellQuote(endpointUrl)}`
}

export function codexOAuthSetup(endpointUrl: string): string {
  return [
    `codex mcp add ${MCP_CLIENT_SERVER_NAME} --url ${shellQuote(endpointUrl)}`,
    `codex mcp login ${MCP_CLIENT_SERVER_NAME}`,
  ].join('\n')
}

export function cursorOAuthSetup(endpointUrl: string): string {
  return JSON.stringify({ mcpServers: { [MCP_CLIENT_SERVER_NAME]: { url: endpointUrl } } }, null, 2)
}

export function claudeAiSetup(endpointUrl: string): string {
  return [
    '1. In Claude, open Settings → Connectors and choose "Add custom connector".',
    '2. Name it Gamut and paste this URL:',
    `   ${endpointUrl}`,
    '3. Choose Connect, then approve Gamut\'s consent screen.',
  ].join('\n')
}

export function mcpOAuthClientSetups(endpointUrl: string): McpClientSetup[] {
  return [
    {
      id: 'claude-code',
      label: 'Claude Code',
      hint: 'Run in a terminal, then sign in with claude mcp login gamut (or /mcp inside Claude Code). Add -s user to make it available in every project.',
      language: 'shell',
      text: claudeCodeOAuthSetup(endpointUrl),
    },
    {
      id: 'codex',
      label: 'Codex',
      hint: 'Run in a terminal; the login opens the browser to sign in. Seen with Codex 0.167: codex exec refuses invoke_agent and ask_team_brain, which need approval, unless this server sets default_tools_approval_mode.',
      language: 'shell',
      text: codexOAuthSetup(endpointUrl),
    },
    {
      id: 'cursor',
      label: 'Cursor',
      hint: 'Add to ~/.cursor/mcp.json (or .cursor/mcp.json in a project). Cursor asks you to sign in the first time it connects.',
      language: 'json',
      text: cursorOAuthSetup(endpointUrl),
    },
    {
      id: 'claude-ai',
      label: 'Claude (claude.ai and the desktop app)',
      hint: 'Needs this workspace to be reachable from the internet over https.',
      language: 'steps',
      text: claudeAiSetup(endpointUrl),
    },
  ]
}
