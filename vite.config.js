import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Relative asset paths, so the same build works served from a domain root
  // (Cloudflare Pages) or from a subpath (github.io/<repo>/) without changes.
  base: "./",
  build: {
    outDir: "dist",
    sourcemap: false,
    rollupOptions: {
      output: {
        // Split the heavy third-party code so a change to the app itself
        // does not force everyone to re-download the charting library.
        // Only chunk what is statically imported. recharts arrives through a
        // dynamic import, so Rollup gives it its own chunk automatically and
        // it stays off the initial load.
        manualChunks: { icons: ["lucide-react"] },
      },
    },
  },
});
