//! Comandos Tauri: unica frontera entre el backend Rust y el frontend.
//!
//! Regla de concurrencia: libgit2 es bloqueante, asi que ninguna operacion se
//! ejecuta en el hilo de la UI. Cada comando envuelve su trabajo en
//! `spawn_blocking` y devuelve un `AppResult` serializable.

use std::path::PathBuf;
use std::sync::Arc;

use tauri::{AppHandle, Manager, State};

use crate::error::{AppError, AppResult};
use crate::git::{
    commit_ops, flow, graph, merge, refs, remote, repo::OpenRepository, staging, stash, tags,
};
use crate::git::repo::AppState;
use crate::types::*;
use crate::watch::WatchRegistry;

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

/// Ejecuta un cierre bloqueante dentro del pool de hilos de Tauri.
async fn blocking<T, F>(label: &'static str, f: F) -> AppResult<T>
where
    F: FnOnce() -> AppResult<T> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| AppError::internal(format!("La tarea {label} fallo: {e}")))?
}

/// Registra el watcher de inotify en el pool de bloqueo, sin retrasar la
/// respuesta IPC: el recorrido recursivo del arbol puede tardar segundos en
/// repos con muchos directorios (node_modules, target, builds...).
fn spawn_watch(app: AppHandle, repo_id: String, dir: PathBuf) {
    tauri::async_runtime::spawn_blocking(move || {
        let registry = app.state::<WatchRegistry>();
        registry.watch(app.clone(), &repo_id, &dir);
    });
}

/// Obtiene el handle del repositorio y ejecuta un cierre bloqueante de solo lectura.
macro_rules! with_repo {
    ($state:expr, $repo_id:expr, $label:literal, |$repo:ident| $body:block) => {{
        let handle: Arc<OpenRepository> = $state.require($repo_id)?;
        blocking($label, move || {
            let inner = handle.lock();
            let $repo = &*inner;
            $body
        })
        .await
    }};
}

/// Igual que `with_repo!` pero con acceso mutable al repositorio.
macro_rules! with_repo_mut {
    ($state:expr, $repo_id:expr, $label:literal, |$repo:ident| $body:block) => {{
        let handle: Arc<OpenRepository> = $state.require($repo_id)?;
        blocking($label, move || {
            let mut inner = handle.lock();
            let $repo = &mut *inner;
            $body
        })
        .await
    }};
}

// ---------------------------------------------------------------------------
// Repositorios
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn open_repository(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    allow_bare: bool,
) -> AppResult<RepositoryOpenResult> {
    // `State` no es 'static: se clona el estado gestionado antes de entrar al
    // hilo bloqueante.
    // `State` no es 'static, pero `AppState` es un handle barato de clonar
    // (sus mapas van tras `Arc`), asi que se clona antes de spawn_blocking.
    let handle_state = state.inner().clone();
    let path = PathBuf::from(path);
    let result = blocking("abrir repositorio", move || {
        let state = &handle_state;
        if allow_bare {
            match state.open_repository(&path) {
                Ok(result) => Ok(result),
                Err(err) if err.kind == crate::error::ErrorKind::NotARepository => {
                    state.open_bare_repository(&path)
                }
                Err(err) => Err(err),
            }
        } else {
            state.open_repository(&path)
        }
    })
    .await?;

    // Vigilancia con inotify: la UI se refresca sola ante cambios externos.
    // Se registra en el pool de bloqueo para no demorar la respuesta IPC.
    spawn_watch(app, result.handle.id.clone(), PathBuf::from(&result.handle.path));
    Ok(result)
}

#[tauri::command]
pub async fn clone_repository(
    app: AppHandle,
    state: State<'_, AppState>,
    url: String,
    path: String,
) -> AppResult<RepositoryOpenResult> {
    let handle_state = state.inner().clone();
    let dest = PathBuf::from(path);
    let result = blocking("clonar repositorio", move || {
        remote::clone_repository(&url, &dest)?;
        handle_state.open_repository(&dest)
    })
    .await?;

    spawn_watch(app, result.handle.id.clone(), PathBuf::from(&result.handle.path));
    Ok(result)
}

#[tauri::command]
pub async fn close_repository(
    state: State<'_, AppState>,
    watch: State<'_, WatchRegistry>,
    repo_id: String,
) -> AppResult<()> {
    state.close(&repo_id)?;
    watch.unwatch(&repo_id);
    Ok(())
}

/// Recoge la URL de un enlace `git://` recibido al arrancar (si la hay).
///
/// El frontend lo llama al montar: el enlace pudo llegar antes de que la webview
/// estuviera lista para escuchar eventos.
#[tauri::command]
pub async fn take_pending_clone_url(
    state: State<'_, crate::deeplink::PendingCloneUrl>,
) -> AppResult<Option<String>> {
    Ok(state.take())
}

// ---------------------------------------------------------------------------
// Ajustes persistentes
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn settings_load() -> AppResult<crate::settings::Settings> {
    blocking("leer ajustes", crate::settings::load).await
}

#[tauri::command]
pub async fn settings_save_session(session: crate::settings::Session) -> AppResult<()> {
    blocking("guardar sesion", move || {
        crate::settings::save_session(session)
    })
    .await
}

#[tauri::command]
pub async fn settings_save_theme(theme: Option<String>) -> AppResult<()> {
    blocking("guardar tema", move || crate::settings::save_theme(theme)).await
}

#[tauri::command]
pub async fn settings_save_locale(locale: Option<String>) -> AppResult<()> {
    blocking("guardar idioma", move || {
        crate::settings::save_locale(locale)
    })
    .await
}

#[tauri::command]
pub async fn list_repositories(state: State<'_, AppState>) -> AppResult<Vec<RepositoryHandle>> {
    Ok(state.list())
}

#[tauri::command]
pub async fn recent_repositories(state: State<'_, AppState>) -> AppResult<Vec<String>> {
    Ok(state.recent_paths())
}

#[tauri::command]
pub async fn scan_for_repositories(
    path: String,
    max_depth: Option<usize>,
) -> AppResult<Vec<String>> {
    let root = PathBuf::from(path);
    if !root.is_dir() {
        return Err(AppError::not_found(format!(
            "{} no es un directorio",
            root.display()
        )));
    }
    blocking("escanear repositorios", move || {
        let found = crate::git::repo::scan_repositories(&root, max_depth.unwrap_or(2));
        Ok(found
            .into_iter()
            .map(|p| p.to_string_lossy().to_string())
            .collect())
    })
    .await
}

// ---------------------------------------------------------------------------
// Grafo y ramas
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn load_graph(state: State<'_, AppState>, query: GraphQuery) -> AppResult<CommitGraph> {
    let repo_id = query.repo_id.clone();
    with_repo!(state, &repo_id, "cargar grafo", |repo| { graph::build_graph(repo, &query) })
}

#[tauri::command]
pub async fn list_branches(state: State<'_, AppState>, repo_id: String) -> AppResult<BranchList> {
    with_repo!(state, &repo_id, "listar ramas", |repo| { refs::list(repo) })
}

#[tauri::command]
pub async fn create_branch(
    state: State<'_, AppState>,
    repo_id: String,
    name: String,
    start_point: Option<String>,
    checkout: bool,
    force: bool,
    track: bool,
) -> AppResult<OperationResult> {
    with_repo_mut!(state, &repo_id, "crear rama", |repo| {
        refs::create(
            repo,
            refs::NewBranch {
                name: &name,
                start_point: start_point.as_deref(),
                checkout,
                force,
                track,
            },
        )
    })
}

#[tauri::command]
pub async fn checkout_branch(
    state: State<'_, AppState>,
    repo_id: String,
    target: String,
) -> AppResult<OperationResult> {
    with_repo_mut!(state, &repo_id, "cambiar de rama", |repo| { refs::checkout(repo, &target) })
}

#[tauri::command]
pub async fn delete_branch(
    state: State<'_, AppState>,
    repo_id: String,
    name: String,
    force: bool,
) -> AppResult<OperationResult> {
    with_repo_mut!(state, &repo_id, "eliminar rama", |repo| {
        refs::delete(repo, &name, force)
    })
}

#[tauri::command]
pub async fn rename_branch(
    state: State<'_, AppState>,
    repo_id: String,
    old_name: String,
    new_name: String,
) -> AppResult<OperationResult> {
    with_repo_mut!(state, &repo_id, "renombrar rama", |repo| {
        refs::rename(repo, &old_name, &new_name)
    })
}

#[tauri::command]
pub async fn set_upstream(
    state: State<'_, AppState>,
    repo_id: String,
    branch: String,
    upstream: Option<String>,
) -> AppResult<OperationResult> {
    with_repo!(state, &repo_id, "configurar upstream", |repo| {
        refs::set_upstream(repo, &branch, upstream.as_deref())
    })
}

#[tauri::command]
pub async fn reset_branch(
    state: State<'_, AppState>,
    repo_id: String,
    branch: String,
    target: String,
    mode: String,
) -> AppResult<OperationResult> {
    let mode = refs::ResetMode::parse(&mode)?;
    with_repo_mut!(state, &repo_id, "reiniciar rama", |repo| {
        refs::reset_to(repo, &branch, &target, mode)
    })
}

// ---------------------------------------------------------------------------
// Commits
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn create_commit(
    state: State<'_, AppState>,
    repo_id: String,
    message: String,
    amend: bool,
    allow_empty: bool,
    staged_only: bool,
    target: Option<String>,
) -> AppResult<OperationResult> {
    with_repo!(state, &repo_id, "crear commit", |repo| {
        commit_ops::commit(
            repo,
            commit_ops::CommitOptions {
                message: &message,
                amend,
                allow_empty,
                sign: false,
                staged_only,
                target: target.as_deref(),
            },
        )
    })
}

#[tauri::command]
pub async fn get_commit_detail(
    state: State<'_, AppState>,
    repo_id: String,
    oid: String,
) -> AppResult<CommitDetail> {
    with_repo!(state, &repo_id, "cargar commit", |repo| {
        commit_ops::detail(repo, &oid)
    })
}

#[tauri::command]
pub async fn cherry_pick(
    state: State<'_, AppState>,
    repo_id: String,
    oid: String,
    no_commit: bool,
    mainline: Option<usize>,
) -> AppResult<OperationResult> {
    with_repo_mut!(state, &repo_id, "cherry-pick", |repo| {
        commit_ops::cherry_pick(repo, &oid, no_commit, mainline)
    })
}

#[tauri::command]
pub async fn revert_commit(
    state: State<'_, AppState>,
    repo_id: String,
    oid: String,
    no_commit: bool,
    mainline: Option<usize>,
) -> AppResult<OperationResult> {
    with_repo_mut!(state, &repo_id, "revertir commit", |repo| {
        commit_ops::revert(repo, &oid, mainline, no_commit)
    })
}

#[tauri::command]
pub async fn delete_commit(
    state: State<'_, AppState>,
    repo_id: String,
    oid: String,
) -> AppResult<OperationResult> {
    with_repo_mut!(state, &repo_id, "eliminar commit", |repo| {
        commit_ops::delete_commit(repo, &oid)
    })
}

#[tauri::command]
pub async fn move_branch_to(
    state: State<'_, AppState>,
    repo_id: String,
    branch: String,
    target: String,
) -> AppResult<OperationResult> {
    with_repo_mut!(state, &repo_id, "mover rama", |repo| {
        refs::reset_to(repo, &branch, &target, refs::ResetMode::Hard)
    })
}

#[tauri::command]
pub async fn list_file_history(
    state: State<'_, AppState>,
    repo_id: String,
    path: String,
    limit: Option<usize>,
) -> AppResult<Vec<FileHistoryEntry>> {
    with_repo!(state, &repo_id, "historial de archivo", |repo| {
        commit_ops::file_history(repo, &path, limit.unwrap_or(200))
    })
}

#[tauri::command]
pub async fn list_reflog(
    state: State<'_, AppState>,
    repo_id: String,
    limit: Option<usize>,
) -> AppResult<Vec<ReflogEntry>> {
    with_repo!(state, &repo_id, "leer reflog", |repo| {
        commit_ops::reflog(repo, limit.unwrap_or(150))
    })
}

// ---------------------------------------------------------------------------
// Estado y staging
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn get_status(state: State<'_, AppState>, repo_id: String) -> AppResult<RepoStatus> {
    with_repo!(state, &repo_id, "leer estado", |repo| { staging::status(repo) })
}

#[tauri::command]
pub async fn get_diff(state: State<'_, AppState>, query: DiffQuery) -> AppResult<DiffResult> {
    let repo_id = query.repo_id.clone();
    with_repo!(state, &repo_id, "generar diff", |repo| { staging::diff(repo, &query) })
}

#[tauri::command]
pub async fn stage_files(
    state: State<'_, AppState>,
    repo_id: String,
    paths: Vec<String>,
) -> AppResult<RepoStatus> {
    with_repo!(state, &repo_id, "anadir al area de stage", |repo| {
        staging::stage(repo, &paths)?;
        staging::status(repo)
    })
}

#[tauri::command]
pub async fn unstage_files(
    state: State<'_, AppState>,
    repo_id: String,
    paths: Vec<String>,
) -> AppResult<RepoStatus> {
    with_repo!(state, &repo_id, "sacar del area de stage", |repo| {
        staging::unstage(repo, &paths)?;
        staging::status(repo)
    })
}

#[tauri::command]
pub async fn stage_all(state: State<'_, AppState>, repo_id: String) -> AppResult<RepoStatus> {
    with_repo!(state, &repo_id, "stagear todo", |repo| {
        staging::stage_all(repo)?;
        staging::status(repo)
    })
}

#[tauri::command]
pub async fn discard_files(
    state: State<'_, AppState>,
    repo_id: String,
    paths: Vec<String>,
) -> AppResult<RepoStatus> {
    with_repo_mut!(state, &repo_id, "descartar cambios", |repo| {
        staging::discard(repo, &paths)?;
        staging::status(repo)
    })
}

#[tauri::command]
pub async fn stage_hunks(
    state: State<'_, AppState>,
    repo_id: String,
    selections: Vec<HunkSelection>,
) -> AppResult<RepoStatus> {
    with_repo!(state, &repo_id, "stagear hunks", |repo| {
        staging::apply_hunk_selection(repo, &selections)?;
        staging::status(repo)
    })
}

#[tauri::command]
pub async fn discard_hunk(
    state: State<'_, AppState>,
    repo_id: String,
    path: String,
    hunk_index: usize,
    reverse: bool,
) -> AppResult<RepoStatus> {
    with_repo_mut!(state, &repo_id, "descartar hunk", |repo| {
        staging::discard_hunk(repo, &path, hunk_index, reverse)?;
        staging::status(repo)
    })
}

#[tauri::command]
pub async fn resolve_conflict(
    state: State<'_, AppState>,
    repo_id: String,
    path: String,
    side: Option<String>,
) -> AppResult<RepoStatus> {
    with_repo!(state, &repo_id, "resolver conflicto", |repo| {
        match side {
            Some(side) => {
                let parsed = commit_ops::ConflictSide::parse(&side)?;
                commit_ops::checkout_conflict_side(repo, &path, parsed)?;
            }
            None => commit_ops::resolve_conflict(repo, &path)?,
        }
        staging::status(repo)
    })
}

// ---------------------------------------------------------------------------
// Merge y rebase
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn merge_branch(
    state: State<'_, AppState>,
    repo_id: String,
    target: String,
    no_ff: bool,
    ff_only: bool,
    squash: bool,
    message: Option<String>,
) -> AppResult<MergeResult> {
    with_repo_mut!(state, &repo_id, "fusionar rama", |repo| {
        merge::merge(
            repo,
            merge::MergeOptions2 {
                target,
                no_ff,
                ff_only,
                squash,
                message,
            },
        )
    })
}

/// Fusiona `source` en `destination` (p. ej. `feature/x` -> `develop`),
/// cambiando de rama si hace falta.
#[tauri::command]
pub async fn merge_into(
    state: State<'_, AppState>,
    repo_id: String,
    source: String,
    destination: String,
    no_ff: bool,
    ff_only: bool,
    squash: bool,
    message: Option<String>,
) -> AppResult<MergeResult> {
    with_repo_mut!(state, &repo_id, "fusionar rama", |repo| {
        merge::merge_into(
            repo,
            &destination,
            merge::MergeOptions2 {
                target: source.clone(),
                no_ff,
                ff_only,
                squash,
                message,
            },
        )
    })
}

#[tauri::command]
pub async fn abort_merge(state: State<'_, AppState>, repo_id: String) -> AppResult<MergeResult> {
    with_repo_mut!(state, &repo_id, "abortar fusion", |repo| { merge::merge_abort(repo) })
}

/// Cierra una fusion en curso creando el commit de merge (dos padres).
///
/// Si no se pasa mensaje se reutiliza el de `MERGE_MSG` (lo escribe Git al
/// iniciar la fusion). Es valido aunque no haya cambios: resolver todo a favor
/// de la rama actual sigue siendo un merge de verdad.
#[tauri::command]
pub async fn merge_continue(
    state: State<'_, AppState>,
    repo_id: String,
    message: Option<String>,
) -> AppResult<OperationResult> {
    with_repo_mut!(state, &repo_id, "continuar fusion", |repo| {
        let message = message
            .map(|m| m.trim().to_string())
            .filter(|m| !m.is_empty())
            .or_else(|| merge::merge_message(repo))
            .unwrap_or_else(|| "Merge".to_string());
        commit_ops::commit(
            repo,
            commit_ops::CommitOptions {
                message: &message,
                amend: false,
                allow_empty: true,
                sign: false,
                staged_only: true,
                target: None,
            },
        )
    })
}

#[tauri::command]
pub async fn plan_rebase(
    state: State<'_, AppState>,
    repo_id: String,
    onto: String,
    branch: Option<String>,
) -> AppResult<RebasePlan> {
    with_repo!(state, &repo_id, "planificar rebase", |repo| {
        merge::plan(repo, &onto, branch.as_deref())
    })
}

#[tauri::command]
pub async fn rebase_onto(
    state: State<'_, AppState>,
    repo_id: String,
    onto: String,
    force: bool,
) -> AppResult<MergeResult> {
    with_repo_mut!(state, &repo_id, "rebasar", |repo| {
        merge::rebase(repo, &onto, force)
    })
}

#[tauri::command]
pub async fn rebase_continue(state: State<'_, AppState>, repo_id: String) -> AppResult<MergeResult> {
    with_repo_mut!(state, &repo_id, "continuar rebase", |repo| {
        merge::rebase_continue(repo)
    })
}

#[tauri::command]
pub async fn rebase_skip(state: State<'_, AppState>, repo_id: String) -> AppResult<MergeResult> {
    with_repo_mut!(state, &repo_id, "omitir commit", |repo| { merge::rebase_skip(repo) })
}

#[tauri::command]
pub async fn rebase_abort(state: State<'_, AppState>, repo_id: String) -> AppResult<MergeResult> {
    with_repo_mut!(state, &repo_id, "abortar rebase", |repo| { merge::rebase_abort(repo) })
}

#[tauri::command]
pub async fn compare_branches(
    state: State<'_, AppState>,
    repo_id: String,
    base: String,
    target: String,
) -> AppResult<BranchComparison> {
    with_repo!(state, &repo_id, "comparar ramas", |repo| {
        let (ahead, behind, ancestor) = merge::compare_branches(repo, &base, &target)?;
        Ok(BranchComparison {
            base,
            target,
            ahead,
            behind,
            can_fast_forward: ancestor,
        })
    })
}

#[tauri::command]
pub async fn repository_operation_state(
    state: State<'_, AppState>,
    repo_id: String,
) -> AppResult<RepositoryOperationState> {
    with_repo!(state, &repo_id, "leer estado de operacion", |repo| {
        Ok(RepositoryOperationState {
            merge_in_progress: merge::merge_in_progress(repo),
            rebase_in_progress: merge::rebase_in_progress(repo),
            conflicted_files: commit_ops::conflicted_paths(repo),
        })
    })
}

// ---------------------------------------------------------------------------
// Stash
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn list_stashes(state: State<'_, AppState>, repo_id: String) -> AppResult<Vec<StashEntry>> {
    with_repo!(state, &repo_id, "listar stashes", |repo| { stash::list(repo) })
}

#[tauri::command]
pub async fn push_stash(
    state: State<'_, AppState>,
    repo_id: String,
    message: Option<String>,
    include_untracked: bool,
    keep_index: bool,
    all: bool,
) -> AppResult<OperationResult> {
    with_repo_mut!(state, &repo_id, "guardar stash", |repo| {
        stash::push(
            repo,
            message.as_deref(),
            include_untracked,
            keep_index,
            all,
        )
    })
}

#[tauri::command]
pub async fn apply_stash(
    state: State<'_, AppState>,
    repo_id: String,
    index: usize,
    reinstate_index: bool,
) -> AppResult<OperationResult> {
    with_repo_mut!(state, &repo_id, "aplicar stash", |repo| {
        stash::apply(repo, index, reinstate_index)
    })
}

#[tauri::command]
pub async fn pop_stash(
    state: State<'_, AppState>,
    repo_id: String,
    index: usize,
) -> AppResult<OperationResult> {
    with_repo_mut!(state, &repo_id, "aplicar y borrar stash", |repo| {
        stash::pop(repo, index)
    })
}

#[tauri::command]
pub async fn drop_stash(
    state: State<'_, AppState>,
    repo_id: String,
    index: usize,
) -> AppResult<OperationResult> {
    with_repo_mut!(state, &repo_id, "eliminar stash", |repo| {
        stash::drop_entry(repo, index)
    })
}

#[tauri::command]
pub async fn clear_stashes(state: State<'_, AppState>, repo_id: String) -> AppResult<OperationResult> {
    with_repo_mut!(state, &repo_id, "limpiar stashes", |repo| { stash::clear(repo) })
}

#[tauri::command]
pub async fn branch_from_stash(
    state: State<'_, AppState>,
    repo_id: String,
    index: usize,
    branch_name: String,
) -> AppResult<OperationResult> {
    with_repo_mut!(state, &repo_id, "rama desde stash", |repo| {
        stash::branch_from(repo, index, &branch_name)
    })
}

// ---------------------------------------------------------------------------
// Git Auth Helper
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn git_auth_setup_gh() -> AppResult<String> {
    use std::process::Command;
    
    let output = Command::new("gh")
        .args(["auth", "setup-git"])
        .output()
        .map_err(|e| {
            AppError::new(
                crate::error::ErrorKind::Internal,
                "No se pudo ejecutar GitHub CLI",
            )
            .with_detail(format!("Asegúrate de tener 'gh' instalado. Error: {e}"))
        })?;
    
    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        Ok(if stdout.trim().is_empty() {
            "Git configurado correctamente para usar las credenciales de GitHub CLI".to_string()
        } else {
            stdout.trim().to_string()
        })
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(AppError::new(
            crate::error::ErrorKind::Authentication,
            "Error al configurar Git con GitHub CLI",
        )
        .with_detail(stderr.trim().to_string()))
    }
}

#[tauri::command]
pub async fn git_auth_status_gh() -> AppResult<String> {
    use std::process::Command;
    
    let output = Command::new("gh")
        .args(["auth", "status"])
        .output()
        .map_err(|e| {
            AppError::new(
                crate::error::ErrorKind::Internal,
                "No se pudo ejecutar GitHub CLI",
            )
            .with_detail(format!("Error: {e}"))
        })?;
    
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    
    if output.status.success() {
        Ok(stdout.to_string())
    } else {
        Err(AppError::new(
            crate::error::ErrorKind::Authentication,
            "GitHub CLI no está autenticado",
        )
        .with_detail(if stderr.trim().is_empty() { stdout.trim().to_string() } else { stderr.trim().to_string() }))
    }
}

// ---------------------------------------------------------------------------
// Remotos
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn list_remotes(state: State<'_, AppState>, repo_id: String) -> AppResult<Vec<RemoteInfo>> {
    with_repo!(state, &repo_id, "listar remotos", |repo| { remote::list_remotes(repo) })
}

#[tauri::command]
pub async fn add_remote(
    state: State<'_, AppState>,
    repo_id: String,
    name: String,
    url: String,
    push_url: Option<String>,
    mirror: bool,
) -> AppResult<RemoteInfo> {
    with_repo!(state, &repo_id, "agregar remoto", |repo| {
        remote::add_remote(repo, &name, &url, push_url.as_deref(), mirror)
    })
}

#[tauri::command]
pub async fn rename_remote(
    state: State<'_, AppState>,
    repo_id: String,
    old_name: String,
    new_name: String,
) -> AppResult<OperationResult> {
    with_repo!(state, &repo_id, "renombrar remoto", |repo| {
        remote::rename_remote(repo, &old_name, &new_name)
    })
}

#[tauri::command]
pub async fn remove_remote(
    state: State<'_, AppState>,
    repo_id: String,
    name: String,
) -> AppResult<OperationResult> {
    with_repo!(state, &repo_id, "eliminar remoto", |repo| {
        remote::remove_remote(repo, &name)
    })
}

#[tauri::command]
pub async fn fetch_remote(
    state: State<'_, AppState>,
    repo_id: String,
    remote_name: Option<String>,
    prune: bool,
    credential: Option<Credential>,
) -> AppResult<FetchResult> {
    let handle = state.require(&repo_id)?;
    // El flag de exclusion mutua evita fetch/push simultaneos sobre el mismo repo.
    let op = handle.clone();
    let _guard = op.try_begin_op()?;
    blocking("fetch", move || {
        let repo = handle.lock();
        remote::fetch(&repo, remote_name.as_deref(), prune, credential.as_ref())
    })
    .await
}

#[tauri::command]
pub async fn push_remote(
    state: State<'_, AppState>,
    repo_id: String,
    remote_name: String,
    branch: Option<String>,
    force: bool,
    set_upstream: bool,
    delete_remote: bool,
    credential: Option<Credential>,
) -> AppResult<PushResult> {
    let handle = state.require(&repo_id)?;
    let op = handle.clone();
    let _guard = op.try_begin_op()?;
    blocking("push", move || {
        let repo = handle.lock();
        remote::push(
            &repo,
            &remote_name,
            branch.as_deref(),
            force,
            set_upstream,
            delete_remote,
            credential.as_ref(),
        )
    })
    .await
}

#[tauri::command]
pub async fn pull_remote(
    state: State<'_, AppState>,
    repo_id: String,
    remote_name: Option<String>,
    branch: Option<String>,
    rebase: bool,
    prune: bool,
    credential: Option<Credential>,
) -> AppResult<FetchResult> {
    let handle = state.require(&repo_id)?;
    let op = handle.clone();
    let _guard = op.try_begin_op()?;
    blocking("pull", move || {
        let mut repo = handle.lock();
        remote::pull(
            &mut repo,
            remote_name.as_deref(),
            branch.as_deref(),
            rebase,
            prune,
            credential.as_ref(),
        )
    })
    .await
}

/// Guarda credenciales para un host.
///
/// El host se normaliza con la misma funcion que usa Git para los remotos, asi
/// que se puede pegar una URL completa en Configuracion y se guarda solo el
/// host. La clave es el host, no el repositorio, asi que sirve para todos.
#[tauri::command]
pub async fn store_credential(host: String, credential: Credential) -> AppResult<()> {
    let host = remote::url_host(&host);
    blocking("guardar credenciales", move || remote::store_credential(&host, &credential)).await
}

#[tauri::command]
pub async fn forget_credential(host: String) -> AppResult<()> {
    let host = remote::url_host(&host);
    blocking("olvidar credenciales", move || remote::forget_credential(&host)).await
}

/// Diga si hay credencial guardada para un host, y de que usuario.
///
/// Es lo que permite avisar antes de un fetch/push de si hay que teclear algo
/// sin exponer nunca la contrasena: esta no sale del llavero.
#[tauri::command]
pub async fn credential_status(host: String) -> AppResult<CredentialStatus> {
    let host = remote::url_host(&host);
    blocking("consultar credenciales", move || {
        let credential = remote::lookup_credential(&host);
        let username = credential
            .as_ref()
            .map(|c| c.username.clone())
            .filter(|name| !name.is_empty());
        Ok(CredentialStatus {
            saved: credential.is_some(),
            username,
            host,
        })
    })
    .await
}

#[tauri::command]
pub async fn test_remote(
    state: State<'_, AppState>,
    repo_id: String,
    remote_name: String,
    credential: Option<Credential>,
) -> AppResult<FetchResult> {
    let handle = state.require(&repo_id)?;
    let op = handle.clone();
    let _guard = op.try_begin_op()?;
    blocking("probar remoto", move || {
        let repo = handle.lock();
        remote::fetch(&repo, Some(&remote_name), false, credential.as_ref())
    })
    .await
}

// ---------------------------------------------------------------------------
// Git Flow
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn flow_status(state: State<'_, AppState>, repo_id: String) -> AppResult<FlowStatus> {
    with_repo!(state, &repo_id, "leer git flow", |repo| { flow::status(repo) })
}

#[tauri::command]
pub async fn flow_init(
    state: State<'_, AppState>,
    repo_id: String,
    config: FlowConfig,
) -> AppResult<FlowStatus> {
    with_repo_mut!(state, &repo_id, "inicializar git flow", |repo| {
        flow::init(repo, config)
    })
}

#[tauri::command]
pub async fn flow_disable(state: State<'_, AppState>, repo_id: String) -> AppResult<FlowStatus> {
    with_repo!(state, &repo_id, "desactivar git flow", |repo| { flow::disable(repo) })
}

#[tauri::command]
pub async fn flow_feature_start(
    state: State<'_, AppState>,
    repo_id: String,
    name: String,
    checkout: bool,
) -> AppResult<FlowOperationResult> {
    with_repo_mut!(state, &repo_id, "iniciar feature", |repo| {
        let (branch, result) = flow::feature_start(repo, &name, checkout)?;
        Ok(FlowOperationResult {
            branch,
            operation: result,
        })
    })
}

#[tauri::command]
pub async fn flow_feature_finish(
    state: State<'_, AppState>,
    repo_id: String,
    name: String,
    delete: bool,
) -> AppResult<OperationResult> {
    with_repo_mut!(state, &repo_id, "finalizar feature", |repo| {
        flow::feature_finish(repo, &name, delete)
    })
}

#[tauri::command]
pub async fn flow_release_start(
    state: State<'_, AppState>,
    repo_id: String,
    version: String,
    checkout: bool,
) -> AppResult<FlowOperationResult> {
    with_repo_mut!(state, &repo_id, "iniciar release", |repo| {
        let (branch, result) = flow::release_start(repo, &version, checkout)?;
        Ok(FlowOperationResult {
            branch,
            operation: result,
        })
    })
}

#[tauri::command]
pub async fn flow_release_finish(
    state: State<'_, AppState>,
    repo_id: String,
    name: String,
) -> AppResult<OperationResult> {
    with_repo_mut!(state, &repo_id, "finalizar release", |repo| {
        flow::release_finish(repo, &name)
    })
}

#[tauri::command]
pub async fn flow_hotfix_start(
    state: State<'_, AppState>,
    repo_id: String,
    name: String,
    checkout: bool,
) -> AppResult<FlowOperationResult> {
    with_repo_mut!(state, &repo_id, "iniciar hotfix", |repo| {
        let (branch, result) = flow::hotfix_start(repo, &name, checkout)?;
        Ok(FlowOperationResult {
            branch,
            operation: result,
        })
    })
}

#[tauri::command]
pub async fn flow_hotfix_finish(
    state: State<'_, AppState>,
    repo_id: String,
    name: String,
) -> AppResult<OperationResult> {
    with_repo_mut!(state, &repo_id, "finalizar hotfix", |repo| {
        flow::hotfix_finish(repo, &name)
    })
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn list_tags(state: State<'_, AppState>, repo_id: String) -> AppResult<Vec<TagDetail>> {
    with_repo!(state, &repo_id, "listar tags", |repo| {
        tags::list(repo)
    })
}

/// Crea un tag (anotado si lleva `message`) sobre `target` (por defecto HEAD).
#[tauri::command]
pub async fn create_tag(
    state: State<'_, AppState>,
    repo_id: String,
    name: String,
    message: Option<String>,
    target: Option<String>,
    force: bool,
) -> AppResult<OperationResult> {
    with_repo!(state, &repo_id, "crear tag", |repo| {
        tags::create(
            repo,
            tags::NewTag {
                name: &name,
                target: target.as_deref(),
                message: message.as_deref(),
                force,
            },
        )
    })
}

/// Borra un tag existente.
#[tauri::command]
pub async fn delete_tag(
    state: State<'_, AppState>,
    repo_id: String,
    name: String,
) -> AppResult<OperationResult> {
    with_repo!(state, &repo_id, "borrar tag", |repo| {
        tags::delete(repo, &name)
    })
}

/// Sugiere la siguiente version semver a partir de los tags existentes.
#[tauri::command]
pub async fn suggest_tag(state: State<'_, AppState>, repo_id: String) -> AppResult<TagSuggestion> {
    with_repo!(state, &repo_id, "sugerir tag", |repo| {
        let existing = tags::list(repo)?;
        let suggested = tags::suggest_next_version(&existing);
        let latest = existing
            .iter()
            .filter_map(|t| {
                let v = t.name.strip_prefix('v').unwrap_or(&t.name);
                let numeric = v.split('.').all(|p| p.parse::<u64>().is_ok())
                    && v.split('.').count() == 3;
                numeric.then(|| t.name.clone())
            })
            .max_by_key(|n| {
                let rest = n.strip_prefix('v').unwrap_or(n);
                let mut it = rest.split('.');
                (
                    it.next().and_then(|p| p.parse::<u64>().ok()).unwrap_or(0),
                    it.next().and_then(|p| p.parse::<u64>().ok()).unwrap_or(0),
                    it.next().and_then(|p| p.parse::<u64>().ok()).unwrap_or(0),
                )
            });
        Ok(TagSuggestion {
            suggested,
            latest,
            tags: existing,
        })
    })
}
// ---------------------------------------------------------------------------
// Sistema
// ---------------------------------------------------------------------------

/// Abre una terminal del sistema en la carpeta del repositorio.
///
/// No pasa por `with_repo!` porque no toca libgit2: solo hace falta la ruta.
#[tauri::command]
pub async fn open_terminal(
    state: State<'_, AppState>,
    repo_id: String,
) -> AppResult<OperationResult> {
    let path = state.require(&repo_id)?.path.clone();
    blocking("abrir terminal", move || {
        let program = crate::terminal::open(&path)?;
        Ok(OperationResult::ok(format!(
            "Terminal {program} abierta en {}",
            path.display()
        )))
    })
    .await
}

// ---------------------------------------------------------------------------
// Terminal embebida
// ---------------------------------------------------------------------------

/// Arranca el shell del usuario dentro de la terminal de Foxen.
///
/// Recibe un [`tauri::ipc::Channel`] por el que llega la salida del proceso:
/// es el conducto de streaming de Tauri 2, mucho mas barato que emitir un
/// evento por cada trozo.
#[tauri::command]
pub async fn start_pty(
    state: State<'_, crate::pty::PtyState>,
    repo_id: String,
    cwd: String,
    cols: u16,
    rows: u16,
    channel: tauri::ipc::Channel<crate::pty::PtyOutput>,
) -> AppResult<()> {
    let state = state.inner().clone();
    let cwd = PathBuf::from(cwd);
    blocking("abrir terminal", move || state.start(&repo_id, &cwd, cols, rows, channel)).await
}

/// Escribe en la PTY lo que teclea el usuario (en base64).
#[tauri::command]
pub async fn write_pty(
    state: State<'_, crate::pty::PtyState>,
    repo_id: String,
    data: String,
) -> AppResult<()> {
    let state = state.inner().clone();
    blocking("escribir en la terminal", move || state.write(&repo_id, &data)).await
}

#[tauri::command]
pub async fn resize_pty(
    state: State<'_, crate::pty::PtyState>,
    repo_id: String,
    cols: u16,
    rows: u16,
) -> AppResult<()> {
    let state = state.inner().clone();
    blocking("redimensionar terminal", move || state.resize(&repo_id, cols, rows)).await
}

/// Cierra la terminal y mata el shell. Idempotente.
#[tauri::command]
pub async fn stop_pty(state: State<'_, crate::pty::PtyState>, repo_id: String) -> AppResult<()> {
    state.inner().stop(&repo_id);
    Ok(())
}
pub mod github_auth;
