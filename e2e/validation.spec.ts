import {expect, test} from '@playwright/test'

test.describe('checkout validation', () => {
  test('rejects submission with an incomplete delivery address and names the missing fields', async ({page}) => {
    await page.goto('/menu')
    await page.getByRole('link', {name: /Zaytun tovuq grili tanlash/}).click()
    await page.waitForURL('**/menu/chicken')
    await page.getByRole('button', {name: '+'}).click()
    await page.getByTestId('buy-now').click()
    await page.waitForURL('**/checkout')

    await page.getByTestId('checkout-submit').click()
    await expect(page).toHaveURL(/\/checkout$/)
    // Minimum contract: customerName, primaryPhone, district, street,
    // coordinates, pinConfirmation. House/landmark/notes are optional and
    // never produce a "required" error.
    await expect(page.locator('.error')).toHaveCount(6)
    await expect(page.getByLabel('Ism *').locator('..')).toContainText('Ismingizni kiriting')

    // coordinates are required for delivery even once every required text
    // field is filled in -- house/landmark/notes are deliberately left
    // empty here to prove they are not required.
    await page.getByLabel('Ism *').fill('Mijoz')
    await page.getByLabel('Telefon *').fill('+998901112233')
    await page.getByLabel('Mahalla yoki tuman *').fill('Karmana tumani')
    await page.getByLabel('Ko‘cha yoki joylashuv *').fill('Bunyodkor ko‘chasi')
    await page.getByTestId('checkout-submit').click()
    await expect(page).toHaveURL(/\/checkout$/)
    await expect(page.locator('.error')).toHaveText([
      'Xaritadan joylashuvni belgilang',
      'Pin yetkazish nuqtasida ekanini tasdiqlang',
    ])

    // fixing the field clears its stale error immediately, without needing to resubmit
    await page.getByTestId('map-picker-set').click()
    await page.getByLabel('Kirish joyi xaritada to‘g‘ri belgilangan').check()
    await expect(page.locator('.error')).toHaveCount(0)
  })

  test('pickup orders are not blocked by delivery-address validation', async ({page}) => {
    await page.goto('/menu')
    await page.getByRole('link', {name: /Zaytun tovuq grili tanlash/}).click()
    await page.waitForURL('**/menu/chicken')
    await page.getByRole('button', {name: '+'}).click()
    await page.getByTestId('buy-now').click()
    await page.waitForURL('**/checkout')

    await page.getByTestId('type-pickup').click()
    await expect(page.locator('.location-picker')).toHaveCount(0)
    await page.getByLabel('Ism *').fill('Mijoz')
    await page.getByLabel('Telefon *').fill('+998901112233')
    await page.getByTestId('checkout-submit').click()
    await expect(page).toHaveURL(/\/confirmation\//)
  })
})

test.describe('Uzbekistan checkout phone field (fixed +998 prefix)', () => {
  async function openPickupCheckout(page: import('@playwright/test').Page) {
    await page.goto('/menu')
    await page.getByRole('link', {name: /Zaytun tovuq grili tanlash/}).click()
    await page.waitForURL('**/menu/chicken')
    await page.getByRole('button', {name: '+'}).click()
    await page.getByTestId('buy-now').click()
    await page.waitForURL('**/checkout')
    await page.getByTestId('type-pickup').click()
  }

  test('the +998 prefix is visible and fixed, and typing exactly 9 digits is accepted', async ({page}) => {
    await openPickupCheckout(page)
    await expect(page.locator('.phone-field-prefix')).toHaveText('+998')

    await page.getByLabel('Ism *').fill('Mijoz')
    await page.getByLabel('Telefon *').fill('901234567')
    // The box holds only the 9 national digits -- the fixed prefix is a
    // separate, non-editable element, never duplicated into the input.
    await expect(page.getByLabel('Telefon *')).toHaveValue('901234567')

    await page.getByTestId('checkout-submit').click()
    await expect(page).toHaveURL(/\/confirmation\//)
  })

  test('an incomplete national number is rejected with the Uzbek-specific message, not submitted', async ({page}) => {
    // Phone is only validated on the DELIVERY path (validateOrderInput
    // only calls validateAddress -- which checks primaryPhone -- for
    // type==='DELIVERY') -- pickup has no address/contact validation at
    // all, so this needs a full, otherwise-valid delivery checkout to
    // isolate the phone error specifically.
    await page.goto('/menu')
    await page.getByRole('link', {name: /Zaytun tovuq grili tanlash/}).click()
    await page.waitForURL('**/menu/chicken')
    await page.getByRole('button', {name: '+'}).click()
    await page.getByTestId('buy-now').click()
    await page.waitForURL('**/checkout')

    await page.getByLabel('Ism *').fill('Mijoz')
    await page.getByLabel('Telefon *').fill('90123')
    await page.getByLabel('Mahalla yoki tuman *').fill('Karmana tumani')
    await page.getByLabel('Ko‘cha yoki joylashuv *').fill('Bunyodkor ko‘chasi')
    await page.getByTestId('map-picker-set').click()
    await page.getByLabel('Kirish joyi xaritada to‘g‘ri belgilangan').check()

    await page.getByTestId('checkout-submit').click()
    await expect(page).toHaveURL(/\/checkout$/)
    await expect(page.locator('.error')).toHaveText(['Telefon raqamini to‘liq kiriting'])
  })

  test('pasting a full +998-prefixed number, a bare 998-prefixed number, or a formatted number all normalize to the same 9-digit box with no duplicated prefix', async ({page}) => {
    await openPickupCheckout(page)
    const phone = page.getByLabel('Telefon *')

    await phone.fill('+998901234567')
    await expect(phone).toHaveValue('901234567')

    await phone.fill('998901234567')
    await expect(phone).toHaveValue('901234567')

    await phone.fill('+998 90 123 45 67')
    await expect(phone).toHaveValue('901234567')

    // Never a duplicated country code however it got there.
    await expect(phone).not.toHaveValue(/998.*998/)
  })

  test('the canonical +998XXXXXXXXX value -- not the raw typed digits -- is exactly what is stored and shown downstream (restaurant order detail)', async ({page}) => {
    await openPickupCheckout(page)
    await page.getByLabel('Ism *').fill('Mijoz')
    await page.getByLabel('Telefon *').fill('901234567')
    await page.getByTestId('checkout-submit').click()
    await page.waitForURL('**/confirmation/**')
    const orderId = page.url().split('/confirmation/')[1]

    await page.goto(`/restaurant/orders/${orderId}`)
    await expect(page.locator('a[href="tel:+998901234567"]')).toBeVisible()
  })
})
