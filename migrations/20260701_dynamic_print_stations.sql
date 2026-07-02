ALTER TABLE impresora_propositos
  MODIFY COLUMN proposito VARCHAR(100) NOT NULL;

ALTER TABLE trabajos_impresion
  MODIFY COLUMN proposito VARCHAR(100) NOT NULL;

DELETE duplicate_assignment
FROM producto_estaciones duplicate_assignment
JOIN producto_estaciones original_assignment
  ON original_assignment.producto_id = duplicate_assignment.producto_id
 AND original_assignment.estacion_id = duplicate_assignment.estacion_id
 AND original_assignment.id < duplicate_assignment.id;

ALTER TABLE producto_estaciones
  ADD UNIQUE KEY uk_producto_estacion (producto_id, estacion_id);
