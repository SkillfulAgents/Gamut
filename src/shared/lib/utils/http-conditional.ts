/** An entity tag without its weakness prefix: `W/"a"` and `"a"` both give `"a"`. */
function opaqueTag(tag: string): string {
  const trimmed = tag.trim()
  return trimmed.startsWith('W/') ? trimmed.slice(2) : trimmed
}

/**
 * Whether an `If-None-Match` header names the representation `etag` labels, so
 * a GET or HEAD is answered 304 with no body. The comparison is weak, as the
 * header requires: a client may hold the tag in its `W/` form (a compressing
 * layer weakens the tag of a body it encodes) and still has the same bytes.
 * `*` matches any representation that exists.
 */
export function ifNoneMatchMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false
  const current = opaqueTag(etag)
  return header.split(',').some((candidate) => {
    const tag = candidate.trim()
    return tag === '*' || (tag !== '' && opaqueTag(tag) === current)
  })
}

/**
 * Whether a request's `Range` may be honoured given its `If-Range`: the client
 * holds part of a representation and wants the rest only if the file is still
 * that one. The comparison is strong: a weak tag on either side, a date (this
 * server sends no Last-Modified), or any other tag means "send the whole file".
 * No `If-Range` leaves the range as asked.
 */
export function ifRangeAllowsRange(header: string | undefined, etag: string): boolean {
  if (header === undefined) return true
  return !etag.startsWith('W/') && header.trim() === etag
}
