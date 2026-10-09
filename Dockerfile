FROM node:22-alpine

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./

# Deployments should inject the exact source revision; never bake in a stale SHA.
ARG WELLBOT_BUILD_REV=unknown
ENV WELLBOT_BUILD_REV=$WELLBOT_BUILD_REV
RUN echo "WellBOT build revision: $WELLBOT_BUILD_REV"
COPY src ./src
COPY web ./web
RUN rm -rf dist && npm run build
RUN cp src/database/schema.sql dist/database/
RUN npm prune --omit=dev
RUN chown -R node:node /app
USER node

# Deplexo web services use PORT at runtime; 3000 is the repository default.
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
