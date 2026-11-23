-- =====================================================================
-- Consultas para DBeaver (cuenta de solo lectura lab_reader)
-- Conexion: 127.0.0.1:5433, base hotel_lab
-- Todas se ejecutan en las pruebas automatizadas (./scripts/test-all.sh).
-- =====================================================================

-- 1. Contar usuarios (total y por rol)
SELECT count(*) AS total_usuarios FROM users;
SELECT role, count(*) AS usuarios FROM users GROUP BY role ORDER BY role;

-- 2. Listar 10 clientes
SELECT id, customer_code, full_name, status, loyalty_tier
FROM customers
ORDER BY id
LIMIT 10;

-- 3. Ciudad y pais (datos operativos, sin cifrado de aplicacion)
SELECT country, city, count(*) AS clientes
FROM customers
GROUP BY country, city
ORDER BY clientes DESC, city;

-- 4. Inspeccionar el telefono cifrado del cliente 1
SELECT c.id,
       c.full_name,
       s.encrypted_fields -> 'phone_number' ->> 'ciphertext' AS phone_ciphertext,
       s.encrypted_fields -> 'phone_number' ->> 'nonce'      AS phone_nonce,
       s.encrypted_fields -> 'phone_number' ->> 'tag'        AS phone_tag,
       s.encrypted_fields -> 'phone_number' ->> 'alg'        AS algoritmo
FROM customers c
JOIN customer_sensitive_data s ON s.customer_id = c.id
WHERE c.id = 1;

-- 5. Inspeccionar un campo financiero cifrado (tarjeta de prueba y CLABE)
SELECT c.id,
       c.customer_code,
       s.encrypted_fields -> 'card_number' ->> 'ciphertext' AS card_ciphertext,
       length(decode(s.encrypted_fields -> 'card_number' ->> 'ciphertext', 'base64')) AS card_bytes,
       s.encrypted_fields -> 'clabe' ->> 'ciphertext' AS clabe_ciphertext
FROM customers c
JOIN customer_sensitive_data s ON s.customer_id = c.id
WHERE c.id = 1;

-- 6. Leer el kek_id de cada cliente y cuantos DEK envuelve cada KEK
SELECT customer_id, kek_id, dek_ref
FROM customer_keys
ORDER BY customer_id
LIMIT 10;

SELECT kek_id, count(*) AS clientes
FROM customer_keys
GROUP BY kek_id
ORDER BY kek_id;

-- 7. Inspeccionar un DEK envuelto (32 bytes de DEK cifrados con el KEK)
SELECT customer_id,
       dek_ref,
       wrapped_dek,
       length(decode(wrapped_dek, 'base64')) AS wrapped_bytes,
       dek_wrap_nonce,
       dek_wrap_tag,
       kek_id,
       wrap_algorithm,
       encryption_schema_version
FROM customer_keys
WHERE customer_id = 1;

-- 8. Relacion usuario -> cliente -> datos cifrados -> llave envuelta
SELECT
    u.id AS user_id,
    u.username,
    c.id AS customer_id,
    c.full_name,
    c.city,
    c.country,
    k.kek_id,
    LEFT(s.encrypted_fields -> 'phone_number' ->> 'ciphertext', 32) AS encrypted_phone_preview,
    LEFT(k.wrapped_dek, 32) AS wrapped_dek_preview
FROM users u
JOIN customers c ON c.user_id = u.id
JOIN customer_sensitive_data s ON s.customer_id = c.id
JOIN customer_keys k ON k.customer_id = c.id
ORDER BY c.id
LIMIT 10;

-- 9. Contar reservaciones (total y por estado)
SELECT count(*) AS total_reservaciones FROM reservations;
SELECT status, count(*) AS reservaciones FROM reservations GROUP BY status ORDER BY status;

-- 10. Confirmar que el ciphertext sigue en PostgreSQL aunque el Key Vault no este disponible
--     (ejecutela con el Key Vault detenido: PostgreSQL no depende de el)
SELECT count(*) AS perfiles_cifrados,
       count(*) FILTER (WHERE encrypted_fields ? 'phone_number') AS con_telefono_cifrado,
       min((SELECT count(*) FROM jsonb_object_keys(encrypted_fields))) AS campos_minimos,
       max((SELECT count(*) FROM jsonb_object_keys(encrypted_fields))) AS campos_maximos
FROM customer_sensitive_data;

-- 11. Demostrar que PostgreSQL no guarda KEK: la unica columna relacionada es la referencia kek_id
SELECT table_name, column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public' AND (column_name ILIKE '%kek%' OR column_name ILIKE '%dek%')
ORDER BY table_name, column_name;

-- 12. Vista de apoyo con metadatos de cifrado
SELECT * FROM v_customer_encryption_overview ORDER BY customer_id LIMIT 5;

-- 13. Estado del servidor: primario o standby, linea de tiempo y nombre
SELECT current_setting('cluster_name') AS servidor,
       pg_is_in_recovery() AS es_standby,
       (SELECT timeline_id FROM pg_control_checkpoint()) AS timeline;

-- 14. Laboratorio 1: replicacion vista desde el primario (vacia si se ejecuta en el standby)
SELECT application_name, client_addr, state, sync_state, replay_lsn
FROM pg_stat_replication;

-- 15. Laboratorio 2: archivado de WAL
SELECT archived_count, last_archived_wal, last_archived_time, failed_count
FROM pg_stat_archiver;

-- 16. Ultimos eventos de auditoria (nunca contienen valores sensibles)
SELECT occurred_at, actor_username, action, target_type, target_id, outcome
FROM audit_events
ORDER BY occurred_at DESC
LIMIT 15;
