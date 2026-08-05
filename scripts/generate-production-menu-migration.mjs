import { access, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { generateMenuSql, loadAndValidateMenu } from "./lib/production-menu.mjs";

const argumentsList = process.argv.slice(2);
const outputIndex = argumentsList.indexOf("--output");
if (outputIndex === -1 || !argumentsList[outputIndex + 1]) {
  console.error("Usage: npm run menu:generate -- --output supabase/migrations/YYYYMMDDHHMMSS_production_menu.sql [input-directory]");
  process.exit(1);
}
const output = resolve(argumentsList[outputIndex + 1]);
const migrationsDirectory = resolve("supabase/migrations");
if (dirname(output) !== migrationsDirectory || !/^\d{14}_production_menu\.sql$/.test(basename(output))) {
  console.error("Output must be supabase/migrations/YYYYMMDDHHMMSS_production_menu.sql");
  process.exit(1);
}
const inputArgument = argumentsList.find((_, index) => index !== outputIndex && index !== outputIndex + 1);
const input = resolve(inputArgument || "data/production-menu");
try {
  await access(output);
  throw new Error(`output already exists: ${output}`);
} catch (error) {
  if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
}
const result = await loadAndValidateMenu(input);
if (result.errors.length) {
  console.error("Migration not generated because menu validation failed:");
  result.errors.forEach((error) => console.error(`- ${error}`));
  process.exit(1);
}
await writeFile(output, generateMenuSql(result.data), { encoding: "utf8", flag: "wx" });
console.log(`Generated reviewed menu migration at ${output}. No database was changed.`);
