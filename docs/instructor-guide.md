# Instructor Guide: Unit 4

This guide complements the student documents:

- [Lab 1: High availability and failover](lab1-high-availability.md)
- [Lab 2: Encrypted disaster recovery](lab2-encrypted-recovery.md)

## Preparation (the day before)

1. On the instructor machine, from the repository root:

   ```bash
   docker compose build
   ./scripts/setup-env.sh
   ./scripts/test-all.sh
   ```

   `test-all.sh` runs about 60 integration tests in an **isolated** Docker project (`cetys-dr-test`, ports 13000, 13001 and 15433 to 15435) and deletes it when it finishes. It takes 2 to 5 minutes. The summary is saved in `test-results/latest-results.txt`. It does not touch the class environment.

2. Prepare the demo environment:

   ```bash
   docker compose up -d postgres-primary key-vault
   ./scripts/migrate.sh
   ./scripts/seed.sh
   docker compose up -d
   ./scripts/verify-setup.sh
   ```

3. Ask students to arrive with Docker Desktop installed, the repository cloned and `docker compose build` already run (it downloads about 800 MB the first time). On Windows, inside WSL2.

4. Keep the credentials at hand:

   | Application | Username | Password |
   |---|---|---|
   | Hotel (admin) | `admin@hotel-lab.test` | `Admin2026!` |
   | Hotel (staff) | `frontdesk@hotel-lab.test` | `Staff2026!` |
   | Hotel (customer) | `customer001@hotel-lab.test` ... `customer150@hotel-lab.test` | `Customer2026!` |
   | Key Vault | `vault_admin` | `VaultAdmin2026!` |
   | DBeaver | `lab_reader` | `DB_READER_PASSWORD` from each `.env` |

## Lab 1: 100-minute schedule

| Min | Student activity | Instructor demonstration | Checkpoint |
|---|---|---|---|
| 0 to 10 | `./scripts/start.sh lab1` and `./scripts/status.sh` | Primary/standby diagram; what WAL and streaming are | 4 services `healthy`, `streaming` |
| 10 to 25 | Sign in as admin, reveal data for 3 customers, open **Recovery** | Tour of the Dashboard and the Recovery page (turn on *Refresh every 5 s*) | Successful decryption |
| 25 to 40 | Two DBeaver connections (5433 and 5434), `pg_is_in_recovery()`, `pg_stat_replication` | `async` vs. `sync`; RPO | Roles identified with SQL |
| 40 to 55 | Create a reservation and a customer; query them on the standby; try to write to the standby | Replication copies WAL bytes, which is why the customer arrives encrypted | Records on the standby, write rejected |
| 55 to 80 | `lab1-failover.sh` (refused), `docker compose stop postgres-primary`, watch the GUI, `lab1-failover.sh`, `docker compose up -d postgres-primary` (fenced) | Split brain and fencing; the app stays up even though the database does not | App on `postgres-standby`, primary fenced |
| 80 to 90 | Verify counts, reveal data, new reservation, measurements table | RTO components: detection, decision, promotion, reconnection | RTO recorded |
| 90 to 100 | Discussion, `./scripts/reset-lab.sh lab1` | Why replication does not replace backups (bridge to Lab 2) | Environment rebuilt |

### GUI demonstration (Lab 1)

1. Project http://localhost:3000/dr with **Refresh every 5 s** turned on.
2. Show the **Lab PostgreSQL servers** table: the primary lists `pg-standby streaming`; the standby shows WAL receiver `streaming` and its replay LSN.
3. Create a reservation in another tab and come back: the standby LSN moves forward.
4. Run `docker compose stop postgres-primary`: within 5 seconds the red alert appears, the primary turns *Not responding*, and an incident opens.
5. Run `./scripts/lab1-failover.sh`: the standby becomes *Primary (writable)*, the highlighted row changes to `postgres-standby (current)`, the incident closes with its duration, and the failover appears with the promotion duration.

### Common mistakes in Lab 1

- **Promoting without stopping the primary:** the script refuses; use it to explain split brain.
- **Restarting everything with `docker compose up -d` after the failover:** the primary stays fenced and the app stays on the standby; that is the expected behavior.
- **A student closes the terminal halfway:** `./scripts/status.sh` shows where things are; `./scripts/reset-lab.sh lab1` rebuilds.
- **A high RTO number:** that is correct; it includes human time. Compare it with the promotion duration.

## Lab 2: 100-minute schedule

| Min | Student activity | Instructor demonstration | Checkpoint |
|---|---|---|---|
| 0 to 10 | `./scripts/reset-lab.sh all` (if needed), `verify-setup.sh` | The exercise timeline | 150 customers, PASS |
| 10 to 25 | DBeaver: ciphertext, `kek_id`, `wrapped_dek`; hotel: reveal; Key Vault: KEKs and backups | Envelope encryption with the DEK/KEK diagram | They can explain where each key lives |
| 25 to 40 | `./scripts/backup.sh db`, `./scripts/status.sh`, `pg_stat_archiver` | Base backup vs. continuous WAL; `pg_verifybackup` | Verified backup, 0 archive failures |
| 40 to 50 | Create a customer and a reservation, `lab2-recovery-point.sh before_deletion` | The new customer exists only in the WAL | Point created with 151 customers |
| 50 to 60 | `lab2-simulate-deletion.sh` (type `DELETE`) | Human error as a disaster; it would be replicated too | 46 customers in the app |
| 60 to 75 | `restore.sh pitr --name before_deletion`, DBeaver 5435, reveal data, **Verify recovery** | Recovering into a separate instance; `recovery_target_name`; timelines | 151 decryptable customers |
| 75 to 90 | `docker compose stop/start key-vault`; simulate keystore loss; `restore.sh keys latest` | No KEK, no data; the independent key backup | Decryption restored |
| 90 to 100 | Discussion | RPO, RTO, separating keys from data | |

### GUI demonstration (Lab 2)

1. **Security and encryption** (hotel): shows that all 150 profiles have their 20 fields encrypted, unique DEKs, the `kek_id` table compared with the KEKs that exist, and a sample of the real ciphertext.
2. **Recovery** (hotel): after `backup.sh db` the verified backup appears; after `lab2-recovery-point.sh` the point appears; after the PITR the last recovery appears with its duration, and the current server is `postgres-recovery`.
3. **Key Vault dashboard**: the **unwrap** counter goes up every time someone reveals a value. During the keystore loss the dashboard shows *Keystore missing* in red.
4. **Rotation** (optional, if time allows): rotate to `kek-v2`, create a customer, show that it gets `kek-v2` while CUS-0001 stays on `kek-v1`, and use **Re-wrap DEKs with the active KEK**.

### Common mistakes in Lab 2

- **Creating the point before the backup:** `restore.sh` cannot find a backup taken before the target. Repeat backup, point and deletion (`reset-lab.sh all` if the deletion already happened).
- **Running the deletion twice:** the second time the script warns that there are no customers from Mexico.
- **Expecting the primary to be recovered:** recovery happens on `postgres-recovery` (port 5435) on purpose; the primary keeps the deletion for comparison.
- **Key Vault session lost** after `docker compose stop/start key-vault`: sign in again (sessions live in memory).

## Resetting between groups

```bash
./scripts/reset-lab.sh lab1      # after Lab 1
./scripts/reset-lab.sh all       # back to 150 customers (keeps the keys)
```

To hand over a clean machine: `./scripts/reset-lab.sh all --include-keys`, then `docker compose --profile lab1 --profile lab2 down -v`.

## Key messages to close the unit

1. **High availability is not a backup.** Replication protects against a server failure, not against human error.
2. **RTO includes people.** Manual failover is safe but slow; automatic failover is fast but risks split brain.
3. **A backup that has never been restored is not a backup.** That is why the Verify recovery button exists.
4. **Keys are part of the recovery plan.** Backing up the database without (separately) backing up the KEKs is the same as having no backup of the encrypted data.
5. **Authorization belongs in the backend.** Hiding a button does not stop BOLA/IDOR; the `customer001` test shows it.
