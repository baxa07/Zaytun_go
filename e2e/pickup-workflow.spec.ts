import{expect,test}from'@playwright/test'

test('pickup with physical terminal completes without driver stages',async({context})=>{
  const customer=await context.newPage()
  const staff=await context.newPage()
  const driver=await context.newPage()

  await customer.goto('/menu/chicken')
  await customer.getByTestId('buy-now').click()
  await customer.getByTestId('type-pickup').click()
  await expect(customer.getByLabel('Naqd pul')).toBeVisible()
  await expect(customer.getByLabel('Terminal — restoranda')).toBeVisible()
  await customer.getByLabel('Terminal — restoranda').check()
  await expect(customer.getByTestId('review-payment-method')).toContainText('Terminal')
  await customer.getByLabel('Ism *').fill('Pickup Test Mijoz')
  await customer.getByLabel('Telefon *').fill('+998901112233')
  await customer.getByTestId('checkout-submit').click()
  await customer.waitForURL('**/confirmation/**')
  const orderId=customer.url().split('/confirmation/')[1]
  await customer.getByTestId('track-link').click()
  await expect(customer.locator('.timeline>div')).toHaveCount(5)
  await expect(customer.locator('.timeline')).not.toContainText('Yo‘lda')
  await expect(customer.getByTestId('pickup-tracking-details')).toContainText('To‘lov restorandagi terminal orqali olinadi.')

  await staff.goto(`/restaurant/orders/${orderId}`)
  await expect(staff.getByText('Olib ketish',{exact:true}).first()).toBeVisible()
  await expect(staff.getByTestId('order-payment-preference')).toContainText('Kutilmoqda')
  await expect(staff.getByTestId('restaurant-location-detail')).toHaveCount(0)
  await staff.getByTestId('action-confirm').click()
  await staff.getByTestId('action-start-prep').click()
  await staff.getByTestId('action-mark-ready').click()
  await customer.reload()
  await expect(customer.getByTestId('order-status')).toHaveText('Olib ketishga tayyor')
  await expect(customer.getByTestId('pickup-ready-message')).toHaveText('Buyurtmangiz tayyor. Zaytun Kafedan olib ketishingiz mumkin.')
  await staff.getByTestId('action-mark-pickup-complete').click()
  await customer.reload()
  await expect(customer.getByTestId('order-status')).toHaveText('Olib ketildi')
  await expect(customer.locator('.timeline')).not.toContainText('Yetkazildi')

  const orderNumber=(await staff.locator('.detail-head .eyebrow').textContent())||''
  await driver.goto('/driver')
  await expect(driver.locator('.driver-page')).not.toContainText(orderNumber)
})

test('switching pickup terminal to delivery resets payment to cash',async({page})=>{
  await page.goto('/menu/chicken')
  await page.getByRole('button',{name:'+'}).click()
  await page.getByTestId('buy-now').click()
  await page.getByTestId('type-pickup').click()
  await page.getByLabel('Terminal — restoranda').check()
  await page.getByTestId('type-delivery').click()
  await expect(page.getByLabel('Terminal — restoranda')).toHaveCount(0)
  await expect(page.getByLabel('Naqd pul')).toBeChecked()
})

test('empty basket cannot be submitted',async({page})=>{
  await page.goto('/checkout')
  await page.getByTestId('type-pickup').click()
  await page.getByLabel('Ism *').fill('Bo‘sh savat')
  await page.getByLabel('Telefon *').fill('+998901112233')
  await page.getByTestId('checkout-submit').click()
  await expect(page).toHaveURL(/\/checkout$/)
  await expect(page.getByRole('alert').filter({hasText:'Savat bo‘sh'})).toBeVisible()
})
