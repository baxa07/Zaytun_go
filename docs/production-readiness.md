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
- **Sender/alpha-name**: ZAYTUN's own alpha-name approval has been submitted to Eskiz. A follow-up request to correct the alpha-name's capitalization (`Zaytun` → `ZAYTUN`) has been forwarded by Eskiz support to the appropriate internal department and **remains pending** — the alpha-name is not approved for production OTP as of this writing. **Eskiz support has explicitly confirmed** that, until alpha-name approval finishes, Zaytun Go may send service OTP SMS through Eskiz's shared sender `"4546"`. This makes `4546` a **support-confirmed temporary sender**, not a permanent one — it is expected to be replaced by the `ZAYTUN` alpha-name once that approval completes, and this doc should be revisited when it does. `ESKIZ_SENDER` must remain environment-driven (an Edge Function secret, set via `supabase secrets set`) — `4546` is never to be hard-coded into source regardless of this confirmation.
- **OTP template moderation — operational prerequisite before any production send**: Eskiz requires SMS text templates to be submitted for moderation via their dashboard (`SMS → Мои тексты`, per Eskiz's own `Инструкция по добавлению текстов для модерации`) before they can be used for production sending, independent of sender/alpha-name approval. The exact `formatOtpMessage` output below must be submitted through that flow and approved there before `ESKIZ_SENDER` is ever configured in production — this is a separate gate from both the alpha-name approval and the credential-rotation blocker noted further down.
- **OTP message format**: `formatOtpMessage` (`supabase/functions/send-sms-hook/message.ts`) produces exactly `ZAYTUN GO ilovasi uchun kirish kodi: <otp>`. This wording follows Eskiz support's own operator-template guidance — their earlier-reviewed short form (`ZAYTUN GO kodi: <otp>`) was flagged as incomplete and at risk of rejection by mobile operators; their recommended example format is `<app name> ilovasi uchun kirish kodi: <otp>`. The six-digit `<otp>` is interpolated verbatim from Supabase's own `sms.otp` hook payload field — this function never generates or verifies an OTP itself, only formats the one Supabase already produced.
- **Per-SMS operator pricing (Eskiz support-provided rates, not hard-coded business logic)**: Eskiz support provided the following current per-SMS rates by destination operator. These are informational/planning figures from Eskiz, not values encoded anywhere in this codebase, and are subject to change without notice from Eskiz's side:

  | Operator | UZS/SMS |
  | --- | --- |
  | Mobiuz | 110 |
  | Beeline | 160 |
  | Ucell | 160 |
  | Humans | 95 |
  | Uzmobile | 145 |
  | Perfectum | 110 |

  Separately, Eskiz support noted that **Beeline/Ucell/Uzmobile alpha-name subscriptions are recurring monthly charges**, billed whenever the Eskiz account balance is sufficient to cover them — this is distinct from the per-SMS send price above and is an ongoing cost consideration independent of traffic volume.
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
  8. The real sender choice (ZAYTUN alpha-name, or an Eskiz-confirmed interim sender such as the current `4546` — never an unconfirmed guess) has been approved for that value.
  9. The exact OTP message text (`formatOtpMessage`'s output) has been submitted for and approved through Eskiz's moderation flow (`SMS → Мои тексты`) — a separate gate from sender/alpha-name approval, per Eskiz's own template-moderation requirement.

  Production configuration is its own separate, explicit release gate — never a side effect of a local config-plumbing or dependency change on this branch.
- **Local testing**: `[auth.sms.test_otp]` (fixed local OTP fixtures) takes priority over the hook — confirmed empirically (Supabase-backed Playwright suite passes with the hook enabled locally, and the hook's own request log shows zero invocations for `test_otp`-covered numbers across the full suite run). Real Eskiz is never called by local or CI tests; a fake/injectable provider is used for the Edge Function's own Deno test suite (`supabase/functions/send-sms-hook/*.test.ts`).
- **CAPTCHA**: frontend is built (see the dedicated section below) but **not enabled on hosted Auth**. Ordering matters — CAPTCHA (`signInWithOtp`'s `captchaToken` option) is verified by Supabase Auth *before* it invokes the Send SMS Hook, so the two are independent and compatible; CAPTCHA should still be enabled before any real customer OTP traffic to control SMS-pumping risk.
- **Do not enable** Phone Auth, configure real Eskiz secrets, or flip `customer_auth_required` until: the alpha-name (or a confirmed-acceptable interim sender) is settled with Eskiz, the exposed credential is rotated, and CAPTCHA + rate limits have been deliberately reviewed (not left at Supabase's generic defaults).

## Customer OTP CAPTCHA + abuse protection

**Not live.** Frontend integration is built and locally/recovery-validated; nothing below is applied to hosted Auth yet — same separate release gate as the Eskiz section above.

- **Provider**: [Cloudflare Turnstile](https://developers.cloudflare.com/turnstile/), not hCaptcha. Both are Supabase-supported. Turnstile's free tier includes unlimited requests *and* all three widget modes (Managed, Non-interactive, fully Invisible) — confirmed via Cloudflare's own 2026 pricing announcement ("unlimited managed, non-interactive and invisible challenges" on the free plan). hCaptcha reserves its equivalent low-friction "Passive Mode" for Pro ($99–139/mo) and Enterprise tiers — its free tier is the more visible/higher-friction option, a worse fit for a small single-restaurant checkout. Turnstile's official test sitekeys also work directly on `localhost`/`127.0.0.1` with no hosts-file workaround; hCaptcha's test-key docs explicitly warn against `localhost` and require mapping a fake domain in `/etc/hosts`, which would have made local/CI testing meaningfully more awkward.
- **Frontend**: `src/components/TurnstileWidget.tsx` — a small wrapper around Cloudflare's official `challenges.cloudflare.com/turnstile/v0/api.js` script (loaded once, module-level singleton promise). No new npm dependency added. Rendered inline inside the existing checkout OTP step (`otp-step` section in `src/App.tsx`), shared across both the "phone" and "code" screens so it also covers the resend button — no route change, no loss of cart/address/payment state (same inline-step architecture as the rest of Phase 2). Gates only `signInWithOtp` (the send); `verifyOtp` is unchanged. The resulting token is forwarded once via `state.tsx`'s `sendCustomerOtp(phone, captchaToken)` as `options: { captchaToken }`, and is cleared (with the widget remounted via a `key` bump) after every send attempt, success or failure, since Turnstile tokens are single-use. If `VITE_TURNSTILE_SITE_KEY` is unset, the send button is disabled outright with a clear Uzbek message rather than silently sending without a token.
- **Errors**: GoTrue's stable `captcha_failed` error code (covers both an invalid and an expired-but-submitted token) maps to a clean Uzbek message in `mapCustomerAuthError`. Widget-level failures the frontend detects itself — token expired before use, or the Cloudflare script failing to load — get their own inline Uzbec messages without ever reaching the server.
- **No CAPTCHA in today's production checkout**: the widget only renders inside the OTP step, which itself only ever opens when `customer_auth_required=true` *and* the customer isn't yet verified — both false in production today — so this is true by construction, not a separate check.
- **Local/CI testing**: `.env.local` and `playwright.auth.config.ts` both set `VITE_TURNSTILE_SITE_KEY` to `1x00000000000000000000BB` — Cloudflare's public, official, always-pass **invisible** test sitekey (see [Cloudflare's testing docs](https://developers.cloudflare.com/turnstile/troubleshooting/testing/)) — not a secret, safe on any domain. This exercises the real widget end-to-end (script load, invisible challenge, callback, token forwarding) with zero human interaction and zero Cloudflare account. Confirmed: the full Supabase-backed customer-OTP Playwright suite passes with the real widget active (send/resend now take a few seconds longer, corresponding to the real background challenge completing), and `[auth.sms.test_otp]` still bypasses the Send SMS Hook entirely regardless (hook request log unchanged, zero invocations). **Not yet done**: the real production Turnstile sitekey/secret pair (a real Cloudflare account + domain registration) — that's part of the future hosted release gate, not this branch.

### Proposed production rate-limit / expiry values (design only — not applied)

Corrected against a fresh re-read of the current [official rate-limits docs](https://supabase.com/docs/guides/auth/rate-limits), the Management API's `UpdateAuthConfigBody` schema, and this project's own `supabase/config.toml` comments (not memory). Values below are launch **starting** values for a single-restaurant MVP, not a final tuned state — re-tune once real order volume is observed.

| Setting | Production current (confirmed, read-only) | Supabase-documented default | Proposed | Basis |
|---|---|---|---|---|
| OTP expiry (`sms_otp_exp`) | **60s** | not located in currently-fetched docs (not asserted as "the default" here — only confirmed as this project's current value) | **300s (5 min)** | 60s is tight for a person reading an SMS and typing 6 digits on a weak signal. 5 minutes is a common, still-tight norm. |
| Same-phone resend window (`sms_max_frequency`) | **5s** | **60s** — official docs: "Defaults to 60 seconds window before a new request is allowed to the same user" | **60s** | This project's current 5s is **not** the Supabase default — it's more permissive than Supabase's own stated default, confirmed via the current docs page. Proposing 60s aligns with Supabase's own default, not an arbitrary new number. |
| Aggregate SMS send limit (`rate_limit_sms_sent`, project-wide/hour) | **30** | **30/hour** — official docs: "Send One-Time-Passwords (OTP)... Defaults to 30 OTPs per hour" | **60** | 30/hour shared across *all* customers risks blocking a legitimate busy dinner service. Using Eskiz support's own per-operator rates above (95–160 UZS/SMS, see the pricing table in the Eskiz transport section), 60/hour bounds worst-case abuse spend to roughly 5,700–9,600 UZS/hour if abuse leaks past CAPTCHA, depending on the mix of destination operators — tolerable for MVP, **must be re-tuned once real volume is observed**, not treated as final. `rate_limit_sms_sent` is the field this project's own `config.toml` documents as "Number of SMS messages that can be sent per hour" — the one with a clear, sourced match to the docs' aggregate `/otp` row. |
| OTP verification limit (`rate_limit_verify`) | **30** (per `config.toml`'s own comment: 5-minute window, per IP) | **AMBIGUOUS — see below** | **KEEP CURRENT / DO NOT CHANGE YET** | See the discrepancy writeup below. Not enough confirmed information to propose a specific number responsibly. |
| Anonymous sign-in limit (`rate_limit_anonymous_users`) | 30 | 30 | **unchanged (moot)** | `enable_anonymous_sign_ins=false` on this project (confirmed Phase 3A) — no live attack surface regardless of value. |
| Sign-in/signup IP limit (local config name: `sign_in_sign_ups`, covers every phone-OTP sign-in attempt) | not confirmed settable via Management API — see below | 30/5min per IP, per `config.toml`'s own comment | **no aggressive reduction for MVP** | Uzbek mobile carriers commonly use CGNAT, so unrelated customers can share one public IP; tightening this risks blocking innocent bystanders behind the same carrier IP as someone else's order. |

**`rate_limit_verify` — genuine, unresolved doc/API discrepancy, not guessed away.** The current official rate-limits docs table lists `/auth/v1/verify` as: `IP Address` limited, **"No"** under Customizable, **"360 requests per hour (with bursts up to 30 requests)"** as the value. But this project's own `supabase/config.toml` documents a field with the exact same apparent purpose — `auth.rate_limit.token_verifications`, comment: *"Number of OTP / Magic link verifications that can be made in a 5 minute interval per IP address"* — as an ordinary, settable value (currently `30`), and the Management API's `UpdateAuthConfigBody` schema exposes the equivalent `rate_limit_verify` as a plain writable integer (production's current value: `30`) with no field description distinguishing it from the docs' fixed limit. Two real possibilities, neither confirmed from available sources: (a) the docs' 360/hr-with-burst figure is a separate, non-customizable platform/gateway-level limit that sits in front of a genuinely-customizable GoTrue-level `rate_limit_verify`, or (b) the docs table is simply stale relative to the current schema. Re-inspected the installed CLI (`2.111.0`), the live Management API schema, and both recovery's and production's actual configured values — none resolve which is true. **Do not tune `rate_limit_verify` based on this document until Supabase support confirms the relationship.**

Separately, `rate_limit_sign_in_sign_ups` (the Management API name one would expect by analogy with the other `rate_limit_*` fields) **does not appear in the current `UpdateAuthConfigBody` schema at all** — confirmed by listing every property containing "rate" or "sign" in the fetched schema. Whether `config.toml`'s local-only `sign_in_sign_ups` setting has any hosted-project equivalent, and under what name, is unconfirmed — flagging rather than guessing.

None of these values have been changed on any hosted project. Applying them (Dashboard → Authentication → Rate Limits, and the CAPTCHA toggle) is part of the same future explicit production release gate as Eskiz/Phone Auth activation.

## Real delivery pilot checklist

Verified: exact entrance pin `40.087274, 65.402551` and default zoom `17`. Owner still verifies and signs off: written address; service radius; minimum subtotal; base fee; free threshold; hours; phone; payment methods; expected preparation time; expected delivery time; named admin/dispatcher/drivers; customer privacy handling; incident owner.

Perform witnessed scenarios: address next to the restaurant; apartment with entrance/floor/unit; landmark-dependent address; radius edge; outside radius; wrong pin corrected and reconfirmed; map unavailable with manual details retained (delivery still requires a confirmed pin); customer not answering; no available driver; restaurant rejection; cancellation; driver payment/address issue; failed delivery and return.

## Production smoke gate

Use [production-smoke-test.md](production-smoke-test.md). Do not accept pilot orders until database rules, browser behavior, the real entrance coordinate, navigation links and rollback contacts pass on the final domain.
