import {expect,test} from '@playwright/test'

test.describe('product detail quick actions',()=>{
  test('add to cart preserves configuration and returns to the selected menu category',async({page})=>{
    await page.goto('/menu/chicken')
    await page.getByRole('textbox').fill('Sous alohida')
    await page.getByRole('button',{name:'+'}).click()
    await page.getByTestId('add-to-cart').click()
    await expect(page).toHaveURL(/\/menu$/)
    await expect(page.getByText('Savatga qo‘shildi.')).toBeVisible()
    await page.getByTestId('cart-pill').click()
    await expect(page.locator('.line-item')).toContainText('2')
    await expect(page.locator('.line-item')).toContainText('Sous alohida')
  })

  test('buy now keeps existing items and navigates directly to Step 1 of checkout; both items still appear once Step 5 (review) is reached',async({page})=>{
    await page.goto('/menu/chicken')
    await page.getByTestId('add-to-cart').click()
    await page.locator('.menu-card-name').filter({hasText:'Mol go‘shtli kabob'}).click()
    await page.getByTestId('buy-now').click()
    await expect(page).toHaveURL(/\/checkout$/)
    await expect(page.getByTestId('checkout-step-1')).toBeVisible()

    await page.getByLabel('Ism *').fill('Mijoz')
    await page.getByLabel('Telefon *').fill('+998901112233')
    await page.getByTestId('type-pickup').click()
    await page.getByTestId('checkout-continue').click()
    await expect(page.getByTestId('checkout-step-4')).toBeVisible()
    await page.getByTestId('checkout-continue').click()
    await expect(page.getByTestId('checkout-step-5')).toBeVisible()
    await expect(page.getByTestId('review-items').getByText(/Zaytun tovuq grili/)).toBeVisible()
    await expect(page.getByTestId('review-items').getByText(/Mol go‘shtli kabob/)).toBeVisible()
  })

  test('different instructions stay separate and rapid clicks do not duplicate',async({page})=>{
    await page.goto('/menu/chicken')
    await page.getByRole('textbox').fill('Piyozsiz')
    await page.getByTestId('add-to-cart').dblclick()
    // The card's footer action is now a direct stepper (exactly one
    // configured line exists), not the selection link -- the image/name
    // still opens configuration for a second, distinct variant.
    await page.locator('.menu-card-name').filter({hasText:'Zaytun tovuq grili'}).click()
    await page.getByRole('textbox').fill('Achchiq')
    await page.getByTestId('add-to-cart').click()
    await page.getByTestId('cart-pill').click()
    await expect(page.locator('.line-item')).toHaveCount(2)
    await expect(page.locator('.line-item').filter({hasText:'Piyozsiz'})).toHaveCount(1)
    await expect(page.locator('.line-item').filter({hasText:'Achchiq'})).toHaveCount(1)
  })
})

test.describe('product-card quantity stepper',()=>{
  test('a simple product starts at the bare +, becomes − 1 +, increments to 2, decrements back to 1, then removing it returns to the bare + -- and the bottom cart count stays in sync throughout',async({page})=>{
    await page.goto('/menu')
    // The top-of-page cart pill always shows a count (including zero) --
    // unlike the bottom nav link, which hides the count entirely at zero.
    await expect(page.getByTestId('cart-pill')).toHaveText('Savat · 0')

    // "Mol go'shtli kabob" has no modifiers, so its card action is a
    // <button class="round">, not a <a> to the product detail page.
    const card=page.locator('.menu-category-section .menu-card',{has:page.getByText('Mol go‘shtli kabob')})
    const plainAdd=card.locator('button.round')
    await plainAdd.click()

    const stepper=card.getByTestId(/^qty-stepper-/)
    await expect(stepper).toBeVisible()
    await expect(stepper.locator('b')).toHaveText('1')
    await expect(page.getByTestId('cart-pill')).toHaveText(/Savat · 1/)

    await stepper.getByRole('button',{name:/sonini oshirish/}).click()
    await expect(stepper.locator('b')).toHaveText('2')
    await expect(page.getByTestId('cart-pill')).toHaveText(/Savat · 2/)

    await stepper.getByRole('button',{name:/sonini kamaytirish/}).click()
    await expect(stepper.locator('b')).toHaveText('1')
    await expect(page.getByTestId('cart-pill')).toHaveText(/Savat · 1/)

    await stepper.getByRole('button',{name:/sonini kamaytirish/}).click()
    await expect(card.locator('button.round')).toBeVisible()
    await expect(card.getByTestId(/^qty-stepper-/)).toHaveCount(0)
    await expect(page.getByTestId('cart-pill')).toHaveText('Savat · 0')
  })

  test('packaging totals stay correct as the card stepper changes quantity -- driven by the same calculatePackagingTotal used everywhere else',async({page})=>{
    await page.goto('/menu')
    const card=page.locator('.menu-category-section .menu-card',{has:page.getByText('Mol go‘shtli kabob')})
    // packagingCapacity: 1, packagingUnitPrice: 3000 -- one box per unit.
    await card.locator('button.round').click()
    await card.getByRole('button',{name:/sonini oshirish/}).click()
    await card.getByRole('button',{name:/sonini oshirish/}).click()

    await page.getByTestId('cart-pill').click()
    await expect(page.getByTestId('cart-packaging-total')).toHaveText('9,000 so‘m')
  })

  test('1. a modifier product (Grill) with zero cart lines shows the plain selection + link',async({page})=>{
    await page.goto('/menu')
    const chickenCard=page.locator('.menu-category-section .menu-card',{has:page.getByText('Zaytun tovuq grili')})
    await expect(chickenCard.getByRole('link',{name:/tanlash/})).toBeVisible()
    await expect(chickenCard.getByTestId(/^qty-stepper-/)).toHaveCount(0)
    await expect(chickenCard.getByTestId(/^cart-qty-badge-/)).toHaveCount(0)
  })

  test('2/3/4/5/6. selecting and adding one Grill variant returns to menu with − 1 +, which increments/decrements that exact configured line without touching its modifiers or instructions, and removing it restores the selection +',async({page})=>{
    await page.goto('/menu/chicken')
    await page.getByLabel('Achchiq').check()
    await page.getByRole('textbox').fill('Sousni alohida soling')
    await page.getByTestId('add-to-cart').click()
    await expect(page).toHaveURL(/\/menu$/)

    const chickenCard=page.locator('.menu-category-section .menu-card',{has:page.getByText('Zaytun tovuq grili')})
    const stepper=chickenCard.getByTestId(/^qty-stepper-/)
    await expect(stepper).toBeVisible()
    await expect(stepper.locator('b')).toHaveText('1')
    await expect(chickenCard.getByRole('link',{name:/tanlash/})).toHaveCount(0)

    // 3. + increments that exact configured line to 2.
    await stepper.getByRole('button',{name:/sonini oshirish/}).click()
    await expect(stepper.locator('b')).toHaveText('2')

    // 6. the configured line's own modifier and instructions are untouched
    // by the card's +/- -- only quantity changed (verified via the cart
    // page, which reads the same authoritative line).
    await page.getByTestId('cart-pill').click()
    const cartLine=page.locator('.line-item').filter({hasText:'Zaytun tovuq grili'})
    await expect(cartLine).toContainText('Achchiq')
    await expect(cartLine).toContainText('Sousni alohida soling')
    await expect(cartLine.locator('.stepper b')).toHaveText('2')
    await page.goBack()
    await page.waitForURL('**/menu')

    // 4. − decrements that exact line back to 1.
    const stepperAgain=chickenCard.getByTestId(/^qty-stepper-/)
    await stepperAgain.getByRole('button',{name:/sonini kamaytirish/}).click()
    await expect(stepperAgain.locator('b')).toHaveText('1')

    // 5. decrementing the last unit removes the line and restores the
    // plain selection + (same zero-removes-the-line rule as everywhere
    // else in the cart).
    await stepperAgain.getByRole('button',{name:/sonini kamaytirish/}).click()
    await expect(chickenCard.getByTestId(/^qty-stepper-/)).toHaveCount(0)
    await expect(chickenCard.getByRole('link',{name:/tanlash/})).toBeVisible()
  })

  test('7. packaging and cart totals remain correct for a card-incremented modifier line',async({page})=>{
    await page.goto('/menu/chicken')
    await page.getByLabel('Qo‘shimcha sous').check() // +5,000 so'm
    await page.getByTestId('add-to-cart').click()
    await expect(page).toHaveURL(/\/menu$/)

    const chickenCard=page.locator('.menu-category-section .menu-card',{has:page.getByText('Zaytun tovuq grili')})
    const stepper=chickenCard.getByTestId(/^qty-stepper-/)
    await stepper.getByRole('button',{name:/sonini oshirish/}).click() // quantity -> 2

    await page.getByTestId('cart-pill').click()
    // chicken: packagingCapacity 1, packagingUnitPrice 3,000 -- one box per unit -> 2 * 3,000.
    await expect(page.getByTestId('cart-packaging-total')).toHaveText('6,000 so‘m')
    const cartLine=page.locator('.line-item').filter({hasText:'Zaytun tovuq grili'})
    // (68,000 + 5,000 modifier) * 2 = 146,000.
    await expect(cartLine).toContainText('146,000')
  })

  test('8/9. two distinct configured Grill variants never show one ambiguous shared stepper -- the card shows the plain + plus a total cart quantity badge instead',async({page})=>{
    await page.goto('/menu/chicken')
    await page.getByLabel('Achchiq').check()
    await page.getByTestId('add-to-cart').click()
    await expect(page).toHaveURL(/\/menu$/)
    // Exactly one configured line exists now -- the card's footer is a
    // direct stepper, not the selection link, so the second, distinct
    // variant is reached via the image/name link instead.
    await page.locator('.menu-card-name').filter({hasText:'Zaytun tovuq grili'}).click()
    await page.getByLabel('Qo‘shimcha sous').check()
    await page.getByRole('button',{name:'+'}).click() // quantity -> 2 on this second, distinct variant
    await page.getByTestId('add-to-cart').click()
    await expect(page).toHaveURL(/\/menu$/)

    const chickenCard=page.locator('.menu-category-section .menu-card',{has:page.getByText('Zaytun tovuq grili')})
    await expect(chickenCard.getByTestId(/^qty-stepper-/)).toHaveCount(0)
    await expect(chickenCard.getByRole('link',{name:/tanlash/})).toBeVisible()
    const badge=chickenCard.getByTestId(/^cart-qty-badge-/)
    await expect(badge).toHaveText('Savatda 3') // 1 + 2 across the two distinct lines
  })

  test('10. the image/name links still open product configuration even while one variant is already configured, so a different variant can be added',async({page})=>{
    await page.goto('/menu/chicken')
    await page.getByLabel('Achchiq').check()
    await page.getByTestId('add-to-cart').click()
    await expect(page).toHaveURL(/\/menu$/)

    const chickenCard=page.locator('.menu-category-section .menu-card',{has:page.getByText('Zaytun tovuq grili')})
    await expect(chickenCard.getByTestId(/^qty-stepper-/)).toBeVisible()
    await chickenCard.locator('.menu-card-name').click()
    await expect(page).toHaveURL(/\/menu\/chicken$/)
  })

  // 12. Featured (Zaytun Tanlovi) and category cards render the same
  // stepper/badge decision because both call the identical
  // ProductQuantityControl(item, cart, ...) function -- no seed product is
  // currently curated as a bestseller, so there is nothing to click here
  // in this environment; the shared-component guarantee is exercised
  // directly by the RTL/domain tests (ProductImage.test.tsx,
  // domain.test.ts's resolveProductCartLines suite), which call the exact
  // same function the bestseller card's JSX invokes.

  test('13. Grill category stepper works at Telegram-shaped 390x844 without horizontal overflow',async({page})=>{
    await page.setViewportSize({width:390,height:844})
    await page.goto('/menu/chicken')
    await page.getByLabel('Achchiq').check()
    await page.getByTestId('add-to-cart').click()
    await expect(page).toHaveURL(/\/menu$/)

    const overflow=await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth)
    expect(overflow).toBe(0)
    const chickenCard=page.locator('.menu-category-section .menu-card',{has:page.getByText('Zaytun tovuq grili')})
    await expect(chickenCard.getByTestId(/^qty-stepper-/)).toBeVisible()
  })
})
