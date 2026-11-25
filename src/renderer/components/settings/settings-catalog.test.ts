import { describe, expect, it } from 'vitest'
import { SETTINGS_TABS } from '@renderer/router/search-schemas'
import { SETTINGS_PAGES, settingsGroupsFor, type SettingsAudience } from './settings-catalog'

function nav(audience: SettingsAudience): Record<string, string[]> {
  return Object.fromEntries(settingsGroupsFor(audience).map((g) => [g.label, g.pages.map((p) => p.id)]))
}

describe('settings catalog', () => {
  it('has every settings route tab, once', () => {
    const ids = SETTINGS_PAGES.map((page) => page.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect([...ids].sort()).toEqual([...SETTINGS_TABS].sort())
  })

  it('gives a local install every page but the auth-mode ones', () => {
    expect(nav({ isAuthMode: false, isAdmin: false, computerUse: true })).toEqual({
      'App Settings': ['general', 'notifications', 'platform', 'experiments', 'team-directory', 'admin'],
      'Agent Capabilities': [
        'connections', 'mcp-server', 'volumes', 'logins', 'skillsets', 'web', 'browser',
        'computer-use', 'capabilities', 'global-guidance', 'llm', 'voice',
      ],
      'Agent Infrastructure': ['account-provider', 'runtime'],
      'Agent Activity': ['usage', 'audit-log'],
    })
  })

  it('gives an auth-mode admin every page', () => {
    expect(nav({ isAuthMode: true, isAdmin: true, computerUse: true })).toEqual({
      'App Settings': [
        'general', 'notifications', 'platform', 'experiments', 'analytics', 'team-directory',
        'users', 'auth', 'admin',
      ],
      'Agent Capabilities': [
        'mobile', 'connections', 'mcp-server', 'volumes', 'logins', 'skillsets', 'web', 'browser',
        'computer-use', 'capabilities', 'global-guidance', 'llm', 'voice',
      ],
      'Agent Infrastructure': ['account-provider', 'runtime'],
      'Agent Activity': ['usage', 'audit-log'],
    })
  })

  it('gives an auth-mode member their own pages, and no empty group', () => {
    expect(nav({ isAuthMode: true, isAdmin: false, computerUse: true })).toEqual({
      'App Settings': ['general', 'notifications', 'platform', 'experiments'],
      'Agent Capabilities': [
        'mobile', 'connections', 'mcp-server', 'volumes', 'logins', 'global-guidance', 'llm', 'voice',
      ],
      'Agent Activity': ['usage'],
    })
  })

  it('leaves Computer Use out where this computer does not run it', () => {
    for (const isAuthMode of [false, true]) {
      const pages = nav({ isAuthMode, isAdmin: true, computerUse: false })['Agent Capabilities']
      expect(pages).not.toContain('computer-use')
    }
  })
})
