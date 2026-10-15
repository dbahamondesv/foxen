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
