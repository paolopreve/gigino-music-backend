#!/usr/bin/env bash
set -e

echo "Starting Docker containers..."
docker compose up -d

echo "Waiting for connected Android devices..."
adb wait-for-device

echo "Reversing port 3000 to Android device..."
adb reverse tcp:3000 tcp:3000

echo "Ready! http://localhost:3000 is now accessible from your phone."
docker compose logs -f