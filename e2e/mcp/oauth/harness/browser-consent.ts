/**
 * The person's half of an OAuth sign-in, in a real browser: open the
 * authorization URL a client produced, sign in on Gamut's own page when not
 * signed in, look at the consent screen, approve or deny. The redirect back
 * to the client is either captured (the SDK tests hand the code to the SDK
 * themselves) or followed (a CLI's loopback listener receives it).
 */
import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { baseUrl, PASSWORD, type Person } from './oauth-app'

export interface ConsentOptions {
  deny?: boolean
  /** Untick "Run agents" before approving. */
  readOnly?: boolean
  /** Let the browser load the callback (a CLI listens there) instead of capturing it. */
  follow?: boolean
  /** Called on the consent page before answering, to look at it. */
  inspect?: (page: Page) => Promise<void>
  /** Reuse a signed-in context (a second connection by the same person). */
  context?: BrowserContext
}

export interface ConsentResult {
  /** Where the browser was sent back to: the client's redirect URI with `code` or `error`. */
  callback: URL
  /** Whether the sign-in form was shown first. */
  signedIn: boolean
}

const LOOPBACK_CALLBACK = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+\/.*[?&](?:code|error)=/

export async function signInOnPage(page: Page, person: Person): Promise<void> {
  const tab = page.getByTestId('auth-tab-signin')
  if (await tab.isVisible().catch(() => false)) await tab.click()
  await page.locator('#signin-email').fill(person.email)
  await page.locator('#signin-password').fill(PASSWORD)
  await page.getByTestId('signin-submit').click()
}

/** Give a browser context the person's session (the cookie their API sign-in got). */
export async function useSession(context: BrowserContext, person: Person): Promise<void> {
  const url = baseUrl()
  await context.addCookies(person.cookie.split('; ').filter(Boolean).map((pair) => {
    const at = pair.indexOf('=')
    return { name: pair.slice(0, at), value: pair.slice(at + 1), url }
  }))
}

export async function consentInBrowser(browser: Browser, authorizeUrl: string, person: Person, options: ConsentOptions = {}): Promise<ConsentResult> {
  const context = options.context ?? await browser.newContext()
  const page = await context.newPage()
  let callback: URL | null = null
  if (!options.follow) {
    await page.route(LOOPBACK_CALLBACK, async (route) => {
      callback = new URL(route.request().url())
      await route.fulfill({ status: 200, contentType: 'text/plain', body: 'Callback captured by the test.' })
    })
  } else {
    page.on('request', (request) => {
      if (LOOPBACK_CALLBACK.test(request.url())) callback = new URL(request.url())
    })
  }
  try {
    await page.goto(authorizeUrl)
    const form = page.locator('#signin-email')
    const allow = page.getByTestId('mcp-consent-allow')
    await expect(form.or(allow).first()).toBeVisible({ timeout: 30_000 })
    const signedIn = await form.isVisible()
    if (signedIn) await signInOnPage(page, person)
    await expect(allow).toBeVisible({ timeout: 30_000 })
    await expect(page).toHaveURL(/\/oauth\/consent\?/)
    if (options.inspect) await options.inspect(page)
    if (options.readOnly) await page.getByTestId('mcp-consent-scope-run').click()
    await page.getByTestId(options.deny ? 'mcp-consent-deny' : 'mcp-consent-allow').click()
    await expect.poll(() => callback, { timeout: 30_000 }).not.toBeNull()
    if (options.follow) await page.waitForLoadState('load').catch(() => undefined)
    return { callback: callback!, signedIn }
  } finally {
    await page.close()
    if (!options.context) await context.close()
  }
}
