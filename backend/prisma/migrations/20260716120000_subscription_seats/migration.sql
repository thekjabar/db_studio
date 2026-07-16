-- Dynamic per-seat billing: how many seats the workspace has paid for.
ALTER TABLE "Subscription" ADD COLUMN IF NOT EXISTS "seats" INTEGER NOT NULL DEFAULT 1;
