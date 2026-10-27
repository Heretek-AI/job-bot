FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV JOBPILOT_DIST_DIR=/opt/jobpilot-dist
ENV JOBPILOT_INSTALL_DIR=/root/.jobpilot
ENV PATH="/root/.jobpilot:/root/.local/bin:/root/.bun/bin:${PATH}"

# 1. System dependencies + Node.js 26 + Python 3 + ICU/libssl for .NET NativeAOT binary
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    jq \
    unzip \
    xz-utils \
    python3 \
    python3-pip \
    python3-venv \
    python3-pypdf \
    poppler-utils \
    libicu74 \
    libssl3t64 \
    procps \
    && curl -fsSL https://deb.nodesource.com/setup_26.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# 2. Install Bun & uv
RUN curl -fsSL https://bun.sh/install | bash \
    && curl -LsSf https://astral.sh/uv/install.sh | sh

# 3. Install pinned Claude Code CLI & Playwright MCP globally
RUN npm install -g @anthropic-ai/claude-code@2.1.312 @playwright/mcp@0.0.83

# 4. Install JobPilot Terminal Host binary + bundled plugin/ outside the /root/.jobpilot volume
# so container image upgrades never get shadowed by the persistent terminal-data volume.
RUN JOBPILOT_INSTALL_DIR=/opt/jobpilot-dist \
    bash -c "curl -fsSL https://raw.githubusercontent.com/suxrobGM/jobpilot/08fa978ecac0da68b0ee5694c93c0d94f18b4d9f/apps/terminal/install.sh | bash"

# 5. Clone pinned career-ops-hq/career-ops for zero-token ATS portal scanning & HTML->PDF generation
ARG CAREER_OPS_COMMIT=82d20c858e83c4fb8ba8d868024e31684a3929a2
RUN git clone https://github.com/career-ops-hq/career-ops.git /opt/career-ops \
    && cd /opt/career-ops \
    && git checkout "${CAREER_OPS_COMMIT}" \
    && npm install --omit=dev --ignore-scripts

# 6. Build custom jobbot-mcp server (Gmail IMAP 2FA/OTP + ATS Password Vault + Captcha + Career-Ops bridge)
WORKDIR /opt/jobbot-mcp
COPY mcp/jobbot-mcp/package.json mcp/jobbot-mcp/package-lock.json mcp/jobbot-mcp/tsconfig.json ./
RUN npm ci
COPY mcp/jobbot-mcp/src ./src
RUN npm run build

# 7. Copy container entrypoint
COPY docker/terminal/entrypoint.sh /usr/local/bin/terminal-entrypoint.sh
RUN sed -i 's/\r$//' /usr/local/bin/terminal-entrypoint.sh \
    && chmod +x /usr/local/bin/terminal-entrypoint.sh \
    && mkdir -p /app/shared/resumes /root/.claude /root/.jobpilot

WORKDIR /root/.jobpilot
ENV DOTNET_EnableWriteXorExecute=0
EXPOSE 4102

ENTRYPOINT ["/usr/local/bin/terminal-entrypoint.sh"]
