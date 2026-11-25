import { describe, expect, it } from 'vitest'
import { SETTINGS_PAGES, settingsPagesFor, type SettingsPageEntry } from '@renderer/components/settings/settings-catalog'
import { searchSettings, SETTINGS_RESULTS_LIMIT } from './settings-match'

const everyPage = settingsPagesFor({ isAuthMode: true, isAdmin: true, computerUse: true })

function ids(query: string, pages: readonly SettingsPageEntry[] = everyPage): string[] {
  return searchSettings(pages, query).map((result) => result.page.id)
}

function top(query: string) {
  return searchSettings(everyPage, query)[0]
}

describe('searchSettings', () => {
  it('lists nothing before a query, or for one letter', () => {
    expect(searchSettings(everyPage, '')).toEqual([])
    expect(searchSettings(everyPage, '   ')).toEqual([])
    expect(searchSettings(everyPage, 'm')).toEqual([])
  })

  it('finds a page as its name is typed, from the second letter', () => {
    for (const query of ['mo', 'mode', 'model', 'model prov', 'model providers', 'Model Providers']) {
      expect(ids(query)).toContain('llm')
    }
    for (const query of ['br', 'brow', 'browser', 'browser u', 'browser use']) {
      expect(top(query).page.id).toBe('browser')
    }
  })

  it('matches the start of each word, in any order', () => {
    expect(top('providers').page.id).toBe('llm')
    expect(top('use browser').page.id).toBe('browser')
    expect(top('prov mod').page.id).toBe('llm')
  })

  it('matches the name typed without its spaces', () => {
    expect(top('browseruse').page.id).toBe('browser')
    expect(top('modelproviders').page.id).toBe('llm')
  })

  it('ranks a page whose name matches above one listed for a keyword', () => {
    // Logins keeps the agent's "Browser vault"; Browser Use is the page named so.
    expect(ids('browser').slice(0, 2)).toEqual(['browser', 'logins'])
    expect(top('browser')).toEqual({ page: expect.objectContaining({ id: 'browser' }) })
  })

  it('finds a page by what is on it and says which keyword matched', () => {
    expect(top('anthropic')).toMatchObject({ page: { id: 'llm' }, matched: 'Anthropic' })
    expect(top('dark mode')).toMatchObject({ page: { id: 'general' }, matched: 'Dark mode' })
    expect(top('captcha')).toMatchObject({ page: { id: 'browser' }, matched: 'CAPTCHA solving' })
    expect(top('docker')).toMatchObject({ page: { id: 'runtime' }, matched: 'Docker' })
    expect(top('passkeys')).toMatchObject({ page: { id: 'logins' }, matched: 'Passkeys' })
  })

  it('takes words from the name and a keyword together', () => {
    expect(top('browser captcha')).toMatchObject({ page: { id: 'browser' }, matched: 'CAPTCHA solving' })
  })

  it('needs three letters before it looks at keywords', () => {
    expect(ids('aw')).not.toContain('llm')
    expect(ids('aws')).toContain('llm')
  })

  it('matches inside a word once three letters are typed', () => {
    expect(ids('rowser')).toContain('browser')
    expect(ids('ro')).not.toContain('browser')
  })

  it('forgives a typo in a longer word', () => {
    expect(top('browsr').page.id).toBe('browser')
    expect(top('modle providers').page.id).toBe('llm')
    expect(top('notifcations').page.id).toBe('notifications')
    // Not in a short one: "mob" is Mobile, never Model Providers or anything else.
    expect(ids('mob')).toEqual(['mobile'])
  })

  it('needs every word to match', () => {
    expect(ids('browser zebra')).toEqual([])
    // The palette's own unmatched-query e2e searches for this kind of string.
    expect(ids('no-search-results-0-0-0-1732400000000-x1y2z3')).toEqual([])
  })

  it('reads "settings" beside other words as where to look', () => {
    expect(top('settings browser').page.id).toBe('browser')
    expect(top('model providers settings').page.id).toBe('llm')
    expect(top('preferences theme')).toMatchObject({ page: { id: 'general' }, matched: 'Theme' })
  })

  it('offers the page settings open on for "settings" alone', () => {
    expect(searchSettings(everyPage, 'settings')).toEqual([{ page: everyPage[0] }])
    expect(searchSettings(everyPage, 'sett')).toEqual([{ page: everyPage[0] }])
    expect(everyPage[0].id).toBe('general')
  })

  it('ignores case, accents and punctuation', () => {
    expect(top('BROWSER-USE').page.id).toBe('browser')
    expect(top('you com')).toMatchObject({ page: { id: 'web' }, matched: 'You.com' })
    expect(top('modèl').page.id).toBe('llm')
  })

  it('keeps nav order among pages that match equally', () => {
    expect(ids('api keys')).toEqual(['web', 'browser', 'llm', 'voice'])
  })

  it(`lists at most ${SETTINGS_RESULTS_LIMIT} pages, the best ones`, () => {
    const pages = Array.from({ length: 8 }, (_, i): SettingsPageEntry => ({
      id: 'general', label: `Alpha ${i}`, icon: 'general', group: 'App Settings', keywords: [],
    }))
    pages.push({ id: 'voice', label: 'Alphabet', icon: 'mic', group: 'App Settings', keywords: [] })
    const found = searchSettings(pages, 'alphabet').map((result) => result.page.label)
    expect(found).toEqual(['Alphabet'])
    const many = searchSettings(pages, 'alpha').map((result) => result.page.label)
    expect(many).toEqual(['Alpha 0', 'Alpha 1', 'Alpha 2', 'Alpha 3', 'Alpha 4'])
  })

  it('lists a page once, however many of its keywords match', () => {
    const found = ids('max')
    expect(new Set(found).size).toBe(found.length)
  })

  it('only lists the pages it is given', () => {
    const member = settingsPagesFor({ isAuthMode: true, isAdmin: false, computerUse: true })
    expect(ids('browser use', member)).toEqual([])
    expect(ids('model providers', member)).toEqual(['llm'])
  })
})

describe('the settings pages are worth searching', () => {
  it('every keyword reads as it should be shown and is on one page only once', () => {
    for (const page of SETTINGS_PAGES) {
      expect(new Set(page.keywords.map((k) => k.toLowerCase())).size, page.id).toBe(page.keywords.length)
      for (const keyword of page.keywords) {
        expect(keyword.trim(), `${page.id}: "${keyword}"`).toBe(keyword)
        expect(keyword.toLowerCase(), `${page.id}: "${keyword}" repeats the page name`).not.toBe(page.label.toLowerCase())
      }
    }
  })

  it('each page is found by its own name', () => {
    for (const page of everyPage) {
      expect(top(page.label).page.id, page.label).toBe(page.id)
    }
  })
})
