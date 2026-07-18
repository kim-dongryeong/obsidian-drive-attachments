import obsidianmd from "eslint-plugin-obsidianmd";

// Mirrors the Obsidian community-directory reviewer: eslint-plugin-obsidianmd's recommended config
// (which bundles typescript-eslint's recommended-type-checked). Type-aware rules need the TS project.
export default [
  {
    ignores: ["main.js", "esbuild.config.mjs", "eslint.config.mjs", "node_modules/**", "**/*.test.ts", "test/**"],
  },
  ...obsidianmd.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // TypeScript itself resolves globals like PromiseRejectedResult; the base no-undef rule
      // doesn't know them and only produces false positives on typed code (the reviewer doesn't
      // enforce it either).
      "no-undef": "off",
      // "Sentence case" mangles proper nouns (Google Drive, OAuth, Picker) — the directory reviewer
      // does not enforce it.
      "obsidianmd/ui/sentence-case": "off",
    },
  },
];
