# AGENTS.md - Foxen

## Contexto del proyecto
Foxen es un cliente de escritorio Git hecho con Tauri 2 (Rust + React/TypeScript + Vite). Permite gestionar repositorios Git con interfaz gráfica.

## Arquitectura
- Frontend: React + TypeScript + Vite (src/)
- Backend: Rust + Tauri 2 (src-tauri/src/)
- Estado: Zustand (src/store/)
- IPC: Tauri commands (src/lib/ipc.ts <-> src-tauri/src/commands/mod.rs)

## Estructura clave
- `src-tauri/src/git/` - Lógica Git con git2
- `src-tauri/src/commands/` - Comandos Tauri
- `src/components/` - Componentes React
- `src/store/useAppStore.ts` - Store global
- `packaging/` - Archivos para empaquetado (deb/rpm/appimage/flatpak)
- `src-tauri/tauri.conf.json` - Configuración Tauri

## Patrones
- Errores con `AppError` y `ErrorKind` (src-tauri/src/error.rs)
- Comandos async con `with_repo!` macro
- Operaciones Git con mutex por repo
- Credenciales guardadas en keyring del sistema

## Desarrollo
- Seguir GitFlow: NO push directo a main, PR obligatorio a dev
- Tests Rust en `src-tauri/tests/`
- TypeScript con strict mode
- Ver REGLAS_DESARROLLO_FOXEN.md en /home/foxdora/Proyectos/

## Notas importantes
- GitHub CLI (`gh`) soportado para auth
- SSH usa ssh-agent
- HTTPS usa credenciales del keyring o helpers de git
- Soporte multiidioma (es/en)
