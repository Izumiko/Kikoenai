# Kikoenai container image.
#
# Two stages. The build stage installs every workspace dependency (the frontend
# Quasar toolchain and the backend esbuild bundler) and produces the
# self-contained backend/build/ directory. The runtime stage carries nothing but
# that directory plus tini and ffmpeg -- no node_modules, no .ts sources.
#
# Debug variant: `--build-arg KIKO_DEBUG=1` builds the frontend with its debug
# configuration (unminified, with source maps) and the backend bundle unminified
# with source maps. build-debug.yml passes it; build.yml keeps the default.
FROM node:26-alpine AS build

WORKDIR /usr/src/kikoeru

# Workspace manifests only, so the (slow) install layer is cached until a
# dependency actually changes.
COPY package.json package-lock.json ./
COPY backend/package.json ./backend/
COPY frontend/package.json ./frontend/

# Install every workspace dependency. No C/C++ toolchain is needed: sqlite3 is
# gone (the app uses the built-in node:sqlite), and nothing else is native.
# --ignore-scripts is safe here for the same reason -- there is no native addon
# to build -- and it keeps package install hooks out of the image build. (plyr
# ships `preinstall: npx only-allow pnpm`, which cannot run under npm at all;
# esbuild's postinstall is only a fallback, its platform binary arrives as an
# optional dependency.)
RUN npm ci --ignore-scripts

# Sources. frontend/ is part of the build now: this stage produces the WebApp
# itself, and quasar.config.js emits it straight into backend/dist/.
COPY ./backend/ ./backend/
COPY ./frontend/ ./frontend/

# 0 = production build (minified backend bundle), 1 = debug build (unminified,
# with source maps). Both build the frontend and bundle the backend; only the
# two npm scripts change.
ARG KIKO_DEBUG=0
RUN if [ "$KIKO_DEBUG" = "1" ]; then \
      npm run build -w frontend && npm run build -w backend -- --debug; \
    else \
      npm run build:prod -w frontend && npm run build -w backend; \
    fi

# Final stage
FROM node:26-alpine

# NODE_ENV=production forces auth on (see backend/config.ts) and cannot be
# overridden via the admin config -- required so the shipped image is never
# accidentally exposed with every /api request treated as admin.
# KIKO_DATA_DIR holds all persistent data (config/sqlite/covers/images plus the
# disposable logs/transcodes/lyrics caches), so the library stays the only
# separate mount.
ENV IS_DOCKER=true \
    NODE_ENV=production \
    KIKO_DATA_DIR=/appdata
WORKDIR /usr/src/kikoeru

# Install runtime dependencies: tini for signal handling, ffmpeg for audio processing
RUN apk add --no-cache tini ffmpeg

# backend/build/ is the deployment unit: app.mjs, the forked scanner entry
# points, their shared chunks, dist/ (the WebApp) and static/. Nothing outside
# this directory is needed at runtime except Node and the ffmpeg binaries.
COPY --from=build /usr/src/kikoeru/backend/build/ ./

# GPL-3.0 requires shipping the license with the binary image. The bundle has no
# room for it (build/ is replaced wholesale on every build), so it lives at the
# image root -- the same place the old source-copy layout put backend/LICENSE.
COPY --from=build /usr/src/kikoeru/backend/LICENSE ./LICENSE

EXPOSE 8888

# No VOLUME is declared on purpose. It only takes effect when the operator
# mounts nothing at that path, and then produces *anonymous* volumes -- with
# KIKO_DATA_DIR set those would be guaranteed-unused ones. Explicit mounts are
# unaffected.
ENTRYPOINT ["/sbin/tini", "--"]
CMD [ "node", "app.mjs" ]
