FROM node:24-alpine

ARG TARGETARCH
ARG CLOUDFLARED_VERSION=2026.10.7
RUN case "$TARGETARCH" in \
      amd64) sum=1f99fb518b83dec2ba8d870a7cc991d82a77e6196295a3d2754ba17ab9f91872 ;; \
      arm64) sum=3df43aedc9ff291d1735b5cb576cb97e0b157488796db2e32b28aecabb445775 ;; \
      *) echo "Unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac \
    && wget -q -O /usr/local/bin/cloudflared "https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-${TARGETARCH}" \
    && echo "$sum  /usr/local/bin/cloudflared" | sha256sum -c - \
    && chmod 755 /usr/local/bin/cloudflared

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY views ./views
COPY public ./public

RUN mkdir /data && chown node:node /data
USER node

ENV NODE_ENV=production SHORTIFY_DATA_DIR=/data PORT=8080
EXPOSE 8080 8443

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1

CMD ["node", "src/server.js"]
