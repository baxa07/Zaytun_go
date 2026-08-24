import {expect, test} from '@playwright/test'

async function openCheckout(page: import('@playwright/test').Page) {
  await page.goto('/menu')
  await page.getByRole('link', {name: /Zaytun tovuq grili tanlash/}).click()
  await page.waitForURL('**/menu/chicken')
  await page.getByRole('button', {name: '+'}).click()
  await page.getByTestId('buy-now').click()
  await page.waitForURL('**/checkout')
}

test.describe('checkout validation (5-step wizard, per-step gating)', () => {
  test('Step 1 rejects an empty contact and names exactly the missing fields, without leaking later-step errors', async ({page}) => {
    await openCheckout(page)
    await expect(page.getByTestId('checkout-step-1')).toBeVisible()

    await page.getByTestId('checkout-continue').click()
    await expect(page).toHaveURL(/\/checkout$/)
    await expect(page.getByTestId('checkout-step-1')).toBeVisible()
    // Only Step 1's own fields (customerName, primaryPhone) -- Step
    // 2/3's coordinate/pin/district/street errors do not exist yet.
    await expect(page.locator('.error')).toHaveCount(2)
    await expect(page.getByLabel('Ism *').locator('..')).toContainText('Ismingizni kiriting')

    // fixing the field clears its stale error immediately, without needing to press Continue again
    await page.getByLabel('Ism *').fill('Mijoz')
    await expect(page.locator('.error')).toHaveCount(1)
  })

  test('Step 2 (map) rejects continuing without a confirmed pin; Step 3 (address) rejects continuing without district/street -- each step validates only its own fields', async ({page}) => {
    await openCheckout(page)
    await page.getByLabel('Ism *').fill('Mijoz')
    await page.getByLabel('Telefon *').fill('+998901112233')
    await page.getByTestId('checkout-continue').click()
    await expect(page.getByTestId('checkout-step-map')).toBeVisible()

    // No pin at all yet -- Continue ("Shu joyni tanlash") is blocked, and
    // both the missing-coordinate and missing-confirmation errors show
    // together (there is genuinely no pin to confirm).
    await page.getByTestId('checkout-continue').click()
    await expect(page.getByTestId('checkout-step-map')).toBeVisible()
    await expect(page.locator('.error')).toHaveText(['Xaritadan joylashuvni belgilang', 'Pin yetkazish nuqtasida ekanini tasdiqlang'])

    // Pin placed but not confirmed -- still blocked.
    await page.getByTestId('map-picker-set').click()
    await page.getByTestId('checkout-continue').click()
    await expect(page.getByTestId('checkout-step-map')).toBeVisible()
    await expect(page.locator('.error')).toHaveText(['Pin yetkazish nuqtasida ekanini tasdiqlang'])

    // Confirmed -- advances to Step 3, which has no coordinate errors of
    // its own (Step 2 already satisfied them), only district/street.
    await page.getByLabel('Kirish joyi xaritada to‘g‘ri belgilangan').check()
    await page.getByTestId('checkout-continue').click()
    await expect(page.getByTestId('checkout-step-address')).toBeVisible()
    await expect(page.locator('.error')).toHaveCount(0)

    // The pin placement above already reverse-geocoded and autofilled
    // district/street -- clear both (a material change, which also resets
    // the Step 2 confirmation) to genuinely isolate Step 3's own
    // district/street requirement, then reconfirm so only THAT is missing.
    await page.getByLabel('Mahalla yoki tuman *').fill('')
    await page.getByLabel('Ko‘cha yoki joylashuv *').fill('')
    await page.getByLabel('Kirish joyi xaritada to‘g‘ri belgilangan').check()
    await page.getByTestId('checkout-continue').click()
    await expect(page.getByTestId('checkout-step-address')).toBeVisible()
    await expect(page.locator('.error')).toHaveCount(2)

    await page.getByLabel('Mahalla yoki tuman *').fill('Karmana tumani')
    await page.getByLabel('Ko‘cha yoki joylashuv *').fill('Bunyodkor ko‘chasi')
    // Filling district/street again just invalidated the pin confirmation
    // once more (same material-change rule) -- reconfirm before Continue.
    await page.getByLabel('Kirish joyi xaritada to‘g‘ri belgilangan').check()
    await expect(page.locator('.error')).toHaveCount(0)
    await page.getByTestId('checkout-continue').click()
    await expect(page.getByTestId('checkout-step-4')).toBeVisible()
  })

  test('pickup orders skip the map/address steps entirely -- Step 1 goes straight to payment, and .location-picker never renders', async ({page}) => {
    await openCheckout(page)
    await page.getByTestId('type-pickup').click()
    await page.getByLabel('Ism *').fill('Mijoz')
    await page.getByLabel('Telefon *').fill('+998901112233')
    await page.getByTestId('checkout-continue').click()
    await expect(page.getByTestId('checkout-step-4')).toBeVisible()
    await expect(page.locator('.location-picker')).toHaveCount(0)

    await page.getByTestId('checkout-continue').click()
    await expect(page.getByTestId('checkout-step-5')).toBeVisible()
    await page.getByTestId('checkout-submit').click()
    await expect(page).toHaveURL(/\/confirmation\//)
  })
})

test.describe('Uzbekistan checkout phone field (fixed +998 prefix)', () => {
  async function openPickupCheckout(page: import('@playwright/test').Page) {
    await openCheckout(page)
    await page.getByTestId('type-pickup').click()
  }
  async function completePickupCheckout(page: import('@playwright/test').Page, name: string, nationalDigits: string) {
    await openPickupCheckout(page)
    await page.getByLabel('Ism *').fill(name)
    await page.getByLabel('Telefon *').fill(nationalDigits)
    await page.getByTestId('checkout-continue').click()
    await expect(page.getByTestId('checkout-step-4')).toBeVisible()
    await page.getByTestId('checkout-continue').click()
    await expect(page.getByTestId('checkout-step-5')).toBeVisible()
    await page.getByTestId('checkout-submit').click()
  }

  test('the +998 prefix is visible and fixed, and typing exactly 9 digits is accepted', async ({page}) => {
    await openPickupCheckout(page)
    await expect(page.locator('.phone-field-prefix')).toHaveText('+998')

    await page.getByLabel('Ism *').fill('Mijoz')
    await page.getByLabel('Telefon *').fill('901234567')
    // The box holds only the 9 national digits -- the fixed prefix is a
    // separate, non-editable element, never duplicated into the input.
    await expect(page.getByLabel('Telefon *')).toHaveValue('901234567')

    await page.getByTestId('checkout-continue').click()
    await expect(page.getByTestId('checkout-step-4')).toBeVisible()
    await page.getByTestId('checkout-continue').click()
    await page.getByTestId('checkout-submit').click()
    await expect(page).toHaveURL(/\/confirmation\//)
  })

  test('an incomplete national number is rejected with the Uzbek-specific message, not advanced past Step 1 -- contact is validated at Step 1 for every fulfillment type now, delivery or pickup', async ({page}) => {
    await openCheckout(page)
    await page.getByLabel('Ism *').fill('Mijoz')
    await page.getByLabel('Telefon *').fill('90123')
    await page.getByTestId('checkout-continue').click()
    await expect(page).toHaveURL(/\/checkout$/)
    await expect(page.getByTestId('checkout-step-1')).toBeVisible()
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
    await completePickupCheckout(page, 'Mijoz', '901234567')
    await page.waitForURL('**/confirmation/**')
    const orderId = page.url().split('/confirmation/')[1]

    await page.goto(`/restaurant/orders/${orderId}`)
    await expect(page.locator('a[href="tel:+998901234567"]')).toBeVisible()
  })
})
