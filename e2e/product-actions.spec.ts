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

  test('buy now keeps existing items and navigates directly to checkout',async({page})=>{
    await page.goto('/menu/chicken')
    await page.getByTestId('add-to-cart').click()
    await page.getByRole('link',{name:/Mol go‘shtli kabob tanlash/}).click()
    await page.getByTestId('buy-now').click()
    await expect(page).toHaveURL(/\/checkout$/)
    await expect(page.locator('.review').getByText(/Zaytun tovuq grili/)).toBeVisible()
    await expect(page.locator('.review').getByText(/Mol go‘shtli kabob/)).toBeVisible()
  })

  test('different instructions stay separate and rapid clicks do not duplicate',async({page})=>{
    await page.goto('/menu/chicken')
    await page.getByRole('textbox').fill('Piyozsiz')
    await page.getByTestId('add-to-cart').dblclick()
    await page.getByRole('link',{name:/Zaytun tovuq grili tanlash/}).click()
    await page.getByRole('textbox').fill('Achchiq')
    await page.getByTestId('add-to-cart').click()
    await page.getByTestId('cart-pill').click()
    await expect(page.locator('.line-item')).toHaveCount(2)
    await expect(page.locator('.line-item').filter({hasText:'Piyozsiz'})).toHaveCount(1)
    await expect(page.locator('.line-item').filter({hasText:'Achchiq'})).toHaveCount(1)
  })
})
