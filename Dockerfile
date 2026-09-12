FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY web ./web
RUN npm run build

# Copy SQL schema file to dist
RUN cp src/database/schema.sql dist/database/

# Remove dev dependencies after build
RUN npm prune --omit=dev

EXPOSE 8080

CMD ["node", "dist/index.js"]
