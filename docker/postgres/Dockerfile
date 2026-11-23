# PostgreSQL 17 image for the lab (primary, standby and recovery).
FROM postgres:17-bookworm

COPY lab-entrypoint.sh archive-wal.sh lab-basebackup.sh lab-prepare-recovery.sh /usr/local/bin/
COPY initdb/ /docker-entrypoint-initdb.d/

RUN chmod 0755 /usr/local/bin/lab-entrypoint.sh /usr/local/bin/archive-wal.sh \
        /usr/local/bin/lab-basebackup.sh /usr/local/bin/lab-prepare-recovery.sh \
    && chmod 0755 /docker-entrypoint-initdb.d/*.sh \
    && mkdir -p /wal-archive /backups/catalog /lab-control \
    && chown postgres:postgres /wal-archive /backups /backups/catalog \
    && chmod 0755 /wal-archive /backups /backups/catalog \
    && chmod 1777 /lab-control

ENTRYPOINT ["lab-entrypoint.sh"]
CMD ["postgres"]
