import { serveStatic } from '@hono/node-server/serve-static'
import type { Context, Hono } from 'hono'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { getServerFacts, withServerFacts, withServerFactsRevision } from '@shared/lib/facts/server-facts'

// Cache policy for the static web build. Vite emits content-hashed JS/CSS into
// `/assets/*`, so the filename itself changes whenever the bytes change — those
// can be cached permanently and a new deploy is picked up automatically (new
// URLs, nothing to invalidate). `index.html` is the un-hashed entry that points
// at the hashed bundles, so it must always be revalidated or clients pin to a
// stale build. Stable-named `public/` assets (icons, manifest) have no hash to
// bust them, so they revalidate too rather than caching forever.
function staticCacheControl(filePath: string): string {
  const p = filePath.replace(/\\/g, '/')
  if (p.includes('/assets/')) return 'public, max-age=31536000, immutable'
  if (p.endsWith('index.html')) return 'no-cache'
  return 'public, max-age=3600, must-revalidate'
}

/** Headers for the MCP consent page's document: never framed. */
export const CONSENT_PAGE_HEADERS = {
  'Content-Security-Policy': "frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
} as const

/** The consent page's paths, as the renderer's case-insensitive router matches them. */
export function isConsentPagePath(path: string): boolean {
  return /^\/oauth(?:\/|$)/i.test(path)
}

/** Serve the built renderer in `root`: its files, and its HTML entry for every other route. */
export function mountWebBuild(app: Hono, root: string): void {
  // The HTML entry carries this server's facts, so a page knows them before its
  // first render without another request. Built once: they can't change while
  // the process runs. Never cached, so a reload always discovers the latest
  // hashed bundles.
  const facts = getServerFacts()
  const indexHtml = withServerFacts(readFileSync(join(root, 'index.html'), 'utf-8'), facts)
  const serveIndex = (c: Context) => {
    c.header('Cache-Control', 'no-cache')
    return c.html(indexHtml)
  }
  // Ahead of the static middleware, which would serve the file as built. The
  // service worker precaches `/index.html`, so that path needs the facts too.
  app.get('/', serveIndex)
  app.get('/index.html', serveIndex)
  // The worker serves that precached copy to every navigation, so its revision
  // of it carries the facts too: a deploy that changes them changes the worker.
  const swPath = join(root, 'sw.js')
  if (existsSync(swPath)) {
    const serviceWorker = withServerFactsRevision(readFileSync(swPath, 'utf-8'), facts)
    app.get('/sw.js', (c) => {
      // The worker is the update trigger for the whole precached set. Browsers
      // revalidate it on their own schedule, but an explicit no-cache removes
      // any intermediary-cache delay on picking up a deploy.
      c.header('Cache-Control', 'no-cache')
      c.header('Content-Type', 'text/javascript; charset=utf-8')
      return c.body(serviceWorker)
    })
  }
  app.use(
    '/*',
    serveStatic({
      root,
      onFound: (filePath, c) => c.header('Cache-Control', staticCacheControl(filePath)),
    }),
  )
  // SPA fallback: any unmatched route serves the HTML entry. The MCP consent
  // page grants a client access to the person's account, so no other origin
  // may frame it (clickjacking): its document, in any letter case (the
  // renderer's router matches paths case-insensitively), carries
  // CONSENT_PAGE_HEADERS. Narrow on purpose: only that route; the PWA never
  // answers it from cache (vite.config.ts).
  app.get('*', (c) => {
    if (isConsentPagePath(c.req.path)) {
      for (const [name, value] of Object.entries(CONSENT_PAGE_HEADERS)) c.header(name, value)
    }
    return serveIndex(c)
  })
}
