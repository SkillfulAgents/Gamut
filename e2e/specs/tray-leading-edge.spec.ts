import { expect, test } from '@playwright/test'
import { PNG } from 'pngjs'
import { createAgent, createSession, gotoAgentSession, uniqueName } from '../helpers/agents'

test('the selected first tab and the panel share a continuous shadow', async ({ page, request }, testInfo) => {
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  const agent = await createAgent(request, uniqueName(testInfo, 'Tray edge'))
  const session = await createSession(request, agent, 'hello')
  await gotoAgentSession(page, agent, session)
  await page.getByTestId('tray-show').click()
  await page.getByTestId('tray-new-tab').click()
  const panel = page.getByTestId('tray-panel')
  await expect(panel).not.toHaveCSS('border-top-left-radius', '0px')
  await page.getByTestId('new-tab-select').first().click()
  await expect(panel).toHaveCSS('border-top-left-radius', '0px')
  await page.mouse.move(0, 0)

  // Sample the painted gutter as well as the border. Matching CSS border colors
  // alone misses the shadow being clipped by the tab scroller.
  await expect(async () => {
    const { x, y } = (await panel.boundingBox())!
    const clip = { x: Math.floor(x) - 8, y: Math.floor(y) - 12, width: 9, height: 25 }
    const { data, width, height } = PNG.sync.read(await page.screenshot({ clip, scale: 'css', animations: 'disabled' }))
    const stride = width * 4
    const body = data.subarray((height - 1) * stride)
    expect(body[0] - body[(width - 2) * 4]).toBeGreaterThan(2)
    const largestDifference = data.reduce((max, value, offset) => Math.max(max, Math.abs(value - body[offset % stride])), 0)
    expect(largestDifference).toBeLessThanOrEqual(2)
  }).toPass({ timeout: 5000 })
})
