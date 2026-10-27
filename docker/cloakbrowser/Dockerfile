FROM cloakhq/cloakbrowser@sha256:9e08a8f391d322810b72315fb06a102d98d51071767330ef381c4bc05626b5a6

USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    socat \
    python3 \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -c "import cloakbrowser; print('CloakBrowser module verified:', cloakbrowser.__name__)"

RUN mkdir -p /data/profile /app/shared/resumes

COPY entrypoint.sh /usr/local/bin/cloak-entrypoint.sh
RUN chmod +x /usr/local/bin/cloak-entrypoint.sh

EXPOSE 9222

ENTRYPOINT ["/usr/local/bin/cloak-entrypoint.sh"]
