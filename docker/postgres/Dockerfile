FROM postgres:16-alpine

RUN mkdir -p /usr/local/share/jobbot
COPY init-vault.sql /usr/local/share/jobbot/init-vault.sql
RUN chmod 644 /usr/local/share/jobbot/init-vault.sql
