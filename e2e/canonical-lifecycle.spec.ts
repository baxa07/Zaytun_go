import {expect, test} from '@playwright/test'

// The app has no backend: `orders`/`drivers` live in localStorage, shared per browser
// context. Every page opened from the same `context` therefore sees the same state,
// which is how this single continuous test simulates customer + restaurant + driver
// acting on one shared order lifecycle.
test.describe('canonical order lifecycle', () => {
  test('delivery order flows from menu to delivered across customer, restaurant and driver', async ({context}) => {
    const customer = await context.newPage()
    const staff = await context.newPage()
    const driver = await context.newPage()
    await customer.setViewportSize({width: 390, height: 844})
    await staff.setViewportSize({width: 1440, height: 900})
    await driver.setViewportSize({width: 390, height: 844})

    // driver-1 starts BUSY on the seeded ord-active delivery. Complete it first so an
    // available driver exists for the new order created below.
    await test.step('free up driver-1 by completing the seeded active delivery', async () => {
      await driver.goto('/driver')
      await expect(driver.locator('.delivery-card')).toBeVisible()
      await driver.getByTestId('driver-primary-action').click() // ON_THE_WAY -> ARRIVED
      await driver.getByTestId('driver-primary-action').click() // ARRIVED -> DELIVERED
      await expect(driver.getByTestId('driver-no-active')).toBeVisible()
    })

    await test.step('customer adds two items with a modifier, quantity change and instructions', async () => {
      await customer.goto('/menu')
      await customer.getByRole('link', {name: /Zaytun tovuq grili tanlash/}).click()
      await customer.waitForURL('**/menu/chicken')
      await customer.getByLabel('Achchiq').check()
      await customer.getByRole('textbox').fill('Sousni alohida soling')
      await customer.getByRole('button', {name: '+'}).click() // quantity -> 2
      await customer.getByTestId('add-to-cart').click()
      await customer.waitForURL('**/menu')
      await customer.getByRole('link', {name: /Mol go‘shtli kabob tanlash/}).click()
      await customer.waitForURL('**/menu/kebab')
      await customer.getByTestId('add-to-cart').click()
      await customer.waitForURL('**/menu')
      await customer.getByTestId('cart-pill').click()

      await expect(customer.locator('.line-item')).toHaveCount(2)
      await customer.locator('.line-item').nth(1).locator('.stepper button').last().click()
      await customer.getByTestId('go-to-checkout').click()
      await customer.waitForURL('**/checkout')
    })

    let orderId = ''
    await test.step('customer completes the delivery address, coordinates and payment, then submits', async () => {
      await customer.getByLabel('Ism *').fill('Test Mijoz')
      await customer.getByLabel('Telefon *').fill('+998901112233')
      await customer.getByLabel('Mahalla yoki tuman *').fill('Karmana tumani')
      await customer.getByLabel('Ko‘cha yoki joylashuv *').fill('Bunyodkor ko‘chasi')
      await customer.getByLabel('Uy / bino *').fill('5A')
      await customer.getByLabel('Mo‘ljal', {exact: true}).fill('Maktab yonida')
      await customer.getByTestId('map-picker-set').click()
      await customer.getByLabel('Kirish joyi xaritada to‘g‘ri belgilangan').check()
      await customer.getByTestId('checkout-submit').click()
      await customer.waitForURL('**/confirmation/**')
      orderId = customer.url().split('/confirmation/')[1]
      expect(orderId).toBeTruthy()

      await customer.getByTestId('track-link').click()
      await customer.waitForURL(`**/track/${orderId}`)
      await expect(customer.getByTestId('order-status')).toHaveText('Manzil tasdiqlanmoqda')
    })

    await test.step('restaurant confirms, sets an estimate, prepares and marks ready', async () => {
      await staff.goto('/restaurant')
      await expect(staff.getByTestId(`order-card-${orderId}`)).toBeVisible()
      await staff.getByTestId(`order-card-${orderId}`).click()
      await staff.waitForURL(`**/restaurant/orders/${orderId}`)

      await staff.getByTestId('approve-delivery').click()
      await expect(staff.getByTestId('delivery-review-approved')).toBeVisible()
      await staff.getByTestId('action-confirm').click()
      await staff.getByLabel('Taxminiy tayyorlash vaqti').fill('40')
      await staff.getByTestId('action-set-estimate').click()
      await expect(staff.locator('.panel').first()).toContainText('40 daqiqa')
      await staff.getByTestId('action-start-prep').click()
      await staff.getByTestId('action-mark-ready').click()
      await expect(staff.getByTestId('assign-driver-driver-1')).toBeEnabled()
    })

    await test.step('restaurant assigns the available driver', async () => {
      await staff.getByTestId('assign-driver-driver-1').click()
      await expect(staff.locator('.detail-head .badge')).toHaveText('Haydovchi biriktirilgan')
    })

    await test.step('driver accepts the assignment and progresses to delivered', async () => {
      await driver.goto('/driver')
      await expect(driver.locator('.delivery-card')).toBeVisible()
      await expect(driver.getByTestId('driver-primary-action')).toHaveText('Topshiriqni qabul qilish')
      await driver.getByTestId('driver-primary-action').click() // accept
      await expect(driver.getByTestId('driver-primary-action')).toHaveText('Olib ketdim')
      await driver.getByTestId('driver-primary-action').click() // PICKED_UP
      await driver.getByTestId('driver-primary-action').click() // ON_THE_WAY
      await driver.getByTestId('driver-primary-action').click() // ARRIVED
      await driver.getByTestId('driver-primary-action').click() // DELIVERED
      await expect(driver.getByTestId('driver-no-active')).toBeVisible()
    })

    await test.step('customer tracking and restaurant history both reflect DELIVERED, surviving a refresh', async () => {
      await customer.reload()
      await expect(customer.getByTestId('order-status')).toHaveText('Yetkazildi')

      await staff.goto(`/restaurant/orders/${orderId}`)
      await staff.reload()
      await expect(staff).toHaveURL(new RegExp(orderId))
      await expect(staff.locator('.detail-head .badge')).toHaveText('Yetkazildi')
      const eventLabels = await staff.getByTestId('event-list').locator('b').allTextContents()
      for (const label of ['Yangi', 'Tasdiqlangan', 'Tayyorlanmoqda', 'Tayyor', 'Haydovchi biriktirilgan', 'Kuryer olib ketdi', 'Yo‘lda', 'Yetib keldi', 'Yetkazildi']) {
        expect(eventLabels).toContain(label)
      }
    })
  })
})
