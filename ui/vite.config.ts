import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { fileURLToPath } from "node:url"

import { loadPublicConfig } from "../src/public-config.cts"

export default defineConfig({
  base: "/ui/",
  plugins: [
    react({
      babel: {
        plugins: ["babel-plugin-react-compiler"],
      },
    }),
    tailwindcss(),
  ],
  server: {
    proxy: {
      "/ui/api": {
        target: `http://127.0.0.1:${loadPublicConfig(fileURLToPath(new URL("../.shellby/config.toml", import.meta.url))).port}`,
        changeOrigin: true,
      },
    },
  },
})
