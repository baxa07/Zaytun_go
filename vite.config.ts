import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { defineConfig, type Plugin } from "vitest/config";
import react from "@vitejs/plugin-react";

// Phase D: public/sw.js is copied verbatim (no build-time processing) --
// without this, its content is byte-identical across every deploy, so
// the browser's own service-worker update check could never detect a
// new version at all. Netlify sets COMMIT_REF to the exact commit being
// deployed; falling back to a local git SHA (dev builds) and finally a
// timestamp (no git available) so the stamp is always genuinely unique
// per build, never a hardcoded string a human has to remember to bump.
function stampServiceWorker(): Plugin {
  let outDir = "dist";
  return {
    name: "zaytun-stamp-service-worker",
    apply: "build",
    configResolved(config) {
      outDir = config.build.outDir;
    },
    closeBundle() {
      const swPath = resolve(outDir, "sw.js");
      let buildId = process.env.COMMIT_REF || process.env.GITHUB_SHA;
      if (!buildId) {
        try {
          buildId = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
        } catch {
          buildId = String(Date.now());
        }
      }
      try {
        const original = readFileSync(swPath, "utf8");
        writeFileSync(swPath, original.replaceAll("__ZAYTUN_BUILD_ID__", buildId));
      } catch {
        /* sw.js not present in this build's output -- nothing to stamp */
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), stampServiceWorker()],
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.{test,spec}.{ts,tsx}", "scripts/**/*.test.mjs"],
    env: {
      VITE_SUPABASE_URL: "",
      VITE_SUPABASE_ANON_KEY: "",
      VITE_DATA_PROVIDER: "local",
      VITE_MAP_PROVIDER: "mock",
      VITE_DEFAULT_MAP_LAT: "40.087274",
      VITE_DEFAULT_MAP_LNG: "65.402551",
      VITE_DEFAULT_MAP_ZOOM: "17",
    },
  },
  server: {
    host: "localhost",
    port: 5173,
    strictPort: true,
  },
});
