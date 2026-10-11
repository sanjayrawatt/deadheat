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

  // FIX, pessimistic locks: lock both rows before reading them. Always in id order, so two
  // transfers in opposite directions can't each hold one lock and wait for the other.
  "for-update": (fromId, toId, amount) =>
    inTransaction(async (db) => {
      const locked = await db.query<{ id: number; balance: number }>(
        "SELECT id, balance FROM accounts WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE",
        [[fromId, toId]],
      );
      const from = locked.rows.find((r) => r.id === fromId)?.balance;
      const to = locked.rows.find((r) => r.id === toId)?.balance;
      if (from === undefined || to === undefined) return { kind: "account-not-found" };
      if (from < amount) return { kind: "insufficient-funds" };

      await db.query("UPDATE accounts SET balance = $2 WHERE id = $1", [fromId, from - amount]);
      await db.query("UPDATE accounts SET balance = $2 WHERE id = $1", [toId, to + amount]);
      return { kind: "done", transferId: await record(db, fromId, toId, amount) };
    }),

  // FIX, conditional write: the debit checks the balance in the same statement that changes
  // it, and the credit is relative. Postgres re-evaluates the WHERE on the latest row version,
  // so two debits can't both pass, and no credit overwrites another.
  conditional: (fromId, toId, amount) =>
    inTransaction(async (db) => {
      const debited = await db.query(
        "UPDATE accounts SET balance = balance - $2 WHERE id = $1 AND balance >= $2",
        [fromId, amount],
      );
      if (!debited.rowCount) {
        const exists = await db.query("SELECT 1 FROM accounts WHERE id = $1", [fromId]);
        throw new Rollback(
          exists.rowCount ? { kind: "insufficient-funds" } : { kind: "account-not-found" },
        );
      }
      const credited = await db.query("UPDATE accounts SET balance = balance + $2 WHERE id = $1", [
        toId,
        amount,
      ]);
      if (!credited.rowCount) throw new Rollback({ kind: "account-not-found" });
      return { kind: "done", transferId: await record(db, fromId, toId, amount) };
    }),

  // FIX, SERIALIZABLE: the lost-update code unchanged, at SERIALIZABLE, retried when Postgres
  // aborts it (40001) or picks it as a deadlock victim (40P01).
  serializable: (fromId, toId, amount) =>
    withRetry(() =>
      inTransaction(async (db) => {
        const from = await balanceOf(db, fromId);
        const to = await balanceOf(db, toId);
        if (from === undefined || to === undefined) return { kind: "account-not-found" };
        if (from < amount) return { kind: "insufficient-funds" };

        await db.query("UPDATE accounts SET balance = $2 WHERE id = $1", [fromId, from - amount]);
        await db.query("UPDATE accounts SET balance = $2 WHERE id = $1", [toId, to + amount]);
        return { kind: "done", transferId: await record(db, fromId, toId, amount) };
      }, "BEGIN ISOLATION LEVEL SERIALIZABLE"),
    ),
} satisfies Record<string, TransferFn>;

export type VariantName = keyof typeof variants;

export function isVariantName(name: string): name is VariantName {
  return Object.hasOwn(variants, name);
}

// Ends the transaction with ROLLBACK but still returns a normal result (e.g. insufficient funds
// after a debit that matched no row).
class Rollback {
  constructor(readonly result: TransferResult) {}
}

async function inTransaction<T extends TransferResult>(
  fn: (db: PoolClient) => Promise<T>,
  begin = "BEGIN",
): Promise<T | TransferResult> {
  const db = await pool.connect();
  try {
    await db.query(begin);
    const result = await fn(db);
    await db.query("COMMIT");
    return result;
  } catch (err) {
    await db.query("ROLLBACK").catch(() => {});
    if (err instanceof Rollback) return err.result;
    throw err;
  } finally {
    db.release();
  }
}

const RETRYABLE = new Set(["40001", "40P01"]); // serialization failure, deadlock detected

async function withRetry<T>(fn: () => Promise<T>, attempts = 10): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts || !RETRYABLE.has((err as { code?: string }).code ?? "")) throw err;
    }
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
