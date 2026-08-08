import {expect, test} from '@playwright/test'

const routes = ['/', '/menu', '/menu/chicken', '/cart', '/checkout', '/track/ord-new', '/track/ord-clarify', '/driver']

test.describe('no horizontal overflow at required mobile viewports', () => {
  test.use({viewport: {width: 390, height: 844}})
  for (const route of routes) {
    test(`customer/driver mobile (390x844): ${route}`, async ({page}) => {
      await page.goto(route)
      const {scrollWidth, clientWidth} = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }))
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth)
    })
  }
})

test.describe('no horizontal overflow at the 320px narrow check', () => {
  test.use({viewport: {width: 320, height: 700}})
  for (const route of routes) {
    test(`narrow (320x700): ${route}`, async ({page}) => {
      await page.goto(route)
      const {scrollWidth, clientWidth} = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }))
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth)
    })
  }
})
