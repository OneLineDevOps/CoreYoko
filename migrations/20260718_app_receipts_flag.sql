ALTER TABLE restaurantes
  ADD COLUMN IF NOT EXISTS app_comprobantes_activo TINYINT(1) NOT NULL DEFAULT 0 AFTER sunat_activo;
