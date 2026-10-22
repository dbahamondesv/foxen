//! Registro de repositorios abiertos y acceso seguro a los handles de libgit2.
//!
//! `git2::Repository` es `Send` pero no `Sync`, por lo que cada handle se
//! protege con un mutex. Las operaciones largas se ejecutan siempre fuera del
//! hilo de la UI mediante `spawn_blocking` (ver `commands.rs`).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use git2::Repository;
use parking_lot::{Mutex, MutexGuard};

use crate::error::{AppError, AppResult};
use crate::types::{RepositoryHandle, RepositoryOpenResult};

/// Cantidad maxima de repositorios recientes recordados.
const MAX_RECENT: usize = 20;

/// Un repositorio abierto con su handle de libgit2 protegido.
pub struct OpenRepository {
    pub id: String,
    pub path: PathBuf,
    name: String,
    bare: bool,
    repo: Mutex<Repository>,
    /// Bandera de exclusion mutua para operaciones de red (fetch/pull/push).
    busy: AtomicBool,
}

impl OpenRepository {
    /// Abre un repositorio en disco y registra su handle.
    pub fn open(path: &Path, id: String) -> AppResult<Self> {
        if !path.exists() {
            return Err(AppError::new(
                crate::error::ErrorKind::NotFound,
                format!("La ruta {} no existe", path.display()),
            ));
        }
        let repo = Repository::open(path)
            .map_err(|e| AppError::from_git(e).with_detail(format!("Ruta: {}", path.display())))?;

        let bare = repo.is_bare();
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "repo".to_string());

        let head_branch = repo
            .head()
            .ok()
            .filter(|h| h.is_branch())
            .and_then(|h| h.shorthand().map(|s| s.to_string()));
        let detached = repo.head_detached().unwrap_or(false);
        let default_branch = default_branch_name(&repo);
        log::debug!("abierto {name}: head={head_branch:?} detached={detached} default={default_branch:?}");

        Ok(Self {
            id,
            path: path.to_path_buf(),
            name,
            bare,
            repo: Mutex::new(repo),
            busy: AtomicBool::new(false),
        })
    }

    /// Identificador estable derivado de la ruta canonica.
    pub fn id_for_path(path: &Path) -> String {
        let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
        let mut hash: u64 = 0xcbf29ce484222325;
        for byte in canonical.to_string_lossy().as_bytes() {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x100000001b3);
        }
        format!("repo-{hash:016x}")
    }

    pub fn lock(&self) -> MutexGuard<'_, Repository> {
        self.repo.lock()
    }

    /// Ejecuta una operacion de solo lectura sobre el repositorio.
    pub fn read<T>(&self, f: impl FnOnce(&Repository) -> AppResult<T>) -> AppResult<T> {
        let guard = self.repo.lock();
        f(&guard)
    }

    /// Ejecuta una operacion que muta el repositorio.
    pub fn write<T>(&self, f: impl FnOnce(&mut Repository) -> AppResult<T>) -> AppResult<T> {
        let mut guard = self.repo.lock();
        f(&mut guard)
    }

    /// Estado actual de HEAD sin tomar el lock (lectura atomica de disco).
    pub fn head_snapshot(&self) -> (Option<String>, Option<String>, bool) {
        self.read(|repo| {
            let branch = repo
                .head()
                .ok()
                .filter(|h| h.is_branch())
                .and_then(|h| h.shorthand().map(|s| s.to_string()));
            let oid = repo
                .head()
                .ok()
                .and_then(|h| h.target())
                .map(|o| o.to_string());
            let detached = repo.head_detached().unwrap_or(false);
            Ok((branch, oid, detached))
        })
        // Un fallo de lectura del lock no debe tumbar la UI: se reporta HEAD como
        // ausente y la vista refresca en el siguiente ciclo.
        .unwrap_or_default()
    }

    pub fn handle(&self) -> RepositoryHandle {
        let (head_branch, _, detached) = self.head_snapshot();
        RepositoryHandle {
            id: self.id.clone(),
            path: self.path.to_string_lossy().to_string(),
            name: self.name.clone(),
            bare: self.bare,
            head_branch,
            detached,
            default_branch: self
                .read(|repo| Ok(default_branch_name(repo)))
                .unwrap_or(None),
        }
    }

    /// Intenta tomar la bandera de operacion en curso.
    pub fn try_begin_op(&self) -> AppResult<OpGuard<'_>> {
        self.busy
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| AppError::busy(&self.name))?;
        Ok(OpGuard { repo: self })
    }

    pub fn is_busy(&self) -> bool {
        self.busy.load(Ordering::Acquire)
    }
}

/// Libera la bandera de operacion al terminar el comando.
pub struct OpGuard<'a> {
    repo: &'a OpenRepository,
}

impl Drop for OpGuard<'_> {
    fn drop(&mut self) {
        self.repo.busy.store(false, Ordering::Release);
    }
}

/// Detecta la rama por defecto del repositorio.
fn default_branch_name(repo: &Repository) -> Option<String> {
    if let Ok(head) = repo.head() {
        if let Some(name) = head.shorthand() {
            return Some(name.to_string());
        }
    }
    // HEAD unborn: probar origin/HEAD, luego main, luego master.
    if let Ok(remote_head) = repo.find_reference("refs/remotes/origin/HEAD") {
        if let Some(target) = remote_head.symbolic_target() {
            if let Some(name) = target.strip_prefix("refs/remotes/") {
                return Some(name.to_string());
            }
        }
    }
    for candidate in ["refs/heads/main", "refs/heads/master"] {
        if repo.find_reference(candidate).is_ok() {
            return candidate.strip_prefix("refs/heads/").map(|s| s.to_string());
        }
    }
    None
}

/// Estado global de la aplicacion.
#[derive(Clone)]
pub struct AppState {
    repos: Arc<Mutex<HashMap<String, Arc<OpenRepository>>>>,
    recent: Arc<Mutex<Vec<String>>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            repos: Arc::new(Mutex::new(HashMap::new())),
            recent: Arc::new(Mutex::new(Vec::new())),
        }
    }
}

impl AppState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Abre un repositorio o devuelve el handle existente.
    pub fn open_repository(&self, path: &Path) -> AppResult<RepositoryOpenResult> {
        let id = OpenRepository::id_for_path(path);
        // El guard del mapa se suelta ANTES de tocar el candado de git del repo
        // (`handle()` lo adquiere): retener los dos candados a la vez formaba un
        // convoy que congelaba todos los comandos IPC.
        let existing = self.repos.lock().get(&id).cloned();
        if let Some(existing) = existing {
            return Ok(RepositoryOpenResult {
                handle: existing.handle(),
                already_open: true,
            });
        }

        // Resolver el directorio de trabajo raiz si se paso un subdirectorio.
        let repo = git2::Repository::discover(path).map_err(|e| {
            AppError::from_git(e).with_detail(format!("Ruta: {}", path.display()))
        })?;
        let workdir = repo
            .workdir()
            .map(|w| w.to_path_buf())
            .ok_or_else(|| {
                if repo.is_bare() {
                    AppError::invalid_state(format!(
                        "{} es un repositorio bare; Foxen requiere un working tree",
                        path.display()
                    ))
                } else {
                    AppError::not_a_repository(path)
                }
            })?;
        drop(repo);

        let opened = OpenRepository::open(&workdir, id.clone())?;
        let handle = opened.handle();
        let arc = Arc::new(opened);

        self.repos.lock().insert(id, arc);
        self.push_recent(&workdir);

        Ok(RepositoryOpenResult {
            handle,
            already_open: false,
        })
    }

    /// Abre un repositorio en modo bare (solo lectura de refs).
    pub fn open_bare_repository(&self, path: &Path) -> AppResult<RepositoryOpenResult> {
        let id = OpenRepository::id_for_path(path);
        let repo = Repository::open_bare(path).map_err(AppError::from_git)?;
        let bare_path = repo.path().to_path_buf();
        drop(repo);

        let opened = OpenRepository::open(&bare_path, id.clone())?;
        let handle = opened.handle();
        let arc = Arc::new(opened);
        self.repos.lock().insert(id, arc);
        self.push_recent(&bare_path);

        Ok(RepositoryOpenResult {
            handle,
            already_open: false,
        })
    }

    /// Busca un repositorio por id sin fallar.
    pub fn find(&self, repo_id: &str) -> Option<Arc<OpenRepository>> {
        self.repos.lock().get(repo_id).cloned()
    }

    /// Busca un repositorio por id o falla con un error claro.
    pub fn require(&self, repo_id: &str) -> AppResult<Arc<OpenRepository>> {
        self.find(repo_id)
            .ok_or_else(|| AppError::repo_not_found(repo_id))
    }

    /// Cierra un repositorio abierto.
    pub fn close(&self, repo_id: &str) -> AppResult<()> {
        let mut repos = self.repos.lock();
        let Some(removed) = repos.remove(repo_id) else {
            return Err(AppError::repo_not_found(repo_id));
        };
        drop(repos);
        // Hay que quitar la entrada por su ruta, ya que el repo se acaba de
        // retirar del mapa (antes se llamaba a `find` y ya no lo encontraba).
        let key = removed.path.to_string_lossy().to_string();
        self.recent.lock().retain(|p| p != &key);
        Ok(())
    }

    pub fn list(&self) -> Vec<RepositoryHandle> {
        // Primero se clonan los handles (suelta el candado del mapa) y luego se
        // consulta cada repo: nunca se retiene el candado del mapa mientras se
        // adquiere el de un repositorio, eso bloqueaba el backend entero.
        let repos: Vec<Arc<OpenRepository>> = self.repos.lock().values().cloned().collect();
        repos.iter().map(|r| r.handle()).collect()
    }

    pub fn recent_paths(&self) -> Vec<String> {
        self.recent.lock().clone()
    }

    fn push_recent(&self, path: &Path) {
        let key = path.to_string_lossy().to_string();
        let mut recent = self.recent.lock();
        recent.retain(|p| p != &key);
        recent.insert(0, key);
        recent.truncate(MAX_RECENT);
    }
}

/// Determina si una ruta corresponde a un repositorio bare.
pub fn is_bare_path(path: &Path) -> bool {
    Repository::open_bare(path)
        .map(|r| r.is_bare())
        .unwrap_or(false)
}

/// Enumera repositorios git encontrados en un directorio padre.
pub fn scan_repositories(parent: &Path, max_depth: usize) -> Vec<PathBuf> {
    fn walk(dir: &Path, depth: usize, max_depth: usize, out: &mut Vec<PathBuf>) {
        if depth > max_depth {
            return;
        }
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with('.') || name == "node_modules" || name == "target" {
                continue;
            }
            if path.join(".git").is_dir() || path.join(".git").is_file() {
                out.push(path.clone());
            } else {
                walk(&path, depth + 1, max_depth, out);
            }
        }
    }

    let mut out = Vec::new();
    walk(parent, 0, max_depth, &mut out);
    out.sort();
    out
}

/// Abre el repositorio que contiene una ruta, subiendo directorios arriba.
pub fn open_discovered(path: &Path) -> AppResult<Repository> {
    Repository::discover(path).map_err(|e| {
        AppError::from_git(e).with_detail(format!("Ruta: {}", path.display()))
    })
}
