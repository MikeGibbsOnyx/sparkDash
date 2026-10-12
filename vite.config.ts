// Modified by Onyx AI Labs, 2026: adds the Connect page entry.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    // Allow HMR in Docker
    watch: {
      usePolling: process.env.CHOKIDAR_USEPOLLING === "1",
    },
    proxy: {
      "/api": "http://127.0.0.1:5555",
      "/metrics": "http://127.0.0.1:5555",
      "/ws": {
        target: "ws://127.0.0.1:5555",
        ws: true,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Onyx: the Connect page is a second entry, served by the Gateway at `/`.
    rolldownOptions: {
      input: {
        main: path.resolve(__dirname, "index.html"),
        connect: path.resolve(__dirname, "connect.html"),
      },
    },
  },
});