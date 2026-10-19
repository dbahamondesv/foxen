//! Vigilancia de repositorios con inotify (crate `notify`).
//!
//! Cada repositorio abierto registra un watcher recursivo sobre su raiz. Los
//! eventos del kernel se agrupan con un debounce trailing-edge y se traducen en
//! un unico evento `git://changed` para que el frontend refresque sin sondear
//! (sin polling).
//!
//! Si el kernel agota los watches de inotify (`fs.inotify.max_user_watches`),
//! se degrada a vigilar solo `.git`, que cubre cualquier operacion git externa.
//! El refresco al recuperar el foco de la ventana cubre ademas las ediciones
//! del arbol de trabajo en ese escenario.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use parking_lot::Mutex;
use tauri::{AppHandle, Emitter};

/// Evento emitido al frontend cuando cambia el estado de un repositorio.
pub const CHANGED_EVENT: &str = "git://changed";

/// Silencio necesario antes de avisar: agrupa rafagas (checkout, fetch...).
const DEBOUNCE: Duration = Duration::from_millis(250);

struct Slot {
    /// Mantiene vivo el watcher; al soltarlo se liberan los watches de inotify.
    _watcher: RecommendedWatcher,
    /// Mantiene viva la tarea de debounce; al soltarla la tarea termina.
    _signal: tokio::sync::mpsc::UnboundedSender<()>,
}

/// Watchers activos, indexados por id de repositorio.
#[derive(Default)]
pub struct WatchRegistry {
    slots: Mutex<HashMap<String, Slot>>,
}

impl WatchRegistry {
    /// Empieza a vigilar `dir` (raiz del working tree o git dir de un bare).
    ///
    /// Sustituye cualquier watcher previo del mismo repositorio.
    pub fn watch(&self, app: AppHandle, repo_id: &str, dir: &Path) {
        self.unwatch(repo_id);

        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<()>();
        let emit_id = repo_id.to_string();

        // Debounce: espera el primer evento, luego un silencio de `DEBOUNCE`, y
        // emite un unico aviso. Termina cuando se sueltan todos los emisores
        // (al desregistrar el watcher).
        tauri::async_runtime::spawn(async move {
            loop {
                if rx.recv().await.is_none() {
                    return;
                }
                loop {
                    tokio::time::sleep(DEBOUNCE).await;
                    if rx.try_recv().is_err() {
                        break;
                    }
                }
                let _ = app.emit(CHANGED_EVENT, serde_json::json!({ "repoId": emit_id }));
            }
        });

        let tx_cb = tx.clone();
        let callback = move |res: notify::Result<Event>| {
            // Los accesos (lecturas, stat) no cambian el estado del repo.
            if matches!(res, Ok(event) if !matches!(event.kind, EventKind::Access(_))) {
                let _ = tx_cb.send(());
            }
        };
        let mut watcher = match notify::recommended_watcher(callback) {
            Ok(watcher) => watcher,
            Err(error) => {
                log::warn!("Sin watcher para {repo_id}: {error}");
                return; // se sueltan tx/tx_cb y la tarea termina sola
            }
        };

        let root = PathBuf::from(dir);
        let mut watched = watcher.watch(&root, RecursiveMode::Recursive).is_ok();
        if !watched {
            // Fallback: vigilar solo el directorio git (operaciones externas).
            let git_dir = root.join(".git");
            if git_dir.is_dir() {
                watched = watcher.watch(&git_dir, RecursiveMode::Recursive).is_ok();
            }
            if watched {
                log::info!("Watcher de {repo_id} limitado a .git (limite de inotify)");
            }
        }
        if !watched {
            log::warn!("No se pudo vigilar {}: {repo_id}", root.display());
            return;
        }

        self.slots.lock().insert(
            repo_id.to_string(),
            Slot { _watcher: watcher, _signal: tx },
        );
    }

    /// Deja de vigilar un repositorio (idempotente).
    pub fn unwatch(&self, repo_id: &str) {
        self.slots.lock().remove(repo_id);
    }
}
