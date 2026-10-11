-- Booking demo schema. Applied on every server start, so it must be idempotent.
-- Deliberately NO constraint that limits bookings per slot: the oversell bug must stay reachable.

CREATE TABLE IF NOT EXISTS slots (
  id       SERIAL PRIMARY KEY,
  capacity INT NOT NULL DEFAULT 1 CHECK (capacity >= 0)
);

CREATE TABLE IF NOT EXISTS bookings (
  id         SERIAL PRIMARY KEY,
  slot_id    INT NOT NULL REFERENCES slots (id),
  user_id    INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seats claimed so far, used only by the `conditional` fix (an atomic counter to update).
ALTER TABLE slots ADD COLUMN IF NOT EXISTS booked INT NOT NULL DEFAULT 0;

INSERT INTO slots (id, capacity) VALUES (1, 1) ON CONFLICT (id) DO NOTHING;
