import { describe, expect, it } from "vitest";
import { generateMenuSql, parseCsv, validateMenuRows } from "./production-menu.mjs";

const rows = (text) => parseCsv(text.trimStart());
const valid = () => ({
  categories: rows(`record_type,id,name,description,sort_order,active
EXAMPLE,<category-slug>,<OWNER>,,1,false
DATA,issiq-taomlar,Issiq taomlar,,1,true`),
  items: rows(`record_type,id,category_id,name,description,price,image,available,sort_order
EXAMPLE,<item-slug>,<category-slug>,<OWNER>,,100000,,false,1
DATA,owner-item,issiq-taomlar,Owner item,,100000,https://example.test/item.jpg,true,1`),
  modifiers: rows(`record_type,id,menu_item_id,name,price,available
EXAMPLE,<modifier-slug>,<item-slug>,<OWNER>,0,false
DATA,owner-option,owner-item,Owner option,0,true`),
});

describe("production menu validation", () => {
  it("accepts linked owner data and excludes example rows", () => {
    const result = validateMenuRows(valid());
    expect(result.errors).toEqual([]);
    expect(result.data.items).toHaveLength(1);
  });

  it("rejects invalid IDs, references, prices, duplicates, ordering, URLs and status", () => {
    const input = valid();
    input.items.push(["DATA", "Bad ID", "issiq-taomlar", "owner ITEM", "", "0", "http://unsafe.test/a.jpg", "maybe", "1"]);
    input.items.push(["DATA", "missing-category-item", "missing", "Different item", "", "10", "", "false", "2"]);
    const errors = validateMenuRows(input).errors.join("\n");
    expect(errors).toMatch(/kichik harfli/);
    expect(errors).toMatch(/kategoriya topilmadi/);
    expect(errors).toMatch(/1 yoki undan katta/);
    expect(errors).toMatch(/https:\/\//);
    expect(errors).toMatch(/true yoki false/);
    expect(errors).toMatch(/takrorlangan mahsulot/);
    expect(errors).toMatch(/tartib takrorlangan/);
  });

  it("generates idempotent upserts without deletes or historical tables", () => {
    const result = validateMenuRows(valid());
    const sql = generateMenuSql(result.data);
    expect(sql).toContain("on conflict(id) do update");
    expect(sql).not.toMatch(/\bdelete\b/i);
    expect(sql).not.toContain("order_items");
    expect(sql).not.toContain("delivery_settings");
  });
});
