// ESLint flat config. It replaces the `.eslintrc.js` named in the plan, which ESLint 9+ no longer reads.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "work/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // Plain JS files (e.g. benchmarks/*.mjs) run on Node and use its globals.
  { files: ["**/*.mjs", "**/*.js"], languageOptions: { globals: globals.node } },
  prettier,
);
