#!/usr/bin/env bash
set -e

# Free port 3000 if occupied by any lingering process
old_pid=$(ss -tlpn 2>/dev/null | grep ":3000" | grep -o 'pid=[0-9]*' | cut -d= -f2 | head -n1 || true)
if [ -n "$old_pid" ]; then
  echo "Freeing port 3000 (PID $old_pid)..."
  kill -9 "$old_pid" 2>/dev/null || true
  sleep 0.5
fi

# Fallback check for any stray node vite process
pkill -9 -f "web/node_modules/.bin/vite" 2>/dev/null || true

cd /app/applet/web
exec ./node_modules/.bin/vite --host 0.0.0.0 --port 3000
