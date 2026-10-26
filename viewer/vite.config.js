import { defineConfig } from "vite";

// The built output is deployed to Cloudflare Pages. Relative asset URLs keep the
// page working when it is served from a sub-path.
export default defineConfig({
  base: "./",
  build: {
    outDir: "dist",
    target: "es2022",
  },
  server: {
    port: 8787,
  },
  preview: {
    port: 8787,
  },
});
