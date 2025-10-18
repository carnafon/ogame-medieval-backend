-- Migration 004: create populations table and migrate entity population columns

BEGIN;

-- Create populations table
CREATE TABLE IF NOT EXISTS populations (
  id SERIAL PRIMARY KEY,
  entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  type VARCHAR(32) NOT NULL, -- 'poor', 'burgess', 'patrician'
  available_population INTEGER NOT NULL DEFAULT 1,
  current_population INTEGER NOT NULL DEFAULT 1,
  max_population INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  UNIQUE(entity_id, type)
);

-- Add trigger to update updated_at on change (optional)
CREATE OR REPLACE FUNCTION populations_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER populations_updated_at_trigger
BEFORE UPDATE ON populations
FOR EACH ROW
EXECUTE PROCEDURE populations_updated_at();

COMMIT;
