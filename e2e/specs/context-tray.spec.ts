import { test, expect } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'
import { SessionPage } from '../pages/session.page'

test('context is counted only when opened and can be refreshed and inspected', async ({ page }, testInfo) => {
  const counts: string[] = []
  page.on('request', request => {
    if (request.method() === 'GET' && /\/sessions\/[^/]+\/context$/.test(request.url())) counts.push(request.url())
  })
  const app = new AppPage(page)
  await app.goto()
  await app.waitForAgentsLoaded()
  const agent = new AgentPage(page)
  await agent.createAgent(`Context inspector ${testInfo.workerIndex}-${Date.now()}`)
  const session = new SessionPage(page)
  await session.sendMessage('Summarize the workspace')
  await expect(session.getAssistantMessages().first()).toBeVisible()
  await expect(session.getStopButton()).not.toBeVisible()
  await page.getByTestId('tray-show').click()
  await expect(page.getByTestId('tray-empty-context')).toBeVisible()
  expect(counts).toEqual([])
  await page.getByTestId('tray-empty-context').click()
  await expect(page.getByTestId('context-percent')).toHaveText('56% used')
  expect(counts).toHaveLength(1)
  await page.getByRole('button', { name: /MCP tools/ }).click()
  await expect(page.getByText('mcp__browser__navigate', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect.poll(() => counts.length).toBe(2)
  await page.getByTestId('tray-hide').click()
  await session.sendMessage('Summarize the workspace again')
  await expect(session.getAssistantMessages()).toHaveCount(2)
  expect(counts).toHaveLength(2)
})
