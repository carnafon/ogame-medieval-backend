-- 001_add_last_resource_update.sql
-- Migración: añadir columna last_resource_update a la tabla users
-- Up: añade la columna si no existe y la inicializa para filas existentes
-- Down: elimina la columna si existe

-- NOTAS:
-- - Requiere privilegios para alterar la tabla `users`.
-- - Ejecuta esto en la base de datos correcta (producción, staging o dev).

BEGIN;

-- Añadir la columna si no existe (timestamp sin zona; usamos NOW() por defecto para nuevas filas)
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS last_resource_update TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW();

-- Rellenar valores NULL para filas existentes con NOW() (o con otra fecha si prefieres)
UPDATE users
  SET last_resource_update = NOW()
  WHERE last_resource_update IS NULL;

COMMIT;

-- --------------------------------------------------
-- Para revertir (DOWN):
-- BEGIN;
-- ALTER TABLE users DROP COLUMN IF EXISTS last_resource_update;
-- COMMIT;
-- --------------------------------------------------
