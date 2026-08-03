import {expect, test} from '@playwright/test'

test.describe('checkout validation', () => {
  test('rejects submission with an incomplete delivery address and names the missing fields', async ({page}) => {
    await page.goto('/menu')
    await page.getByRole('link', {name: /Zaytun tovuq grili tanlash/}).click()
    await page.waitForURL('**/menu/chicken')
    await page.getByTestId('add-to-cart').click()
    await page.waitForURL('**/cart')
    await page.getByTestId('go-to-checkout').click()
    await page.waitForURL('**/checkout')

    await page.getByTestId('checkout-submit').click()
    await expect(page).toHaveURL(/\/checkout$/)
    await expect(page.locator('.error')).toHaveCount(8) // prior fields plus explicit pin confirmation
    await expect(page.getByLabel('Ism *').locator('..')).toContainText('Ismingizni kiriting')

    // coordinates are required for delivery even once every text field is filled in
    await page.getByLabel('Ism *').fill('Mijoz')
    await page.getByLabel('Telefon *').fill('+998901112233')
    await page.getByLabel('Mahalla yoki tuman *').fill('Karmana tumani')
    await page.getByLabel('Ko‘cha yoki joylashuv *').fill('Bunyodkor ko‘chasi')
    await page.getByLabel('Uy / bino *').fill('5A')
    await page.locator('label.field').filter({hasText: /^Mo‘ljal/}).locator('input').fill('Maktab yonida')
    await page.getByTestId('checkout-submit').click()
    await expect(page).toHaveURL(/\/checkout$/)
    await expect(page.locator('.error')).toHaveText([
      'Xaritadan joylashuvni belgilang',
      'Pin yetkazish nuqtasida ekanini tasdiqlang',
    ])

    // fixing the field clears its stale error immediately, without needing to resubmit
    await page.getByTestId('map-picker-set').click()
    await page.getByLabel('Pin to‘g‘ri joyda').check()
    await expect(page.locator('.error')).toHaveCount(0)
  })

  test('pickup orders are not blocked by delivery-address validation', async ({page}) => {
    await page.goto('/menu')
    await page.getByRole('link', {name: /Zaytun tovuq grili tanlash/}).click()
    await page.waitForURL('**/menu/chicken')
    await page.getByTestId('add-to-cart').click()
    await page.waitForURL('**/cart')
    await page.getByTestId('go-to-checkout').click()
    await page.waitForURL('**/checkout')

    await page.getByTestId('type-pickup').click()
    await expect(page.locator('.location-picker')).toHaveCount(0)
    await page.getByLabel('Ism *').fill('Mijoz')
    await page.getByLabel('Telefon *').fill('+998901112233')
    await page.getByTestId('checkout-submit').click()
    await expect(page).toHaveURL(/\/confirmation\//)
  })
})
