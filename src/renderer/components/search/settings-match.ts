import type { SettingsPageEntry } from '@renderer/components/settings/settings-catalog'

/**
 * Which settings pages the Cmd-K palette offers for a query, best first.
 *
 * Settings are never listed before something is typed, and a page is listed
 * once however many of its words match. A query matches by the start of words
 * in any order ("prov", "use browser"), so it finds a page as its name is
 * typed; then by the settings and services on the page (its keywords: "dark
 * mode", "anthropic"); then inside a word ("rowser"); and last with a typo in
 * each longer word ("browsr", "modle"). Each kind ranks below the one before,
 * and a page's own name above its keywords. "settings" or "preferences" beside
 * other words only says where to look, and alone offers the page settings
 * open on.
 */

export interface SettingsResult {
  page: SettingsPageEntry
  /**
   * The keyword the page was listed for, when it was not its own name: the row
   * shows it, so it is clear why "Model Providers" answers "anthropic".
   */
  matched?: string
}

/** How many settings pages a query lists at most. */
export const SETTINGS_RESULTS_LIMIT = 5

/** A one-letter query starts a word in most page names, so it lists none. */
const MIN_QUERY_LENGTH = 2
/** Keywords, inner substrings and typos take at least this much query. */
const MIN_LOOSE_QUERY_LENGTH = 3
/** A word needs this many letters before a typo in it is forgiven. */
const MIN_TYPO_WORD_LENGTH = 4

// Words that only say where to look: "settings browser" means Browser Use.
const FILLER_WORDS = ['settings', 'setting', 'preferences', 'prefs']

/** How well a text matches; 0 is not at all. */
const SCORE = {
  exact: 100,
  prefix: 90,
  // The query with its spaces left out starts the text with its spaces left out: "browseruse".
  compactPrefix: 85,
  wordPrefixes: 70,
  substring: 50,
  typo: 30,
} as const
/** A keyword ranks this far below the page's own name. */
const KEYWORD_PENALTY = 20
/**
 * Every word starts a word somewhere on the page, but not all in its name or
 * in one keyword: "browser captcha". With no typos: across a page's many
 * words, one would let a stray query word in ("keys" for "Keyboard").
 */
const ACROSS_PAGE_SCORE = 35

interface Query {
  /** Lowercased, accents and punctuation as spaces, collapsed. */
  text: string
  words: string[]
  compact: string
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/** The query without its filler words; `'settings'` when it was nothing else. */
function parseQuery(raw: string): Query | 'settings' | null {
  const typed = normalize(raw).split(' ').filter(Boolean)
  const words = typed.filter((word) => !isFiller(word))
  if (typed.length > 0 && words.length === 0) return 'settings'
  const text = words.join(' ')
  if (text.length < MIN_QUERY_LENGTH) return null
  return { text, words, compact: words.join('') }
}

function isFiller(word: string): boolean {
  return word.length >= 4 && FILLER_WORDS.some((filler) => filler.startsWith(word))
}

/**
 * Optimal string alignment distance (Levenshtein plus adjacent transposition),
 * giving up once it is past `max`.
 */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1
  let prevPrev: number[] = []
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    let rowMin = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let value = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, prevPrev[j - 2] + 1)
      }
      row.push(value)
      rowMin = Math.min(rowMin, value)
    }
    if (rowMin > max) return max + 1
    prevPrev = prev
    prev = row
  }
  return prev[b.length]
}

/** Whether `queryWord`, with a typo, is the start of `word`. */
function startsWithTypo(word: string, queryWord: string): boolean {
  if (queryWord.length < MIN_TYPO_WORD_LENGTH) return false
  const allowed = queryWord.length >= 8 ? 2 : 1
  // The typed word may be a letter short or long of the start it means.
  for (let length = queryWord.length - allowed; length <= queryWord.length + allowed; length++) {
    if (length < MIN_TYPO_WORD_LENGTH - 1 || length > word.length) continue
    if (editDistance(queryWord, word.slice(0, length), allowed) <= allowed) return true
  }
  return false
}

function everyWordStartsOne(words: string[], query: Query, typos: boolean): boolean {
  return query.words.every((queryWord) =>
    words.some((word) => word.startsWith(queryWord) || (typos && startsWithTypo(word, queryWord))),
  )
}

/** How well one text (a page name or one keyword) matches the query. */
function scoreText(text: string, query: Query, loose: boolean): number {
  const normalized = normalize(text)
  if (!normalized) return 0
  if (normalized === query.text) return SCORE.exact
  if (normalized.startsWith(query.text)) return SCORE.prefix
  if (normalized.replace(/ /g, '').startsWith(query.compact)) return SCORE.compactPrefix
  const words = normalized.split(' ')
  if (everyWordStartsOne(words, query, false)) return SCORE.wordPrefixes
  if (!loose) return 0
  if (normalized.includes(query.text)) return SCORE.substring
  if (everyWordStartsOne(words, query, true)) return SCORE.typo
  return 0
}

function scorePage(page: SettingsPageEntry, query: Query): { score: number; matched?: string } {
  const loose = query.text.length >= MIN_LOOSE_QUERY_LENGTH
  let best: { score: number; matched?: string } = { score: scoreText(page.label, query, loose) }
  if (!loose) return best

  for (const keyword of page.keywords) {
    const score = scoreText(keyword, query, true)
    if (score > 0 && score - KEYWORD_PENALTY > best.score) {
      best = { score: score - KEYWORD_PENALTY, matched: keyword }
    }
  }
  if (query.words.length < 2 || best.score >= ACROSS_PAGE_SCORE) return best

  const pageWords = [page.label, ...page.keywords].flatMap((text) => normalize(text).split(' '))
  if (!everyWordStartsOne(pageWords, query, false)) return best
  // Name the keyword that brought in a word the page's name does not have.
  const labelWords = normalize(page.label).split(' ')
  const missing = query.words.filter((queryWord) => !labelWords.some((word) => word.startsWith(queryWord)))
  const matched = page.keywords.find((keyword) =>
    normalize(keyword).split(' ').some((word) => missing.some((queryWord) => word.startsWith(queryWord))),
  )
  return { score: ACROSS_PAGE_SCORE, matched }
}

/**
 * The settings pages that match a query, best first, at most
 * `SETTINGS_RESULTS_LIMIT`. Pages that match equally keep their nav order.
 * `pages` is only what this viewer has: see `settingsPagesFor`.
 */
export function searchSettings(pages: readonly SettingsPageEntry[], rawQuery: string): SettingsResult[] {
  const query = parseQuery(rawQuery)
  if (!query) return []
  // "settings" alone is a way to open them: offer the page they open on.
  if (query === 'settings') return pages.slice(0, 1).map((page) => ({ page }))
  return pages
    .map((page, order) => ({ page, order, ...scorePage(page, query) }))
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, SETTINGS_RESULTS_LIMIT)
    .map(({ page, matched }) => (matched ? { page, matched } : { page }))
}
