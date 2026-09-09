import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  root: "client",
  publicDir: "public",
  server: {
    port: 5174,
    host: "127.0.0.1",
    proxy: {
      "/api": { target: "http://127.0.0.1:8765", changeOrigin: true },
      "/v1": { target: "http://127.0.0.1:8765", changeOrigin: true },
      "/health": { target: "http://127.0.0.1:8765", changeOrigin: true },
    },
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
});
