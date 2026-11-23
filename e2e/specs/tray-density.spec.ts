import { expect, test } from '@playwright/test'
import { AgentPage } from '../pages/agent.page'
import { AppPage } from '../pages/app.page'
import { SessionPage } from '../pages/session.page'

test('a narrow tray fits a second tab and a two-digit overflow control', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('tray_drawer_width', '320'))
  const app = new AppPage(page)
  await app.goto()
  await app.waitForAgentsLoaded()
  await new AgentPage(page).createAgent('Compact tray')
  const session = new SessionPage(page)
  await session.sendMessage('hello')
  await session.waitForResponse(15000)
  await page.getByTestId('tray-show').click()

  for (let i = 1; i < 12; i++) await page.getByTestId('tray-new-tab').click()
  const strip = page.getByTestId('tray-tab-group')
  const visible = strip.getByTestId('new-tab')
  await expect(visible).toHaveCount(2)
  const allTabs = strip.getByRole('button', { name: 'All tabs, 10 more' })
  const close = visible.last().getByRole('button', { name: 'Close New tab' })
  await expect(close).toBeVisible()
  const widths = await strip.evaluate(el => {
    const tabs = [...el.querySelectorAll('[data-tray-tab]')].map(tab => tab.getBoundingClientRect().width)
    const all = el.querySelector('[data-testid="tray-tab-all"]')!.getBoundingClientRect()
    return { tabs, group: el.clientWidth, scroll: el.scrollWidth, right: all.right - el.getBoundingClientRect().right }
  })
  expect(widths.tabs[0]).toBeGreaterThanOrEqual(84)
  expect(widths.tabs[1]).toBeGreaterThanOrEqual(120)
  expect(widths.right).toBeLessThanOrEqual(0.5)
  expect(widths.scroll).toBeLessThanOrEqual(widths.group + 1)
  await allTabs.click()
  await expect(page.getByTestId('tray-tab-all-item')).toHaveCount(12)
  await page.keyboard.press('Escape')
  await close.click()
  await expect(strip.getByRole('button', { name: 'All tabs, 9 more' })).toBeVisible()
})
