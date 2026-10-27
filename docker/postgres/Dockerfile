FROM postgres:16-alpine

COPY init-vault.sql /docker-entrypoint-initdb.d/10-init-vault.sql
RUN chmod 644 /docker-entrypoint-initdb.d/10-init-vault.sql
