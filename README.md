# Telegram AI Bot

## Migration example

```sh
npx typeorm migration:generate ./src/migrations/Initial -d ./dist/dataSource/dataSource.js
```

## Docker

### Local image

```sh
docker build -t ghcr.io/operkh/ai_bot .
```

### Image for GitHub Packages

```sh
docker buildx build --platform linux/amd64,linux/arm64 -t ghcr.io/operkh/ai_bot --push .
docker push ghcr.io/operkh/ai_bot
```
