// ESLint flat config. It replaces the `.eslintrc.js` named in the plan, which ESLint 9+ no longer reads.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "work/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
);
