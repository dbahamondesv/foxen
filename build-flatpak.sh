#!/usr/bin/env bash
# Construye e instala el Flatpak de Foxen a partir del .deb de dist/packages.
#
# Estrategia (la que recomienda la guia de Tauri): el .deb ya compilado se
# desempaqueta dentro del runtime de GNOME, sin recompilar Rust/Node dentro del
# sandbox.
#
# Uso:
#   ./build-flatpak.sh              # construye, empaqueta e instala (--user)
#   ./build-flatpak.sh --no-install # solo construye el .flatpak
#   ./build-flatpak.sh --runtime 50 # cambia la rama del runtime/SDK
#
# Requisitos: flatpak con el remoto flathub configurado. Instala solo con
# --user, no necesita root.
set -euo pipefail

cd "$(dirname "$0")"
ROOT="$(pwd)"

MANIFEST="$ROOT/packaging/io.github.dbahamondesv.foxen.yaml"
REPO="$ROOT/flatpak-repo"
BUILD_DIR="$ROOT/build-dir"
BUNDLE="$ROOT/foxen.flatpak"
TOOLS_DIR="$ROOT/.flatpak-tools"
RUNTIME_BRANCH="$(awk -F"'" '/^runtime-version:/{print $2}' "$MANIFEST")"
INSTALL=1
DEB="$(ls "$ROOT"/dist/packages/deb/*.deb 2>/dev/null | head -n1 || true)"

while (($#)); do
  case "$1" in
    --no-install) INSTALL=0; shift ;;
    --runtime) RUNTIME_BRANCH="${2:?falta el valor de --runtime}"; shift 2 ;;
    -h|--help)
      sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "Opcion desconocida: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$DEB" ]]; then
  echo "No hay .deb en dist/packages/deb. Ejecuta antes: ./build-in-container.sh" >&2
  exit 1
fi
if ! command -v flatpak >/dev/null 2>&1; then
  echo "flatpak no esta instalado." >&2
  exit 1
fi

# --- Runtime y SDK (instalacion de usuario) ----------------------------------
ensure_flatpak() {
  local ref="$1"
  if ! flatpak --user info "$ref" >/dev/null 2>&1; then
    echo "==> Instalando $ref (usuario)"
    flatpak install --user -y flathub "$ref"
  fi
}
ensure_flatpak "org.gnome.Platform//$RUNTIME_BRANCH"
ensure_flatpak "org.gnome.Sdk//$RUNTIME_BRANCH"

# --- flatpak-builder ----------------------------------------------------------
# Puede estar en el PATH o dentro de la app org.flatpak.Builder. En el segundo
# caso el sandbox de Builder no encuentra los runtime de usuario, asi que se
# extrae la version de Ubuntu (sin necesitar root) y se ejecuta en el host.
FB=""
if command -v flatpak-builder >/dev/null 2>&1; then
  FB="$(command -v flatpak-builder)"
fi

APSTREAM_LIBDIR=""
if [[ -z "$FB" ]]; then
  FB="$TOOLS_DIR/usr/bin/flatpak-builder"
  APSTREAM_LIBDIR="$TOOLS_DIR/usr/lib/x86_64-linux-gnu"
  if [[ ! -x "$FB" ]]; then
    echo "==> Preparando flatpak-builder local en .flatpak-tools"
    mkdir -p "$TOOLS_DIR"
    ( cd "$TOOLS_DIR"
      for pkg in flatpak-builder appstream-compose libappstream-compose0; do
        apt-get download "$pkg"
      done
      for deb in ./*.deb; do dpkg -x "$deb" .; done
      rm -f ./*.deb )
  fi
fi

run_builder() {
  local appstream_bin="$TOOLS_DIR/usr/libexec/appstreamcli-compose"
  if [[ -x "$appstream_bin" && ! -x /usr/libexec/appstreamcli-compose ]]; then
    # Se monta un /usr/libexec propio (namespace de usuario) para que
    # flatpak-builder encuentre appstreamcli-compose, que viene en un paquete
    # aparte en Ubuntu.
    local libexec="$TOOLS_DIR/libexec"
    if [[ ! -d "$libexec" ]]; then
      mkdir -p "$libexec"
      cp -a /usr/libexec/. "$libexec/" 2>/dev/null || true
      cp "$appstream_bin" "$libexec/"
    fi
    unshare -rm sh -c '
      mount --bind "$1" /usr/libexec || exit 1
      export LD_LIBRARY_PATH="$2"
      exec "$3" --user --force-clean --disable-cache --repo="$4" "$5" "$6"
    ' _ "$libexec" "$APSTREAM_LIBDIR" "$FB" "$REPO" "$BUILD_DIR" "$MANIFEST"
  else
    "$FB" --user --force-clean --disable-cache --repo="$REPO" "$BUILD_DIR" "$MANIFEST"
  fi
}

# --- Construccion -------------------------------------------------------------
echo "==> Construyendo el flatpak (runtime $RUNTIME_BRANCH)"
rm -rf "$REPO" "$BUILD_DIR"
run_builder

echo "==> Empaquetando foxen.flatpak"
flatpak build-bundle "$REPO" "$BUNDLE" com.foxbuntu.foxen

if ((INSTALL)); then
  echo "==> Instalando (usuario)"
  flatpak install --user -y --reinstall "$BUNDLE"
  echo
  echo "Ejecuta:  flatpak run com.foxbuntu.foxen"
fi

echo
echo "==> Flatpak generado: $BUNDLE"
