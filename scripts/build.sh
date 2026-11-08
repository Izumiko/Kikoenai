#!/usr/bin/env bash
set -e

# Build the frontend into backend/dist/ and the backend bundle into backend/build/.
# backend/build/ is the self-contained deployment unit: app.mjs, the maintenance
# CLIs, their chunks, plus copies of dist/ and static/.
cd "$(dirname "$0")/.."

echo "Building Kikoenai..."
echo ""

# Build frontend (outputs directly to backend/dist/ via distDir in quasar.config.js)
echo "1. Building frontend (PWA, debug)..."
npm run build:frontend
echo "   ✓ Frontend built to backend/dist/"

echo ""
echo "2. Bundling backend (esbuild)..."
npm run build:backend
echo "   ✓ Backend bundled to backend/build/"

echo ""
echo "3. Deployment unit ready: backend/build/"
echo "   Run it with:    npm run start:bundle -w backend"
echo "   Or from source: npm start"
echo ""
echo "Build complete. ✓"
