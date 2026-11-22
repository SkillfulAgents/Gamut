import { describe, expect, it } from 'vitest'
import { claudeCodeSetup, codexSetup, cursorSetup, mcpClientSetups } from './client-setup'

const URL = 'http://localhost:47891/mcp'
const TOKEN = 'gamut_mcp_abc-DEF_123'

describe('client setup', () => {
  it('builds the Claude Code command with the header quoted for a POSIX shell', () => {
    expect(claudeCodeSetup(URL, TOKEN)).toBe(
      `claude mcp add --transport http gamut 'http://localhost:47891/mcp' --header 'Authorization: Bearer gamut_mcp_abc-DEF_123'`,
    )
    expect(claudeCodeSetup("http://x/it's", TOKEN)).toContain(`'http://x/it'\\''s'`)
  })

  it('builds the Codex config.toml table', () => {
    expect(codexSetup(URL, TOKEN)).toBe([
      '[mcp_servers.gamut]',
      'url = "http://localhost:47891/mcp"',
      'http_headers = { "Authorization" = "Bearer gamut_mcp_abc-DEF_123" }',
    ].join('\n'))
  })

  it('builds the Cursor mcp.json', () => {
    expect(JSON.parse(cursorSetup(URL, TOKEN))).toEqual({
      mcpServers: { gamut: { url: URL, headers: { Authorization: `Bearer ${TOKEN}` } } },
    })
  })

  it('offers Claude Code, Codex and Cursor, each carrying the token', () => {
    const setups = mcpClientSetups(URL, TOKEN)
    expect(setups.map((setup) => setup.label)).toEqual(['Claude Code', 'Codex', 'Cursor'])
    for (const setup of setups) expect(setup.text).toContain(TOKEN)
  })
})
