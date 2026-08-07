import { expect, test, type Page } from "@playwright/test";

const localPassword = "zaytun-local-2026";

async function signIn(page: Page, email: string) {
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Parol").fill(localPassword);
  await page.getByRole("button", { name: "Kirish" }).click();
}

test("local customer, restaurant, and driver auth/RLS workflow", async ({ page }) => {
  const anonymousOperationalFailures: string[] = [];
  page.on("response", (response) => {
    const pathname = new URL(response.url()).pathname;
    if (response.status() === 401 && (pathname.includes("/rest/v1/orders") || pathname.includes("/rest/v1/drivers"))) {
      anonymousOperationalFailures.push(pathname);
    }
  });

  await test.step("anonymous customer creates and tracks an order without staff queries", async () => {
    await page.goto("/menu");
    await page.getByRole("link", { name: /Zaytun tovuq grili tanlash/ }).click();
    await page.getByRole("button", { name: "+" }).click();
    await page.getByTestId("buy-now").click();
    await page.getByLabel("Ism *").fill("Auth RLS Mijoz");
    await page.getByLabel("Telefon *").fill("+998901234567");
    await page.getByLabel("Mahalla yoki tuman *").fill("Navoiy shahar");
    await page.getByLabel("Ko‘cha yoki joylashuv *").fill("Amir Temur ko‘chasi");
    await page.getByLabel("Uy / bino *").fill("24B");
    await page.getByLabel("Mo‘ljal", { exact: true }).fill("Maktab ro‘parasida");
    await page.getByTestId("map-picker-set").click();
    await page.getByLabel("Pin to‘g‘ri joyda").check();
    await page.getByTestId("checkout-submit").click();
    await expect(page).toHaveURL(/\/confirmation\//);
    await expect(page.getByTestId("server-confirmed-total")).toContainText(/136.?000/);
    await page.getByTestId("track-link").click();
    await expect(page.getByTestId("order-status")).toHaveText("Manzil tasdiqlanmoqda");
    await expect(page.locator(".track .form-card")).toContainText(/136.?000/);
    expect(anonymousOperationalFailures).toEqual([]);
  });

  const orderId = page.url().split("/track/")[1];
  let orderNumber = "";

  await test.step("restaurant is gated, signs in, loads orders, and prepares the order", async () => {
    await page.goto("/restaurant");
    await expect(page.getByRole("heading", { name: "Kirish" })).toBeVisible();
    expect(anonymousOperationalFailures).toEqual([]);
    await signIn(page, "restaurant@zaytun.local");
    await expect(page.getByTestId(`order-card-${orderId}`)).toBeVisible();
    await page.getByTestId(`order-card-${orderId}`).click();
    orderNumber = (await page.locator(".detail-head .eyebrow").textContent()) || "";
    await expect(page.locator(".panel").first()).toContainText(/136.?000/);
    await page.getByTestId("approve-delivery").click();
    await page.getByTestId("action-confirm").click();
    await page.getByTestId("action-start-prep").click();
    await page.getByTestId("action-mark-ready").click();
    const availableDriver = page.locator('[data-testid^="assign-driver-"]:not([disabled])').first();
    await expect(availableDriver).toBeVisible();
    await availableDriver.click();
    await expect(page.locator(".detail-head .badge")).toHaveText("Haydovchi biriktirilgan");
    await page.getByRole("button", { name: "Chiqish" }).click();
    await expect(page.getByRole("heading", { name: "Kirish" })).toBeVisible();
  });

  await test.step("driver is gated, signs in, and performs permitted actions", async () => {
    await page.goto("/driver");
    await expect(page.getByRole("heading", { name: "Kirish" })).toBeVisible();
    await signIn(page, "driver@zaytun.local");
    await expect(page.locator(".delivery-card")).toContainText(orderNumber);
    await expect(page.getByTestId("driver-primary-action")).toHaveText("Topshiriqni qabul qilish");
    await page.getByTestId("driver-primary-action").click();
    await expect(page.getByTestId("driver-primary-action")).toHaveText("Olib ketdim");
    await page.getByTestId("driver-primary-action").click();
    await expect(page.locator(".delivery-top .badge")).toHaveText("Olib ketildi");
  });
});

test('local Supabase pickup card lifecycle is restaurant-only',async({page})=>{
  await page.goto('/menu')
  await page.getByRole('link',{name:/Zaytun tovuq grili tanlash/}).click()
  await page.getByTestId('buy-now').click()
  await page.getByTestId('type-pickup').click()
  await page.getByLabel('Restoranda karta orqali').check()
  await page.getByLabel('Ism *').fill('Supabase Pickup Mijoz')
  await page.getByLabel('Telefon *').fill('+998901234568')
  await page.getByTestId('checkout-submit').click()
  await page.waitForURL('**/confirmation/**')
  const orderId=page.url().split('/confirmation/')[1]
  await page.getByTestId('track-link').click()
  const trackingUrl=page.url()
  await expect(page.getByTestId('pickup-tracking-details')).toContainText('restoranda karta')

  await page.goto(`/restaurant/orders/${orderId}`)
  await signIn(page,'restaurant@zaytun.local')
  await page.waitForURL(`**/restaurant/orders/${orderId}`)
  await page.getByTestId('action-confirm').click()
  await page.getByTestId('action-start-prep').click()
  await page.getByTestId('action-mark-ready').click()
  await page.getByTestId('action-mark-pickup-complete').click()
  await expect(page.locator('.detail-head .badge')).toHaveText('Olib ketildi')
  await page.getByRole('button',{name:'Chiqish'}).click()

  await page.goto(trackingUrl)
  await expect(page.getByTestId('order-status')).toHaveText('Olib ketildi')
  await expect(page.locator('.timeline>div')).toHaveCount(5)
  await expect(page.locator('.timeline')).not.toContainText('Haydovchi')
})
