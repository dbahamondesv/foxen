#!/usr/bin/env bash
# Renombra el .desktop autogenerado por Tauri (Foxen.desktop) al id de la app
# para que coincida con el <launchable> de AppStream:
#
#   /usr/share/applications/Foxen.desktop
#     -> /usr/share/applications/com.foxbuntu.foxen.desktop
#
# Ademas regenera DEBIAN/md5sums e Installed-Size tras la modificacion.
#
# Uso: packaging/postprocess-deb.sh <archivo.deb>   (in-place)
set -euo pipefail

DEB="${1:?uso: postprocess-deb.sh <archivo.deb>}"
[[ -f "$DEB" ]] || { echo "No existe el paquete: $DEB" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

dpkg-deb -R "$DEB" "$WORK"

APPS="$WORK/usr/share/applications"
OLD="$APPS/Foxen.desktop"
NEW="$APPS/com.foxbuntu.foxen.desktop"
if [[ -f "$OLD" ]]; then
  if [[ -e "$NEW" ]]; then
    rm -f "$OLD"
  else
    mv "$OLD" "$NEW"
  fi
fi

if [[ -d "$WORK/usr" ]]; then
  (cd "$WORK" && find usr -type f -exec md5sum {} + | LC_ALL=C sort -k2 > DEBIAN/md5sums)
  SIZE_KB="$(du -sk "$WORK/usr" | awk '{print $1}')"
  sed -i "s/^Installed-Size: .*/Installed-Size: $SIZE_KB/" "$WORK/DEBIAN/control"
fi

# --root-owner-group: dpkg-deb se ejecuta sin root en el build de contenedor.
dpkg-deb --root-owner-group -b "$WORK" "$DEB"
