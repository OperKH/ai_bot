# build-stage
FROM node:20 as build-stage
ENV NODE_ENV build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --production

# production-stage
FROM node:20
RUN apt -y update && apt install -y --no-install-recommends ffmpeg && apt clean
ENV NODE_ENV production
WORKDIR /app
COPY --from=build-stage /app/package*.json ./
COPY --from=build-stage /app/node_modules/ ./node_modules/
COPY --from=build-stage /app/dist/ ./dist/
CMD ["node", "dist/app.js"]
