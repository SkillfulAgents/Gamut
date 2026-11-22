import { describe, expect, it } from 'vitest'
import { claudeCodeSetup, codexSetup, cursorSetup, mcpClientSetups, shellQuote } from './client-setup'

const URL = 'http://localhost:47891/mcp'
const TOKEN = 'gamut_mcp_abc-DEF_123'

describe('client setup', () => {
  it('builds the Claude Code command in double quotes, which sh, PowerShell and cmd.exe all read', () => {
    expect(claudeCodeSetup(URL, TOKEN)).toBe(
      'claude mcp add --transport http gamut "http://localhost:47891/mcp" --header "Authorization: Bearer gamut_mcp_abc-DEF_123"',
    )
  })

  it('falls back to a POSIX single-quoted word for a value double quotes would change', () => {
    for (const unsafe of ['a"b', 'a$b', 'a`b', 'a\\b', 'a!b', 'a%b']) {
      expect(shellQuote(unsafe)).toBe(`'${unsafe}'`)
    }
    expect(shellQuote("it's $HOME")).toBe(`'it'\\''s $HOME'`)
    expect(shellQuote("it's")).toBe(`"it's"`)
    // A real token and endpoint never need the fallback.
    expect(shellQuote('https://gamut.example.com:8443/mcp')).toBe('"https://gamut.example.com:8443/mcp"')
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
