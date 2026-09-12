import js from "@eslint/js"
import { defineConfig } from "eslint/config"
import eslintConfigPrettier from "eslint-config-prettier"
import tseslint from "typescript-eslint"

export default defineConfig(
  {
    ignores: ["dist/**", "node_modules/**", "vendor/**"],
  },
  {
    files: ["src/**/*.{ts,cts}", "test/**/*.ts"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
  },
  eslintConfigPrettier
)
