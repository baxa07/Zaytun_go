import {expect, test} from '@playwright/test'

// These use the seeded orders directly (ord-ready, ord-active) so each test is fast
// and independent, instead of re-running the full order lifecycle.
test.describe('exceptional and illegal states', () => {
  test('a ready order with no available driver shows an explicit waiting state, and manual assignment (once opened) shows no assignment succeeds', async ({page}) => {
    await page.goto('/restaurant/orders/ord-ready')
    await expect(page).toHaveURL(/ord-ready/) // must not redirect away
    // P5.6/P5.7: automatic dispatch is the default presentation -- this is
    // always visible, not hidden behind the manual-assign exception control.
    await expect(page.getByTestId('dispatch-searching')).toBeVisible()
    // Manual assignment is demoted to a closed-by-default exception panel.
    await page.locator('.manual-assign summary').click()
    await expect(page.getByTestId('no-driver-available')).toBeVisible()
    for (const button of await page.locator('[data-testid^="assign-driver-"]').all()) {
      await expect(button).toBeDisabled()
    }
  })

  test('an illegal cancel action is hidden once an order is out for delivery', async ({page}) => {
    // ord-active seeds at ON_THE_WAY, where CANCELLED is not a legal transition.
    await page.goto('/restaurant/orders/ord-active')
    await expect(page).toHaveURL(/ord-active/)
    await expect(page.getByTestId('action-cancel')).toHaveCount(0)
  })

  test('the cancel action is available (though reason-gated) while cancellation is still legal', async ({page}) => {
    // ord-new seeds at NEW, where CANCELLED is legal.
    await page.goto('/restaurant/orders/ord-new')
    await expect(page.getByTestId('action-cancel')).toBeVisible()
    await expect(page.getByTestId('action-cancel')).toBeDisabled()
  })
})
