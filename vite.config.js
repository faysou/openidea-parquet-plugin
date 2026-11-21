import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  build: { outDir: "web", target: "safari15.4", modulePreload: false },
});
