FROM node:22-alpine

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./

# Force Deplexo to rebuild application source when the deployment revision changes.
ARG WELLBOT_BUILD_REV=7350001
RUN echo "WellBOT build revision: $WELLBOT_BUILD_REV"
COPY src ./src
COPY web ./web
RUN npm run build
RUN cp src/database/schema.sql dist/database/
RUN npm prune --omit=dev
RUN chown -R node:node /app
USER node

# Deplexo web services use PORT at runtime; 3000 is the repository default.
EXPOSE 3000

CMD ["node", "dist/index.js"]
