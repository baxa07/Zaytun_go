import { resolve } from "node:path";
import { loadAndValidateMenu } from "./lib/production-menu.mjs";

const directory = resolve(process.argv[2] || "data/production-menu");
try {
  const result = await loadAndValidateMenu(directory);
  if (result.errors.length) {
    console.error(`Production menu validation failed (${result.errors.length}):`);
    result.errors.forEach((error) => console.error(`- ${error}`));
    process.exitCode = 1;
  } else {
    console.log(`Production menu valid: ${result.data.categories.length} categories, ${result.data.items.length} items, ${result.data.modifiers.length} modifiers.`);
  }
} catch (error) {
  console.error(`Production menu validation could not run: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
}
