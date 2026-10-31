FROM node:24-alpine AS build
WORKDIR /app
RUN npm install -g pnpm@10.33.2
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod
# onnxruntime-web ships ~140 MB of browser builds; the people counter only loads the Node one.
RUN find node_modules/.pnpm -path '*/onnxruntime-web/dist/*' -type f \
      ! -name ort.node.min.js ! -name 'ort-wasm-simd-threaded.mjs' ! -name 'ort-wasm-simd-threaded.wasm' -delete

FROM node:24-alpine
# ffmpeg records Ring clips (stream copy), repackages live view as HLS, reads Reolink clip
# lengths, makes thumbnails, converts the 4K HEVC daily summary to H.264, and feeds frames to
# the people counter.
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
COPY models ./models
EXPOSE 3012
HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO- http://127.0.0.1:3012/health || exit 1
CMD ["node", "dist/server.js"]
