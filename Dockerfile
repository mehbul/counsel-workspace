FROM node:24.20.0-bookworm-slim AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY client ./client
RUN npm run build

FROM node:24.20.0-bookworm-slim
ARG INSTALL_OCR=0
RUN if [ "$INSTALL_OCR" = "1" ]; then apt-get update && apt-get install -y --no-install-recommends tesseract-ocr poppler-utils && rm -rf /var/lib/apt/lists/*; fi
ARG VERSION=0.1.0
ARG REVISION=unknown
LABEL org.opencontainers.image.title="Counsel workspace" \
      org.opencontainers.image.description="Free, self-hosted legal workspace for contract review, legal research, drafting, workflows and matter collaboration." \
      org.opencontainers.image.source="https://github.com/mehbul/counsel-workspace" \
      org.opencontainers.image.url="https://mehbul.github.io/counsel-workspace/" \
      org.opencontainers.image.documentation="https://github.com/mehbul/counsel-workspace#readme" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.vendor="Counsel workspace contributors" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_DIR=/data
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY *.js ./
COPY public ./public
COPY --from=build /build/public/collaboration.bundle.js /build/public/collaboration.bundle.css ./public/
COPY scripts ./scripts
COPY mcp ./mcp
COPY evaluation ./evaluation
RUN mkdir /data && chown node:node /data /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD node -e "fetch('http://127.0.0.1:3000/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node","server.js"]
