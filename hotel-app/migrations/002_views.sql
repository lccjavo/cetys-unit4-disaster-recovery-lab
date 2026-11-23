-- 002_views.sql
-- Vistas de apoyo para inspeccion con DBeaver. No exponen informacion en claro:
-- solo muestran metadatos de cifrado y fragmentos de ciphertext.

CREATE OR REPLACE VIEW v_customer_encryption_overview AS
SELECT
    c.id                                   AS customer_id,
    c.customer_code,
    c.full_name,
    c.city,
    c.country,
    k.kek_id,
    k.dek_ref,
    LEFT(k.wrapped_dek, 24)                AS wrapped_dek_preview,
    s.encryption_algorithm,
    s.encryption_schema_version,
    (SELECT count(*) FROM jsonb_object_keys(s.encrypted_fields)) AS encrypted_field_count,
    LEFT(s.encrypted_fields -> 'phone_number' ->> 'ciphertext', 24) AS phone_ciphertext_preview
FROM customers c
JOIN customer_sensitive_data s ON s.customer_id = c.id
JOIN customer_keys k ON k.customer_id = c.id;

CREATE OR REPLACE VIEW v_kek_usage AS
SELECT kek_id, count(*) AS customers, min(created_at) AS first_wrapped_at, max(coalesce(rewrapped_at, created_at)) AS last_wrapped_at
FROM customer_keys
GROUP BY kek_id;
