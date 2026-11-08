#!/usr/bin/env bash
set -e

# Start the backend (node --watch, :8888) and the frontend (quasar dev, :8080)
# together. This is what `npm run dev` from the repo root does.
cd "$(dirname "$0")/.."

echo "Starting Kikoenai monorepo development environment..."
echo "  Backend:  http://localhost:8888 (node --watch)"
echo "  Frontend: http://localhost:8080 (proxies /api -> :8888)"
echo ""

echo "Starting backend..."
npm run dev:backend &
BACKEND_PID=$!

echo "Starting frontend..."
npm run dev:frontend &
FRONTEND_PID=$!

# Trap to kill both on exit
trap "kill $BACKEND_PID $FRONTEND_PID 2>/dev/null; exit" INT TERM

echo ""
echo "Both processes running. Press Ctrl+C to stop."
wait
