FROM node:24-alpine AS build
WORKDIR /app
RUN npm install -g pnpm@10.33.2
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

FROM node:24-alpine
# ffmpeg repackages live view as HLS, reads clip lengths and codecs, makes thumbnails, and
# builds each camera's daily summary (joined and converted to 1080p H.264).
RUN apk add --no-cache ffmpeg tzdata
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3012 \
    DATA_DIR=/data \
    CAMERA_ROOT=/cameras \
    TZ=America/Chicago
COPY package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY public ./public
EXPOSE 3012
HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO- http://127.0.0.1:3012/health || exit 1
CMD ["node", "dist/server.js"]
