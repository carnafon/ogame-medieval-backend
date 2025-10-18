-- Migration 005: Move population columns from entities to populations and add per-type current/max/available

BEGIN;

-- Add new columns to populations for per-type population tracking
ALTER TABLE populations
  ADD COLUMN IF NOT EXISTS current_population INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_population INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS available_population INTEGER NOT NULL DEFAULT 0;

-- If we previously stored 'amount' as a proxy for current_population, migrate it
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='populations' AND column_name='amount') THEN
    UPDATE populations SET current_population = amount, max_population = amount, available_population = GREATEST(0, amount - 0);
    ALTER TABLE populations DROP COLUMN IF EXISTS amount;
  END IF;
END$$;

-- Drop legacy columns from entities (if they exist)
ALTER TABLE entities DROP COLUMN IF EXISTS current_population;
ALTER TABLE entities DROP COLUMN IF EXISTS max_population;

COMMIT;
