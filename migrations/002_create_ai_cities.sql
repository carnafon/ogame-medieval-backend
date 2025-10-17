-- Migration: create minimal ai_cities table
-- The AI runtime data will live in the linked `entities.ai_runtime` JSONB field.

CREATE TABLE IF NOT EXISTS ai_cities (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  entity_id INTEGER NULL REFERENCES entities(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

