-- Migration: scale existing price_base values by 20
BEGIN;

-- Multiply all existing integer price_base values by 20
UPDATE resource_types
SET price_base = price_base * 20
WHERE price_base IS NOT NULL;

COMMIT;
