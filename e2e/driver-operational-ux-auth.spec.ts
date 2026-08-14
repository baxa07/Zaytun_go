import { expect, test } from "@playwright/test";
import { forceFreeDriver } from "./helpers/driverCleanup";

// Driver UI Final Operational UX: proves the rendered "what should I do
// right now?" experience the spec asks for, live, with no manual reload
// anywhere -- built on top of the already-verified Multi-Order Dispatch
// backend (assign at ACCEPT, batching, actual-wait release/redispatch,
// route-stop sequencing). Covers spec section 39's scenarios A (single
// order), B (two compatible orders end to end, including capacity,
// second-order UI, wait-for-second, both-ready, and automatic stop
// promotion), and C (delayed second order released mid-wait). Scenario D
// (decline one of two) and the underlying batching/privacy/redispatch
// mechanics are already covered by multi-order-batching-auth.spec.ts and
// supabase/tests/multi_order_dispatch.test.sql; this file focuses on the
// NEW operational-UX surface itself.
const localPassword = "zaytun-local-2026";

async function freeDriver(page: import("@playwright/test").Page, identifier: string) {
  await forceFreeDriver(identifier);
  await page.goto("/driver");
  await page.getByLabel("Telefon yoki email").fill(identifier);
  await page.getByLabel("Parol").fill(localPassword);
  await page.getByRole("button", { name: "Kirish" }).click();
  await expect(page.getByRole("button", { name: "Chiqish" })).toBeVisible();
  await page.waitForTimeout(500);
  if (await page.getByTestId("driver-shift-toggle").isEnabled().catch(() => false)) {
    if ((await page.getByTestId("driver-availability-status").textContent()) !== "🟢 Ishga tayyor") {
      await page.getByTestId("driver-shift-toggle").click();
      await expect(page.getByTestId("driver-availability-status")).toHaveText("🟢 Ishga tayyor");
    }
  }
  // Multi-Order Dispatch: coming on-shift above can itself trigger a live
  // sweep assignment for a pending order left elsewhere in the branch by
  // an earlier spec -- AFTER the forceFreeDriver call above already ran,
  // so it couldn't have caught this one. If it lands as CONFIRMED/
  // PREPARING (accepted-but-not-ready), it has no driver-primary-action
  // at all (that screen only offers check-in), so blindly clicking it
  // would hang until the whole test's timeout fires. Hard-clear again
  // instead of guessing at a click.
  if (await page.locator(".assignment-card, .delivery-card").count() > 0) {
    await forceFreeDriver(identifier);
    await page.reload();
    await page.waitForTimeout(500);
  }
  for (let i = 0; i < 6; i++) {
    if (await page.locator(".assignment-card, .delivery-card").count() === 0) break;
    await page.getByTestId("driver-primary-action").click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(250);
  }
  if (await page.locator(".assignment-card, .delivery-card").count() > 0) {
    await forceFreeDriver(identifier);
    await page.reload();
  }
  await expect(page.locator(".assignment-card, .delivery-card")).toHaveCount(0, { timeout: 10000 });
}

async function takeOffShift(page: import("@playwright/test").Page, identifier: string) {
  await freeDriver(page, identifier);
  await page.getByTestId("driver-shift-toggle").click();
  await expect(page.getByTestId("driver-availability-status")).toHaveText("⚪ Hozir ishlamayapman");
}

async function signInStaff(page: import("@playwright/test").Page) {
  await page.goto("/restaurant");
  await page.getByLabel("Telefon yoki email").fill("restaurant@zaytun.local");
  await page.getByLabel("Parol").fill(localPassword);
  await page.getByRole("button", { name: "Kirish" }).click();
  await expect(page.getByRole("button", { name: "Chiqish" })).toBeVisible();
}

async function placeDeliveryOrder(customer: import("@playwright/test").Page, name: string, phone: string) {
  await customer.goto("/menu/chicken");
  await customer.getByRole("button", { name: "+" }).click();
  await customer.getByTestId("buy-now").click();
  await customer.waitForURL("**/checkout");
  await customer.getByLabel("Ism *").fill(name);
  await customer.getByLabel("Telefon *").fill(phone);
  await customer.getByLabel("Mahalla yoki tuman *").fill("Guliston tumani");
  await customer.getByLabel("Ko‘cha yoki joylashuv *").fill("Test ko‘chasi");
  await customer.getByTestId("map-picker-set").click();
  await customer.getByLabel("Kirish joyi xaritada to‘g‘ri belgilangan").check();
  await customer.getByTestId("checkout-submit").click();
  await customer.waitForURL("**/confirmation/**");
  return customer.url().split("/confirmation/")[1];
}

async function acceptOrder(staff: import("@playwright/test").Page, orderId: string) {
  await staff.goto(`/restaurant/orders/${orderId}`);
  await staff.getByTestId("approve-delivery").click();
  await staff.getByTestId("action-confirm").click();
}

async function readyOrder(staff: import("@playwright/test").Page, orderId: string) {
  await staff.goto(`/restaurant/orders/${orderId}`);
  await staff.getByTestId("action-start-prep").click();
  await expect(staff.getByTestId("action-mark-ready")).toBeVisible({ timeout: 10000 });
  for (let i = 0; i < 5; i++) {
    if ((await staff.locator(".detail-head .badge").textContent()) === "Haydovchi biriktirilgan") break;
    await staff.getByTestId("action-mark-ready").click().catch(() => {});
    await staff.waitForTimeout(400);
  }
  await expect(staff.locator(".detail-head .badge")).toHaveText("Haydovchi biriktirilgan", { timeout: 10000 });
}

test("scenario A: one normal order end to end -- capacity, early check-in, no batch UI for a solo order, no reload anywhere", async ({ browser }) => {
  const driverContext = await browser.newContext();
  const otherDriverContext = await browser.newContext();
  const customerContext = await browser.newContext();
  const staffContext = await browser.newContext();
  const driver = await driverContext.newPage();
  const otherDriver = await otherDriverContext.newPage();
  const customer = await customerContext.newPage();
  const staff = await staffContext.newPage();

  await takeOffShift(otherDriver, "998900000099");
  await otherDriverContext.close();
  await freeDriver(driver, "driver@zaytun.local");
  await signInStaff(staff);

  const orderId = await placeDeliveryOrder(customer, "UX Solo Mijoz", "+998907779101");
  await acceptOrder(staff, orderId); // real assignment happens right here, at ACCEPT

  // New real assignment: prominent card, not standby, with a prep-time
  // estimate and delivery area -- no customer address/phone exposed yet.
  await expect(driver.locator(".assignment-card")).toBeVisible({ timeout: 15000 });
  await expect(driver.getByTestId("driver-primary-action")).toHaveText("Qabul qilish");
  await driver.getByTestId("driver-primary-action").click(); // accept

  // Preparing view -- check-in is available now, well before READY.
  await expect(driver.getByTestId("driver-pre-ready-card")).toBeVisible();
  await expect(driver.getByTestId("driver-mark-at-restaurant")).toBeVisible();
  // Single order: no batch grouping panel, no "N/2" capacity confusion.
  await expect(driver.getByTestId("driver-batch-group")).toHaveCount(0);
  await driver.getByTestId("driver-mark-at-restaurant").click();
  await expect(driver.getByTestId("driver-at-restaurant-badge")).toBeVisible();
  // Lands on the already-open staff order-detail page live, no reload,
  // even though the order is still CONFIRMED/PREPARING.
  await staff.goto(`/restaurant/orders/${orderId}`);
  await expect(staff.getByTestId("driver-at-restaurant-notice")).toBeVisible({ timeout: 15000 });

  await readyOrder(staff, orderId);

  // Ready -- single-order path stays simple, no wait/both-ready UI.
  await expect(driver.locator(".delivery-card")).toBeVisible({ timeout: 15000 });
  await expect(driver.getByTestId("driver-wait-for-second")).toHaveCount(0);
  await expect(driver.getByTestId("driver-both-ready")).toHaveCount(0);
  await expect(driver.getByTestId("driver-primary-action")).toHaveText("Buyurtmani oldim");
  await driver.getByTestId("driver-primary-action").click(); // PICKED_UP

  // A single order never gets the multi-stop route wrapper.
  await expect(driver.getByTestId("driver-route-current-stop")).toHaveCount(0);
  await expect(driver.getByTestId("driver-primary-action")).toHaveText("Yo‘lga chiqdim");
  await driver.getByTestId("driver-primary-action").click(); // ON_THE_WAY
  await expect(driver.getByTestId("driver-primary-action")).toHaveText("Yetib keldim");
  await driver.getByTestId("driver-primary-action").click(); // ARRIVED

  // Customer sees the arrival live, with no reload.
  await customer.goto(`/track/${orderId}`);
  await expect(customer.getByTestId("order-status")).toContainText("Yetib keldi", { timeout: 15000 });

  await expect(driver.getByTestId("driver-primary-action")).toHaveText("Yetkazildi");
  await driver.getByTestId("driver-primary-action").click(); // DELIVERED
  await expect(driver.locator(".assignment-card, .delivery-card")).toHaveCount(0);
  await expect(driver.getByTestId("driver-no-active")).toBeVisible({ timeout: 15000 });

  await driverContext.close();
  await customerContext.close();
  await staffContext.close();
});

test("scenario B: two compatible orders end to end -- capacity, second-order UI, wait-for-second, both-ready, multi-stop route, automatic stop promotion", async ({ browser }) => {
  const driverContext = await browser.newContext();
  const otherDriverContext = await browser.newContext();
  const customerAContext = await browser.newContext();
  const customerBContext = await browser.newContext();
  const staffContext = await browser.newContext();
  const driver = await driverContext.newPage();
  const otherDriver = await otherDriverContext.newPage();
  const customerA = await customerAContext.newPage();
  const customerB = await customerBContext.newPage();
  const staff = await staffContext.newPage();

  await takeOffShift(otherDriver, "998900000099");
  await otherDriverContext.close();
  await freeDriver(driver, "driver@zaytun.local");
  await signInStaff(staff);

  const orderIdA = await placeDeliveryOrder(customerA, "UX Batch Mijoz A", "+998907779102");
  await acceptOrder(staff, orderIdA);
  await expect(driver.locator(".assignment-card")).toBeVisible({ timeout: 15000 });
  await driver.getByTestId("driver-primary-action").click(); // accept A
  await expect(driver.getByTestId("driver-pre-ready-card")).toBeVisible();
  // Capacity: one active order, room for one more.
  await expect(driver.getByTestId("driver-capacity")).toContainText("1/2");

  const orderIdB = await placeDeliveryOrder(customerB, "UX Batch Mijoz B", "+998907779103");
  await acceptOrder(staff, orderIdB); // still under capacity, same branch, compatible -> joins the SAME driver

  // Production hotfix: before pickup, both orders render as ONE PICKUP
  // BATCH mission -- never "one full card for A + a tiny KEYINGI row for
  // B." B's own accept/decline live inside the SAME card as A, with the
  // same prominence, and the plain queue list is empty (no redundant
  // duplicate entry for a batch-mate).
  await expect(driver.getByTestId("driver-pickup-batch")).toBeVisible({ timeout: 15000 });
  await expect(driver.getByTestId("driver-batch-mission-header")).toContainText("2 TA BUYURTMA");
  await expect(driver.getByTestId("driver-batch-count")).toContainText("2/2 buyurtma");
  await expect(driver.getByTestId("driver-queue")).toHaveCount(0);
  await expect(driver.getByTestId(`driver-batch-accept-${orderIdB}`)).toBeVisible();
  await driver.getByTestId(`driver-batch-accept-${orderIdB}`).click();
  await expect(driver.getByTestId("driver-capacity")).toContainText("2/2");

  await readyOrder(staff, orderIdA);
  // One ready, the other still preparing -- the platform tells the driver
  // to wait, not the other way around.
  await expect(driver.getByTestId("driver-wait-for-second")).toBeVisible({ timeout: 15000 });
  await expect(driver.getByTestId("driver-both-ready")).toHaveCount(0);

  await readyOrder(staff, orderIdB);
  // Both ready -- strong, unambiguous pickup-both instruction.
  await expect(driver.getByTestId("driver-both-ready")).toBeVisible({ timeout: 15000 });
  await expect(driver.getByTestId("driver-primary-action")).toHaveText("2 TA BUYURTMANI OLDIM");
  await driver.getByTestId("driver-primary-action").click(); // picks up BOTH, sequentially

  // Now on route: current stop dominant, next stop secondary -- the
  // driver never chooses which order comes first, the server's own
  // deterministic stop_sequence decides.
  await expect(driver.getByTestId("driver-route-current-stop")).toBeVisible({ timeout: 15000 });
  await expect(driver.getByTestId("driver-route-next-stop")).toBeVisible();
  const firstStopLabel = await driver.getByTestId("driver-route-current-stop").locator("b").textContent();
  expect(firstStopLabel).toContain("1-manzil");

  // Production hotfix: the two batched orders must read as one delivery
  // mission with two stops, not an unrelated order plus a tiny row --
  // stop 2 gets a real summary (order number, district, street/house,
  // distance, expandable contents), never just a bare number.
  await expect(driver.getByTestId("driver-route-mission-header")).toContainText("2 TA BUYURTMA");
  const nextStop = driver.getByTestId("driver-route-next-stop");
  await expect(nextStop.locator("h3")).not.toBeEmpty(); // real order number, not blank
  await expect(nextStop).toContainText("KEYINGI");
  await expect(nextStop).toContainText("Navoiy shahri"); // district, not just the order number
  await expect(nextStop.getByTestId("driver-route-next-details")).toBeVisible();

  // Safety: stop 2 must never be independently actionable before stop 1
  // completes -- exactly one driver-primary-action on the whole page
  // (stop 1's), and it is not reachable from within the next-stop card.
  await expect(driver.getByTestId("driver-primary-action")).toHaveCount(1);
  await expect(nextStop.getByTestId("driver-primary-action")).toHaveCount(0);

  // Deliver stop 1 -- no refresh, the route automatically promotes stop 2.
  // Each click waits for its own expected label first (matches scenario
  // A's pattern) rather than firing 3 clicks back to back, which raced
  // the label update under full-suite load and intermittently landed a
  // click before the DOM had progressed to the next stage.
  await expect(driver.getByTestId("driver-primary-action")).toHaveText("Yo‘lga chiqdim");
  await driver.getByTestId("driver-primary-action").click(); // ON_THE_WAY
  await expect(driver.getByTestId("driver-primary-action")).toHaveText("Yetib keldim");
  await driver.getByTestId("driver-primary-action").click(); // ARRIVED
  await expect(driver.getByTestId("driver-primary-action")).toHaveText("Yetkazildi");
  await driver.getByTestId("driver-primary-action").click(); // DELIVERED
  await expect(driver.getByTestId("driver-route-next-stop")).toHaveCount(0, { timeout: 15000 }); // no longer a second stop -- it's now current
  await expect(driver.locator(".delivery-card, .assignment-card")).toHaveCount(1);

  // Deliver stop 2 -- batch completes, driver returns to available.
  await expect(driver.getByTestId("driver-primary-action")).toHaveText("Yo‘lga chiqdim");
  await driver.getByTestId("driver-primary-action").click(); // ON_THE_WAY
  await expect(driver.getByTestId("driver-primary-action")).toHaveText("Yetib keldim");
  await driver.getByTestId("driver-primary-action").click(); // ARRIVED
  await expect(driver.getByTestId("driver-primary-action")).toHaveText("Yetkazildi");
  await driver.getByTestId("driver-primary-action").click(); // DELIVERED
  await expect(driver.getByTestId("driver-all-stops-complete")).toBeVisible({ timeout: 15000 });
  await expect(driver.getByTestId("driver-no-active")).toBeVisible({ timeout: 15000 });

  await staff.goto(`/restaurant/orders/${orderIdA}`);
  await expect(staff.locator(".detail-head .badge")).toHaveText("Yetkazildi");
  await staff.goto(`/restaurant/orders/${orderIdB}`);
  await expect(staff.locator(".detail-head .badge")).toHaveText("Yetkazildi");

  await driverContext.close();
  await customerAContext.close();
  await customerBContext.close();
  await staffContext.close();
});

test("scenario C: a delayed second order is released while the driver is waiting -- the stale card disappears and the driver is told to leave with the ready one, with no reload", async ({ browser }) => {
  const driverContext = await browser.newContext();
  const otherDriverContext = await browser.newContext();
  const customerAContext = await browser.newContext();
  const customerBContext = await browser.newContext();
  const staffContext = await browser.newContext();
  const driver = await driverContext.newPage();
  const otherDriver = await otherDriverContext.newPage();
  const customerA = await customerAContext.newPage();
  const customerB = await customerBContext.newPage();
  const staff = await staffContext.newPage();

  await takeOffShift(otherDriver, "998900000099");
  await otherDriverContext.close();
  await freeDriver(driver, "driver@zaytun.local");
  await signInStaff(staff);

  const orderIdA = await placeDeliveryOrder(customerA, "UX Delay Mijoz A", "+998907779104");
  await acceptOrder(staff, orderIdA);
  await expect(driver.locator(".assignment-card")).toBeVisible({ timeout: 15000 });
  await driver.getByTestId("driver-primary-action").click(); // accept A

  const orderIdB = await placeDeliveryOrder(customerB, "UX Delay Mijoz B", "+998907779105");
  await acceptOrder(staff, orderIdB);
  await expect(driver.getByTestId(`driver-batch-accept-${orderIdB}`)).toBeVisible({ timeout: 15000 });
  await driver.getByTestId(`driver-batch-accept-${orderIdB}`).click();

  await readyOrder(staff, orderIdA);
  await expect(driver.getByTestId("driver-wait-for-second")).toBeVisible({ timeout: 15000 });

  // Force the actual-wait window to have already elapsed (local-only DB
  // backdate -- see the script's own comment; the real enforcement is
  // still the authoritative server-side evaluate_batch_actual_wait_internal,
  // triggered by the driver's own next PICKED_UP click below, not this
  // helper itself).
  const { execFileSync } = await import("node:child_process");
  execFileSync("node", ["scripts/e2e-backdate-batch-ready.mjs", "driver@zaytun.local", "30"]);

  // The wait screen re-evaluates the deadline live (no reload) and now
  // tells the driver they may leave with the ready order alone.
  await expect(driver.getByTestId("driver-leave-now")).toBeVisible({ timeout: 25000 });
  await expect(driver.getByTestId("driver-primary-action")).toHaveText("Buyurtmani oldim");
  await driver.getByTestId("driver-primary-action").click(); // PICKED_UP A -- this is what actually triggers the server release of B

  // B is released and redispatched -- the stale card disappears from A's
  // own driver page, with a brief explanation, no stale ownership, no
  // reload.
  await expect(driver.getByTestId("driver-second-order-released")).toBeVisible({ timeout: 15000 });
  await expect(driver.getByTestId("driver-queue")).toHaveCount(0);
  await expect(driver.getByTestId("driver-route-next-stop")).toHaveCount(0);

  // B itself is safely back to searching for a driver, not lost.
  await staff.goto(`/restaurant/orders/${orderIdB}`);
  await expect(staff.getByTestId("early-assignment-hint")).toHaveCount(0);

  await driverContext.close();
  await customerAContext.close();
  await customerBContext.close();
  await staffContext.close();
});

test("scenario E: a second order that auto-assigns to the same driver OUTSIDE any batch -- via the READY-time fallback sweep, not early dispatch -- must render as its own full card, never only in a passive list", async ({ browser }) => {
  test.setTimeout(60000);
  // Invariant: any active assignment that belongs to the logged-in driver
  // and has not been picked up must appear in the primary panel
  // immediately, regardless of whether it happens to share a pickup
  // batch with another active assignment. This is a REAL, fully
  // automatic path, not just a manual-assignment edge case:
  // select_best_driver_internal (the READY-time fallback used when an
  // order reaches READY with no driver, e.g. because early dispatch
  // found the driver's ready-time incompatible) has no batch-gap check
  // at all -- only capacity -- so it can freely hand a driver who
  // already holds one (possibly batched) order a second, wholly
  // unrelated one via assign_driver_internal, which never sets
  // pickup_batch_id. The driver frontend must not silently demote that
  // second, genuinely active assignment to a "KEYINGI" row.
  const driverContext = await browser.newContext();
  const otherDriverContext = await browser.newContext();
  const customerAContext = await browser.newContext();
  const customerCContext = await browser.newContext();
  const staffContext = await browser.newContext();
  const driver = await driverContext.newPage();
  const otherDriver = await otherDriverContext.newPage();
  const customerA = await customerAContext.newPage();
  const customerC = await customerCContext.newPage();
  const staff = await staffContext.newPage();

  await takeOffShift(otherDriver, "998900000099");
  await otherDriverContext.close();
  await freeDriver(driver, "driver@zaytun.local");
  await signInStaff(staff);

  const orderIdA = await placeDeliveryOrder(customerA, "UX Unbatched A", "+998907779108");
  await staff.goto(`/restaurant/orders/${orderIdA}`);
  await staff.getByTestId("approve-delivery").click();
  await staff.getByTestId("action-confirm").click(); // real assignment at ACCEPT, driver is idle so this is a normal early pick
  // Push A's estimated-ready time far out, so a fresh order C (default
  // ~25 min estimate) will fall well outside the batch compatibility
  // window the moment C is confirmed -- deterministic, no real waiting.
  await staff.getByLabel("Taxminiy tayyorlash vaqti").fill("90");
  await staff.getByTestId("action-set-estimate").click();
  await expect(driver.locator(".assignment-card")).toBeVisible({ timeout: 15000 });
  await driver.getByTestId("driver-primary-action").click(); // accept A

  const orderIdC = await placeDeliveryOrder(customerC, "UX Unbatched C", "+998907779110");
  await staff.goto(`/restaurant/orders/${orderIdC}`);
  await staff.getByTestId("approve-delivery").click();
  await expect(staff.getByTestId("action-confirm")).toBeVisible();
  await staff.getByTestId("action-confirm").click(); // early dispatch for C fails (gap >> compatibility window) -- driver is the only eligible one, so C gets no driver yet
  await expect(staff.locator(".detail-head .badge")).toHaveText("Tasdiqlandi", { timeout: 15000 });
  await expect(driver.getByTestId("driver-pre-ready-card")).toBeVisible({ timeout: 15000 }); // A's own card, unaffected
  await expect(driver.getByTestId("driver-pickup-batch")).toHaveCount(0); // C is NOT batched with A

  // C reaches READY with assigned_driver_id still null -- the READY-time
  // fallback sweep (select_best_driver_internal, capacity-only) now picks
  // up the SAME driver (1/2 capacity used), outside any batch.
  await readyOrder(staff, orderIdC);

  // C must appear as its OWN full, prominent assignment card -- never
  // only as a small queue row -- immediately, with no reload.
  await expect(driver.getByTestId("driver-assignment-card")).toBeVisible({ timeout: 15000 });
  await expect(driver.getByTestId("driver-queue")).toHaveCount(0);
  await expect(driver.locator(".assignment-card, .delivery-card, .pre-ready-card")).toHaveCount(2); // A's card + C's card, both full
  await expect(driver.getByTestId("driver-capacity")).toContainText("2/2");

  // C is independently actionable -- accept it, then it has its own
  // primary action, unrelated to A's.
  await driver.getByTestId("driver-assignment-card").getByTestId("driver-primary-action").click(); // accept C
  await expect(driver.locator(".assignment-card, .delivery-card, .pre-ready-card")).toHaveCount(2);

  await driverContext.close();
  await customerAContext.close();
  await customerCContext.close();
  await staffContext.close();
});

test("scenario D: the second-assigned order becomes ready before the first -- wait/both-ready state must not depend on which order was assigned first", async ({ browser }) => {
  // Production hotfix regression: the wait/both-ready card used to be
  // driven only by the earlier-assigned order's own readiness. Live in
  // production (ZG-1067/ZG-1068), the SECOND-assigned order's kitchen
  // finished first -- and the driver never saw the meaningful "one ready,
  // one still cooking" wait card for that whole window, because the
  // component was keyed to the wrong order. This reproduces exactly that
  // ordering and asserts the wait/both-ready cards fire correctly
  // regardless of which order was assigned to the driver first.
  const driverContext = await browser.newContext();
  const otherDriverContext = await browser.newContext();
  const customerAContext = await browser.newContext();
  const customerBContext = await browser.newContext();
  const staffContext = await browser.newContext();
  const driver = await driverContext.newPage();
  const otherDriver = await otherDriverContext.newPage();
  const customerA = await customerAContext.newPage();
  const customerB = await customerBContext.newPage();
  const staff = await staffContext.newPage();

  await takeOffShift(otherDriver, "998900000099");
  await otherDriverContext.close();
  await freeDriver(driver, "driver@zaytun.local");
  await signInStaff(staff);

  const orderIdA = await placeDeliveryOrder(customerA, "UX Reversed Mijoz A", "+998907779106");
  await acceptOrder(staff, orderIdA);
  await expect(driver.locator(".assignment-card")).toBeVisible({ timeout: 15000 });
  await driver.getByTestId("driver-primary-action").click(); // accept A (assigned FIRST)

  const orderIdB = await placeDeliveryOrder(customerB, "UX Reversed Mijoz B", "+998907779107");
  await acceptOrder(staff, orderIdB);
  await expect(driver.getByTestId(`driver-batch-accept-${orderIdB}`)).toBeVisible({ timeout: 15000 });
  await driver.getByTestId(`driver-batch-accept-${orderIdB}`).click(); // accept B (assigned SECOND)

  // B (assigned second) becomes ready first -- A (assigned first) is
  // still cooking. The wait card must still appear -- this is the exact
  // ordering the old "current-order-only" logic missed.
  await readyOrder(staff, orderIdB);
  await expect(driver.getByTestId("driver-wait-for-second")).toBeVisible({ timeout: 15000 });
  await expect(driver.getByTestId("driver-both-ready")).toHaveCount(0);
  await expect(driver.getByTestId("driver-primary-action")).toContainText("Faqat");

  await readyOrder(staff, orderIdA);
  await expect(driver.getByTestId("driver-both-ready")).toBeVisible({ timeout: 15000 });
  await expect(driver.getByTestId("driver-primary-action")).toHaveText("2 TA BUYURTMANI OLDIM");
  await driver.getByTestId("driver-primary-action").click(); // picks up BOTH

  await expect(driver.getByTestId("driver-route-current-stop")).toBeVisible({ timeout: 15000 });
  await expect(driver.getByTestId("driver-route-next-stop")).toBeVisible();

  await driverContext.close();
  await customerAContext.close();
  await customerBContext.close();
  await staffContext.close();
});
