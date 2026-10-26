FROM node:24.20.0-bookworm-slim AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY client ./client
RUN npm run build

FROM node:24.20.0-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_DIR=/data
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.js agent-api.js agent-contract.js models.js retrieval.js evidence.js comparisons.js portal.js legal-sources.js research.js personal.js security.js parser.js parse-worker.js parse-process.js jobs.js collaboration.js connectors.js connector-list.js rich-text.js drafting.js workflows.js ./
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
