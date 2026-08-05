# Zaytun production menu import template

No production menu rows are bootstrapped automatically. Obtain owner-approved names, prices, descriptions, images and availability before importing. Use stable lowercase slug identifiers; changing an identifier later breaks references from modifiers and historical order metadata.

## Categories (`menu_categories`)

| Field | Type | Required | Rule |
| --- | --- | --- | --- |
| `id` | text | yes | Unique stable slug, for example `<category-slug>` |
| `name` | text | yes | Customer-visible Uzbek name |
| `description` | text | yes | May be empty |
| `sort_order` | integer | yes | Display order, starting at 1 |
| `active` | boolean | yes | Only active categories are public |

## Items (`menu_items`)

| Field | Type | Required | Rule |
| --- | --- | --- | --- |
| `id` | text | yes | Unique stable product slug |
| `category_id` | text | yes | Existing category ID |
| `name` | text | yes | Customer-visible product name |
| `description` | text | yes | Ingredients/portion description; may be empty |
| `price` | integer | yes | Authoritative integer UZS, zero or greater |
| `image` | text | yes | Approved image URL/path or empty string |
| `available` | boolean | yes | Only available items can be ordered |
| `sort_order` | integer | yes | Order within its category |

## Modifiers (`menu_modifiers`)

| Field | Type | Required | Rule |
| --- | --- | --- | --- |
| `id` | text | yes | Globally unique stable modifier slug |
| `menu_item_id` | text | yes | Existing item ID; modifiers cannot cross items |
| `name` | text | yes | Customer-visible option name |
| `price` | integer | yes | Authoritative integer UZS increment, zero or greater |
| `available` | boolean | yes | Only available modifiers can be selected |

## Owner input files

Fill these UTF-8, spreadsheet-compatible files:

- `data/production-menu/categories.csv`
- `data/production-menu/items.csv`
- `data/production-menu/modifiers.csv`

Every file contains one `EXAMPLE` row. It is formatting documentation only and
is never imported. Add approved records as `DATA` rows. Keep the example row and
headers unchanged. If there are no modifiers, leave that file with only its
example row.

`description` and `image` are optional owner content, but their CSV columns must
remain. An image must be blank or an approved `https://` URL. Item prices must be
positive integer UZS. A modifier may have a zero increment because the database
explicitly supports free choices. IDs are deterministic lowercase slugs and
must not be renamed after launch.

## Validation and reviewed import

```bash
npm run menu:validate
npm run menu:generate -- --output supabase/migrations/YYYYMMDDHHMMSS_production_menu.sql
```

Validation checks headers, required fields, deterministic and unique IDs,
references, positive item prices, non-negative modifier prices, display order,
HTTPS image URLs, booleans and duplicate product/options. Generation refuses
invalid data, refuses to overwrite an existing file, and only writes an SQL
migration; it never connects to a database.

The generated forward-only migration upserts categories, then items, then
modifiers by their stable IDs. It contains no deletes and does not touch orders,
order items, price snapshots, users, drivers, tracking tokens, delivery settings
or payment configuration. Review the generated diff and run a clean local reset,
database lint, pgTAP and customer tests before applying it to production with the
documented production migration procedure. Never import `supabase/seed.sql` into
production.

Omitting an already-imported product does not remove or unpublish it. Include
that stable ID with `available=false` (or a category with `active=false`) in a
later reviewed import when the owner wants to hide it. This preserves historical
references and makes deactivation explicit.

`delivery_settings` remains the authority for delivery eligibility and pricing.
This workflow does not enable delivery or change the production `CASH`-only
payment setting.
