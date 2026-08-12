import { execSync } from "node:child_process";
import { expect, test } from "@playwright/test";

const localPassword = "zaytun-local-2026";

function psql(sql: string) {
  execSync(
    `PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -v ON_ERROR_STOP=1 -c ${JSON.stringify(sql)}`,
  );
}

test("H1 order history: date presets, search, and row navigation", async ({ page }) => {
  // A yesterday order (backdated created_at) and a today order, both
  // reachable through History regardless of current status -- History
  // filters by created_at, not by whether the order is still active.
  await page.goto("/menu/chicken");
  await page.getByTestId("buy-now").click();
  await page.getByTestId("type-pickup").click();
  await page.getByLabel("Ism *").fill("Tarix Kecha Mijoz");
  await page.getByLabel("Telefon *").fill("+998907779900");
  await page.getByTestId("checkout-submit").click();
  await page.waitForURL("**/confirmation/**");
  const yesterdayOrderId = page.url().split("/confirmation/")[1];
  psql(`update orders set created_at=now()-interval '1 day' where id='${yesterdayOrderId}';`);

  await page.goto("/menu/chicken");
  await page.getByTestId("buy-now").click();
  await page.getByTestId("type-pickup").click();
  await page.getByLabel("Ism *").fill("Tarix Bugun Mijoz");
  await page.getByLabel("Telefon *").fill("+998907779901");
  await page.getByTestId("checkout-submit").click();
  await page.waitForURL("**/confirmation/**");
  const todayOrderId = page.url().split("/confirmation/")[1];

  await page.goto("/restaurant");
  await page.getByLabel("Telefon yoki email").fill("restaurant@zaytun.local");
  await page.getByLabel("Parol").fill(localPassword);
  await page.getByRole("button", { name: "Kirish" }).click();
  await expect(page.getByRole("button", { name: "Chiqish" })).toBeVisible();

  await page.getByRole("link", { name: "Tarix", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Buyurtmalar tarixi" })).toBeVisible();

  // TODAY (default preset): today's order visible, yesterday's absent.
  await expect(page.getByTestId(`history-row-${todayOrderId}`)).toBeVisible();
  await expect(page.getByTestId(`history-row-${yesterdayOrderId}`)).toHaveCount(0);

  // YESTERDAY preset: the reverse.
  await page.getByTestId("history-preset-YESTERDAY").click();
  await expect(page.getByTestId(`history-row-${yesterdayOrderId}`)).toBeVisible();
  await expect(page.getByTestId(`history-row-${todayOrderId}`)).toHaveCount(0);

  // LAST_7_DAYS: both visible.
  await page.getByTestId("history-preset-LAST_7_DAYS").click();
  await expect(page.getByTestId(`history-row-${yesterdayOrderId}`)).toBeVisible();
  await expect(page.getByTestId(`history-row-${todayOrderId}`)).toBeVisible();

  // Order-number search narrows to just the matching order.
  const todayNumber = await page.getByTestId(`history-row-${todayOrderId}`).locator("td").first().innerText();
  await page.getByTestId("history-search").fill(todayNumber);
  await expect(page.getByTestId(`history-row-${todayOrderId}`)).toBeVisible();
  await expect(page.getByTestId(`history-row-${yesterdayOrderId}`)).toHaveCount(0);
  await page.getByTestId("history-search").fill("");

  // Clicking a row opens the existing order detail page (read-only report,
  // no duplicated lifecycle controls in History itself).
  await page.getByTestId(`history-row-${todayOrderId}`).click();
  await expect(page).toHaveURL(new RegExp(`/restaurant/orders/${todayOrderId}$`));
});
