# ZAYTUN GO

Standalone customer ordering, restaurant operations, and driver delivery prototype for Zaytun Cafe.

## Run locally

```sh
npm install
npm run dev
```

Use `/menu` for customers, `/restaurant` for staff, and `/driver` for drivers. Development data persists in local storage and is accessed only through repository interfaces in `src/data.ts`.

## Validation

```sh
npm run typecheck
npm run lint
npm test
npm run build
```
