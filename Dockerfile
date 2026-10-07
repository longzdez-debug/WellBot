FROM node:22-alpine

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./

# Force Deplexo to rebuild application source when the deployment revision changes.
ARG WELLBOT_BUILD_REV=98e1e9de00c436eb035e94400823b94fb946e1cb
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
