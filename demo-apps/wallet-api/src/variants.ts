import type { PoolClient } from "pg";
import { pool } from "./db.js";

export type TransferResult =
  | { kind: "done"; transferId: number }
  | { kind: "insufficient-funds" }
  | { kind: "account-not-found" };

export type TransferFn = (fromId: number, toId: number, amount: number) => Promise<TransferResult>;

/**
 * Both variants wrap the transfer in a transaction, as most developers would. That's the
 * point: a transaction at READ COMMITTED doesn't make check-then-act safe, because the
 * balance read takes no lock and other transactions can change the row before our UPDATE.
 */
export const variants = {
  // THE BUG, overdraft: check the balance, then subtract relative to the *current* value.
  // Two transfers both see 100, both pass the check, and both run `balance - 100`, so the
  // account ends at -100.
  naive: (fromId, toId, amount) =>
    inTransaction(async (db) => {
      const from = await balanceOf(db, fromId);
      const to = await balanceOf(db, toId);
      if (from === undefined || to === undefined) return { kind: "account-not-found" };
      if (from < amount) return { kind: "insufficient-funds" };

      await db.query("UPDATE accounts SET balance = balance - $2 WHERE id = $1", [fromId, amount]);
      await db.query("UPDATE accounts SET balance = balance + $2 WHERE id = $1", [toId, amount]);
      return { kind: "done", transferId: await record(db, fromId, toId, amount) };
    }),

  // THE BUG, lost update: compute the new balances in the app and write them back as
  // absolute values. When two senders pay the same receiver at once, both read the
  // receiver's old balance and both write `old + amount`, so one credit is overwritten.
  // Money disappears, and no balance goes negative, so only a "total is conserved"
  // invariant catches it.
  "lost-update": (fromId, toId, amount) =>
    inTransaction(async (db) => {
      const from = await balanceOf(db, fromId);
      const to = await balanceOf(db, toId);
      if (from === undefined || to === undefined) return { kind: "account-not-found" };
      if (from < amount) return { kind: "insufficient-funds" };

      await db.query("UPDATE accounts SET balance = $2 WHERE id = $1", [fromId, from - amount]);
      await db.query("UPDATE accounts SET balance = $2 WHERE id = $1", [toId, to + amount]);
      return { kind: "done", transferId: await record(db, fromId, toId, amount) };
    }),
} satisfies Record<string, TransferFn>;

export type VariantName = keyof typeof variants;

export function isVariantName(name: string): name is VariantName {
  return Object.hasOwn(variants, name);
}

async function inTransaction<T>(fn: (db: PoolClient) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const result = await fn(db);
    await db.query("COMMIT");
    return result;
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  } finally {
    db.release();
  }
}

async function balanceOf(db: PoolClient, id: number): Promise<number | undefined> {
  const r = await db.query<{ balance: number }>("SELECT balance FROM accounts WHERE id = $1", [id]);
  return r.rows[0]?.balance;
}

async function record(db: PoolClient, fromId: number, toId: number, amount: number) {
  const r = await db.query<{ id: number }>(
    "INSERT INTO transfers (from_id, to_id, amount) VALUES ($1, $2, $3) RETURNING id",
    [fromId, toId, amount],
  );
  return r.rows[0]!.id;
}
