import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** The API serves the built portal under /espace/ on the public origin (PORTAL_DIST_DIR). */
export default defineConfig({
  base: "/espace/",
  plugins: [react()],
  server: {
    port: 5174,
    proxy: { "/api": { target: process.env.API_URL ?? "http://localhost:3000", changeOrigin: false } },
  },
  build: { outDir: "dist", sourcemap: true },
});
