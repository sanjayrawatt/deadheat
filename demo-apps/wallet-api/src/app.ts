import { registerFastify } from "@deadheat/agent";
import Fastify, { type FastifyInstance } from "fastify";
import { pool } from "./db.js";
import { variants, type VariantName } from "./variants.js";

interface TransferBody {
  fromId: number;
  toId: number;
  amount: number;
}

interface ResetBody {
  balances?: Record<string, number>;
}

export function buildApp(variant: VariantName): FastifyInstance {
  const app = Fastify({ logger: process.env.LOG_LEVEL ? { level: process.env.LOG_LEVEL } : false });
  registerFastify(app);
  const transfer = variants[variant];

  app.post<{ Body: TransferBody }>(
    "/transfers",
    {
      schema: {
        body: {
          type: "object",
          required: ["fromId", "toId", "amount"],
          properties: {
            fromId: { type: "integer" },
            toId: { type: "integer" },
            amount: { type: "integer", minimum: 1 },
          },
        },
      },
    },
    async (req, reply) => {
      const { fromId, toId, amount } = req.body;
      if (fromId === toId) return reply.code(400).send({ error: "fromId and toId must differ" });
      const result = await transfer(fromId, toId, amount);
      switch (result.kind) {
        case "done":
          return reply.code(201).send({ transferId: result.transferId });
        case "insufficient-funds":
          return reply.code(409).send({ error: "insufficient funds" });
        case "account-not-found":
          return reply.code(404).send({ error: "account not found" });
      }
    },
  );

  app.get("/accounts", async () => {
    const r = await pool.query<{ id: number; balance: number }>(
      "SELECT id, balance FROM accounts ORDER BY id",
    );
    return r.rows;
  });

  app.get("/variant", async () => ({ variant }));

  // Test helper: clear transfers and set balances. Demo-only, never for a real app.
  app.post<{ Body: ResetBody }>("/reset", async (req) => {
    const balances = req.body?.balances ?? { "1": 100, "2": 100, "3": 0 };
    await pool.query("TRUNCATE transfers");
    for (const [id, balance] of Object.entries(balances)) {
      await pool.query(
        "INSERT INTO accounts (id, balance) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET balance = EXCLUDED.balance",
        [Number(id), balance],
      );
    }
    return { balances };
  });

  return app;
}
