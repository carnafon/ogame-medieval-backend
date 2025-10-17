-- Migration: create map_entities table
-- Associates entity_id with map coordinates and optionally an ai_city_id

CREATE TABLE IF NOT EXISTS map_entities (
  id SERIAL PRIMARY KEY,
  entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  x_coord INTEGER NOT NULL,
  y_coord INTEGER NOT NULL,
  ai_city_id INTEGER NULL REFERENCES ai_cities(id) ON DELETE SET NULL,
  runtime JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_map_entities_coords ON map_entities(x_coord, y_coord);
