import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The end-to-end tests share one Postgres and reset the same rows (e.g. slot 1), so test
    // files must not run at the same time. Tests inside a file already run in order.
    fileParallelism: false,
    // e2e tests talk to Postgres in Docker. One run hit the 5s default once (not reproduced
    // in 6 reruns), so allow headroom rather than fail on a slow VM moment.
    testTimeout: 20_000,
  },
});
