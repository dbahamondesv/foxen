# Foxen on Flathub

This folder contains the Flatpak manifest for submitting `io.github.dbahamondesv.foxen` to Flathub.

## Testing locally

```bash
# Install runtime/sdk
flatpak install --user flathub org.gnome.Platform//50 org.gnome.Sdk//50 org.freedesktop.Sdk.Extension.rust-stable//25.08 org.freedesktop.Sdk.Extension.node20//25.08

# Build
flatpak run --user org.flatpak.Builder --force-clean --user --repo=repo build-dir io.github.dbahamondesv.foxen.yml

# Bundle & install
flatpak build-bundle repo foxen.flatpak io.github.dbahamondesv.foxen
flatpak install --user foxen.flatpak

# Run
flatpak run io.github.dbahamondesv.foxen