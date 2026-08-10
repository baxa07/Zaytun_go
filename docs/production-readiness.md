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

### Hosted default-ACL exposure — read before writing any new table or function

Every hosted project (production, and recovery since it's restored from a production backup) carries broad default-privilege (`ALTER DEFAULT PRIVILEGES`) rules that are **not set by any migration** — confirmed by a full-history `git log -S"ALTER DEFAULT PRIVILEGES" --all` search across every branch, which finds no such statement ever committed. They exist only as an out-of-band configuration on the hosted project (set once, directly, outside version control) and auto-grant broad privileges — full `INSERT`/`SELECT`/`UPDATE`/`DELETE` on every new **table**, `EXECUTE` on every new **function**, and `SELECT`/`UPDATE`/`USAGE` on every new **sequence** — to `anon`, `authenticated`, and `service_role`, for every object subsequently created by the `postgres` role (the role migrations run as).

Inspect it directly (read-only) with:

```sql
select defaclrole::regrole, defaclnamespace::regnamespace, defaclobjtype, defaclacl
from pg_default_acl where defaclnamespace = 'public'::regnamespace;
```

**Recovery reproduces this exactly** (confirmed identical `postgres`-owned rows, since recovery is restored from a real production backup, which carries this database-level state). **Local `supabase start`/`db reset` does not** (local's `postgres`-owned defaults are weaker on tables/sequences and entirely absent for functions, since a from-scratch migration replay never sets it). This means local testing — however thorough — is not evidence that a new table or function is actually locked down; only recovery or production are.

**Rule for every new table or function**: explicitly `revoke all/execute ... from public, anon, authenticated, service_role` immediately after creation, then selectively `grant` back only what's intended. `revoke ... from public` alone is insufficient — it only revokes the implicit `PUBLIC` pseudo-role grant, not the explicit named-role grants this default-ACL rule creates (this exact gap caused a real incident: `calculate_delivery_quote_internal`, fixed in `20260809160000_restrict_internal_delivery_quote_execute.sql`). Never infer an object is safe from local behavior alone — verify against recovery (or, for a read-only privilege check, directly against production) before trusting a new grant.

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

## Customer phone-OTP SMS transport (Eskiz)

**Not live.** Phone Auth remains disabled on production; this section documents the transport design for when it is eventually enabled, and the open items that gate that.

- **Provider decision**: Eskiz.uz is the primary SMS provider (Uzbekistan-native, per-SMS domestic pricing). Twilio remains a documented, unconfigured fallback option only — no Twilio credentials exist on this project.
- **Architecture**: Supabase Auth remains the sole generator and verifier of the OTP itself — `signInWithOtp`/`verifyOtp` on the frontend are unchanged. A Supabase [Send SMS Hook](https://supabase.com/docs/guides/auth/auth-hooks/send-sms-hook) (`[auth.hook.send_sms]`) routes the SMS *text delivery only* through a dedicated Edge Function (`supabase/functions/send-sms-hook`), which calls Eskiz's `/api/message/sms/send`. Eskiz never sees or generates an OTP value on its own — it only relays the six-digit code Supabase already produced.
- **Required server-side secrets** (Edge Function env, never the browser, never committed — see `supabase/functions/.env.example` for names only): `SEND_SMS_HOOK_SECRETS` (Supabase Standard Webhooks signing secret), `ESKIZ_EMAIL`, `ESKIZ_PASSWORD`, `ESKIZ_SENDER`. The function fails closed (500, no SMS attempt) if any is missing — the production sender is never silently defaulted.
- **Sender/alpha-name**: ZAYTUN's own alpha-name approval has been submitted to Eskiz and is pending (Eskiz's public docs cite 1–2 months for operator approval). Whether Eskiz's shared default/test sender (`"4546"`, seen consistently across Eskiz's own API examples) is acceptable for *production* OTP traffic — as opposed to the free testing allotment — is **still awaiting Eskiz support's confirmation**. Do not set `ESKIZ_SENDER=4546` in production until that's confirmed.
- **Credential rotation — blocker before any real integration**: an Eskiz API secret was exposed in a screenshot during this project's planning. That credential must be treated as compromised and is never to be used. Before Phone Auth is ever enabled with real Eskiz credentials, rotate the Eskiz account credential and place only the replacement directly into server-side secrets (Supabase Edge Function secrets) — never into source, chat, or a screenshot.
- **Hook URI is never hard-coded**: `[auth.hook.send_sms].uri` in `supabase/config.toml` reads `env(SEND_SMS_HOOK_URI)` — it is not a literal URL in tracked source. Locally this resolves to `http://host.docker.internal:54321/functions/v1/send-sms-hook`; if the variable is unset, `supabase start`/`stop`/`db reset` fail loudly with a config-validation error rather than silently defaulting to any URL (confirmed empirically — there is no automatic production or `4546` fallback of any kind).

  **`supabase config push` safety gate — do not skip any item.** `config push` applies `supabase/config.toml` verbatim to whichever project the CLI is currently linked to, including the SMS-hook wiring. Never run it for the SMS-hook rollout unless every one of the following has been explicitly, freshly verified immediately beforehand, in the same sitting:
  1. The linked project ref (`supabase/.temp/project-ref` or `supabase projects list` / `supabase status`) is the intended target — not recovery, not a stale link from a previous task.
  2. `SEND_SMS_HOOK_URI` is set to the exact hosted Edge Function URL for *that* project (not a value copied from another project or from this doc).
  3. That URL is HTTPS.
  4. That URL is not `localhost`, `127.0.0.1`, or `host.docker.internal` — any of those in a value about to be pushed to a hosted project means the wrong value is loaded.
  5. `SEND_SMS_HOOK_SECRETS` is the *current* hook signing secret for that project (rotate it and this together if either is ever suspected exposed — a stale secret here means Standard Webhooks verification will reject GoTrue's own real requests).
  6. The `send-sms-hook` Edge Function is already deployed to that project (`supabase functions deploy send-sms-hook` there first — `config push` wires the hook to a URL, it does not deploy the function behind it).
  7. `ESKIZ_EMAIL`/`ESKIZ_PASSWORD`/`ESKIZ_SENDER` already exist as that project's Edge Function secrets (`supabase secrets set`, scoped to that project only).
  8. The real sender choice (ZAYTUN alpha-name, or an Eskiz-confirmed interim sender — never an unconfirmed guess) has been approved for that value.

  Production configuration is its own separate, explicit release gate — never a side effect of a local config-plumbing or dependency change on this branch.
- **Local testing**: `[auth.sms.test_otp]` (fixed local OTP fixtures) takes priority over the hook — confirmed empirically (Supabase-backed Playwright suite passes with the hook enabled locally, and the hook's own request log shows zero invocations for `test_otp`-covered numbers across the full suite run). Real Eskiz is never called by local or CI tests; a fake/injectable provider is used for the Edge Function's own Deno test suite (`supabase/functions/send-sms-hook/*.test.ts`).
- **CAPTCHA**: not yet enabled (see the Phase 3A SMS-abuse-protection findings). Ordering matters — CAPTCHA (`signInWithOtp`'s `captchaToken` option) is verified by Supabase Auth *before* it invokes the Send SMS Hook, so the two are independent and compatible; CAPTCHA should still be enabled before any real customer OTP traffic to control SMS-pumping risk.
- **Do not enable** Phone Auth, configure real Eskiz secrets, or flip `customer_auth_required` until: the alpha-name (or a confirmed-acceptable interim sender) is settled with Eskiz, the exposed credential is rotated, and CAPTCHA + rate limits have been deliberately reviewed (not left at Supabase's generic defaults).

## Real delivery pilot checklist

Verified: exact entrance pin `40.087274, 65.402551` and default zoom `17`. Owner still verifies and signs off: written address; service radius; minimum subtotal; base fee; free threshold; hours; phone; payment methods; expected preparation time; expected delivery time; named admin/dispatcher/drivers; customer privacy handling; incident owner.

Perform witnessed scenarios: address next to the restaurant; apartment with entrance/floor/unit; landmark-dependent address; radius edge; outside radius; wrong pin corrected and reconfirmed; map unavailable with manual details retained (delivery still requires a confirmed pin); customer not answering; no available driver; restaurant rejection; cancellation; driver payment/address issue; failed delivery and return.

## Production smoke gate

Use [production-smoke-test.md](production-smoke-test.md). Do not accept pilot orders until database rules, browser behavior, the real entrance coordinate, navigation links and rollback contacts pass on the final domain.
