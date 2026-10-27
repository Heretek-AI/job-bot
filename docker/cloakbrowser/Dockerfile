FROM cloakhq/cloakbrowser:latest

USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    socat \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /data/profile /app/shared/resumes

COPY entrypoint.sh /usr/local/bin/cloak-entrypoint.sh
RUN chmod +x /usr/local/bin/cloak-entrypoint.sh

EXPOSE 9222

ENTRYPOINT ["/usr/local/bin/cloak-entrypoint.sh"]
