-- Migration: add ai_runtime JSONB to entities

ALTER TABLE entities
ADD COLUMN IF NOT EXISTS ai_runtime JSONB DEFAULT '{}'::jsonb;
