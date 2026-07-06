CREATE TABLE IF NOT EXISTS ingredientes (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  restaurante_id BIGINT UNSIGNED NOT NULL,
  nombre VARCHAR(150) NOT NULL,
  unidad_base ENUM('UNIDAD', 'GRAMO', 'MILILITRO') NOT NULL,
  activo TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_ingrediente_restaurante_nombre (restaurante_id, nombre),
  KEY idx_ingrediente_restaurante (restaurante_id, activo),
  CONSTRAINT fk_ingrediente_restaurante
    FOREIGN KEY (restaurante_id) REFERENCES restaurantes (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS producto_recetas (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  producto_id BIGINT UNSIGNED NOT NULL,
  ingrediente_id BIGINT UNSIGNED NOT NULL,
  cantidad DECIMAL(12,3) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_receta_producto_ingrediente (producto_id, ingrediente_id),
  KEY idx_receta_ingrediente (ingrediente_id),
  CONSTRAINT fk_receta_producto
    FOREIGN KEY (producto_id) REFERENCES productos (id),
  CONSTRAINT fk_receta_ingrediente
    FOREIGN KEY (ingrediente_id) REFERENCES ingredientes (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
