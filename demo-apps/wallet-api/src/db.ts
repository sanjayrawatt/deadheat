import { readFile } from "node:fs/promises";
import { instrumentPg } from "@deadheat/agent";
import pg from "pg";

// Tags every query with the HTTP request that caused it, so Deadheat can attribute it.
// Harmless without Deadheat: the tag is a SQL comment.
instrumentPg(pg);

export const DEFAULT_DATABASE_URL = "postgres://deadheat:deadheat@localhost:55432/deadheat";

// More than one connection is what makes the race possible: with max = 1 every
// query would queue behind the previous one and the requests could never interleave.
export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
  max: 10,
});

// schema.sql sits at the package root, one level above src/. The app runs from source via tsx.
export async function applySchema(): Promise<void> {
  const sql = await readFile(new URL("../schema.sql", import.meta.url), "utf8");
  await pool.query(sql);
}
