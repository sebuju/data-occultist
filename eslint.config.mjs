// Flat ESLint config for the web UI front-end. The app ships raw ES modules (no bundler,
// no build step), so this is the ONLY thing that catches parse/scope errors -- duplicate
// `export const`, redeclared identifiers, use of an undeclared name, dead code -- before
// they reach the browser as a runtime SyntaxError. Run with `npm run lint`.
import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["**/vendor/**", "**/*.min.js", ".venv/**", "node_modules/**", "playground/**"] },
  js.configs.recommended,
  {
    files: ["src/oc/web/static/js/**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: {
        ...globals.browser,
        // Vendored globals attached to window by libraries loaded via <script>.
        EventSource: "readonly",
      },
    },
    rules: {
      // Unused vars are common in WIP edits -- warn, don't fail the build over them.
      "no-unused-vars": ["warn", { args: "none", varsIgnorePattern: "^_", ignoreRestSiblings: true }],
      // Empty `catch {}` is an intentional idiom here (best-effort fetches).
      "no-empty": ["error", { allowEmptyCatch: true }],
      // These ARE the bugs ESLint exists to catch here -- keep them hard errors.
      "no-redeclare": "error",
      "no-dupe-keys": "error",
      "no-undef": "error",
    },
  },
];
