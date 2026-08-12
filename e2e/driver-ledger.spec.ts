import { execSync } from "node:child_process";
import { expect, test } from "@playwright/test";

const localPassword = "zaytun-local-2026";
// A dedicated, test-owned driver -- other specs in this same suite run
// against the same persistent local DB and also assign the shared seed
// drivers (...003/...004), so asserting an exact completed count against
// them would be a real cross-test race. This id is used by no other spec.
const driverId = "9f000000-0000-4000-8000-00000000ffff";

function psql(sql: string) {
  execSync(
    `PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -v ON_ERROR_STOP=1 -c ${JSON.stringify(sql)}`,
  );
}

test("H2 driver ledger: completed delivery is credited to the driver and visible in their detail ledger", async ({ page }) => {
  psql(
    `insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,created_at,updated_at,raw_app_meta_data,raw_user_meta_data,is_super_admin,confirmation_token,recovery_token,email_change_token_new,email_change,phone_change_token,email_change_token_current,reauthentication_token) values ('00000000-0000-0000-0000-000000000000','${driverId}','authenticated','authenticated','ledger-e2e-driver@zaytun.local',crypt('${localPassword}',gen_salt('bf')),now(),now(),now(),'{"provider":"email","providers":["email"]}','{}',false,'','','','','','','');` +
      `insert into profiles(id,role,display_name,phone) values ('${driverId}','DRIVER','Ledger E2E Driver','+998900009999');` +
      `insert into drivers(id,phone,vehicle,availability,shift_status,dispatch_status) values ('${driverId}','+998900009999','Test vehicle','AVAILABLE','ON_SHIFT','ACTIVE');`,
  );
  // A DELIVERY order (checkout defaults to DELIVERY) so it can carry a
  // real driver_assignments row -- the +136,000 so'm bump clears the
  // delivery minimum, same technique as delivery-timeline-and-driver-cleanup.spec.ts.
  await page.goto("/menu/chicken");
  await page.getByRole("button", { name: "+" }).click();
  await page.getByTestId("buy-now").click();
  await page.waitForURL("**/checkout");
  await page.getByLabel("Ism *").fill("Ledger Test Mijoz");
  await page.getByLabel("Telefon *").fill("+998907779800");
  await page.getByLabel("Mahalla yoki tuman *").fill("Guliston tumani");
  await page.getByLabel("Ko‘cha yoki joylashuv *").fill("Test ko‘chasi");
  await page.getByTestId("map-picker-set").click();
  await page.getByLabel("Kirish joyi xaritada to‘g‘ri belgilangan").check();
  await page.getByTestId("checkout-submit").click();
  await page.waitForURL("**/confirmation/**");
  const orderId = page.url().split("/confirmation/")[1];

  // Stand in for the not-yet-built Smart Dispatch Phase 6 decline/
  // reassignment RPC: a completed assignment, written directly, exactly
  // like the pgTAP suite does for the same reason.
  psql(
    `update orders set status='DELIVERED',delivery_review_status='APPROVED',assigned_driver_id='${driverId}' where id='${orderId}';` +
      `insert into driver_assignments(order_id,driver_id,assigned_at,accepted_at,ended_at,status) values ('${orderId}','${driverId}',now(),now(),now(),'COMPLETED');`,
  );

  await page.goto("/restaurant");
  await page.getByLabel("Telefon yoki email").fill("restaurant@zaytun.local");
  await page.getByLabel("Parol").fill(localPassword);
  await page.getByRole("button", { name: "Kirish" }).click();
  await expect(page.getByRole("button", { name: "Chiqish" })).toBeVisible();

  await page.getByRole("link", { name: "Haydovchilar", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Haydovchilar — yetkazish tarixi" })).toBeVisible();
  const summaryRow = page.getByTestId(`ledger-driver-${driverId}`);
  await expect(summaryRow).toContainText("Ledger E2E Driver");
  await expect(summaryRow.locator(".driver-ledger-stats span").first()).toHaveText("1 Bajarildi");

  await summaryRow.click();
  await expect(page.getByRole("heading", { name: "Ledger E2E Driver" })).toBeVisible();
  const entry = page.locator(`[data-testid^="ledger-entry-"]`).first();
  await expect(entry).toContainText("Bajarildi");
  await expect(entry).toContainText("Biriktirildi");
  await expect(entry).toContainText("Qabul qilindi");
  await expect(entry).toContainText("Yakunlandi");
});
