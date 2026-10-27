FROM postgres:16-alpine

RUN mkdir -p /usr/local/share/jobbot
COPY init-vault.sql /docker-entrypoint-initdb.d/10-init-vault.sql
COPY init-vault.sql /usr/local/share/jobbot/init-vault.sql
RUN chmod 644 /docker-entrypoint-initdb.d/10-init-vault.sql /usr/local/share/jobbot/init-vault.sql
