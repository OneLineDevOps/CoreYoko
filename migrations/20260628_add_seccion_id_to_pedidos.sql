ALTER TABLE pedidos
  ADD COLUMN seccion_id BIGINT(20) UNSIGNED NULL AFTER mesa_id,
  ADD KEY fk_pedido_seccion (seccion_id),
  ADD CONSTRAINT fk_pedido_seccion
    FOREIGN KEY (seccion_id) REFERENCES secciones_mesa (id);
