import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Served under /v2/ in production. In dev, proxy /v2/api → the Rust backend
// (stripping /v2 since the backend mounts routes at /api).
export default defineConfig({
  base: "/v2/",
  plugins: [react()],
  server: {
    proxy: {
      "/v2/api": {
        target: "http://localhost:3010",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/v2/, ""),
      },
    },
  },
});
