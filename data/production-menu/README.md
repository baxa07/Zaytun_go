# Production menu owner handoff

Fill the three CSV files in this directory in a spreadsheet application or a
plain-text editor. Keep the header and the single `EXAMPLE` row in each file.
The example rows document formatting and are always excluded from validation
references and generated SQL.

Add real rows below each example with `record_type` set to `DATA`. Do not put
test products or unapproved values into these files. Save CSV as UTF-8.

- `categories.csv`: menu sections.
- `items.csv`: products and authoritative integer UZS prices.
- `modifiers.csv`: optional product-specific additions. Leave this file with
  only its example row when Zaytun has no modifiers.

Run `npm run menu:validate` before requesting review. See
`docs/production-menu-template.md` for every field and the controlled import
procedure.
