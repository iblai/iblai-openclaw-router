#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="iblai-router"
ROUTER_DIR="$HOME/.openclaw/workspace/router"

echo "Removing iblai-router..."

# 1. Stop and disable service
if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
  sudo systemctl stop "$SERVICE_NAME"
  echo "  ✓ Service stopped"
fi

if systemctl is-enabled --quiet "$SERVICE_NAME" 2>/dev/null; then
  sudo systemctl disable "$SERVICE_NAME"
fi

# 2. Remove service file
if [ -f "/etc/systemd/system/$SERVICE_NAME.service" ]; then
  sudo rm "/etc/systemd/system/$SERVICE_NAME.service"
  sudo systemctl daemon-reload
  echo "  ✓ Systemd unit removed"
fi

# 3. Remove router files
if [ -d "$ROUTER_DIR" ]; then
  rm -rf "$ROUTER_DIR"
  echo "  ✓ Router files removed from $ROUTER_DIR"
fi

echo ""
echo "  Don't forget to remove the OpenClaw provider in your session:"
echo "  /config unset models.providers.iblai-router"
echo ""
echo "  And switch any workloads using iblai-router/auto to a direct model."
echo ""
echo "Done."
