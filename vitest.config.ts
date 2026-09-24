import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    alias: {
      // Modules the Workers runtime provides; stubbed so worker code can be unit-tested in node.
      "cloudflare:workflows": fileURLToPath(new URL("./tests/stubs/cloudflare-workflows.ts", import.meta.url)),
      "cloudflare:workers": fileURLToPath(new URL("./tests/stubs/cloudflare-workers.ts", import.meta.url)),
    },
  },
});
