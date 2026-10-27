FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV JOBPILOT_INSTALL_DIR=/root/.jobpilot
ENV PATH="/root/.jobpilot:/root/.local/bin:/root/.bun/bin:${PATH}"

# 1. System dependencies + Node.js 22 + Python 3 + ICU/libssl for .NET NativeAOT binary
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
    libicu74 \
    libssl3t64 \
    procps \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# 2. Install Bun & uv
RUN curl -fsSL https://bun.sh/install | bash \
    && curl -LsSf https://astral.sh/uv/install.sh | sh

# 3. Install Claude Code CLI & Playwright MCP globally
RUN npm install -g @anthropic-ai/claude-code@latest @playwright/mcp@latest

# 4. Install JobPilot Terminal Host binary + bundled plugin/ directory
RUN curl -fsSL https://raw.githubusercontent.com/suxrobGM/jobpilot/main/apps/terminal/install.sh | bash

# 5. Clone career-ops-hq/career-ops for zero-token ATS portal scanning & HTML->PDF generation
RUN git clone --depth 1 https://github.com/career-ops-hq/career-ops.git /opt/career-ops \
    && cd /opt/career-ops \
    && (npm install --omit=dev || true)

# 6. Build custom jobbot-mcp server (Gmail IMAP 2FA/OTP + ATS Password Vault + Captcha + Career-Ops bridge)
WORKDIR /opt/jobbot-mcp
COPY mcp/jobbot-mcp/package.json mcp/jobbot-mcp/tsconfig.json ./
RUN npm install
COPY mcp/jobbot-mcp/src ./src
RUN npm run build

# 7. Copy container entrypoint & skill enhancements
COPY docker/terminal/entrypoint.sh /usr/local/bin/terminal-entrypoint.sh
RUN chmod +x /usr/local/bin/terminal-entrypoint.sh \
    && mkdir -p /app/shared/resumes /root/.claude

WORKDIR /root/.jobpilot
EXPOSE 4102

ENTRYPOINT ["/usr/local/bin/terminal-entrypoint.sh"]
