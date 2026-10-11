import type { PoolClient } from "pg";
import { pool } from "./db.js";

export type BookResult =
  { kind: "created"; bookingId: number } | { kind: "full" } | { kind: "slot-not-found" };

export type BookFn = (slotId: number, userId: number) => Promise<BookResult>;

// Every variant implements the same "book one seat" operation. The buggy ones are
// for Deadheat to find; the fix gallery (for-update, conditional, serializable) is what
// Deadheat must find nothing in. redis-lua is still to come.
export const variants = {
  // THE BUG, wide window: check-then-act across separate round trips, with no locking.
  // Two requests can both run the COUNT before either runs the INSERT, both see a free
  // seat, and both insert. READ COMMITTED doesn't stop this, because each statement only
  // sees rows committed before *it* started.
  naive: async (slotId, userId) => {
    const slot = await pool.query<{ capacity: number }>(
      "SELECT capacity FROM slots WHERE id = $1",
      [slotId],
    );
    const capacity = slot.rows[0]?.capacity;
    if (capacity === undefined) return { kind: "slot-not-found" };

    const booked = await pool.query<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM bookings WHERE slot_id = $1",
      [slotId],
    );
    if ((booked.rows[0]?.count ?? 0) >= capacity) return { kind: "full" };

    const inserted = await pool.query<{ id: number }>(
      "INSERT INTO bookings (slot_id, user_id) VALUES ($1, $2) RETURNING id",
      [slotId, userId],
    );
    return { kind: "created", bookingId: inserted.rows[0]!.id };
  },

  // THE BUG, narrow window: the same check-then-act squeezed into ONE statement. It looks
  // atomic, but it isn't. The sub-select's snapshot is taken when the statement starts,
  // so two concurrent statements can both count 0 and both insert. The window is now
  // sub-millisecond, which makes this the variant that separates naive bursts from
  // synchronized release in benchmarks.
  "single-statement": async (slotId, userId) => {
    const inserted = await pool.query<{ id: number }>(
      `INSERT INTO bookings (slot_id, user_id)
       SELECT s.id, $2 FROM slots s
        WHERE s.id = $1
          AND (SELECT COUNT(*) FROM bookings b WHERE b.slot_id = s.id) < s.capacity
       RETURNING id`,
      [slotId, userId],
    );
    const row = inserted.rows[0];
    if (row) return { kind: "created", bookingId: row.id };
    const exists = await pool.query("SELECT 1 FROM slots WHERE id = $1", [slotId]);
    return exists.rowCount ? { kind: "full" } : { kind: "slot-not-found" };
  },

  // FIX, pessimistic lock: the same check-then-act, but the first read locks the slot row.
  // A second request's FOR UPDATE waits until the first commits, and then counts its booking.
  "for-update": (slotId, userId) =>
    inTransaction(async (db) => {
      const slot = await db.query<{ capacity: number }>(
        "SELECT capacity FROM slots WHERE id = $1 FOR UPDATE",
        [slotId],
      );
      const capacity = slot.rows[0]?.capacity;
      if (capacity === undefined) return { kind: "slot-not-found" };
      const booked = await db.query<{ count: number }>(
        "SELECT COUNT(*)::int AS count FROM bookings WHERE slot_id = $1",
        [slotId],
      );
      if ((booked.rows[0]?.count ?? 0) >= capacity) return { kind: "full" };
      return { kind: "created", bookingId: await insertBooking(db, slotId, userId) };
    }),

  // FIX, conditional write: claim a seat with one atomic UPDATE on a counter, and only
  // insert if a row was updated. The UPDATE re-checks `booked < capacity` on the latest row
  // version (it waits for a concurrent update of the same row), so two requests can't both
  // take the last seat.
  conditional: (slotId, userId) =>
    inTransaction(async (db) => {
      const claimed = await db.query(
        "UPDATE slots SET booked = booked + 1 WHERE id = $1 AND booked < capacity",
        [slotId],
      );
      if (!claimed.rowCount) {
        const exists = await db.query("SELECT 1 FROM slots WHERE id = $1", [slotId]);
        return exists.rowCount ? { kind: "full" } : { kind: "slot-not-found" };
      }
      return { kind: "created", bookingId: await insertBooking(db, slotId, userId) };
    }),

  // FIX, SERIALIZABLE: the naive check-then-act, run at SERIALIZABLE. Postgres aborts one of
  // two transactions whose reads and writes overlap (SQLSTATE 40001), and we retry it.
  serializable: (slotId, userId) =>
    withRetry(() =>
      inTransaction(async (db) => {
        const slot = await db.query<{ capacity: number }>(
          "SELECT capacity FROM slots WHERE id = $1",
          [slotId],
        );
        const capacity = slot.rows[0]?.capacity;
        if (capacity === undefined) return { kind: "slot-not-found" };
        const booked = await db.query<{ count: number }>(
          "SELECT COUNT(*)::int AS count FROM bookings WHERE slot_id = $1",
          [slotId],
        );
        if ((booked.rows[0]?.count ?? 0) >= capacity) return { kind: "full" };
        return { kind: "created", bookingId: await insertBooking(db, slotId, userId) };
      }, "BEGIN ISOLATION LEVEL SERIALIZABLE"),
    ),
} satisfies Record<string, BookFn>;

export type VariantName = keyof typeof variants;

export function isVariantName(name: string): name is VariantName {
  return Object.hasOwn(variants, name);
}

async function inTransaction<T>(fn: (db: PoolClient) => Promise<T>, begin = "BEGIN"): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query(begin);
    const result = await fn(db);
    await db.query("COMMIT");
    return result;
  } catch (err) {
    await db.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    db.release();
  }
}

async function insertBooking(db: PoolClient, slotId: number, userId: number): Promise<number> {
  const inserted = await db.query<{ id: number }>(
    "INSERT INTO bookings (slot_id, user_id) VALUES ($1, $2) RETURNING id",
    [slotId, userId],
  );
  return inserted.rows[0]!.id;
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
