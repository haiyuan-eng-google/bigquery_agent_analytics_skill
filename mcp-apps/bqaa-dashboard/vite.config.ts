import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

export default defineConfig({
  plugins: [viteSingleFile()],
  build: {
    outDir: "dist",
    assetsInlineLimit: 100_000_000, // fonts must inline — MCP-app CSP blocks external origins
    rollupOptions: {
      input: process.env.INPUT,
    },
  },
});
