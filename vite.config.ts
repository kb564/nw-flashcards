import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  define: {
    "console.debug": "(()=>{})",
    "console.warn": "(()=>{})",
    "console.log": "(()=>{})",
    "console.info": "(()=>{})",
    "console.error": "(()=>{})",
  },
  build: {
    target: "es2022",
    sourcemap: false,
    cssCodeSplit: false,
    reportCompressedSize: true,
  },
  server: {
    strictPort: true,
  },
  preview: {
    strictPort: true,
  },
});
