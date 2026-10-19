# Plan de cierre — Foxen v0.1.0

## Estado actual (ya aplicado, sin commitear)

**Backend Rust** ✔ `cargo check` verde
1. `git/github_auth.rs`: eliminado el `DEFAULT_CLIENT_ID` muerto (devolvía 404);
   Client ID solo por `FOXEN_GITHUB_CLIENT_ID` o explícito; nuevo
   `device_flow_configured()`; validación de nombre de repo con reglas de GitHub
   (1-100 chars, alfanumérico + `-_ .`, sin iniciar en `.`/`-`);
   `poll_for_token` ya no depende del ID muerto.
2. `commands/github_auth.rs`:
   - `github_get_user` / `github_list_repos` usan `github_token()` (llavero →
     fallback `gh`), eliminada la inconsistencia.
   - `publish_remote_and_push` con parámetro `replace_origin`: no pisa `origin`
     sin confirmación; si el push falla tras crear el repo, el error dice
     claramente que el repo **ya existe en GitHub** y su URL.
   - Nuevo comando `github_device_flow_configured`.
3. `lib.rs`: comando registrado.

**Frontend** ✔ pendiente de `tsc`/`lint`
4. `ipc.ts`: wrappers nuevos (`githubDeviceFlowConfigured`, `replaceOrigin` en publish).
5. `useAppStore.ts`: `publishToGitHub` acepta `replaceOrigin` y ya no cierra el
   modal (el éxito se muestra allí).
6. `PublishToGitHubModal.tsx`: confirmación nativa (`dialog::confirm`) si hay
   `origin` con otra URL; vista de éxito con botón **"Ver en GitHub"**
   (plugin opener).
7. `GitHubAuthModal.tsx`: consulta disponibilidad del Device Flow; si no está
   configurado se oculta el botón de navegador y se ofrece configurar Client ID;
   `gh` y PAT siempre disponibles.
8. `desktop.ts`: F12/devtools (Ctrl+Shift+I/J/C) **no se bloquean en
   desarrollo**; en release se bloquean.
9. `preview.tsx`: comentario actualizado (se queda como herramienta visual) +
   mock del comando nuevo.

## Pendiente

### 1. Tests frontend (vitest ya configurado, 0 tests hoy)
- [x] `src/lib/session.test.ts`: roundtrip, datos corruptos, `active` inválido.
- [x] `src/lib/desktop.test.ts`: F5/Ctrl+R bloqueados, devtools permitidas en
  DEV, contextmenu anulado.
- [x] `src/lib/format.test.ts`: utilidades puras (laneColor, statusChar,
  truncateMiddle…).
- [x] `src/lib/b64.test.ts`: roundtrip base64 UTF-8.

### 2. Documentación
- [x] `README.md`: qué es Foxen, features, requisitos, build
  (`npm install`, `npm run tauri:dev`, `./build-deb.sh`), autenticación GitHub
  (`gh`, PAT, `FOXEN_GITHUB_CLIENT_ID`), estructura del proyecto.
- [x] `LICENSE`: MIT (foxbuntu, 2026).

### 3. Pulido menor
- [x] `TopBar.tsx`: corregir indentación del `</button>` de "Clonar desde
  GitHub".

### 4. Verificación completa
- [x] `npx tsc --noEmit`, `npm run lint`, `npm run test`, `npm run build`.
- [x] `cargo check`, `cargo test --lib`, `cargo test --test git_integration`.
- [x] `./build-deb.sh` (`Foxen_0.1.0_amd64.deb`, 4.86 MiB).

### 5. Cierre
- [x] Entrada en `DIARIO.md` (device flow honesto, publicación con control de
  origin, tests, docs).
- [x] Commits en chunks lógicos:
  1. `feat(github): device flow configurable + publicación con control de origin`
  2. `feat(desktop): devtools accesibles en desarrollo + tests de utilidades`
  3. `docs: README, LICENSE y diario de la 0.1.0`
- [x] Tag `v0.1.0` (local, sin push). Movido después al commit final de la
  Parte 2 (`b249572`).

## Fuera de alcance (para después)
- CI (GitHub Actions), publicación flatpak, i18n, tests E2E con geckodriver
  automatizados.
