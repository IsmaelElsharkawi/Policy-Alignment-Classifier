import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The classifier backend runs separately (default :8000). In dev, Vite proxies
// /api to it so the browser never deals with CORS or API keys.
const backend = process.env.CLASSIFIER_API ?? "http://localhost:8000";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": { target: backend, changeOrigin: true } },
  },
});
