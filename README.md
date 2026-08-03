# ZAYTUN GO

Standalone customer ordering, restaurant operations, and driver delivery prototype for Zaytun Cafe.

## Run locally

```sh
npm install
npm run dev
```

Use `/menu` for customers, `/restaurant` for staff, and `/driver` for drivers. When Supabase environment variables are present, data uses the local Supabase stack; otherwise the repository abstraction falls back to browser-local demonstration data.

For the Docker-based Supabase backend, Auth accounts, RLS model, local testing, and later production deployment, see [docs/backend.md](docs/backend.md).

## Validation

```sh
npm run typecheck
npm run lint
npm test
npm run build
```
