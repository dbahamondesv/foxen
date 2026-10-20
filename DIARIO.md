# Diario de Foxen

## 2026-10-06

### Credenciales Git (configuración por host)
- **Backend (Rust/Tauri)**:
  - Añadido `CredentialStatus { host, saved, username }` en `types.rs` (no expone contraseña).
  - Nuevos comandos: `store_credential(host, credential)`, `forget_credential(host)`, `credential_status(host)`. Normalizan el host con `remote::url_host()` (acepta URL completa o `github.com`).
  - Registrados en `src-tauri/src/lib.rs`. La clave del llavero es **el host** (comparte credenciales entre repositorios).
  - `RemoteInfo` pasa a incluir `host`. `git/remote.rs` lo calcula al listar/añadir remotos.
  - Corregido mensaje de error corrupto: `"guardalas desde Foxen"`.
- **Frontend (React/TypeScript)**:
  - `src/lib/types.ts`: añade `CredentialStatus`, `RemoteInfo.host`.
  - `src/lib/ipc.ts`: wrappers `storeCredential`, `forgetCredential`, `credentialStatus` (por host).
  - Nuevo componente reutilizable `src/components/CredentialsForm.tsx` (badge de estado, usuario/token, Guardar/Olvidar, limpia contraseña tras guardar).
  - `src/components/RemotesPanel.tsx`: por cada remoto HTTP muestra `CredentialsForm`; `askCredential()` consulta estado guardado y **aborta** la operación si el usuario cancela los prompts. Usa `remote.host` para consultar estado.
  - `src/components/SettingsPanel.tsx`: nueva sección **Credenciales**. Chips con remotos HTTP del repo abierto (preselecciona el primero), input de host con debounce 250ms, y `CredentialsForm`.
- **Estilos**: `.creds-form`, `.host-chips`, soporte `input[type='password']`.
- **Preview**: `src/preview.tsx` acepta `?panel=remotes` con `mockIPC`.

### Verificación
- `typecheck`, `lint`, `build`, `cargo check`, `cargo test --lib` → **verde** (4 tests: 3 ok, 1 ignored).
- Verificación E2E con geckodriver: CRUD de credenciales funciona, contraseña no queda visible tras guardar, botón Olvidar se habilita/deshabilita, sin overflow.
- App levantada en modo `tauri dev` (PID `~/tmp/foxen-dev.pid`, logs `~/tmp/foxen-dev-*.log`).

### Notas
- SSH no muestra formulario (usa `ssh-agent`).
- Credenciales en llavero del SO por host. Nunca en texto plano.

## 2026-10-13 (tarde)

### Mejora autenticación Git (MFA/2FA con helpers del sistema)
- **Backend (src-tauri/src/git/remote.rs)**:
  - Modificado callbacks de credenciales para delegar a helpers del sistema cuando libgit2 solicita `DEFAULT` o `USERNAME`.
  - Añadido intento `Cred::default()` (credential helpers: `gh`, Git Credential Manager, libsecret/keychain, etc.) para soportar login por navegador + MFA.
  - Añadido intento `Cred::username()` cuando el servidor solo pide username.
  - Se mantiene fallback a PAT guardado en keyring (`USER_PASS_PLAINTEXT`) y SSH vía `ssh-agent`.
  - Mensaje de error actualizado para indicar uso alternativo de helpers del sistema.
- **Validación**: `cargo check` OK, `cargo test` (33 passed, 0 failed).

## 2026-10-14

### Autenticación OAuth con GitHub (Device Flow) y Gestión de Fuentes
- **Backend (Rust/Tauri)**:
  - Módulo `src-tauri/src/git/github_auth.rs`:
    - Implementado flujo OAuth Device Flow contra `https://github.com/login/device/code` y `https://github.com/login/oauth/access_token` con scope `repo read:user user:email`.
    - Soporte para Client ID configurable vía `FOXEN_GITHUB_CLIENT_ID` con valor predeterminado seguro.
    - Polling inteligente con backoff automático en respuesta a `slow_down` y manejo de expiración/denegación.
    - Consulta de perfil de usuario (`get_user_info`) y listado de repositorios (`list_repos`) con headers API GitHub v3.
    - Almacenamiento automático del token en el llavero del sistema bajo `github.com` con `store_credential`.
  - Comandos en `src-tauri/src/commands/github_auth.rs`:
    - `github_start_login`: inicia device flow y abre el navegador por defecto automáticamente vía `tauri_plugin_opener::open_url`.
    - `github_poll_login`: espera autorización y persiste credenciales.
    - `github_login_complete`: permite autenticación o fallback manual mediante Personal Access Token (PAT).
    - `github_get_user`: recupera el usuario autenticado desde el llavero.
    - `github_logout`: borra credenciales de GitHub del llavero del sistema.
    - `github_list_repos`: obtiene los repositorios del usuario (privados y públicos).
  - Nueva función `clone_repository` en `remote.rs` y comando `commands::clone_repository`:
    - Clona repositorios usando libgit2 con callbacks de autenticación automática contra el llavero (`callbacks`), y abre el repositorio directamente en Foxen.
  - `types.rs`: añadidos tipos `GitHubUser`, `GitHubRepo`, `GitHubLoginState`, `GitHubLoginResult`.
  - `error.rs`: añadidos helpers de error `AppError::authentication` y `AppError::network`.
- **Frontend (React/TypeScript/Zustand)**:
  - `src/lib/types.ts` & `src/lib/ipc.ts`: contratos e invocaciones tipadas para GitHub y clonación.
  - `src/store/useAppStore.ts`: estado global para usuario de GitHub (`githubUser`), modales, lista de repositorios y acción `cloneAndOpen`.
  - `src/components/GitHubAuthModal.tsx`:
    - Modal interactivo con botón de login, visualización destacada del código de usuario, copia al portapapeles, botón para reabrir navegador y polling en tiempo real.
    - Alternativa para PAT manual si el usuario lo requiere.
  - `src/components/GitHubReposModal.tsx`:
    - Explorador y gestor completo de repositorios GitHub: buscador, filtro por públicos/privados, badges de estado, botón para clonar y abrir directamente en Foxen, y enlace directo a GitHub.
  - `src/components/TopBar.tsx`:
    - Botón interactivo de GitHub en la cabecera: muestra `🐙 GitHub` si no está conectado y `🐙 @usuario` con avatar si está autenticado.
    - Opción añadida en el selector `Foxen ▾`: "Clonar desde GitHub…".
  - `src/App.tsx`:
    - Pantalla de bienvenida (`welcome`) enriquecida con acceso directo a "Abrir local" y "Explorar repositorios de GitHub".
    - Renderizado condicional de los modales de autenticación y fuentes.
  - `src/components/SettingsPanel.tsx`: sección "Cuenta de GitHub" con estado de conexión, acceso a repositorios y cierre de sesión.
  - `src/components/CredentialsForm.tsx`: botón directo para iniciar sesión vía navegador cuando el host es `github.com`.
  - `src/preview.tsx`: mocks integrados para pruebas en entorno sin Tauri.
- **Validación**:
  - `cargo check`: OK.
  - `cargo test --lib`: 4 tests (3 ok, 1 ignored).
  - `cargo test --test git_integration`: 33 tests pasados (0 fallos).
  - `npm run typecheck`, `npm run lint`, `npm run build`: todos verdes.

## 2026-10-15

### Fix: fetch/push rechazado y login GitHub roto

Diagnóstico:
- El `DEFAULT_CLIENT_ID` (`Ov23liMcveN7uGz5wzFz`) del Device Flow devuelve **HTTP 404** en
  `https://github.com/login/device/code` (la OAuth App no existe o no tiene "Enable Device Flow").
  Por eso el login fallaba y no se guardaba token → fetch sin credenciales → rechazo.
- **libgit2 NO ejecuta los `credential.helper` de git** (gh, GCM, libsecret...). `Cred::default()`
  es solo para NTLM/Negotiate, no resuelve helpers. Por eso `gh auth login` no servía a Foxen.

Cambios backend:
- `src-tauri/src/git/remote.rs`:
  - Revertidas las ramas `CredentialType::DEFAULT`/`USERNAME` (no hacían lo que decía el comentario).
  - Nueva `credential_from_helper(host, url)`: invoca `git credential fill` (con `GIT_TERMINAL_PROMPT=0`)
    como último recurso para HTTP(S), reutilizando los helpers configurados (p. ej. `gh auth git-credential`).
  - Orden de resolución en `callbacks`: sesión → llavero → helper del sistema.
- `src-tauri/src/git/github_auth.rs`: nueva `token_from_gh()` (`gh auth token --hostname github.com`).
- `src-tauri/src/commands/github_auth.rs`: nuevo comando `github_login_with_gh` (reutiliza la sesión
  de `gh`, valida con la API, guarda el token en el llavero bajo `github.com`).
- `src-tauri/src/lib.rs`: registrado `github_login_with_gh`.

Cambios frontend:
- `src/lib/ipc.ts`: wrapper `githubLoginWithGh`.
- `src/components/GitHubAuthModal.tsx`: se deja de auto-iniciar el Device Flow (que fallaba al 404);
  pantalla inicial con dos opciones explícitas ("⚡ Usar sesión de GitHub CLI (gh)" y
  "🌐 Iniciar sesión en el navegador") + PAT. El panel de error también ofrece el botón de `gh`.
- `src/preview.tsx`: mock de `github_login_with_gh`.

Verificación:
- `cargo check`, `cargo test` (3+33 ok), `npx tsc --noEmit`, `npm run lint`, `npm run build`: verdes.
- Prueba E2E real: se ejecutó `remote::fetch` de Foxen contra `DemoJavaQuarkus`
  (`https://github.com/dbahamondesv/DemoJavaQuarkus.git`) **sin** credencial en llavero →
  `OK: origin: sin cambios`, resolviendo el token vía `git credential fill` + helper de `gh`.

### Fix crítico: fetch/push en repos PRIVADOS (callbacks nunca se invocaban)

Síntoma: en un repo privado (`music-player` → `github.com/dbahamondesv/metronome.git`) el fetch
fallaba con `Authentication (1008)`, aunque `git ls-remote` con el helper de `gh` funcionaba.
El repo público `DemoJavaQuarkus` "funcionaba" solo porque no requiere autenticación (falso positivo).

Causa raíz:
- `fetch_one` (y `push`) llamaban a `remote.connect(Direction::…)` **antes** de `remote.fetch/push`.
- En git2 0.20.4, `Remote::connect(dir)` invoca `git_remote_connect` con callbacks/proxy en `null`
  (ver `git2-0.20.4/src/remote.rs:182`). Es decir, conectaba **sin** los callbacks de autenticación.
- La conexión sin credenciales a un repo privado devuelve 401 y aborta antes de que se invoque
  el callback (`[callbacks]` nunca se imprimía con logging temporal).
- `Remote::fetch`/`Remote::push` ya conectan internamente usando las `FetchOptions`/`PushOptions`
  (que sí llevan los callbacks), así que el `connect` previo era redundante y dañino.

Solución (`src-tauri/src/git/remote.rs`):
- Eliminado `remote.connect(...)` en `fetch_one` y en `push`. Se deja que `fetch`/`push`
  gestionen la conexión con las opciones (y callbacks) provistas.
- Verificado con el repo privado real: `remote::fetch` → `OK: origin: sin cambios`.

Nota de aprendizaje: para validar credenciales hay que probar contra un remoto **privado**;
un repo público no ejercita el camino de autenticación.

2025-10-15 20:12 - Persistencia de repos abiertos + publicación en GitHub + fix upstream + desactivar browser
- Persistencia: src/lib/session.ts guarda {paths, active}. Store: restoreSession, remember/forget en openPath/cloneAndOpen/closeCurrent. App.tsx llama restoreSession.
- Desactivar navegador: src/lib/desktop.ts bloquea contextmenu, F5/F12, Ctrl/Cmd+R/P/U/S/O/N/I/J/C/±/0, wheel+ctrl. main.tsx llama disableBrowserFeatures().
- GitHub publish: src-tauri/src/git/github_auth.rs create_repo (POST /user/repos o /orgs/{org}/repos), commands/github_auth.rs github_create_repo/github_publish_repo. publish añade origin (o actualiza URL) y hace push de rama actual con set_upstream. remote.rs fix: set_branch_upstream tras push exitoso.
- Registrados comandos en lib.rs. Frontend: ipc, store, PublishToGitHubModal, entry points en TopBar/RemotesPanel, App.tsx.

Verificación: cargo check/test OK (33 pass), tsc --noEmit OK, eslint OK, vite build OK.

## 2026-10-19

### Cierre de la v0.1.0: device flow honesto, publicación robusta, tests y docs

**Backend (Rust)**:
- `git/github_auth.rs`: eliminado el `DEFAULT_CLIENT_ID` muerto (devolvía HTTP 404
  porque la OAuth App no existía o no tenía Device Flow). El Client ID ahora viene
  solo de `FOXEN_GITHUB_CLIENT_ID` o del parámetro explícito del modal.
  - `device_flow_configured()` + comando `github_device_flow_configured`: el
    frontend consulta si el Device Flow es viable antes de ofrecerlo.
  - `start_device_flow` falla rápido con mensaje accionable si no hay Client ID.
  - `validate_repo_name` con las reglas de GitHub (1-100 chars, alfanumérico y
    `-_ .`, sin empezar por `.` ni `-`): error claro antes de llamar a la API.
- `commands/github_auth.rs`:
  - `github_get_user`/`github_list_repos` usan `github_token()` (llavero → `gh`),
    antes ignoraban la sesión de `gh`.
  - Publicación con control de `origin`: `publish_remote_and_push` exige
    `replace_origin` para pisar una URL existente; sin él, error con la URL actual.
  - Si el push falla tras crear el repo remoto, el error indica que el repo **ya
    existe en GitHub** y su URL, para no crear duplicados.

**Frontend**:
- `PublishToGitHubModal`: confirmación nativa del SO si hay `origin` con otra URL;
  tras el éxito, vista de resumen con **"Ver en GitHub"** (plugin opener). El store
  ya no cierra el modal automáticamente.
- `GitHubAuthModal`: el botón de navegador solo aparece con Device Flow configurado
  (env o Client ID tecleado en el propio modal); si no, se explica y se ofrece
  configurarlo. `gh` y PAT siguen siempre disponibles.
- `desktop.ts`: en desarrollo no se bloquean F12/devtools (`isBrowserShortcut`
  parametrizable con `isDev`); en release siguen bloqueadas.
- `tsconfig.json`: añadido `vite/client` a `types` (tipos de `import.meta.env`).
- `preview.tsx`: deja de llamarse "temporal" — se queda como herramienta de
  inspección visual; mock de `github_device_flow_configured`.

**Tests y docs**:
- Primeros tests del frontend con Vitest (32 tests): `session`, `desktop`
  (atajos bloqueados/permitidos), `format` y `b64`.
- `README.md` (features, build, autenticación, estructura) y `LICENSE` (MIT),
  que el metainfo AppStream ya declaraba.
- `PLAN-CIERRE-v0.1.0.md`: plan de cierre con checklist.

**Verificación**: `tsc --noEmit`, `eslint --max-warnings 0`, `vitest` (32/32),
`vite build`, `cargo check`, `cargo test --lib` (3+1 ignored),
`cargo test --test git_integration` (33/33), `./build-deb.sh` →
`Foxen_0.1.0_amd64.deb` (4.86 MiB).

### Post-cierre: el botón «Ver en GitHub» no abría la página

**Causa raíz**: en `tauri-plugin-opener` 2.7.0 el scope del comando y las URLs
permitidas son permisos separados. La capability solo tenía `opener:allow-open-url`
(habilita el comando *sin* scope) y faltaba `opener:allow-default-urls` (los
patrones `https://*`), así que `open_url` devolvía `ForbiddenUrl` y el `void
openUrl(...)` del frontend lo tragaba en silencio. **Todos** los `openUrl` del
frontend estaban rotos (publicar, clonar, PAT, ajustes OAuth); solo funcionaba
el navegador abierto desde Rust (`github_start_login`), que no pasa por IPC.

**Arreglos**:
- `capabilities/default.json`: añadido `opener:allow-default-urls`.
- Los 7 `openUrl` del frontend ahora tienen `.catch(err => notify(...))` con
  `errorMessage`: ningún fallo queda silencioso.
- CSP: `img-src` acepta `https://avatars.githubusercontent.com` — el avatar de
  GitHub (TopBar y modal de repos) estaba bloqueado y no cargaba.
- `github_login_complete`: el PAT **se valida contra la API antes de guardarlo**
  (antes un token inválido se guardaba con usuario `"git"` y devolvía éxito);
  además comprueba que el usuario tecleado coincida con la cuenta del token.
  Igual en `github_login_with_gh` y en el device flow (`poll_for_token`), que
  ahora exige obtener el perfil antes de declarar sesión.

**Verificación**: `cargo check` (schema regenerado con el permiso nuevo),
`tsc`, `eslint`, `vitest` 32/32, `vite build`, `cargo test --lib` 3,
`git_integration` 33/33, `.deb` regenerado.

## 2026-10-19

### Cierre v0.1.0 — Parte 2 (kernel, Rust y multi-distro)

Plan: `PLAN-CIERRE-v0.1.0-PARTE2.md`. Objetivo: exprimir Rust, aprovechar el
kernel moderno y publicar paquetes que funcionen en más de una distribución.

#### Fase A — Refresco automático (inotify)
- Dependencia `notify` 8.2 (backend **inotify** en Linux).
- `src-tauri/src/watch.rs`: `WatchRegistry` con un watcher recursivo por repo;
  si se agotan los watches, degrada a vigilar solo `.git`. Debounce
  *trailing-edge* de 250 ms por repo, se ignoran los eventos `Access` (no
  cambian el estado) y se emite `git://changed` con `{ repoId }`.
- Enganchado en `open_repository`/`clone_repository` (registra) y
  `close_repository` (desregistra); el `drop` del watcher termina su tarea.
- Frontend: listener de `git://changed` con debounce de 200 ms sobre
  `refreshAll()`, refresco al recuperar el foco (500 ms) y botón ⟳ en la barra
  superior + atajos **Ctrl+R**/**F5**.

#### Fase B — Multi-distro
- `build-in-container.sh`: construye **deb + rpm + AppImage** dentro de
  `node:22-bookworm` (Debian 12, glibc 2.36) con docker o podman, volúmenes de
  caché para cargo/rustup/npm/target, etapa temporal aislada y copia de solo los
  tipos pedidos a `dist/packages/`. Verifica con `readelf -V` que el binario no
  exija más de GLIBC 2.36; en la práctica exige **2.34**.
- **Corrección de plan**: `ubuntu:22.04` no es viable, no empaqueta
  `webkit2gtk-4.1` (lo exige Tauri 2). Mínimos reales: Debian 12+/Ubuntu 23.04+.
- `tauri.conf.json`: se eliminan los `depends` explícitos (el deb los duplicaba
  y el rpm ya autogenera los sonames correctos).
- Un `.desktop` y un metainfo únicos, con el **id de la app**
  (`com.foxbuntu.foxen`): requisito de Flatpak (`non-allowed export filename`)
  y del `<launchable>` de AppStream. El deb renombra `Foxen.desktop` en un
  post-proceso (`packaging/postprocess-deb.sh`, regenera `md5sums` e
  `Installed-Size`); el rpm usa una plantilla `NoDisplay` para el `.desktop`
  oculto y aporta el canónico por `files`; el AppImage acepta el nombre libre.

#### Fase C — Flatpak
- Manifiesto a runtime **GNOME 50**; se construye a partir del **.deb del
  contenedor** (glibc baja y determinista).
- `org.flatpak.Builder` no sirve en esta máquina: su sandbox no ve los runtimes
  de usuario. Solución sin root, encapsulada en `build-flatpak.sh`: usa el
  `flatpak-builder` del sistema si existe y, si no, prepara uno portable en
  `.flatpak-tools/` (extraído con `apt-get download` + `dpkg -x`) y aporta
  `appstreamcli-compose` (ruta fija `/usr/libexec`) con `unshare -rm` + bind
  mount.
- Instalado `--user`: se exportan `com.foxbuntu.foxen.desktop`, los iconos
  `com.foxbuntu.foxen.png` (32/128/512) y el metainfo.

#### Fase D — Enlaces `git://`
- `src-tauri/src/deeplink.rs`: normaliza `git://`, `ssh://` y `http(s)://…*.git`
  con `url::Url`; URL pendiente en estado + comando `take_pending_clone_url`.
- Primer arranque: se consume al montar el frontend. Segundo arranque
  (single-instance): evento `git://clone-request`. El frontend pide carpeta y
  lanza `cloneAndOpen`. Queda justificado el `x-scheme-handler/git`.

#### Fase E — Preferencias en Rust
- `src-tauri/src/settings.rs`: `~/.config/foxen/settings.json` con escritura
  atómica (tmp + rename) y recuperación ante archivo corrupto.
- Comandos `settings_load` / `settings_save_session` / `settings_save_theme`.
- `session.ts` y `theme.ts` pasan a leer/escribir vía Rust, con migración única
  desde `localStorage`. La caché de tema en `localStorage` se conserva solo para
  el primer pintado (evita el parpadeo); la de sesión se limpia tras migrar.

#### Decisiones de kernel (no implementadas a propósito)
- **io_uring**: sin beneficio real; libgit2 hace lecturas síncronas (ya en
  `spawn_blocking`) y `reqwest` es async.
- **fanotify**: exige `CAP_SYS_ADMIN`, inaceptable en una app de usuario.
- **pidfd**: marginal; `portable-pty` ya gestiona los procesos hijos.
- **inotify** (≥ 2.6.13, sin privilegios): elegido, con degradación elegante.

#### Verificación
- `cargo check`, `cargo test --lib` (9 + 1 ignored), `cargo test --test
  git_integration` (33), `tsc --noEmit`, `eslint --max-warnings 0`, `vitest`
  (35) y `vite build`: **todo verde**.
- Paquetes: deb 3,8 MB, rpm 5,3 MB, AppImage 102 MB; flatpak 11,3 MB. GLIBC
  máxima exigida: **2.34**.
- Artefactos verificados: `dpkg-deb -c` (desktop con id de app, iconos,
  metainfo), `rpm -qlp`/`-qRp` (sonames), `--appimage-extract`, y `flatpak
  install --user`.

#### Incidencias
- `build-in-container.sh` devolvía `SIGPIPE` (141) de forma esporádica antes de
  arrancar el contenedor; se añadió un reintento acotado.
- El post-proceso del deb comprime con `xz`; el módulo flatpak pasa a usar
  `tar -xf data.tar.*` en lugar de asumir `.gz`.

### Botones de commit/push y flujo de fusion en la UI

Motivado por la falta de acciones visibles: el commit solo estaba en el panel
Cambios y el push, como enlace diminuto por remoto. «Si no hay botón de commit
y push, no sirve».

#### Commit y push
- **Barra superior** (`TopBar.tsx`): botones **Commit** (usa el mensaje del
  panel Cambios; deshabilitado sin stage o sin mensaje) y **Push** (sube la
  rama actual; muestra `Push ↑N` si hay commits pendientes).
- **Panel Cambios** (`ChangesPanel.tsx`): botón **Commit y push** junto a
  Commit.
- **Store** (`useAppStore.ts`): accion `pushCurrent()` que resuelve el remoto
  (el del upstream, si no `origin`, si no el primero), empuja la rama actual y
  fija el upstream en el primer push (`set_upstream`).
- Commit `c33ad8b` «Mejoras de botón commit , push» (hecho desde fuera del
  agente).

#### Fusion (merge) completa
Antes solo existia el enlace `fusionar` (estrategia por defecto) y, ante
conflictos, la UI se limitaba a avisar: habia que cerrar la fusion desde la
terminal. Ahora:

- **Backend**:
  - `commit_ops::commit` cierra una fusion como Git: si hay `MERGE_HEAD` anade
    sus Oids como padres adicionales (commit de merge real), permite el commit
    aunque el arbol coincida con el primer padre y limpia `MERGE_HEAD`/
    `MERGE_MSG` al terminar.
  - Nuevo comando `merge_continue` (registrado en `lib.rs`) y helper
    `merge::merge_message` (lee `MERGE_MSG` sin las lineas de comentario).
- **Frontend**:
  - `MergeModal.tsx`: al pulsar `fusionar` se elige estrategia (automatica,
    merge commit `--no-ff`, solo fast-forward, squash) y mensaje del merge.
  - `OperationBanner.tsx`: aviso bajo la barra superior cuando hay fusion o
    rebase en curso, con **Continuar** (merge commit / reaplicar rebase),
    **Saltar** (solo rebase) y **Abortar**.
  - `ChangesPanel.tsx`: por cada archivo en conflicto, botones
    `mio · suyo · base · resuelto` sobre `resolve_conflict`.
  - Store: `mergeTarget` + `openMerge`/`closeMerge`; `ipc.mergeContinue`.
- **Test**: `cerrar_merge_con_conflicto_crea_commit_de_dos_padres` verifica que
  el commit de cierre tiene dos padres y que el estado de fusion queda limpio
  (`git_integration` 34/34).

#### Origen y destino en la fusion
- El `merge` generico solo integrá la rama pulsada **en la actual**: para
  `feat -> dev` habia que hacer checkout manual primero. Se anade:
  - `MergeModal` con **selector de rama destino** (por defecto la actual y se
    advierte si hay cambio de rama), de modo que `feature/x -> develop` es un
    solo paso.
  - Backend `merge::merge_into` + comando `merge_into`: cambia de rama si hace
    falta, fusiona y **se queda en el destino**; ante error duro restaura la
    rama de partida.
- **Bug corregido** en Git Flow: `flow::merge_into` volvia a la rama anterior
  aunque la fusion fallara por conflictos, dejando `develop` a medias y el
  commit de cierre cayendo en la rama equivocada. Ahora, con conflictos, se
  queda en la rama destino (que es la que deben usar Continuar/Abortar) y solo
  vuelve si la fusion fue limpia.
- **Test**: `merge_into_cambia_al_destino_y_fusiona` (`git_integration` 35/35).

#### Verificación y paquetes
- Gates: `cargo check`, `cargo test --lib` (9), `git_integration` (34),
  `tsc --noEmit`, `eslint --max-warnings 0`, `vitest` (35) y `vite build`.
- Reconstruidos deb (3,8 MB), rpm, AppImage (102 MB) y flatpak (reinstalado,
  commit nuevo) para probar los botones.
- Nota operativa: el `.deb` antiguo (`/usr/bin/foxen`) no contenia estos
  cambios; el AppImage permite probarlos sin `sudo`.

## 2026-10-20

### Rediseño UI/UX: Líneas del Grafo y Nueva Interfaz Limpia (Estilo GitFiend)
- **Análisis exhaustivo**: Documentado al detalle en `DIARIO_ANALISIS.md`.
- **Grafo de commits (`CommitGraph.tsx`)**:
  - Sustituido el trazado rígido en ángulo recto de 90° (`M x1 y1 V y2 H x2`) por geometría diagonal limpia (`M x1 y1 L x2 y2` y transiciones diagonales en merge y fork), creando rombos y bifurcaciones naturales como en GitFiend.
  - Trazos esbeltos calibrados a `1.8px` (antes `2.4px`) con halo sutil semitransparente (`0.35`).
  - Nodos circulares sólidos de `3.8px` con contorno de fondo y doble anillo concéntrico en el commit `HEAD`.
- **Estructura y diseño de filas**:
  - Eliminada la cabecera rígida de tabla (`.graph-head`) con tiradores de redimensionado que recortaba los mensajes.
  - El asunto del commit ahora aprovecha todo el ancho disponible de forma fluida.
  - Incorporadas pastillas (`.ref-pill`) estilo GitFiend: `✓ rama +1` con fondo teal para HEAD, borde punteado para `🏷️ tags` y pastillas suaves para ramas secundarias.
  - Avatares circulares de autor (`.graph-avatar`) con su inicial (`F`, `D`) y paleta de color determinista (`authorColor`, `authorInitial`).
  - Timestamp relativo sutil ("hace 3 meses") y short SHA con copia al portapapeles.
- **TopBar y Acciones (`TopBar.tsx`, `styles.css`)**:
  - Añadida acción directa de **Pull ⬇️** integrada con `ipc.pullRemote`, junto a **Push ⬆️** y **Fetch 🔄**.
  - Pestañas laterales (`PanelTabs`) modernizadas con iconos temáticos (`📝`, `🌿`, `📦`, `🌐`, `⚡`, `📜`).
  - Paleta en modo oscuro migrada de negro absoluto a grafito mate suave (`#18181c`, `#202127`) con bordes translúcidos y carriles cálidos desaturados.
- **Detalle de Commit e Inspector (`CommitDetail.tsx`, `App.tsx`)**:
  - Incorporado avatar de autor con color determinista en la cabecera del detalle.
  - Estadísticas de inserción/deleción (`+N`, `−N`) como píldoras coloreadas.
  - Botones unificados (`Cherry-pick`, `Revert`, `Resetear`) con iconos.
  - Componente `.panel-empty-state` con iconos amigables y estados vacíos descansados.
- **Panel de Cambios y Staging (`styles.css`)**:
  - Celdas de estado (`.status-cell`) redondeadas y coloreadas con tinte translúcido.
  - Filas de archivos interactivas con bordes suaves (`transition: all 0.12s ease`).
- **Validación técnica**:
  - `typecheck` OK (0 errores).
  - `vitest` OK (37/37 tests pasando, incluidos nuevos tests de `authorInitial` y `authorColor`).
  - `eslint` OK (0 warnings).
  - `cargo check` OK (0.83s).
  - `vite build` OK (bundle de producción generado correctamente en 5.69s).

