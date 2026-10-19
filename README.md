# 🦊 Foxen

**Potente gestor de ramas y repositorios Git para escritorio.**

Foxen es una aplicación de escritorio construida con [Tauri 2](https://tauri.app)
(Rust + React) que ofrece una forma rápida y visual de trabajar con Git:
grafo de commits con carriles, staging por fragmentos, stashes, remotos,
Git Flow, terminal embebida y publicación directa a GitHub.

## Características

- **Grafo de commits** con carriles coloreados, etiquetas de ramas/tags y
  búsqueda que resalta el historial.
- **Staging avanzado**: stage/discard por archivo, por hunk o por líneas
  concretas, con vista de diff lado a lado.
- **Ramas y tags**: crear, renombrar, eliminar, comparar (ahead/behind),
  mover, cherry-pick, revert y reset.
- **Merge y rebase** con detección de conflictos y resolución desde la UI.
- **Stashes**: guardar, aplicar, pop, ramificar desde un stash.
- **Remotos**: fetch/pull/push con credenciales resueltas automáticamente
  (sesión → llavero del sistema → helpers de `git`, p. ej. `gh`).
- **Git Flow** (feature/release/hotfix) sin salir de la app.
- **Terminal embebida** (PTY real) en la carpeta del repositorio.
- **GitHub**: iniciar sesión con `gh`, PAT o Device Flow; clonar y
  **publicar** el repositorio actual (crea el repo, configura `origin` y
  hace push con upstream).
- **Sesión persistente**: reabre los repositorios que tenías al cerrar.
- **Preferencias en Rust**: sesión y tema se guardan en
  `~/.config/foxen/settings.json` (escritura atómica), no en el webview.
- **Refresco automático**: un watcher de kernel (inotify) detecta cambios en el
  repositorio hechos desde fuera (terminal, otro editor) y actualiza la UI;
  también al recuperar el foco de la ventana y con el botón ⟳, **Ctrl+R** o
  **F5**.
- **Enlaces `git://`**: `git://…` (y `ssh://`/`https://…*.git`) abren Foxen y
  ofrecen clonar el repositorio.
- **Tema claro/oscuro** (sigue al sistema por defecto).
- Diseñada como app de escritorio: sin menús ni atajos de navegador.

## Requisitos y compatibilidad

Los paquetes usan **glibc ≤ 2.34**, así que funcionan en cualquier distribución
con WebKitGTK 4.1 y GTK 3 (lo exige Tauri 2):

| Distribución | Mínimo | Paquete de WebKitGTK |
| --- | --- | --- |
| Debian | 12 (bookworm) | `libwebkit2gtk-4.1-0` |
| Ubuntu | 23.04 | `libwebkit2gtk-4.1-0` |
| Fedora | 38 | `webkit2gtk4.1` |
| Arch | rolling | `webkit2gtk-4.1` |

Ubuntu 22.04 y Debian 11 **no** sirven: no empaquetan `webkit2gtk-4.1`.
Se asume OpenSSL 3 (predeterminado en las versiones anteriores). Para compilar:
Node.js 20+ y Rust 1.77+.

Opcional: [GitHub CLI](https://cli.github.com/) (`gh`) autenticada para usar Git
sin tocar credenciales. En entornos **headless** (sin Secret Service/gnome-keyring)
el llavero no está disponible: Foxen degrada a mantener los tokens en memoria
durante la sesión y a los helpers de `git`/`gh`, sin guardarlos en disco.

## Compilar y ejecutar

```bash
npm install

# Desarrollo (recarga en caliente)
npm run tauri:dev

# Paquete .deb nativo (usa el toolchain del sistema)
./build-deb.sh

# Paquetes multi-distro (deb + rpm + AppImage) en un contenedor aislado
./build-in-container.sh          # docker o podman; salida en dist/packages/
./build-in-container.sh deb      # solo lo que pidas (deb, rpm, appimage)

# Flatpak (a partir del .deb anterior); usa el flatpak-builder del sistema o
# prepara uno portable sin root en .flatpak-tools/
./build-flatpak.sh               # genera foxen.flatpak e instala con --user
```

## Autenticación con GitHub

Foxen resuelve credenciales en este orden: sesión en la app → llavero del
sistema (keyring) → helpers de `git` del sistema.

| Método | Cómo |
| --- | --- |
| **GitHub CLI (recomendado)** | `gh auth login` y luego «⚡ Usar sesión de gh» en Foxen. Soporta MFA sin config extra. |
| **PAT** | Token de [GitHub](https://github.com/settings/tokens/new?description=Foxen%20Desktop&scopes=repo,read:user,user:email) con alcance `repo read:user user:email`, pegado en el modal de login. |
| **Device Flow (navegador)** | Requiere tu propia OAuth App con «Enable Device Flow» y la variable de entorno `FOXEN_GITHUB_CLIENT_ID=<client_id>`. |

Las contraseñas/tokens viven **solo en el llavero del SO** (clave por host),
nunca en texto plano.

## Estructura

```
src/                  Frontend React + Zustand
  components/         Paneles y modales
  lib/                IPC tipado, tipos, sesión, utilidades
  store/              Estado global
src-tauri/src/        Backend Rust
  commands/           Comandos IPC (frontera única con el frontend)
  git/                Lógica Git sobre libgit2 (grafo, staging, remotos…)
  pty.rs/terminal.rs  Terminal embebida y del sistema
  settings.rs         Preferencias persistentes (sesión + tema)
  watch.rs            Watcher inotify con debounce (evento git://changed)
  deeplink.rs         Enlaces git:// (clonado desde el navegador)
packaging/            .desktop, metainfo AppStream y manifiesto flatpak
build-in-container.sh Paquetes multi-distro (deb/rpm/AppImage)
build-flatpak.sh      Flatpak a partir del .deb
```

## Desarrollo

```bash
npm run typecheck   # TypeScript estricto
npm run lint        # ESLint sin warnings
npm run test        # Vitest (utilidades del frontend)
npm run build       # tsc + vite build
cargo check         # Backend
cargo test --lib    # Tests de unidad Rust
cargo test --test git_integration   # Integración con repos reales en tmp
npx vite --open /preview.html       # Inspección visual sin Tauri
```

## Licencia

[MIT](./LICENSE) © foxbuntu
