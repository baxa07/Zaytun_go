import { expect, test, type Page } from "@playwright/test";

async function addQuantity(page: Page, itemId: string, quantity: number) {
  await page.goto(`/menu/${itemId}`);
  for (let current = 1; current < quantity; current += 1) {
    await page.getByRole("button", { name: "+", exact: true }).click();
  }
  await page.getByTestId("add-to-cart").click();
}

async function addQuantityFromMenu(page: Page, itemId: string, quantity: number) {
  await page.locator(`a[href="/menu/${itemId}"]`).first().click();
  for (let current = 1; current < quantity; current += 1) {
    await page.getByRole("button", { name: "+", exact: true }).click();
  }
  await page.getByTestId("add-to-cart").click();
}

test("Olot somsa shows its separate packaging estimate in cart and checkout", async ({ page }) => {
  await addQuantity(page, "nacional-olot-somsa", 16);

  await page.getByTestId("customer-bottom-nav").getByRole("link", { name: /Savat/ }).click();
  await expect(page.getByTestId("cart-packaging-total")).toContainText(/6[,\s]000/);
  await expect(page.getByText("Taomlar").locator("..")).toContainText(/160[,\s]000/);

  await page.getByTestId("go-to-checkout").click();
  await page.getByTestId("type-pickup").click();
  await expect(page.getByTestId("checkout-packaging-total")).toContainText(/6[,\s]000/);
  await expect(page.getByTestId("estimated-total")).toContainText(/166[,\s]000/);
});

test("mixed Somsa, Olot, and Jiz cart applies the persisted product policy", async ({ page }) => {
  await page.goto("/menu");
  await page.getByRole("button", { name: "Национальные блюда", exact: true }).click();
  await addQuantityFromMenu(page, "nacional-somsa-obychnyy-i-ostryy", 1);
  await addQuantityFromMenu(page, "nacional-olot-somsa", 2);
  await addQuantityFromMenu(page, "nacional-zhiz-file", 1);

  await page.getByTestId("customer-bottom-nav").getByRole("link", { name: /Savat/ }).click();
  await expect(page.getByTestId("cart-packaging-total")).toContainText(/6[,\s]000/);
  await expect(page.getByText("Taomlar").locator("..")).toContainText(/292[,\s]000/);

  await page.getByTestId("go-to-checkout").click();
  await page.getByTestId("type-pickup").click();
  await expect(page.getByTestId("checkout-packaging-total")).toContainText(/6[,\s]000/);
  await expect(page.getByTestId("estimated-total")).toContainText(/298[,\s]000/);
});
