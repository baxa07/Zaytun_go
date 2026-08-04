# Local Supabase backend

Production setup, migration safety, staff bootstrap and deployment preparation are documented in [production-readiness.md](production-readiness.md). Everything below is local-development-only.

ZAYTUN GO uses the Supabase CLI stack locally. No hosted project or `supabase link` is required.

## Prerequisites and startup

Install Docker Desktop (or another Docker-compatible engine) and start it, then run:

```sh
npm install
npm run supabase:start
npm run supabase:reset
npm run supabase:status
```

Copy the local API URL and anon key printed by `supabase status` into an uncommitted `.env.local`:

```dotenv
VITE_DATA_PROVIDER=supabase
VITE_SUPABASE_URL=http://127.0.0.1:54321
VITE_SUPABASE_ANON_KEY=<local anon key>
VITE_MAP_PROVIDER=mock
VITE_YANDEX_MAPS_API_KEY=
VITE_YANDEX_SEARCH_API_KEY=
VITE_YANDEX_GEOSUGGEST_API_KEY=
VITE_DEFAULT_MAP_LAT=40.1039
VITE_DEFAULT_MAP_LNG=65.3688
VITE_DEFAULT_MAP_ZOOM=14
```

Run `npm run dev`. Local Auth accounts all use password `zaytun-local-2026`:

- `restaurant@zaytun.local`
- `dispatcher@zaytun.local`
- `driver@zaytun.local`

Mailpit is at `http://127.0.0.1:54324` and Studio is at `http://127.0.0.1:54323`.

## Database verification

```sh
npm run supabase:reset
npm run supabase:lint
npm run test:db
npm run test
npm run typecheck
npm run lint
npm run build
```

The SQL tests validate schema presence, legal and illegal transitions, delivery/pickup validation, database totals and events, RLS isolation, public menu access, Realtime publication, and seeded Auth roles.

## Security model

Customers remain anonymous. They submit through `create_order` and receive a random tracking token saved in their browser. `get_order_tracking` requires both the order ID and tracking token. Anonymous clients cannot list orders.

Restaurant, dispatcher, and driver users authenticate through Supabase Auth. `profiles.role` drives RLS. Staff can read operational data; drivers can only read orders assigned to their Auth user. Lifecycle changes, assignment, issue handling, and preparation estimates are transactional security-definer functions with fixed `search_path` values. Clients cannot directly mutate operational tables. Order events are append-only to API roles.

Realtime publishes orders, events, assignments, issues, and driver availability. RLS still controls which authenticated subscribers receive records.

## Production deployment later

Create a hosted Supabase project only when capacity is available. Do not edit the migrations for hosting. From a secure operator machine:

```sh
npx supabase login
npx supabase link --project-ref <project-ref>
npx supabase db push
```

Create production staff accounts through the Supabase dashboard or an audited server-side admin process, then insert their `profiles` and driver records. Do **not** run `supabase/seed.sql` in production because it contains local demonstration identities.

Set these frontend deployment variables in Netlify or Vercel:

- `VITE_DATA_PROVIDER=supabase`
- `VITE_SUPABASE_URL=https://<project-ref>.supabase.co`
- `VITE_SUPABASE_ANON_KEY=<hosted publishable/anon key>`
- `VITE_MAP_PROVIDER=yandex`
- `VITE_YANDEX_MAPS_API_KEY=<domain-restricted browser key>`
- `VITE_YANDEX_SEARCH_API_KEY=<domain-restricted Search API key>`
- `VITE_YANDEX_GEOSUGGEST_API_KEY=<domain-restricted Geosuggest API key>`
- `VITE_DEFAULT_MAP_LAT=<verified restaurant latitude>`
- `VITE_DEFAULT_MAP_LNG=<verified restaurant longitude>`
- `VITE_DEFAULT_MAP_ZOOM=<approved default zoom>`

Configure the hosted Auth Site URL and redirect allow-list for the production domain. Never expose the service-role key in Vite or browser code. If server-side administration is added later, store `SUPABASE_SERVICE_ROLE_KEY` only in protected server-function environment variables.

Local CLI credentials, `.env.local`, `.supabase`, Docker volumes, database files, and runtime containers are excluded from Git.

## Maps and delivery configuration

Yandex Maps JavaScript API v3 is the first production provider because it offers an embeddable map, marker interaction, search, and geocoding for the intended Uzbekistan workflow. See the official [JavaScript API v3](https://yandex.com/maps-api/docs/js-api/) and [Geocoder API](https://yandex.com/dev/geocode/doc/en/) documentation. All provider-specific loading and globals remain in `src/maps/yandex.ts`; checkout, restaurant, and driver code use typed provider-neutral map and navigation interfaces. `mock` is an explicit deterministic provider for local development, CI, unit tests, Playwright, and screenshots. Production never silently falls back from `yandex` to `mock`.

Create separate browser keys in the Yandex developer console for JavaScript API, Search API, and Geosuggest API, and restrict all three to approved production domains/referrers. The core script receives only the JavaScript API key. After `ymaps3.ready`, the adapter configures Search and Geosuggest through `ymaps3.getDefaultConfig().setApikeys`; it does not call Yandex REST geocoding endpoints directly. Set `VITE_MAP_PROVIDER=yandex` and all three restricted keys only in the deployment environment. Missing service configuration produces a visible service-specific error without disabling an already loaded map. Never place a Supabase service-role credential or an unrestricted secret in a Vite variable; all `VITE_*` values are browser-visible.

The development seed uses `40.1039, 65.3688` only as a clearly documented test centre. **These are not claimed to be Zaytun Cafe’s production coordinates.** Before a real delivery test, the project owner must verify the restaurant entrance coordinates and service radius in person. Update the active settings record after migrations are applied; do not edit migration history:

### Authoritative order pricing

Public checkout sends only menu-item IDs, quantities, selected modifier IDs, and instructions. `create_public_order` locks and reads the active menu and modifier rows, snapshots their names and combined unit prices into `order_items`, and calculates subtotal and total inside one database transaction. Client price, line-total, subtotal, delivery-fee, or grand-total fields are rejected. Historical order-item snapshots do not change when menu prices change.

The current delivery rule is server-authoritative straight-line radius pricing: pickup has no delivery fee and bypasses delivery minimum/radius checks; delivery must be enabled, meet the configured minimum order, and fall within `maximum_delivery_radius_km` using the Haversine distance from the configured restaurant coordinate. Delivery costs `base_delivery_fee` unless the authoritative subtotal meets `free_delivery_threshold`. Straight-line distance is not road or driving distance, so the owner must verify the real restaurant coordinate and choose a conservative service radius before production.

```sql
update public.delivery_settings
set restaurant_display_name = 'Zaytun Cafe',
    restaurant_latitude = <verified_latitude>,
    restaurant_longitude = <verified_longitude>,
    default_map_zoom = 14,
    delivery_enabled = true,
    maximum_delivery_radius_km = <approved_radius_km>,
    base_delivery_fee_uzs = <fee_in_integer_uzs>,
    free_delivery_threshold_uzs = <integer_uzs_or_null>,
    minimum_delivery_order_uzs = <integer_uzs>,
    updated_at = now()
where id = true;
```

The database is authoritative. It validates coordinate ranges, calculates haversine distance from the configured restaurant point, enforces delivery enabled/radius/minimum-order rules, calculates the delivery fee and final total, and preserves idempotent order creation. Pickup bypasses map and radius checks. Haversine distance is straight-line distance, not road distance, route duration, or traffic-aware pricing; the owner must verify that the configured radius produces an acceptable real service area.

Customer tracking intentionally omits exact coordinates, full private addresses, distance, provider metadata, restaurant settings, and driver identity/contact details. Operational restaurant and assigned-driver views expose coordinates only where needed. Navigation links are generated from validated numeric coordinates alone, open with `noopener noreferrer`, and offer Yandex Maps and Google Maps browser URLs. They do not include untrusted address text. A browser URL remains usable if a native map application is unavailable.

### Troubleshooting and production smoke test

- Blank or failed map: confirm `VITE_MAP_PROVIDER=yandex`, the API key, enabled API products, domain referrer restriction, network/CSP access to `api-maps.yandex.ru`, then use the visible retry action. The cart and manually entered fields remain intact.
- Search or reverse-geocoding failure: retry the provider; the customer can still move the pin and retain/correct the written address, but must explicitly reconfirm it.
- No results: refine the query or manually place the pin. Never use `0,0` or invented coordinates.
- Delivery settings unavailable: verify the migration, the single `singleton=true` record, and database logs. Do not bypass server validation in the browser.
- Offline customer: retain the cart locally, restore connectivity, then submit once. The idempotency key prevents a retry from creating a duplicate.

Before production launch: verify the physical restaurant pin; confirm radius, minimum, base fee and free threshold with the owner; restrict the Yandex key to every approved production hostname; test search, click, drag, suggestion and reconfirmation on a real phone; submit one inside-zone and one outside-zone order; verify authoritative totals in staff view; verify restaurant and driver navigation links at the actual entrance; verify public tracking leaks no private location data; test a provider outage and retry; and test address-problem reporting end to end.
