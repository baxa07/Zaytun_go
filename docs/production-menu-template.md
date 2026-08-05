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

Structured handoff template:

```json
{
  "categories": [
    {"id":"<category-slug>","name":"<OWNER VALUE>","description":"<OWNER VALUE OR EMPTY>","sort_order":1,"active":true}
  ],
  "items": [
    {"id":"<item-slug>","category_id":"<category-slug>","name":"<OWNER VALUE>","description":"<OWNER VALUE OR EMPTY>","price":0,"image":"<APPROVED URL/PATH OR EMPTY>","available":false,"sort_order":1}
  ],
  "modifiers": [
    {"id":"<modifier-slug>","menu_item_id":"<item-slug>","name":"<OWNER VALUE>","price":0,"available":false}
  ]
}
```

The zero prices above are schema examples, not production prices, and `available:false` prevents accidental sale. Import categories, then items, then modifiers inside one reviewed transaction. Verify row counts and the anonymous public menu before changing approved rows to active/available. Never import `supabase/seed.sql` into production.
