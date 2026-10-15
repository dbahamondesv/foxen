#!/usr/bin/env bash
# Genera los iconos de Foxen (PNG + ICO + ICNS) desde el logotipo fuente.
# El origen es icons/source.png (cuadrado, con transparencia).
# Uso: ./generate-icons.sh
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v npx >/dev/null 2>&1; then
  echo "npx requerido" >&2
  exit 1
fi

# tauri-cli incluye un generador de iconos multiplataforma.
npx --yes @tauri-apps/cli icon ./icons/source.png -o ./icons 2>/dev/null \
  || npx tauri icon ./icons/source.png -o ./icons

echo "Iconos generados en ./icons"
