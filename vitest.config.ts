import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The end-to-end tests share one Postgres and reset the same rows (e.g. slot 1), so test
    // files must not run at the same time. Tests inside a file already run in order.
    fileParallelism: false,
  },
});
