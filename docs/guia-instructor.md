# Guía del instructor: Unidad 4

Esta guía complementa los documentos de los estudiantes:

- [Laboratorio 1: alta disponibilidad y failover](lab1-alta-disponibilidad.md)
- [Laboratorio 2: recuperación ante desastres cifrada](lab2-recuperacion-cifrada.md)

## Preparación (un día antes)

1. En la computadora del instructor, desde la raíz del repositorio:

   ```bash
   docker compose build
   ./scripts/setup-env.sh
   ./scripts/test-all.sh
   ```

   `test-all.sh` ejecuta unas 60 pruebas de integración en un proyecto Docker **aislado** (`cetys-dr-test`, puertos 13000, 13001 y 15433 a 15435) y lo elimina al terminar. Tarda de 2 a 5 minutos. El resumen queda en `test-results/ultimo-resultado.txt`. No toca el entorno de clase.

2. Prepare el entorno de demostración:

   ```bash
   docker compose up -d postgres-primary key-vault
   ./scripts/migrate.sh
   ./scripts/seed.sh
   docker compose up -d
   ./scripts/verify-setup.sh
   ```

3. Pida a los estudiantes que lleguen con Docker Desktop instalado, el repositorio clonado y `docker compose build` ya ejecutado (descarga unos 800 MB la primera vez). En Windows, en WSL2.

4. Tenga a la mano las credenciales:

   | Aplicación | Usuario | Contraseña |
   |---|---|---|
   | Hotel (admin) | `admin@hotel-lab.test` | `Admin2026!` |
   | Hotel (personal) | `recepcion@hotel-lab.test` | `Staff2026!` |
   | Hotel (cliente) | `cliente001@hotel-lab.test` ... `cliente150@hotel-lab.test` | `Cliente2026!` |
   | Key Vault | `vault_admin` | `VaultAdmin2026!` |
   | DBeaver | `lab_reader` | `DB_READER_PASSWORD` de cada `.env` |

## Laboratorio 1: agenda de 100 minutos

| Min | Actividad del estudiante | Qué demuestra el instructor | Punto de control |
|---|---|---|---|
| 0 a 10 | `./scripts/start.sh lab1` y `./scripts/status.sh` | Diagrama primario/standby; qué es WAL y streaming | 4 servicios `healthy`, `streaming` |
| 10 a 25 | Login como admin, revelar datos de 3 clientes, abrir **Recuperación** | Recorrido del Panel y la página Recuperación (activar *Actualizar cada 5 s*) | Descifrado exitoso |
| 25 a 40 | Dos conexiones DBeaver (5433 y 5434), `pg_is_in_recovery()`, `pg_stat_replication` | Diferencia entre `async` y `sync`; RPO | Identifican roles por SQL |
| 40 a 55 | Crear reservación y cliente; consultarlos en el standby; intentar escribir en el standby | La replicación copia bytes de WAL, por eso el cliente llega cifrado | Registros en el standby, escritura rechazada |
| 55 a 80 | `lab1-failover.sh` (rechazado), `docker compose stop postgres-primary`, observar la GUI, `lab1-failover.sh`, `docker compose up -d postgres-primary` (cercado) | Split brain y cerco (fencing); la app no cae aunque la BD sí | App en `postgres-standby`, primario cercado |
| 80 a 90 | Verificar conteos, revelar datos, nueva reservación, tabla de mediciones | Componentes del RTO: detección, decisión, promoción, reconexión | RTO anotado |
| 90 a 100 | Discusión, `./scripts/reset-lab.sh lab1` | Por qué la replicación no reemplaza respaldos (puente al laboratorio 2) | Entorno reconstruido |

### Demostración con la GUI (laboratorio 1)

1. Proyecte http://localhost:3000/dr con **Actualizar cada 5 s** activado.
2. Muestre la tabla **Servidores PostgreSQL del laboratorio**: el primario lista `pg-standby streaming`; el standby muestra receptor `streaming` y LSN de replay.
3. Cree una reservación en otra pestaña y regrese: el LSN del standby avanza.
4. Ejecute `docker compose stop postgres-primary`: en menos de 5 segundos aparece la alerta roja, el primario pasa a *Sin respuesta* y se abre un incidente.
5. Ejecute `./scripts/lab1-failover.sh`: el standby pasa a *Primario (escritura)*, la fila resaltada cambia a `postgres-standby (actual)`, el incidente se cierra con su duración y aparece la conmutación con la duración de la promoción.

### Errores frecuentes del laboratorio 1

- **Promover sin detener el primario:** el script lo rechaza; aproveche para explicar split brain.
- **Reiniciar todo con `docker compose up -d` después del failover:** el primario queda cercado y la app sigue en el standby; es el comportamiento esperado.
- **El estudiante cierra la terminal a la mitad:** `./scripts/status.sh` muestra dónde quedó; `./scripts/reset-lab.sh lab1` reconstruye.
- **Número de RTO alto:** es correcto; incluye el tiempo humano. Compárelo con la duración de la promoción.

## Laboratorio 2: agenda de 100 minutos

| Min | Actividad del estudiante | Qué demuestra el instructor | Punto de control |
|---|---|---|---|
| 0 a 10 | `./scripts/reset-lab.sh all` (si hace falta), `verify-setup.sh` | Línea de tiempo del ejercicio | 150 clientes, PASS |
| 10 a 25 | DBeaver: ciphertext, `kek_id`, `wrapped_dek`; hotel: revelar; Key Vault: KEKs y respaldos | Cifrado de sobre con el diagrama DEK/KEK | Explican dónde vive cada llave |
| 25 a 40 | `./scripts/backup.sh db`, `./scripts/status.sh`, `pg_stat_archiver` | Respaldo base frente a WAL continuo; `pg_verifybackup` | Respaldo verificado, 0 fallas de archivado |
| 40 a 50 | Crear cliente y reservación, `lab2-recovery-point.sh antes_borrado` | El cliente nuevo solo existe en el WAL | Punto creado con 151 clientes |
| 50 a 60 | `lab2-simulate-deletion.sh` (escribir `BORRAR`) | El error humano como desastre; se replicaría igual | 46 clientes en la app |
| 60 a 75 | `restore.sh pitr --name antes_borrado`, DBeaver 5435, revelar datos, **Verificar recuperación** | Recuperar en una instancia separada; `recovery_target_name`; timeline | 151 clientes descifrables |
| 75 a 90 | `docker compose stop/start key-vault`; simular pérdida del keystore; `restore.sh keys latest` | Sin KEK no hay datos; respaldo independiente de llaves | Descifrado restaurado |
| 90 a 100 | Discusión | RPO, RTO, separación de llaves y datos | |

### Demostración con la GUI (laboratorio 2)

1. **Seguridad y cifrado** (hotel): muestra que los 150 perfiles tienen los 20 campos cifrados, DEKs únicos, la tabla de `kek_id` contra los KEK existentes y una muestra del ciphertext real.
2. **Recuperación** (hotel): después de `backup.sh db` aparece el respaldo verificado; después de `lab2-recovery-point.sh` aparece el punto; después del PITR aparece la última recuperación con su duración y el servidor actual `postgres-recovery`.
3. **Panel del Key Vault**: los contadores **unwrap** suben cada vez que alguien revela un dato. Durante la pérdida del keystore el panel muestra *Keystore ausente* en rojo.
4. **Rotación** (opcional, si sobra tiempo): rote a `kek-v2`, cree un cliente, muestre que queda con `kek-v2` mientras CUS-0001 sigue con `kek-v1`, y use **Re-envolver DEKs al KEK activo**.

### Errores frecuentes del laboratorio 2

- **Crear el punto antes del respaldo:** `restore.sh` no encuentra un respaldo anterior al objetivo. Repita respaldo, punto y borrado (`reset-lab.sh all` si ya borró).
- **Ejecutar el borrado dos veces:** la segunda vez el script avisa que no hay clientes de México.
- **Esperar que el primario se recupere:** se recupera en `postgres-recovery` (puerto 5435) a propósito; el primario conserva el borrado para comparar.
- **Sesión del Key Vault perdida** tras `docker compose stop/start key-vault`: vuelva a iniciar sesión (las sesiones viven en memoria).

## Restablecimiento entre grupos

```bash
./scripts/reset-lab.sh lab1      # tras el laboratorio 1
./scripts/reset-lab.sh all       # para volver a 150 clientes (conserva llaves)
```

Para entregar una máquina limpia: `./scripts/reset-lab.sh all --include-keys` y después `docker compose --profile lab1 --profile lab2 down -v`.

## Mensajes clave para cerrar la unidad

1. **Alta disponibilidad ≠ respaldo.** La replicación protege contra la caída de un servidor, no contra errores humanos.
2. **El RTO incluye a las personas.** El failover manual es seguro pero lento; el automático es rápido pero arriesga split brain.
3. **Un respaldo sin pruebas de restauración no es un respaldo.** Por eso existe el botón Verificar recuperación.
4. **Las llaves son parte del plan de recuperación.** Respaldar la base sin respaldar (por separado) los KEK equivale a no tener respaldo de los datos cifrados.
5. **La autorización va en el backend.** Ocultar un botón no impide un BOLA/IDOR; la prueba con `cliente001` lo demuestra.
