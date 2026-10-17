# API server for @pila/factcheck. Build from the repo root:
#   docker build -t pila-api .
#   docker run -p 8787:8787 -e PILA_API_TOKENS=... pila-api

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/factcheck/package.json packages/factcheck/
COPY apps/api/package.json apps/api/
RUN npm ci --ignore-scripts
COPY packages/factcheck packages/factcheck
COPY apps/api apps/api
RUN npm run build -w @pila/factcheck -w @pila/api && npm prune --omit=dev --ignore-scripts

FROM node:22-slim
ENV NODE_ENV=production PORT=8787
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages/factcheck/package.json packages/factcheck/
COPY --from=build /app/packages/factcheck/dist packages/factcheck/dist
COPY --from=build /app/apps/api/package.json apps/api/
COPY --from=build /app/apps/api/dist apps/api/dist
USER node
EXPOSE 8787
# Sends the origin header too, since the origin check also guards /health when ORIGIN_VERIFY_SECRET is set.
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health',{headers:{'x-origin-verify':process.env.ORIGIN_VERIFY_SECRET||''}}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "apps/api/dist/server.js"]
