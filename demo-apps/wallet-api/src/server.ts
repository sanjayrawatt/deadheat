import { buildApp } from "./app.js";
import { applySchema, pool } from "./db.js";
import { isVariantName, variants } from "./variants.js";

// 4200: booking-api uses 4100, and 3000 is often taken by other local dev servers.
const port = Number(process.env.PORT ?? 4200);
const variant = process.env.WALLET_VARIANT ?? "naive";
if (!isVariantName(variant)) {
  console.error(
    `Unknown WALLET_VARIANT "${variant}". Use one of: ${Object.keys(variants).join(", ")}`,
  );
  process.exit(1);
}

await applySchema();
const app = buildApp(variant);

const shutdown = async () => {
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ port, host: "127.0.0.1" });
console.log(`wallet-api (${variant}) listening on http://127.0.0.1:${port}`);
