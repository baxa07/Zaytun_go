import { expect, test } from "@playwright/test";

const localPassword = "zaytun-local-2026";

async function freeDriver(page: import("@playwright/test").Page, identifier: string) {
  await page.goto("/driver");
  await page.getByLabel("Telefon yoki email").fill(identifier);
  await page.getByLabel("Parol").fill(localPassword);
  await page.getByRole("button", { name: "Kirish" }).click();
  await expect(page.getByRole("button", { name: "Chiqish" })).toBeVisible();
  // See driver-lifecycle-auth.spec.ts: the post-sign-in refresh is async
  // and can still be in flight right as "Chiqish" appears.
  await page.waitForTimeout(500);
  // Off-shift with no active work renders "driver-off-duty", never
  // "driver-no-active" (see the knownOffDuty branch in App.tsx) -- go
  // on-shift first, before waiting on "driver-no-active" below, so a
  // driver left off-shift by an earlier test (real Supabase, no
  // per-file DB isolation) can never hang this helper.
  if (await page.getByTestId("driver-shift-toggle").isEnabled().catch(() => false)) {
    if ((await page.getByTestId("driver-availability-status").textContent()) !== "🟢 Ishga tayyor") {
      await page.getByTestId("driver-shift-toggle").click();
      await expect(page.getByTestId("driver-availability-status")).toHaveText("🟢 Ishga tayyor");
    }
  }
  // "Free" means no active assignment/delivery card -- NOT literally the
  // driver-no-active testid, since a driver may legitimately be showing
  // driver-standby-notice instead (another order still PREPARING
  // elsewhere in the branch, e.g. left there on purpose by
  // customer-realtime-tracking.spec.ts's offline/online test). Standby is
  // information, not ownership, so it's still "free" for a fresh scenario.
  for (let i = 0; i < 6; i++) {
    if (await page.locator(".assignment-card, .delivery-card").count() === 0) break;
    await page.getByTestId("driver-primary-action").click().catch(() => page.getByTestId("driver-primary-action").click());
    await page.waitForTimeout(250);
  }
  await expect(page.locator(".assignment-card, .delivery-card")).toHaveCount(0);
}

async function placeAndReadyOrder(customer: import("@playwright/test").Page, staff: import("@playwright/test").Page, phone: string) {
  await customer.goto("/menu/chicken");
  await customer.getByRole("button", { name: "+" }).click();
  await customer.getByTestId("buy-now").click();
  await customer.waitForURL("**/checkout");
  await customer.getByLabel("Ism *").fill("P6 Auth Mijoz");
  await customer.getByLabel("Telefon *").fill(phone);
  await customer.getByLabel("Mahalla yoki tuman *").fill("Guliston tumani");
  await customer.getByLabel("Ko‘cha yoki joylashuv *").fill("Test ko‘chasi");
  await customer.getByTestId("map-picker-set").click();
  await customer.getByLabel("Kirish joyi xaritada to‘g‘ri belgilangan").check();
  await customer.getByTestId("checkout-submit").click();
  await customer.waitForURL("**/confirmation/**");
  const orderId = customer.url().split("/confirmation/")[1];

  await staff.goto(`/restaurant/orders/${orderId}`);
  await staff.getByLabel("Telefon yoki email").fill("restaurant@zaytun.local");
  await staff.getByLabel("Parol").fill(localPassword);
  await staff.getByRole("button", { name: "Kirish" }).click();
  await staff.getByTestId("approve-delivery").click();
  await staff.getByTestId("action-confirm").click();
  await staff.getByTestId("action-start-prep").click();
  await staff.getByTestId("action-mark-ready").click();
  return orderId;
}

test("P6 (real Supabase): a declined assignment is automatically and immediately reassigned to the other eligible driver, excluding the one who declined", async ({ browser }) => {
  const aziz = await (await browser.newContext()).newPage();
  const sardor = await (await browser.newContext()).newPage();
  const customerContext = await browser.newContext();
  const staffContext = await browser.newContext();
  const customer = await customerContext.newPage();
  const staff = await staffContext.newPage();

  // Both seed drivers ON_SHIFT/ACTIVE/free -- exactly two eligible
  // candidates, deterministic once we read which one dispatch actually
  // picked first.
  await freeDriver(aziz, "driver@zaytun.local");
  await freeDriver(sardor, "998900000099");

  await placeAndReadyOrder(customer, staff, "+998907777910");

  // No manual click -- real Smart Dispatch assigns one of the two.
  await expect(staff.getByTestId("dispatch-courier-status")).toBeVisible({ timeout: 10000 });
  const assignedName = (await staff.getByTestId("dispatch-courier-status").locator("p").textContent())?.trim();
  expect(["Aziz Bekov", "LOCAL TEST Phone Driver"]).toContain(assignedName);
  const decliningDriverPage = assignedName === "Aziz Bekov" ? aziz : sardor;
  const otherDriverName = assignedName === "Aziz Bekov" ? "LOCAL TEST Phone Driver" : "Aziz Bekov";

  await decliningDriverPage.reload();
  await expect(decliningDriverPage.locator(".assignment-card")).toBeVisible();
  await decliningDriverPage.getByTestId("driver-decline-assignment").click();
  await expect(decliningDriverPage.getByTestId("decline-reasons")).toBeVisible();
  await decliningDriverPage.getByTestId("decline-reason-CANNOT_GO_NOW").click();
  // Proof the decline completed and the driver has no active work -- not
  // literally driver-no-active, since a standby notice for some other
  // order elsewhere in the branch may legitimately be showing instead.
  await expect(decliningDriverPage.locator(".assignment-card, .delivery-card")).toHaveCount(0);

  // Automatic, excluded redispatch: the OTHER driver receives it, never
  // the one who just declined.
  await staff.reload();
  await expect(staff.getByTestId("dispatch-courier-status")).toBeVisible({ timeout: 10000 });
  await expect(staff.getByTestId("dispatch-courier-status")).toContainText(otherDriverName);
  await expect(staff.getByTestId("dispatch-courier-status")).toContainText("Biriktirildi");
  await expect(staff.getByTestId("dispatch-declined-note")).toContainText(`${assignedName} buyurtmani olmadi`);
});

test("P6 (real Supabase): staff can manually supersede an existing active assignment with a different eligible driver", async ({ browser }) => {
  const aziz = await (await browser.newContext()).newPage();
  const sardor = await (await browser.newContext()).newPage();
  const customerContext = await browser.newContext();
  const staffContext = await browser.newContext();
  const customer = await customerContext.newPage();
  const staff = await staffContext.newPage();

  await freeDriver(aziz, "driver@zaytun.local");
  await freeDriver(sardor, "998900000099");

  await placeAndReadyOrder(customer, staff, "+998907777911");
  await expect(staff.getByTestId("dispatch-courier-status")).toBeVisible({ timeout: 10000 });
  const assignedName = (await staff.getByTestId("dispatch-courier-status").locator("p").textContent())?.trim();
  const otherDriverName = assignedName === "Aziz Bekov" ? "LOCAL TEST Phone Driver" : "Aziz Bekov";

  const reassignPanel = staff.getByTestId("manual-reassign-panel");
  await expect(reassignPanel).toBeVisible();
  await expect(reassignPanel).not.toHaveJSProperty("open", true);
  await reassignPanel.locator("summary").click();
  // The currently-assigned driver is excluded from the panel's own list.
  const currentOptionCount = await reassignPanel.locator(".driver-option").count();
  expect(currentOptionCount).toBe(1);
  await reassignPanel.locator(".driver-option").click();

  await expect(staff.getByTestId("dispatch-courier-status")).toContainText(otherDriverName);
  await expect(staff.getByTestId("dispatch-courier-status")).toContainText("Biriktirildi");
  await expect(staff.locator(".detail-head .badge")).toHaveText("Haydovchi biriktirilgan");
});
