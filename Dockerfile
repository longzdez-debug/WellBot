FROM node:22-alpine

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY web ./web
RUN npm run build
RUN cp src/database/schema.sql dist/database/
RUN npm prune --omit=dev
RUN chown -R node:node /app
USER node

# Deplexo injects PORT at runtime. EXPOSE is documentation only.
EXPOSE 8080

CMD ["node", "dist/index.js"]
