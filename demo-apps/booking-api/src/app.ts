import { registerFastify } from "@deadheat/agent";
import Fastify, { type FastifyInstance } from "fastify";
import { pool } from "./db.js";
import { variants, type VariantName } from "./variants.js";

interface BookingBody {
  slotId: number;
  userId: number;
}

interface ResetBody {
  slotId?: number;
  capacity?: number;
}

export function buildApp(variant: VariantName): FastifyInstance {
  const app = Fastify({ logger: process.env.LOG_LEVEL ? { level: process.env.LOG_LEVEL } : false });
  registerFastify(app);
  const book = variants[variant];

  app.post<{ Body: BookingBody }>(
    "/bookings",
    {
      schema: {
        body: {
          type: "object",
          required: ["slotId", "userId"],
          properties: { slotId: { type: "integer" }, userId: { type: "integer" } },
        },
      },
    },
    async (req, reply) => {
      const result = await book(req.body.slotId, req.body.userId);
      switch (result.kind) {
        case "created":
          return reply.code(201).send({ bookingId: result.bookingId });
        case "full":
          return reply.code(409).send({ error: "slot is full" });
        case "slot-not-found":
          return reply.code(404).send({ error: "slot not found" });
      }
    },
  );

  // Current state of a slot. The burst script uses it to check the invariant.
  app.get<{ Params: { id: string } }>("/slots/:id", async (req, reply) => {
    const result = await pool.query<{ capacity: number; booked: number }>(
      `SELECT s.capacity, (SELECT COUNT(*)::int FROM bookings b WHERE b.slot_id = s.id) AS booked
         FROM slots s WHERE s.id = $1`,
      [Number(req.params.id)],
    );
    const row = result.rows[0];
    if (!row) return reply.code(404).send({ error: "slot not found" });
    return row;
  });

  // Which variant this server runs. The burst script prints it so results are labelled.
  app.get("/variant", async () => ({ variant }));

  // Test helper: wipe a slot's bookings and set its capacity. A demo-only endpoint, never for a real app.
  app.post<{ Body: ResetBody }>("/reset", async (req) => {
    const slotId = req.body?.slotId ?? 1;
    const capacity = req.body?.capacity ?? 1;
    await pool.query("DELETE FROM bookings WHERE slot_id = $1", [slotId]);
    await pool.query(
      "INSERT INTO slots (id, capacity) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET capacity = EXCLUDED.capacity",
      [slotId, capacity],
    );
    return { slotId, capacity };
  });

  return app;
}
