# ZAYTUN GO production pilot runbook

This runbook prepares a pilot; it does not authorize a deployment. The entrance coordinates `40.087274, 65.402551` and zoom `17` are owner-verified; development contacts, accounts, address text and prices are not production values.

## Configuration authority

| Setting | Public UI source | Authoritative source |
| --- | --- | --- |
| Restaurant name, address, phone, hours and time estimates | `get_public_restaurant_config()` | `delivery_settings` |
| Restaurant coordinates and map zoom | public config; Vite coordinates are map-load defaults only | `delivery_settings` for delivery eligibility |
| Delivery enabled, radius, minimum subtotal, fee and free threshold | public config is an estimate | `delivery_settings` and `create_public_order()` |
| Maximum item quantity (1–50) and supported payment methods | public config controls the form | database triggers and `create_public_order()`; 50 is the security ceiling |
| Menu prices, modifiers and availability | public menu RPC | menu tables and `create_public_order()` |
| Map provider and browser API keys | validated Vite environment | deployment configuration/Yandex dashboard |

Never put a service-role key, database password or access token in a `VITE_` variable. Every `VITE_` value is public and can be present in built JavaScript.

## Required production environment

Copy variable names from `.env.example` into the hosting dashboard. Set `VITE_DATA_PROVIDER=supabase`, `VITE_MAP_PROVIDER=yandex`, an HTTPS `VITE_SUPABASE_URL`, a Supabase publishable key, three domain-restricted Yandex browser/service keys, the verified defaults `40.087274`, `65.402551`, zoom `17`, and the HTTPS public origin. Do not upload `.env.local`.

Run `npm run validate:production-env` in the build environment. It reports only presence and format, never values. `VITE_SUPABASE_ANON_KEY` remains accepted temporarily as the legacy public-key name; new deployments should use `VITE_SUPABASE_PUBLISHABLE_KEY`. `VITE_YANDEX_GEOCODER_API_KEY` is obsolete and makes validation fail.

## Supabase project and migrations

The owner creates the production project manually and records its project reference and database credentials only in a password manager or CI secret store.

1. Confirm the CLI login belongs to the intended organization with `supabase projects list`.
2. From this repository run `supabase link --project-ref <production-reference>`. The generated `.supabase`/`.temp` state must remain ignored.
3. Compare history with `supabase migration list --linked`. Resolve unexpected remote migrations before continuing.
4. Run `supabase db lint --linked --level warning` and review every finding.
5. Test a clean `supabase db reset` and `supabase test db` against local/isolated Supabase. Never reset production.
6. Create a production database backup or point-in-time recovery checkpoint. Record the responsible operator and recovery test.
7. Preview with `supabase db push --linked --dry-run`, review the exact migration list, then use `supabase db push --linked` in a scheduled window.
8. Verify grants, RLS, public RPCs, staff roles, Realtime and smoke tests below.

Rollback is forward-only: restore from the pre-change backup for a severe data problem, or add a reviewed corrective migration. Never edit already-applied migration history and never use `db reset` on production.

## Development seeds and staff bootstrap

`supabase/seed.sql` is local development data. It contains predictable test identities, mock orders and placeholder customer/location data. Do not run it against production and do not reuse its passwords or email addresses.

Staff signup must stay closed. For each person, an authorized owner creates the Auth user in the Supabase dashboard with a unique real email and temporary random password, requires a reset, copies the generated user UUID, and performs the following in the SQL editor after replacing placeholders:

```sql
begin;
insert into public.profiles (id, display_name, role)
values ('<auth-user-uuid>', '<person name>', '<RESTAURANT|DISPATCHER|DRIVER>');

-- Driver only: use the same Auth UUID for direct RLS ownership.
insert into public.drivers (id, phone, vehicle, availability)
values ('<auth-user-uuid>', '<verified phone>', '<vehicle description>', 'AVAILABLE');
commit;
```

An ordinary browser user cannot assign roles because profile/driver writes are protected by grants and RLS. To remove access, first disable the Auth user, then remove active assignments safely, mark the driver unavailable if relevant, and delete or archive the profile under an audited administrator procedure. Rotate temporary credentials immediately and after any suspected exposure.

## Restaurant setup (owner decisions)

The production bootstrap migration creates the verified restaurant configuration when the table is empty and updates the deterministic singleton `id=true` when it already exists. Because the current eligibility engine is radius-based, it records the verified “Navoiy shahri” policy but leaves delivery disabled and the radius null until the owner approves an enforceable radius or a separately reviewed city-boundary implementation. It does not create menu, user, driver, order, or customer records. Use [production-menu-template.md](production-menu-template.md) for the later owner-approved menu import.

Bootstrapped facts are: `Zaytun Kafe`; `Guliston mavzesi 649, Navoiy shahri`; `+998507440005`; entrance `40.087274, 65.402551`; zoom `17`; daily hours `10:00–00:00`; minimum order `100000` UZS; delivery fee `0`; and `CASH` as the only active payment method. Click and Payme remain unavailable until real payment integrations and their operational settlement procedures are implemented. Fixed preparation and delivery estimates are null because timing is product- and location-dependent; the UI states this instead of inventing minutes.

Update the single `delivery_settings` row through an authenticated SQL-editor/operator session; migration history must not be edited:

```sql
update public.delivery_settings set
  restaurant_display_name = '<OWNER VERIFY>',
  restaurant_address = '<OWNER VERIFY>',
  restaurant_phone = '<OWNER VERIFY>',
  restaurant_latitude = 40.087274,
  restaurant_longitude = 65.402551,
  default_map_zoom = 17,
  operating_hours = '<OWNER VERIFY JSON>'::jsonb,
  delivery_enabled = <OWNER_VERIFY_BOOLEAN>,
  maximum_delivery_radius_km = <OWNER_VERIFY_KM>,
  minimum_delivery_order = <OWNER_VERIFY_UZS>,
  base_delivery_fee = <OWNER_VERIFY_UZS>,
  free_delivery_threshold = <OWNER_VERIFY_UZS_OR_NULL>,
  maximum_item_quantity = <OWNER_VERIFY_QUANTITY>,
  supported_payment_methods = array['CASH']::public.payment_method[],
  estimated_preparation_minutes = <OWNER_VERIFY_MINUTES>,
  estimated_delivery_minutes = <OWNER_VERIFY_MINUTES>,
  updated_at = now()
where id = true;
```

The owner verified the customer-reachable restaurant entrance coordinate as `40.087274, 65.402551` with zoom `17` on 2026-08-04. The written address, phone, hours, service radius, minimum order, fees, payment methods and time estimates remain owner decisions. Straight-line distance is not road distance; perform edge-of-zone road tests before opening orders.

## Hosting and external dashboards

- Build: `npm run build:production`; publish directory: `dist`.
- Configure an SPA fallback from non-file routes to `/index.html` while serving real assets normally.
- Require HTTPS and the final custom domain. Add that exact origin and intended preview origins to Supabase Auth site/redirect URLs; allow only required origins.
- Restrict Yandex keys to the approved HTTPS production domains and verify HTTP Referer rules. Never use unrestricted production browser keys.
- The service worker caches only local static assets. It does not cache HTML navigation, Supabase/Yandex responses, or non-GET order requests. A waiting update shows a user-controlled reload action.
- Purge hosting/CDN HTML caches after deployment; hashed assets may be long-lived. Do not cache `index.html`, API responses, or service-worker files aggressively.

## Operational errors and monitoring

Customer-facing recovery text must not include raw database errors or payloads. Staff should receive authentication, Realtime and action-retry guidance. Browser development diagnostics may include error type/status but never tokens, keys or full secret-bearing URLs.

For the pilot, use Supabase project logs, hosting access/build logs, browser error reports collected by staff, and a manual incident log with time/order number/symptom/resolution. Agree on an on-call owner, response channel and retention/privacy policy. A paid monitoring vendor requires separate approval.

## Real delivery pilot checklist

Verified: exact entrance pin `40.087274, 65.402551` and default zoom `17`. Owner still verifies and signs off: written address; service radius; minimum subtotal; base fee; free threshold; hours; phone; payment methods; expected preparation time; expected delivery time; named admin/dispatcher/drivers; customer privacy handling; incident owner.

Perform witnessed scenarios: address next to the restaurant; apartment with entrance/floor/unit; landmark-dependent address; radius edge; outside radius; wrong pin corrected and reconfirmed; map unavailable with manual details retained (delivery still requires a confirmed pin); customer not answering; no available driver; restaurant rejection; cancellation; driver payment/address issue; failed delivery and return.

## Production smoke gate

Use [production-smoke-test.md](production-smoke-test.md). Do not accept pilot orders until database rules, browser behavior, the real entrance coordinate, navigation links and rollback contacts pass on the final domain.
