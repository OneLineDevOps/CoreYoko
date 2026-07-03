ALTER TABLE restaurantes
  ADD COLUMN igv_porcentaje DECIMAL(5,2) NOT NULL DEFAULT 18.00 AFTER telefono;

UPDATE restaurantes
SET igv_porcentaje = 10.50
WHERE LOWER(nombre) LIKE '%chaparral%';

ALTER TABLE comprobantes
  ADD COLUMN igv_porcentaje DECIMAL(5,2) NOT NULL DEFAULT 18.00 AFTER igv;
