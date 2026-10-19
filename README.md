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
- **Tema claro/oscuro** (sigue al sistema por defecto).
- Diseñada como app de escritorio: sin menús ni atajos de navegador.

## Requisitos

- Linux con `libwebkit2gtk-4.1` (Windows y macOS funcionan vía Tauri, sin
  empaquetado configurado todavía).
- Node.js 20+ y Rust 1.77+ (solo para compilar).
- Opcional: [GitHub CLI](https://cli.github.com/) (`gh`) autenticada para
  usar Git sin tocar credenciales.

## Compilar y ejecutar

```bash
npm install

# Desarrollo (recarga en caliente)
npm run tauri:dev

# Producción
npm run tauri:build

# Paquete .deb para Debian/Ubuntu
./build-deb.sh
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
packaging/            .desktop, metainfo AppStream y flatpak
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
