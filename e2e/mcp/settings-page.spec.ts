/**
 * Settings → MCP Server in the browser: reached through the app's own
 * navigation and by URL, it shows the endpoint as this server is bound and the
 * setup text the CLIs run (client-setup.ts), with the current token; its
 * switch and Regenerate change what /mcp answers.
 */
import { expect, test } from '@playwright/test'
import { claudeCodeSetup, codexSetup } from '../../src/shared/lib/mcp-server/client-setup'
import { baseUrl, mcpStatus, setMcpEnabled } from './harness/app'

test.describe.configure({ mode: 'serial' })

test('the page is a settings section of its own: by URL and from the nav', async ({ page }) => {
  await page.goto('/settings/mcp-server')
  await expect(page.getByTestId('mcp-server-tab')).toBeVisible()
  await page.goto('/settings/general')
  await page.getByTestId('settings-nav-mcp-server').first().click()
  await expect(page.getByTestId('mcp-server-tab')).toBeVisible()
  await expect(page).toHaveURL(/\/settings\/mcp-server/)
})

test('shows the bound endpoint and the setup with the current token', async ({ page }) => {
  const status = await mcpStatus()
  expect(status.endpointUrl).toBe(`${baseUrl()}/mcp`)
  await page.goto('/settings/mcp-server')
  await expect(page.getByTestId('mcp-server-endpoint')).toHaveText(status.endpointUrl)
  await expect(page.getByTestId('mcp-setup-text-claude-code')).toHaveText(claudeCodeSetup(status.endpointUrl, status.token!))
  await expect(page.getByTestId('mcp-setup-text-codex')).toHaveText(codexSetup(status.endpointUrl, status.token!))
})

test('the switch turns /mcp off and on; Regenerate replaces the token shown', async ({ page }) => {
  const before = await mcpStatus()
  await page.goto('/settings/mcp-server')
  try {
    await page.getByTestId('mcp-server-enabled-switch').click()
    await expect(page.getByText('Off: the endpoint does not answer.')).toBeVisible()
    expect((await fetch(before.endpointUrl, { method: 'POST', headers: { Authorization: `Bearer ${before.token}` } })).status).toBe(404)
    await page.getByTestId('mcp-server-enabled-switch').click()
    await expect(page.getByText('On: clients with the token can connect.')).toBeVisible()
  } finally {
    await setMcpEnabled(true)
  }
  await page.getByTestId('mcp-server-regenerate').click()
  await page.getByTestId('mcp-server-regenerate-confirm').click()
  await expect(page.getByTestId('mcp-setup-text-claude-code')).not.toContainText(before.token!)
  const after = await mcpStatus()
  expect(after.token).not.toBe(before.token)
  await expect(page.getByTestId('mcp-setup-text-claude-code')).toContainText(after.token!)
})
