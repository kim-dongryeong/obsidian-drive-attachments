import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Unit tests target Obsidian-free pure helpers (parsing, escaping, formatting, normalization).
// Source modules that import the non-installable `obsidian` package resolve to a tiny stub so they
// can still be imported in the Node test environment — extend test/obsidian-stub.ts as the suite grows.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
  resolve: {
    alias: {
      obsidian: fileURLToPath(new URL("./test/obsidian-stub.ts", import.meta.url)),
    },
  },
});
