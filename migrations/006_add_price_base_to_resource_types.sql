-- Migration: add price_base integer column to resource_types and populate defaults
BEGIN;

ALTER TABLE resource_types
  ADD COLUMN IF NOT EXISTS price_base integer DEFAULT 0 NOT NULL;

-- Populate initial prices (integers) according to category:
-- comunes = 1, procesados = 3, especializados = 6, estrategicos = 30, gold = 150
UPDATE resource_types
SET price_base = CASE
  WHEN lower(name) = 'gold' THEN 150

  WHEN lower(name) IN (
    'rare_iron', 'sea_salt', 'linen', 'gold_dye', 'sulfur', 'precious_gems', 'gems', 'royal_silk'
  ) THEN 30

  WHEN lower(name) IN (
    'spice', 'damascus_steel', 'preservation_elixir', 'explosive_compound',
    'royal_dye', 'illustrated_parchment', 'magic_catalyst', 'silk'
  ) THEN 6

  WHEN lower(name) IN (
    'lumber', 'tools', 'iron_ingot', 'beer', 'baked_brick', 'textile',
    'silk_cloth', 'salted', 'refined_clay', 'books', 'purple_dye'
  ) THEN 3

  WHEN lower(name) IN (
    'wood', 'stone', 'food', 'water', 'clay', 'leather', 'coal', 'copper',
    'wool', 'honey'
  ) THEN 1

  ELSE 3
END
WHERE name IS NOT NULL;

COMMIT;
