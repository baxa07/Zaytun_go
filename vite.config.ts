import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    env: {
      VITE_SUPABASE_URL: "",
      VITE_SUPABASE_ANON_KEY: "",
      VITE_DATA_PROVIDER: "local",
      VITE_MAP_PROVIDER: "mock",
      VITE_DEFAULT_MAP_LAT: "40.1039",
      VITE_DEFAULT_MAP_LNG: "65.3688",
      VITE_DEFAULT_MAP_ZOOM: "14",
    },
  },
  server: {
    host: "localhost",
    port: 5173,
    strictPort: true,
  },
});
