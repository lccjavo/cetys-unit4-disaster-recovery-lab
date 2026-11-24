-- =====================================================================
-- Queries for DBeaver (read-only account lab_reader)
-- Connection: 127.0.0.1:5433, database hotel_lab
-- All of them run in the automated tests (./scripts/test-all.sh).
-- =====================================================================

-- 1. Count users (total and per role)
SELECT count(*) AS total_users FROM users;
SELECT role, count(*) AS users FROM users GROUP BY role ORDER BY role;

-- 2. List 10 customers
SELECT id, customer_code, full_name, status, loyalty_tier
FROM customers
ORDER BY id
LIMIT 10;

-- 3. City and country (operational data, no application encryption)
SELECT country, city, count(*) AS customers
FROM customers
GROUP BY country, city
ORDER BY customers DESC, city;

-- 4. Inspect the encrypted phone number of customer 1
SELECT c.id,
       c.full_name,
       s.encrypted_fields -> 'phone_number' ->> 'ciphertext' AS phone_ciphertext,
       s.encrypted_fields -> 'phone_number' ->> 'nonce'      AS phone_nonce,
       s.encrypted_fields -> 'phone_number' ->> 'tag'        AS phone_tag,
       s.encrypted_fields -> 'phone_number' ->> 'alg'        AS algorithm
FROM customers c
JOIN customer_sensitive_data s ON s.customer_id = c.id
WHERE c.id = 1;

-- 5. Inspect an encrypted financial field (test card and CLABE)
SELECT c.id,
       c.customer_code,
       s.encrypted_fields -> 'card_number' ->> 'ciphertext' AS card_ciphertext,
       length(decode(s.encrypted_fields -> 'card_number' ->> 'ciphertext', 'base64')) AS card_bytes,
       s.encrypted_fields -> 'clabe' ->> 'ciphertext' AS clabe_ciphertext
FROM customers c
JOIN customer_sensitive_data s ON s.customer_id = c.id
WHERE c.id = 1;

-- 6. Every customer has its OWN KEK: kek_id = kek-<customer_code>-v<N>
SELECT c.id AS customer_id, c.customer_code, k.kek_id, k.dek_ref
FROM customer_keys k
JOIN customers c ON c.id = k.customer_id
ORDER BY c.id
LIMIT 10;

SELECT count(*) AS customers,
       count(DISTINCT k.kek_id) AS distinct_keks,
       count(*) FILTER (WHERE k.kek_id LIKE 'kek-' || lower(c.customer_code) || '-v%') AS on_their_own_kek
FROM customer_keys k
JOIN customers c ON c.id = k.customer_id;

-- 7. Inspect a wrapped DEK (32 bytes of DEK encrypted with the KEK)
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

-- 8. Relationship user -> customer -> encrypted data -> wrapped key
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

-- 9. Count reservations (total and per status)
SELECT count(*) AS total_reservations FROM reservations;
SELECT status, count(*) AS reservations FROM reservations GROUP BY status ORDER BY status;

-- 10. Confirm the ciphertext is still in PostgreSQL even when the Key Vault is unavailable
--     (run it with the Key Vault stopped: PostgreSQL does not depend on it)
SELECT count(*) AS encrypted_profiles,
       count(*) FILTER (WHERE encrypted_fields ? 'phone_number') AS with_encrypted_phone,
       min((SELECT count(*) FROM jsonb_object_keys(encrypted_fields))) AS min_fields,
       max((SELECT count(*) FROM jsonb_object_keys(encrypted_fields))) AS max_fields
FROM customer_sensitive_data;

-- 11. Show that PostgreSQL stores no KEK: the only related column is the kek_id reference
SELECT table_name, column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public' AND (column_name ILIKE '%kek%' OR column_name ILIKE '%dek%')
ORDER BY table_name, column_name;

-- 12. Helper view with encryption metadata
SELECT * FROM v_customer_encryption_overview ORDER BY customer_id LIMIT 5;

-- 13. Server state: primary or standby, timeline and name
SELECT current_setting('cluster_name') AS server,
       pg_is_in_recovery() AS is_standby,
       (SELECT timeline_id FROM pg_control_checkpoint()) AS timeline;

-- 14. Lab 1: replication seen from the primary (empty when run on the standby)
SELECT application_name, client_addr, state, sync_state, replay_lsn
FROM pg_stat_replication;

-- 15. Lab 2: WAL archiving
SELECT archived_count, last_archived_wal, last_archived_time, failed_count
FROM pg_stat_archiver;

-- 16. Latest audit events (they never contain sensitive values)
SELECT occurred_at, actor_username, action, target_type, target_id, outcome
FROM audit_events
ORDER BY occurred_at DESC
LIMIT 15;
