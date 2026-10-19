#!/usr/bin/env bash
# Compila Foxen para Linux dentro de un contenedor con una glibc antigua.
#
# Motivo: un binario enlazado contra la glibc del host (p. ej. 2.39+) no arranca
# en distribuciones mas viejas. Construyendo sobre Debian 12 (glibc 2.36) el
# paquete funciona en Debian 12+, Ubuntu 23.04+ y derivadas, donde existe
# libwebkit2gtk-4.1 (Tauri 2 no soporta la serie 4.0 de Ubuntu 22.04).
#
# El arbol se copia a un directorio temporal dentro del contenedor, de modo que
# el host no queda con archivos propiedad de root ni se pisan caches locales.
#
# Uso:
#   ./build-in-container.sh                     # deb + rpm + AppImage
#   ./build-in-container.sh --bundles deb       # solo .deb
#   ./build-in-container.sh --image ubuntu:24.04
#   ./build-in-container.sh --debug --keep      # perfil debug, conserva el stage
#
# Resultado: dist/packages/{deb,rpm,appimage}/
set -euo pipefail

cd "$(dirname "$0")"
ROOT="$(pwd)"

IMAGE="${FOXEN_BUILD_IMAGE:-node:22-bookworm}"
ENGINE="${FOXEN_CONTAINER_ENGINE:-}"
BUNDLES="${FOXEN_BUNDLES:-deb,rpm,appimage}"
OUT_DIR="${FOXEN_OUT_DIR:-dist/packages}"
GLIBC_MAX="${FOXEN_GLIBC_MAX:-2.36}"
PROFILE="release"
KEEP=0

usage() {
  cat <<'EOF'
Compila y empaqueta Foxen para Linux en un contenedor con glibc antigua.

Uso:
  ./build-in-container.sh [opciones]

Opciones:
  --engine docker|podman   Motor de contenedores (autodetectado por defecto)
  --image IMAGEN           Imagen base (por defecto node:22-bookworm, glibc 2.36)
  --bundles LISTA          Paquetes a generar: deb,rpm,appimage
  --out DIR                Directorio de salida (por defecto dist/packages)
  --glibc VERSION          Simbolo GLIBC maximo permitido (por defecto 2.36)
  --debug                  Compila en perfil debug
  --keep                   Conserva el arbol temporal para inspeccionarlo
  -h, --help               Muestra esta ayuda

Variables equivalentes: FOXEN_CONTAINER_ENGINE, FOXEN_BUILD_IMAGE,
FOXEN_BUNDLES, FOXEN_OUT_DIR, FOXEN_GLIBC_MAX.

Notas:
  - La primera ejecucion descarga la imagen e instala Rust; las siguientes
    reutilizan volumenes de cache (foxen-build-*).
  - AppImage requiere red para descargar linuxdeploy en el primer build.
EOF
}

while (($#)); do
  case "$1" in
    --engine) ENGINE="${2:?falta el valor de --engine}"; shift 2 ;;
    --image) IMAGE="${2:?falta el valor de --image}"; shift 2 ;;
    --bundles) BUNDLES="${2:?falta el valor de --bundles}"; shift 2 ;;
    --out) OUT_DIR="${2:?falta el valor de --out}"; shift 2 ;;
    --glibc) GLIBC_MAX="${2:?falta el valor de --glibc}"; shift 2 ;;
    --debug) PROFILE="debug"; shift ;;
    --keep) KEEP=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Opcion desconocida: $1" >&2; usage >&2; exit 1 ;;
  esac
done

# --- Comprobaciones del host -------------------------------------------------
if [[ "$(uname -s)" != "Linux" ]]; then
  echo "Este script solo construye paquetes de Linux." >&2
  exit 1
fi
if [[ "$(uname -m)" != "x86_64" ]]; then
  echo "Arquitectura no soportada: $(uname -m) (solo x86_64 por ahora)." >&2
  exit 1
fi
if [[ ! -f "$ROOT/src-tauri/tauri.conf.json" ]]; then
  echo "Ejecuta el script desde la raiz del repositorio de Foxen." >&2
  exit 1
fi

if [[ -z "$ENGINE" ]]; then
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    ENGINE="docker"
  elif command -v podman >/dev/null 2>&1 && podman info >/dev/null 2>&1; then
    ENGINE="podman"
  else
    echo "No hay docker ni podman operativos. Instala uno o pasa --engine." >&2
    exit 1
  fi
fi
if ! command -v "$ENGINE" >/dev/null 2>&1; then
  echo "Motor de contenedores no encontrado: $ENGINE" >&2
  exit 1
fi

# Podman con SELinux necesita etiquetar los binds; docker lo ignora si no aplica.
MOUNT_OPTS=""
[[ "$ENGINE" == "podman" ]] && MOUNT_OPTS=":Z"

# --- Arbol de trabajo aislado ------------------------------------------------
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/foxen-build-XXXXXX")"
cleanup() {
  local status=$?
  if ((KEEP)); then
    echo "Arbol temporal conservado: $STAGE" >&2
  elif ! rm -rf "$STAGE" 2>/dev/null; then
    # El contenedor pudo dejar archivos de root (fallo antes del chown final).
    echo "Limpiando restos propiedad de root en $STAGE..." >&2
    "$ENGINE" run --rm -v "$STAGE:/stage" "$IMAGE" \
      bash -c 'chown -R "$HOST_UID:$HOST_GID" /stage || rm -rf /stage/* /stage/.[!.]*' \
      >/dev/null 2>&1 || true
    rm -rf "$STAGE" 2>/dev/null || echo "No se pudo borrar $STAGE" >&2
  fi
  exit "$status"
}
trap cleanup EXIT

mkdir -p "$STAGE/src" "$STAGE/out"
tar -C "$ROOT" \
  --exclude=./node_modules \
  --exclude=./dist \
  --exclude=./src-tauri/target \
  --exclude=./.git \
  --exclude=./.flatpak-builder \
  --exclude=./build-dir \
  --exclude=./flatpak-repo \
  --exclude=./repo \
  --exclude='*.deb' --exclude='*.rpm' --exclude='*.AppImage' \
  -cf - . | tar -C "$STAGE/src" -xf -

CACHE_PREFIX="${ENGINE}-foxen-build"

echo "==> Motor: $ENGINE | imagen: $IMAGE | bundles: $BUNDLES | perfil: $PROFILE"

# --- Construccion dentro del contenedor --------------------------------------
run_container() {
"$ENGINE" run --rm -i \
  --workdir /build \
  -v "$STAGE/src:/build" \
  -v "$STAGE/out:/artifacts" \
  -v "${CACHE_PREFIX}-cargo:/root/.cargo" \
  -v "${CACHE_PREFIX}-rustup:/root/.rustup" \
  -v "${CACHE_PREFIX}-npm:/root/.npm" \
  -v "${CACHE_PREFIX}-target:/build/src-tauri/target" \
  -e "FOXEN_BUNDLES=$BUNDLES" \
  -e "FOXEN_GLIBC_MAX=$GLIBC_MAX" \
  -e "FOXEN_PROFILE=$PROFILE" \
  -e "HOST_UID=$(id -u)" \
  -e "HOST_GID=$(id -g)" \
  -e "APPIMAGE_EXTRACT_AND_RUN=1" \
  "$IMAGE" bash -s <<'CONTAINER'
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
GLIBC_NOW="$(ldd --version | head -n1 | awk '{print $NF}')"
echo "==> Contenedor: glibc $GLIBC_NOW"

echo "==> Instalando dependencias del sistema"
apt-get update -qq
apt-get install -y -qq --no-install-recommends \
  build-essential ca-certificates curl pkg-config libssl-dev \
  libgtk-3-dev libwebkit2gtk-4.1-dev libjavascriptcoregtk-4.1-dev \
  libsoup-3.0-dev librsvg2-dev patchelf rpm libfuse2 file xz-utils zstd \
  >/dev/null

if ! command -v cargo >/dev/null 2>&1; then
  echo "==> Instalando Rust (rustup, perfil minimo)"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --profile minimal --no-modify-path >/dev/null
fi
# shellcheck disable=SC1091
. "$HOME/.cargo/env"

echo "==> Instalando dependencias npm (npm ci)"
npm ci --no-audit --no-fund --loglevel=error

echo "==> Compilando y empaquetando"
BUILD_ARGS=(-b "$FOXEN_BUNDLES")
if [[ "$FOXEN_PROFILE" == "debug" ]]; then
  BUILD_ARGS+=(--debug)
fi
npx tauri build "${BUILD_ARGS[@]}"

# --- Verificacion de compatibilidad ------------------------------------------
BIN="src-tauri/target/$FOXEN_PROFILE/foxen"
if [[ ! -x "$BIN" ]]; then
  echo "No se encontro el binario compilado: $BIN" >&2
  exit 1
fi
MAX_GLIBC="$(readelf -V "$BIN" \
  | grep -oE 'GLIBC_[0-9]+\.[0-9]+' \
  | sed 's/GLIBC_//' \
  | sort -V \
  | tail -n1)"
echo "==> glibc requerida por el binario: ${MAX_GLIBC:-desconocida} (maximo: $FOXEN_GLIBC_MAX)"
if [[ -z "$MAX_GLIBC" ]]; then
  echo "No se pudo determinar la glibc requerida." >&2
  exit 1
fi
if dpkg --compare-versions "$MAX_GLIBC" gt "$FOXEN_GLIBC_MAX"; then
  echo "ERROR: el binario exige glibc $MAX_GLIBC > $FOXEN_GLIBC_MAX." >&2
  echo "Usa una imagen base mas antigua o revisa la cache de compilacion." >&2
  exit 1
fi

# --- Post-proceso del empaquetado -------------------------------------------
if [[ ",$FOXEN_BUNDLES," == *",deb,"* ]]; then
  echo "==> Ajustando el .deb (renombrado del .desktop al id de la app)"
  while IFS= read -r deb; do
    bash /build/packaging/postprocess-deb.sh "$deb"
  done < <(find "src-tauri/target/$FOXEN_PROFILE/bundle/deb" -maxdepth 1 -name '*.deb' -print)
fi

rm -rf /artifacts/*
IFS=',' read -r -a REQUESTED <<< "$FOXEN_BUNDLES"
for kind in "${REQUESTED[@]}"; do
  src="src-tauri/target/$FOXEN_PROFILE/bundle/$kind"
  [[ -d "$src" ]] || continue
  mkdir -p "/artifacts/$kind"
  # Solo los paquetes finales: fuera los directorios intermedios de Tauri.
  find "$src" -maxdepth 1 -type f -exec cp -a {} "/artifacts/$kind/" \;
done

# Los binds pertenecen al usuario del host; devolverle la propiedad para que
# pueda borrar el arbol temporal y los artefactos.
chown -R "$HOST_UID:$HOST_GID" /build /artifacts
CONTAINER
}

attempts=0
until run_container; do
  status=$?
  if [[ "$status" -ne 141 ]]; then
    echo "La construccion fallo (codigo $status)." >&2
    exit "$status"
  fi
  attempts=$((attempts + 1))
  if (( attempts >= 3 )); then
    echo "La construccion fallo repetidamente con SIGPIPE (141)." >&2
    exit "$status"
  fi
  echo "==> Reintentando tras SIGPIPE (intento $((attempts + 1)))..." >&2
done

# --- Resultados --------------------------------------------------------------
if [[ -z "$(ls -A "$STAGE/out" 2>/dev/null)" ]]; then
  echo "El contenedor no genero paquetes." >&2
  exit 1
fi

mkdir -p "$ROOT/$OUT_DIR"
IFS=',' read -r -a REQUESTED <<< "$BUNDLES"
for kind in "${REQUESTED[@]}"; do
  rm -rf "${ROOT:?}/$OUT_DIR/$kind"
done
cp -a "$STAGE/out/." "$ROOT/$OUT_DIR/"

echo
echo "==> Paquetes generados en $OUT_DIR:"
find "$ROOT/$OUT_DIR" -type f \( -name '*.deb' -o -name '*.rpm' -o -name '*.AppImage' \) \
  -printf '    %p (%s bytes)\n' | sort
for deb in "$ROOT/$OUT_DIR"/deb/*.deb; do
  [[ -f "$deb" ]] || continue
  echo "    Depends($(basename "$deb")): $(dpkg-deb -f "$deb" Depends)"
done
echo
echo "Instalacion:"
echo "    sudo apt install ./$OUT_DIR/deb/*.deb"
echo "    sudo dnf install ./$OUT_DIR/rpm/*.rpm"
echo "    chmod +x $OUT_DIR/appimage/*.AppImage && ./$OUT_DIR/appimage/*.AppImage"
