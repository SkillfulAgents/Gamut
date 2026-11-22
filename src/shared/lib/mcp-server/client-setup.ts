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

export type McpClientId = 'claude-code' | 'codex' | 'cursor'

export interface McpClientSetup {
  id: McpClientId
  label: string
  /** What to do with `text`. */
  hint: string
  /** `shell` (a command to run) or the file format to paste into. */
  language: 'shell' | 'toml' | 'json'
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
      hint: 'Add to ~/.codex/config.toml.',
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
