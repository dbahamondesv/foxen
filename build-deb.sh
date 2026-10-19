#!/usr/bin/env bash
# Compila Foxen y genera un paquete .deb instalable.
#
# Uso:
#   ./build-deb.sh              # compila en modo release y empaqueta .deb
#   ./build-deb.sh --debug      # compila en modo debug (más rápido)
#
# Resultado:
#   src-tauri/target/<perfil>/bundle/deb/Foxen_<version>_<arch>.deb
#
# Instalación del paquete generado:
#   sudo apt install ./src-tauri/target/release/bundle/deb/Foxen_*.deb
set -euo pipefail

cd "$(dirname "$0")"

usage() {
  cat <<'EOF'
Compila Foxen y genera un paquete .deb instalable.

Uso:
  ./build-deb.sh              Compila en modo release y empaqueta .deb
  ./build-deb.sh --debug      Compila en modo debug (más rápido)
  ./build-deb.sh --help       Muestra esta ayuda

Resultado:
  src-tauri/target/<perfil>/bundle/deb/Foxen_<version>_<arch>.deb

Instalación del paquete generado:
  sudo apt install ./src-tauri/target/release/bundle/deb/Foxen_*.deb
EOF
}

PROFILE="release"
BUILD_FLAGS=()
for arg in "$@"; do
  case "$arg" in
    --debug) PROFILE="debug"; BUILD_FLAGS+=(--debug) ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "Opción desconocida: $arg" >&2
      exit 1
      ;;
  esac
done

# --- Comprobación de dependencias -------------------------------------------
missing=()
for cmd in node npm cargo; do
  command -v "$cmd" >/dev/null 2>&1 || missing+=("$cmd")
done
if ! command -v npx >/dev/null 2>&1; then
  missing+=("npx")
fi
if ((${#missing[@]})); then
  echo "Faltan dependencias: ${missing[*]}" >&2
  echo "Instala Node.js/npm y Rust (https://rustup.rs) antes de continuar." >&2
  exit 1
fi

# Dependencias del sistema para el bundling de .deb en Linux (Debian/Ubuntu).
if command -v dpkg >/dev/null 2>&1 && command -v apt-get >/dev/null 2>&1; then
  sys_missing=()
  command -v dpkg-deb >/dev/null 2>&1 || sys_missing+=("dpkg")
  dpkg -s libwebkit2gtk-4.1-dev >/dev/null 2>&1 || sys_missing+=("libwebkit2gtk-4.1-dev")
  dpkg -s libgtk-3-dev >/dev/null 2>&1 || sys_missing+=("libgtk-3-dev")
  if ((${#sys_missing[@]})); then
    echo "Aviso: podrían faltar paquetes del sistema: ${sys_missing[*]}" >&2
    echo "  sudo apt install ${sys_missing[*]}" >&2
  fi
fi

# --- Dependencias del frontend ----------------------------------------------
if [[ ! -d node_modules ]]; then
  echo "==> Instalando dependencias npm (npm ci)"
  npm ci
fi

# --- Compilación y empaquetado ----------------------------------------------
echo "==> Compilando Foxen y empaquetando .deb (perfil: $PROFILE)"
npx tauri build --bundles deb "${BUILD_FLAGS[@]}"

# --- Ajuste del paquete ------------------------------------------------------
# Renombra el .desktop autogenerado (Foxen.desktop) al id de la app para que
# concuerde con el <launchable> de AppStream.
for deb in src-tauri/target/"$PROFILE"/bundle/deb/*.deb; do
  [[ -f "$deb" ]] && ./packaging/postprocess-deb.sh "$deb"
done

# --- Localizar el paquete generado ------------------------------------------
DEB_DIR="src-tauri/target/$PROFILE/bundle/deb"
DEB_FILE="$(find "$DEB_DIR" -maxdepth 1 -name '*.deb' -printf '%T@ %p\n' 2>/dev/null \
  | sort -nr | head -n1 | cut -d' ' -f2-)"

if [[ -z "${DEB_FILE:-}" ]]; then
  echo "No se encontró ningún .deb en $DEB_DIR" >&2
  exit 1
fi

echo
echo "==> Paquete generado:"
echo "    $DEB_FILE"
echo
echo "Instálalo con:"
echo "    sudo apt install ./$DEB_FILE"
