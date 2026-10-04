-- Wallet demo schema. Applied on every server start, so it must be idempotent.
-- Deliberately NO `CHECK (balance >= 0)`: that constraint is one of the fixes, and the
-- overdraft bug must stay reachable.

CREATE TABLE IF NOT EXISTS accounts (
  id      SERIAL PRIMARY KEY,
  balance INT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS transfers (
  id         SERIAL PRIMARY KEY,
  from_id    INT NOT NULL REFERENCES accounts (id),
  to_id      INT NOT NULL REFERENCES accounts (id),
  amount     INT NOT NULL CHECK (amount > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO accounts (id, balance) VALUES (1, 100), (2, 100), (3, 0) ON CONFLICT (id) DO NOTHING;
