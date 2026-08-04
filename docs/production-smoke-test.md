# Production smoke test

Record date, release commit, domain, Supabase project reference (not credentials), tester and evidence for every result.

## Customer

- Open the home page and direct-refresh `/menu`; menu/categories load anonymously.
- Select items/modifiers, adjust quantities within the configured maximum and retain the cart after refresh/map failure.
- Checkout shows the verified restaurant configuration and server-estimate distinction.
- Yandex loads on the final HTTPS domain; search, pin click/drag, reverse result, suggestion application, confirmation and reconfirmation work.
- Submit an in-zone order. Confirmation and token tracking show the server-confirmed total.
- Confirm delivery fee/free threshold/minimum subtotal against database settings.
- Invalid/expired tracking token displays safe recovery guidance and no private data.

## Restaurant

- Signed-out direct refresh of `/restaurant` shows login before protected queries.
- A restaurant/dispatcher signs in and receives the new order through refresh/Realtime.
- Accept, estimate, prepare, ready and assign a permitted available driver.
- Verify address, confidence, coordinates, distance and navigation links.
- Exercise rejection/cancellation/address-issue handling and sign out; protected data and subscriptions clear.

## Driver

- Signed-out direct refresh of `/driver` shows login before protected queries.
- Driver signs in and sees only assigned delivery data, never the roster or unrelated orders.
- Accept, pick up, open both navigation links, mark on the way/arrived/delivered.
- Report incorrect address, no answer, payment issue and a failed/return scenario in a controlled test.

## Security

- Anon REST selects/inserts on orders, drivers, assignments, events, issues and profiles are rejected.
- Public creation works only through `create_public_order`; client prices/totals are ignored or rejected and database totals are authoritative.
- Invalid item/modifier/quantity/payment/location input creates no partial order.
- Tracking without the correct token returns no order.
- Driver cannot access an unrelated order/assignment or perform restaurant-only transitions.
- Built assets contain no service-role keys, private keys, local URLs, development identities or obsolete map-variable names (`npm run scan:production-bundle`).

## Reliability and release

- Disable network during checkout: no order request is cached/replayed and customer gets recovery guidance.
- Interrupt Supabase, Yandex search and Realtime separately; the UI stays usable where safe and explains recovery.
- Deploy a harmless version change: the update notice appears and reload moves to the new version without trapping users on stale HTML.
- Verify no horizontal overflow at customer/driver 390px and checkout 320px; restaurant detail works at 1024px and 1440px.
- Verify hosting health at `/`, `/menu`, `/track/<test-token>`, `/restaurant`, `/driver`, `/manifest.webmanifest` and `/sw.js`.
- Confirm backup/recovery owner, rollback decision point, incident channel and pilot stop criteria.
