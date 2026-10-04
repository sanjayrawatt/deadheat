import { pool } from "./db.js";

export type BookResult =
  { kind: "created"; bookingId: number } | { kind: "full" } | { kind: "slot-not-found" };

export type BookFn = (slotId: number, userId: number) => Promise<BookResult>;

// Every variant implements the same "book one seat" operation. The buggy ones are
// for Deadheat to find. The fix-gallery variants (for-update, conditional,
// serializable, redis-lua) get added here in Week 12.
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
} satisfies Record<string, BookFn>;

export type VariantName = keyof typeof variants;

export function isVariantName(name: string): name is VariantName {
  return Object.hasOwn(variants, name);
}
