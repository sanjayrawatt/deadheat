// Invariants: no account goes negative, and transfers never create or destroy money.
// Target: demo-apps/wallet-api (start it with `corepack pnpm start` in that folder).
// The `naive` variant breaks the first rule (overdraft); `lost-update` breaks the second.
//
// Accounts 1 and 2 start with 100 each, account 3 with 0. Requests alternate between
// "1 pays 3 everything" and "2 pays 3 everything", so each sender can succeed at most once,
// and two senders hit the same receiver at the same time.
import { scenario } from "deadheat";

const START = 100;
const TOTAL = 2 * START;

export default scenario({
  name: "wallet never overdraws and conserves money",
  baseUrl: "http://127.0.0.1:4200",
  setup: async ({ sql }) => {
    await sql`TRUNCATE transfers`;
    await sql`
      INSERT INTO accounts (id, balance) VALUES (1, ${START}), (2, ${START}), (3, 0)
      ON CONFLICT (id) DO UPDATE SET balance = EXCLUDED.balance`;
  },
  actions: {
    concurrency: 10,
    request: (i) => ({
      method: "POST",
      url: "/transfers",
      body: { fromId: i % 2 === 0 ? 1 : 2, toId: 3, amount: START },
    }),
  },
  invariant: async ({ sql }) => {
    const rows = await sql<{ id: number; balance: number }[]>`
      SELECT id, balance FROM accounts WHERE id IN (1, 2, 3) ORDER BY id`;
    const negative = rows.filter((r) => r.balance < 0);
    if (negative.length) {
      return `overdraft: ${negative.map((r) => `account ${r.id} = ${r.balance}`).join(", ")}`;
    }
    const total = rows.reduce((sum, r) => sum + r.balance, 0);
    return total === TOTAL || `money not conserved: total = ${total}, expected ${TOTAL}`;
  },
  trials: 100,
});
