import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The API the dev and preview servers proxy /api to (e2e runs point this at a throwaway backend).
const apiProxy = { "/api": { target: process.env.VITE_PROXY_TARGET ?? "http://localhost:3000", changeOrigin: false } };

export default defineConfig({
  plugins: [react()],
  build: {
    target: "es2022",
    sourcemap: false,
    rollupOptions: {
      output: {
        // Stable vendor chunks cache across deploys; app code changes do not invalidate them.
        manualChunks(id: string) {
          if (!id.includes("node_modules")) return undefined;
          if (/[\/](react|react-dom|scheduler)[\/]/.test(id)) return "react-vendor";
          if (/[\/](react-router|react-router-dom|@remix-run)[\/]/.test(id)) return "router-vendor";
          if (/[\/]lucide-react[\/]/.test(id)) return "icons-vendor";
          return undefined;
        }
      }
    }
  },
  server: {
    port: 3001,
    strictPort: true,
    proxy: apiProxy
  },
  preview: {
    port: 3001,
    strictPort: true,
    proxy: apiProxy
  }
});
