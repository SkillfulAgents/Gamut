import { describe, expect, it } from 'vitest'
import { ifNoneMatchMatches, ifRangeAllowsRange } from './http-conditional'

describe('ifNoneMatchMatches', () => {
  const ETAG = '"1000.5-42"'

  it('matches the tag it was given', () => {
    expect(ifNoneMatchMatches(ETAG, ETAG)).toBe(true)
  })

  it('matches the weak form a compressing layer hands the client', () => {
    expect(ifNoneMatchMatches(`W/${ETAG}`, ETAG)).toBe(true)
    expect(ifNoneMatchMatches(ETAG, `W/${ETAG}`)).toBe(true)
  })

  it('matches one tag in a list, and the wildcard', () => {
    expect(ifNoneMatchMatches(`"other", ${ETAG}`, ETAG)).toBe(true)
    expect(ifNoneMatchMatches('*', ETAG)).toBe(true)
  })

  it('does not match another tag, a prefix of the tag, an unquoted copy, or nothing', () => {
    expect(ifNoneMatchMatches('"2000-42"', ETAG)).toBe(false)
    expect(ifNoneMatchMatches('"1000.5-4"', ETAG)).toBe(false)
    expect(ifNoneMatchMatches('1000.5-42', ETAG)).toBe(false)
    expect(ifNoneMatchMatches('', ETAG)).toBe(false)
    expect(ifNoneMatchMatches(' , ', ETAG)).toBe(false)
    expect(ifNoneMatchMatches(undefined, ETAG)).toBe(false)
  })
})

describe('ifRangeAllowsRange', () => {
  const ETAG = '"1000.5-42"'

  it('leaves a range without If-Range as asked', () => {
    expect(ifRangeAllowsRange(undefined, ETAG)).toBe(true)
  })

  it('allows the range when the client holds this exact file', () => {
    expect(ifRangeAllowsRange(ETAG, ETAG)).toBe(true)
  })

  it('refuses it for another tag, a weak tag, a date, or an empty header', () => {
    expect(ifRangeAllowsRange('"2000-42"', ETAG)).toBe(false)
    expect(ifRangeAllowsRange(`W/${ETAG}`, ETAG)).toBe(false)
    expect(ifRangeAllowsRange(`W/${ETAG}`, `W/${ETAG}`)).toBe(false)
    expect(ifRangeAllowsRange('Wed, 21 Oct 2015 07:28:00 GMT', ETAG)).toBe(false)
    expect(ifRangeAllowsRange('', ETAG)).toBe(false)
  })
})
