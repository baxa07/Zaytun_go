import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const FILES = {
  categories: { name: "categories.csv", columns: ["record_type", "id", "name", "description", "sort_order", "active"] },
  items: { name: "items.csv", columns: ["record_type", "id", "category_id", "name", "description", "price", "image", "available", "sort_order"] },
  modifiers: { name: "modifiers.csv", columns: ["record_type", "id", "menu_item_id", "name", "price", "available"] },
};

export function parseCsv(source, filename = "CSV") {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') { field += '"'; index += 1; }
      else if (character === '"') quoted = false;
      else field += character;
    } else if (character === '"') quoted = true;
    else if (character === ",") { row.push(field); field = ""; }
    else if (character === "\n") { row.push(field.replace(/\r$/, "")); rows.push(row); row = []; field = ""; }
    else field += character;
  }
  if (quoted) throw new Error(`${filename}: yopilmagan qo‘shtirnoq`);
  if (field || row.length) { row.push(field.replace(/\r$/, "")); rows.push(row); }
  return rows.filter((values) => values.some((value) => value.trim() !== ""));
}

const identifierPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const normalizeName = (value) => value.trim().toLocaleLowerCase("uz").replace(/\s+/g, " ");

function parseBoolean(value, location, errors) {
  const normalized = value.trim().toLowerCase();
  if (!['true', 'false'].includes(normalized)) errors.push(`${location}: qiymat true yoki false bo‘lishi kerak`);
  return normalized === "true";
}

function parseInteger(value, location, minimum, errors) {
  if (!/^-?\d+$/.test(value.trim())) { errors.push(`${location}: butun son bo‘lishi kerak`); return minimum; }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum) errors.push(`${location}: ${minimum} yoki undan katta xavfsiz butun son bo‘lishi kerak`);
  return number;
}

function rowsToObjects(rows, definition, errors) {
  if (!rows.length) { errors.push(`${definition.name}: fayl bo‘sh`); return []; }
  const headers = rows[0].map((value) => value.trim());
  if (headers.join("|") !== definition.columns.join("|")) {
    errors.push(`${definition.name}: sarlavhalar aynan ${definition.columns.join(",")} bo‘lishi kerak`);
    return [];
  }
  const records = [];
  for (let index = 1; index < rows.length; index += 1) {
    if (rows[index].length !== headers.length) {
      errors.push(`${definition.name}:${index + 2}: ${headers.length} ta ustun kutilgan, ${rows[index].length} ta topildi`);
      continue;
    }
    records.push(Object.fromEntries(headers.map((header, column) => [header, rows[index][column].trim()])));
  }
  if (records.filter((record) => record.record_type === "EXAMPLE").length !== 1) errors.push(`${definition.name}: aynan bitta EXAMPLE qatori saqlanishi kerak`);
  records.forEach((record, index) => {
    if (!['EXAMPLE', 'DATA'].includes(record.record_type)) errors.push(`${definition.name}:${index + 2}: record_type EXAMPLE yoki DATA bo‘lishi kerak`);
  });
  return records.filter((record) => record.record_type === "DATA");
}

function requireText(record, fields, location, errors) {
  fields.forEach((field) => { if (!record[field]) errors.push(`${location}.${field}: majburiy maydon`); });
}

function validateIds(records, type, errors) {
  const seen = new Set();
  records.forEach((record, index) => {
    const location = `${FILES[type].name}:${index + 3}`;
    if (!identifierPattern.test(record.id)) errors.push(`${location}.id: kichik harfli barqaror slug kerak`);
    if (seen.has(record.id)) errors.push(`${location}.id: takrorlangan ID “${record.id}”`);
    seen.add(record.id);
  });
}

export function validateMenuRows(raw) {
  const errors = [];
  const categories = rowsToObjects(raw.categories, FILES.categories, errors);
  const items = rowsToObjects(raw.items, FILES.items, errors);
  const modifiers = rowsToObjects(raw.modifiers, FILES.modifiers, errors);
  validateIds(categories, "categories", errors); validateIds(items, "items", errors); validateIds(modifiers, "modifiers", errors);
  if (!categories.length) errors.push("categories.csv: kamida bitta DATA qatori kerak");
  if (!items.length) errors.push("items.csv: kamida bitta DATA qatori kerak");

  const categoryIds = new Set(categories.map(({ id }) => id));
  const itemIds = new Set(items.map(({ id }) => id));
  const categoryOrders = new Set();
  categories.forEach((category, index) => {
    const location = `categories.csv:${index + 3}`;
    requireText(category, ["id", "name", "sort_order", "active"], location, errors);
    category.sort_order = parseInteger(category.sort_order, `${location}.sort_order`, 1, errors);
    category.active = parseBoolean(category.active, `${location}.active`, errors);
    if (categoryOrders.has(category.sort_order)) errors.push(`${location}.sort_order: kategoriya tartibi takrorlangan`);
    categoryOrders.add(category.sort_order);
  });

  const names = new Set(), itemOrders = new Set();
  items.forEach((item, index) => {
    const location = `items.csv:${index + 3}`;
    requireText(item, ["id", "category_id", "name", "price", "available", "sort_order"], location, errors);
    if (!categoryIds.has(item.category_id)) errors.push(`${location}.category_id: kategoriya topilmadi “${item.category_id}”`);
    item.price = parseInteger(item.price, `${location}.price`, 1, errors);
    item.sort_order = parseInteger(item.sort_order, `${location}.sort_order`, 1, errors);
    item.available = parseBoolean(item.available, `${location}.available`, errors);
    if (item.image && !/^https:\/\/[^\s]+$/i.test(item.image)) errors.push(`${location}.image: bo‘sh yoki https:// URL bo‘lishi kerak`);
    const name = normalizeName(item.name);
    if (name && names.has(name)) errors.push(`${location}.name: takrorlangan mahsulot “${item.name}”`);
    names.add(name);
    const orderKey = `${item.category_id}:${item.sort_order}`;
    if (itemOrders.has(orderKey)) errors.push(`${location}.sort_order: shu kategoriyada tartib takrorlangan`);
    itemOrders.add(orderKey);
  });

  const modifierNames = new Set();
  modifiers.forEach((modifier, index) => {
    const location = `modifiers.csv:${index + 3}`;
    requireText(modifier, ["id", "menu_item_id", "name", "price", "available"], location, errors);
    if (!itemIds.has(modifier.menu_item_id)) errors.push(`${location}.menu_item_id: mahsulot topilmadi “${modifier.menu_item_id}”`);
    modifier.price = parseInteger(modifier.price, `${location}.price`, 0, errors);
    modifier.available = parseBoolean(modifier.available, `${location}.available`, errors);
    const nameKey = `${modifier.menu_item_id}:${normalizeName(modifier.name)}`;
    if (modifierNames.has(nameKey)) errors.push(`${location}.name: shu mahsulot uchun qo‘shimcha takrorlangan`);
    modifierNames.add(nameKey);
  });
  return { errors, data: { categories, items, modifiers } };
}

export async function loadAndValidateMenu(directory) {
  const raw = {};
  for (const [type, definition] of Object.entries(FILES)) raw[type] = parseCsv(await readFile(join(directory, definition.name), "utf8"), definition.name);
  return validateMenuRows(raw);
}

const sqlValue = (value) => `'${String(value).replaceAll("'", "''")}'`;
const textValue = (value) => value ? sqlValue(value) : "''";

export function generateMenuSql(data) {
  const categories = data.categories.map((row) => `(${sqlValue(row.id)},${sqlValue(row.name)},${textValue(row.description)},${row.sort_order},${row.active})`).join(",\n  ");
  const items = data.items.map((row) => `(${sqlValue(row.id)},${sqlValue(row.category_id)},${sqlValue(row.name)},${textValue(row.description)},${row.price},${textValue(row.image)},${row.available},${row.sort_order})`).join(",\n  ");
  const modifiers = data.modifiers.map((row) => `(${sqlValue(row.id)},${sqlValue(row.menu_item_id)},${sqlValue(row.name)},${row.price},${row.available})`).join(",\n  ");
  return `-- Generated from owner-approved production menu CSV files. Review before applying.\n-- Idempotent upserts only: no menu rows, orders, or immutable snapshots are deleted.\ninsert into public.menu_categories(id,name,description,sort_order,active) values\n  ${categories}\non conflict(id) do update set name=excluded.name,description=excluded.description,sort_order=excluded.sort_order,active=excluded.active;\n\ninsert into public.menu_items(id,category_id,name,description,price,image,available,sort_order) values\n  ${items}\non conflict(id) do update set category_id=excluded.category_id,name=excluded.name,description=excluded.description,price=excluded.price,image=excluded.image,available=excluded.available,sort_order=excluded.sort_order;\n${modifiers ? `\ninsert into public.menu_modifiers(id,menu_item_id,name,price,available) values\n  ${modifiers}\non conflict(id) do update set menu_item_id=excluded.menu_item_id,name=excluded.name,price=excluded.price,available=excluded.available;\n` : ""}`;
}
