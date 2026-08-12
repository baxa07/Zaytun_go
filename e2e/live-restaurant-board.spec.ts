import { execSync } from "node:child_process";
import { expect, test } from "@playwright/test";

const localPassword = "zaytun-local-2026";

function psql(sql: string) {
  execSync(
    `PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -v ON_ERROR_STOP=1 -c ${JSON.stringify(sql)}`,
  );
}

// H0: the live restaurant board hides terminal orders finished before
// today, but never deletes/hides the underlying data -- an old order must
// still be reachable and fully viewable via its direct detail URL.
test.describe("H0 live restaurant board", () => {
  test("an old (yesterday) DELIVERED order is absent from the board but still reachable via direct URL", async ({ page }) => {
    // Real order created through the app, then its canonical terminal
    // transition backdated directly in the database -- exactly what H0's
    // "canonical transition time, not created_at" rule is required to key
    // on. The precise timestamp behavior itself is already exhaustively
    // proven at the SQL layer (supabase/tests/live_restaurant_board.test.sql);
    // this proves the frontend actually respects the server's answer.
    await page.goto("/menu/chicken");
    await page.getByTestId("buy-now").click();
    await page.getByTestId("type-pickup").click();
    await page.getByLabel("Ism *").fill("Yesterday Order Mijoz");
    await page.getByLabel("Telefon *").fill("+998907778800");
    await page.getByTestId("checkout-submit").click();
    await page.waitForURL("**/confirmation/**");
    const orderId = page.url().split("/confirmation/")[1];

    psql(
      `update orders set status='COLLECTED',delivery_review_status='APPROVED' where id='${orderId}';` +
        `insert into order_events(order_id,actor_type,actor_id,previous_status,new_status,occurred_at) values ('${orderId}','RESTAURANT','seed','READY','COLLECTED',now()-interval '1 day');`,
    );

    await page.goto("/restaurant");
    await page.getByLabel("Telefon yoki email").fill("restaurant@zaytun.local");
    await page.getByLabel("Parol").fill(localPassword);
    await page.getByRole("button", { name: "Kirish" }).click();
    // Wait for the session to be fully settled (not just React state) before
    // triggering a full-page reload below -- otherwise the reload can race
    // Supabase's localStorage session write and briefly look unauthenticated.
    await expect(page.getByRole("button", { name: "Chiqish" })).toBeVisible();
    await expect(page.getByTestId(`order-card-${orderId}`)).toHaveCount(0);

    // The order is not deleted -- direct navigation to its detail page
    // (a bookmark, a Telegram button, browser history) still works.
    await page.goto(`/restaurant/orders/${orderId}`);
    await expect(page.locator(".detail-head .eyebrow")).toBeVisible();
    await expect(page.locator(".detail-head .badge")).toHaveText("Olib ketildi");
  });

  test("a new order still appears on the board normally", async ({ context }) => {
    const customer = await context.newPage();
    const staff = await context.newPage();

    await staff.goto("/restaurant");
    await staff.getByLabel("Telefon yoki email").fill("restaurant@zaytun.local");
    await staff.getByLabel("Parol").fill(localPassword);
    await staff.getByRole("button", { name: "Kirish" }).click();

    await customer.goto("/menu/chicken");
    await customer.getByTestId("buy-now").click();
    await customer.getByTestId("type-pickup").click();
    await customer.getByLabel("Ism *").fill("Today Order Mijoz");
    await customer.getByLabel("Telefon *").fill("+998907778801");
    await customer.getByTestId("checkout-submit").click();
    await customer.waitForURL("**/confirmation/**");
    const orderId = customer.url().split("/confirmation/")[1];

    await staff.reload();
    await expect(staff.getByTestId(`order-card-${orderId}`)).toBeVisible();
  });
});
