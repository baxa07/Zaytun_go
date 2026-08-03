# Local Supabase backend

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
- `VITE_MAP_PROVIDER_URL=<selected map provider URL>`

Configure the hosted Auth Site URL and redirect allow-list for the production domain. Never expose the service-role key in Vite or browser code. If server-side administration is added later, store `SUPABASE_SERVICE_ROLE_KEY` only in protected server-function environment variables.

Local CLI credentials, `.env.local`, `.supabase`, Docker volumes, database files, and runtime containers are excluded from Git.
