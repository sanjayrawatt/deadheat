// Invariant: a slot never has more bookings than its capacity.
// Target: demo-apps/booking-api (start it with `corepack pnpm start` in that folder).
import { scenario } from "deadheat";

const SLOT_ID = 1;
const CAPACITY = 1;

export default scenario({
  name: "slot is never oversold",
  baseUrl: "http://127.0.0.1:4100",
  setup: async ({ sql }) => {
    await sql`DELETE FROM bookings WHERE slot_id = ${SLOT_ID}`;
    await sql`UPDATE slots SET capacity = ${CAPACITY} WHERE id = ${SLOT_ID}`;
  },
  actions: {
    concurrency: 20,
    request: (i) => ({
      method: "POST",
      url: "/bookings",
      body: { slotId: SLOT_ID, userId: i + 1 },
    }),
  },
  invariant: async ({ sql }) => {
    const [row] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM bookings WHERE slot_id = ${SLOT_ID}`;
    const count = row?.count ?? 0;
    return count <= CAPACITY || `bookings = ${count}, capacity = ${CAPACITY}`;
  },
  trials: 100,
});
