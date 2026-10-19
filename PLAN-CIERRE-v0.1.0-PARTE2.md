# Plan de cierre — Foxen v0.1.0 (Parte 2: kernel, Rust y multi-distro)

> Continuación de `PLAN-CIERRE-v0.1.0.md` tras la auditoría posterior al tag.
> Estado de partida: tag `v0.1.0` en `c9b88d6`, fix de opener en `d629666`.

## Contexto: hallazgos de la auditoría

| # | Hallazgo | Severidad |
|---|---|---|
| 1 | Binario necesita **glibc 2.39** (host 2.43): no arranca en Debian 12 / Ubuntu 22.04 | Crítica (multi-distro) |
| 2 | Sin eventos ni refresh externo: `git commit` en terminal deja la UI obsoleta | Alta |
| 3 | Sin watcher de kernel (ni crate `notify`): cero inotify/fanotify | Alta (petición) |
| 4 | `.desktop` declara `x-scheme-handler/git` pero argv se ignora | Media |
| 5 | Sesión/tema en `localStorage` del webview, no en Rust | Media |
| 6 | RPM sin `requires`; deb con Depends duplicados; rpm/AppImage nunca construidos | Media |
| 7 | flatpak-builder ausente (sudo interactivo); vía `org.flatpak.Builder` en flathub | Media |
| 8 | Metainfo duplicado (`packaging/` vs `packaging/deb/`) | Baja |

Decisiones aprobadas por el usuario:
- Mover el tag `v0.1.0` al **commit final** de este plan (incluye `d629666`).
- **Activar flatpak** (validar build del manifiesto existente).
- **Implementar** el manejador de enlaces `git://` (abre el flujo de clonado).

## Fase A — Kernel y refresco automático (Rust primero)

- [x] Dependencia `notify` 8.2 (backend inotify en Linux).
- [x] `src-tauri/src/watch.rs`: `WatchRegistry` gestionado con `manage()` en `lib.rs`.
  - `watch(app, repo_id, dir)`: watcher recursivo sobre la raíz del repo.
    Fallback si se agotan los watches: solo `.git` recursivo.
  - Debounce trailing-edge 250 ms por repo (tarea tokio por watcher).
  - Filtro de eventos: ignorar `EventKind::Access` (no modifica estado).
  - `emit("git://changed", { repoId })` vía `Emitter`.
  - `unwatch(repo_id)` al cerrar; drop del watcher ⇒ fin limpio de la tarea.
- [x] Enganchar en comandos: `open_repository` (incluye bare/clone) y
  `close_repository`; `AppHandle` + `State<WatchRegistry>` como parámetros.
- [x] Frontend: `listen('git://changed')` → si `repoId` activo, `refreshAll()`
  con debounce de ~200 ms.
- [x] Refresco al recuperar foco de ventana (`focus`, debounce 500 ms).
- [x] Botón ⟳ en `TopBar` + atajos **Ctrl+R** y **F5** → `refreshAll()`.

## Fase B — Compatibilidad multi-distro

- [x] `build-in-container.sh` (docker → podman): base `node:22-bookworm`
  (Debian 12, glibc 2.36).
  - **Corrección**: `ubuntu:22.04` no es viable — no existe
    `libwebkit2gtk-4.1-dev` (Tauri 2 exige webkit2gtk 4.1). Mínimo real:
    Debian 12+/Ubuntu 23.04+.
  - `readelf -V` del binario: exigir **GLIBC ≤ 2.36**; conseguido **2.34**.
  - Construye **deb + rpm + AppImage** con `npx tauri build -b ...`.
  - Artefactos a `dist/packages/{deb,rpm,appimage}/`; volúmenes de caché
    (`docker-foxen-build-*`) y copia fuera del workspace, con `chown` de vuelta.
  - Reintento automático ante `SIGPIPE` (141) esporádico del motor.
- [x] `tauri.conf.json`:
  - RPM: **sin `depends`** explícito (Tauri autogenera los sonames correctos:
    `libwebkit2gtk-4.1.so.0()(64bit)`, `libgtk-3.so.0()(64bit)`).
  - Eliminado `deb.depends` explícito (se duplicaba:
    `libwebkit2gtk-4.1-0, libgtk-3-0, libwebkit2gtk-4.1-0, libgtk-3-0`).
  - `desktopTemplate` + `files` por target para que el `.desktop`/iconos
    usen el id de la app (`com.foxbuntu.foxen`) — requisito de exportación de
    Flatpak y de `<launchable>` de AppStream.
- [x] Validado por primera vez rpm (`rpm -qRp/-qlp`) y AppImage
  (`--appimage-extract`).
- [x] `README.md`: matriz de compatibilidad real (Debian 12+/Ubuntu 23.04+/
  Fedora 38+; paquetes webkit2gtk-4.1 por distro; OpenSSL 3; nota de Secret
  Service en entornos headless → fallback a memoria + `gh`).
- [x] Metainfo AppStream unificado en `packaging/com.foxbuntu.foxen.metainfo.xml`
  (una sola copia, `Icon=com.foxbuntu.foxen`, `<launchable>` al id de la app).

## Fase C — Flatpak

- [x] `org.flatpak.Builder` instalado `--user`, pero **su sandbox no ve los
  runtimes de usuario** (`org.gnome.Sdk/x86_64/50 not installed`). Solución sin
  sudo: `flatpak-builder` 1.4.8 extraído de su `.deb` de Ubuntu (`apt-get
  download` + `dpkg -x`) y ejecutado en el host; `appstreamcli-compose` (ruta
  fija `/usr/libexec`) aportado igual y expuesto con `unshare -rm` + bind mount.
  Todo encapsulado en `build-flatpak.sh` (usa el `flatpak-builder` del PATH si
  existe y, si no, prepara `.flatpak-tools/` automáticamente).
- [x] Runtime GNOME **50** (el más reciente disponible) en
  `runtime-version`; `flatpak install --user org.gnome.Platform//50
  org.gnome.Sdk//50`.
- [x] Construido a partir del **.deb del contenedor**; el módulo adapta la
  descompresión al `data.tar.*` real (xz tras el post-proceso).
- [x] Instalado `--user` y verificado: se exportan
  `com.foxbuntu.foxen.desktop` + iconos `com.foxbuntu.foxen.png` (32/128/512) +
  metainfo; commit base 11,3 MB.

## Fase D — Enlaces `git://`

- [x] Rust: parsear argv del primer arranque y del callback single-instance
  (`git://`, `ssh://`, `http(s)://…*.git`) con `url::Url` (`deeplink.rs`, 4 tests).
  - URL pendiente en estado gestionado + comando `take_pending_clone_url`.
  - Segundo arranque: `emit("git://clone-request", { url })`.
- [x] Frontend: al montar, `takePendingCloneUrl()`; también `listen` del evento.
  - Elegir carpeta destino (`dialog.open({ directory: true })`) →
    `cloneAndOpen(url, path)`; errores con `notify`.
- [x] El `MimeType=x-scheme-handler/git` del `.desktop` queda justificado.

## Fase E — Preferencias en Rust

- [x] `settings.json` en `dirs::config_dir()/foxen/` (escritura atómica
  tmp+rename): `{ session: { paths, active }, theme }` (`settings.rs`, 2 tests).
- [x] Comandos `settings_load` / `settings_save_session` / `settings_save_theme`
  + wrappers en `ipc.ts`.
- [x] `session.ts` y `theme.ts` leen/escriben vía Rust; migración única desde
  `localStorage` (la clave de sesión se limpia; la del tema se conserva como
  caché de primer pintado, la verdad está en Rust).

## Fase F — Verificación y cierre

- [x] Gates: `cargo check`, `cargo test --lib` (9+1 ignored), `cargo test
  --test git_integration` (33), `tsc --noEmit`, `eslint --max-warnings 0`,
  `vitest` (35), `vite build`.
- [x] Builds: contenedor (deb 3,8 MB + rpm 5,3 MB + AppImage 102 MB) y flatpak
  (11,3 MB); GLIBC verificada con `readelf -V` (máx **2.34**).
- [x] `DIARIO.md`: análisis de kernel, decisiones y matriz de compatibilidad.
- [x] Commits en chunks lógicos (watcher/eventos, multi-distro, flatpak,
  git://, settings en Rust, docs).
- [x] **Tag `v0.1.0` movido al commit final** (incluye `d629666`). Sin push.

## Decisiones de kernel documentadas (no implementadas a propósito)

- **io_uring**: sin beneficio real — libgit2 hace sus propias lecturas síncronas
  (ya en `spawn_blocking`) y `reqwest` ya es async.
- **fanotify**: requiere `CAP_SYS_ADMIN`; inaceptable para una app de usuario.
- **inotify** (≥ 2.6.13, sin privilegios): elegido; disponible en todo kernel
  soportado y con degradación elegante si se agotan los watches.
- **pidfd**: marginal — `portable-pty` ya gestiona los procesos hijos.

## Fuera de alcance

- CI (GitHub Actions), i18n, tests E2E con geckodriver, publicación real en
  Flathub (requiere release con URL+sha256), firma de paquetes.
