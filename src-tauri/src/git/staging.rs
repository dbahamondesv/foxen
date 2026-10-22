//! Estado del working tree, diffs y staging (incluido staging parcial por hunks).

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};

use git2::{Delta, DiffOptions, IndexAddOption, Patch, Repository, Sort};

use crate::error::{AppError, AppResult};
use crate::git::util::{change_kind, native_path};
use crate::types::{
    ChangeKind, DiffHunk, DiffLine, DiffQuery, DiffResult, DiffSide, FileDiff, FileStatus,
    HunkSelection, OperationResult, RepoStatus,
};

/// Tamano maximo por defecto para no cargar diffs de archivos enormes.
const DEFAULT_MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
/// Limite de lineas por archivo para mantener el grafo fluido.
const MAX_LINES_PER_FILE: usize = 20_000;

// ---------------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------------

pub fn conflicted_paths_in_workdir(repo: &Repository) -> Vec<String> {
    // Solo tiene sentido barrer cuando hay una operacion a medias.
    if repo.state() == git2::RepositoryState::Clean {
        return Vec::new();
    }
    let Ok(statuses) = repo.statuses(Some(&mut git2::StatusOptions::new())) else {
        return Vec::new();
    };
    conflict_markers_in(repo, &statuses)
}

/// Rutas con marcadores de conflicto completos (`<<<<<<<` + `>>>>>>>`).
///
/// Hace falta porque `git_merge_commits` de libgit2 borra las etapas 1/2/3 del
/// indice al terminar, de modo que `index.conflicts()` sale vacio aunque el
/// merge haya fallado. Los marcadores en disco son la unica fuente fiable.
fn conflict_markers_in(repo: &Repository, statuses: &git2::Statuses) -> Vec<String> {
    let Some(workdir) = repo.workdir() else {
        return Vec::new();
    };

    let mut found = Vec::new();
    for entry in statuses.iter() {
        let Some(path) = entry.path() else { continue };
        let flags = entry.status();
        // Solo se barren los archivos que la operacion toco. Tras un merge
        // conflictivo el indice queda en etapa 0 con los marcadores dentro, asi
        // que `is_conflicted()` es falso: hay que mirar tambien el lado del
        // indice o el archivo en conflicto se escaparia.
        if !flags.is_wt_modified()
            && !flags.is_wt_new()
            && !flags.is_index_modified()
            && !flags.is_conflicted()
        {
            continue;
        }
        let Ok(full) = crate::git::util::safe_worktree_path(workdir, path) else {
            continue;
        };
        let Ok(content) = std::fs::read_to_string(&full) else {
            continue;
        };
        // Se exige la pareja completa de marcadores de apertura y cierre para no
        // marcar archivos que solo contengan lineas como "=======".
        let has_start = content.contains("<<<<<<<");
        let has_end = content.contains(">>>>>>>");
        if has_start && has_end {
            found.push(path.to_string());
        }
    }
    found
}

/// Calcula el estado completo del repositorio en dos pasadas de diff (staged y
/// worktree), en lugar de un diff por archivo, que era O(N) paseos del arbol
/// dentro de la retencion del candado de git y congelaba la app al abrir.
pub fn status(repo: &Repository) -> AppResult<RepoStatus> {
    let mut options = git2::StatusOptions::new();
    options
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(false)
        .exclude_submodules(true)
        .include_unmodified(false);

    let statuses = repo
        .statuses(Some(&mut options))
        .map_err(AppError::from_git)?;

    let head_ref = repo.head().ok();
    let head_branch = head_ref
        .as_ref()
        .filter(|r| r.is_branch())
        .and_then(|r| r.shorthand().map(|s| s.to_string()));
    let head_oid = head_ref.as_ref().and_then(|r| r.target());
    let head_subject = head_ref
        .as_ref()
        .and_then(|r| r.peel_to_commit().ok())
        .map(|c| c.summary().unwrap_or_default().to_string());

    // libgit2 borra las etapas de conflicto del indice, asi que los conflictos
    // se detectan tambien por los marcadores que quedaron en el working tree.
    // Se reutiliza `statuses` en vez de volver a barrer el repositorio.
    let marker_conflicts = if repo.state() != git2::RepositoryState::Clean {
        conflict_markers_in(repo, &statuses)
    } else {
        Vec::new()
    };

    // Estadisticas por archivo en dos paseos globales (HEAD vs indice, indice
    // vs worktree) en vez de un `diff` completo por cada entrada del status.
    // Con el arbol limpio no hay nada que medir: se saltan los paseos.
    let (staged_stats, worktree_stats) = if statuses.is_empty() {
        (HashMap::new(), HashMap::new())
    } else {
        (
            bulk_diff_stats(repo, DiffKind::Staged),
            bulk_diff_stats(repo, DiffKind::Worktree),
        )
    };

    let mut files: Vec<FileStatus> = Vec::with_capacity(statuses.len());
    let mut staged_count = 0usize;
    let mut unstaged_count = 0usize;
    let mut untracked_count = 0usize;
    let mut conflicted_count = 0usize;

    for entry in statuses.iter() {
        let Some(path) = entry.path() else { continue };
        let flags = entry.status();

        // En git2 0.20 `Status` no es mas un bitflags: expone metodos `is_*`.
        let index_status = status_letters(flags);
        let worktree_status = worktree_letters(flags);

        let untracked = flags.is_wt_new();
        let ignored = flags.is_ignored();
        let conflicted = flags.is_conflicted()
            || marker_conflicts.iter().any(|c| c == path);
        let staged = index_status != ' ' && !untracked;
        let unstaged = worktree_status != ' ' && !untracked;

        if staged {
            staged_count += 1;
        }
        if unstaged {
            unstaged_count += 1;
        }
        if untracked {
            untracked_count += 1;
        }
        if conflicted {
            conflicted_count += 1;
        }

        let old_path = (flags.contains(git2::Status::WT_RENAMED)
            || flags.contains(git2::Status::INDEX_RENAMED))
            .then(|| entry.path().map(|p| p.to_string()))
            .flatten()
            .or_else(|| {
                flags
                    .contains(git2::Status::INDEX_RENAMED)
                    .then(String::new)
                    .filter(|s| !s.is_empty())
            });

        // Estadisticas ya calculadas en los dos paseos globales; se prefiere el
        // lado staged cuando la entrada lo tiene, como hacia `delta_stats`.
        let (insertions, deletions, is_binary) = if staged {
            staged_stats.get(path).copied().unwrap_or((0, 0, false))
        } else {
            worktree_stats.get(path).copied().unwrap_or((0, 0, false))
        };

        files.push(FileStatus {
            path: path.to_string(),
            old_path,
            index_status,
            worktree_status,
            staged,
            unstaged,
            untracked,
            ignored,
            conflicted,
            is_binary,
            insertions,
            deletions,
            kind: if conflicted {
                ChangeKind::Conflicted
            } else if untracked {
                ChangeKind::Untracked
            } else {
                change_kind(index_status, worktree_status)
            },
        });
    }

    // Orden estable: conflicted primero, luego por ruta.
    files.sort_by(|a, b| {
        b.conflicted
            .cmp(&a.conflicted)
            .then_with(|| a.path.cmp(&b.path))
    });

    let (ahead, behind, upstream) = upstream_relation(repo);

    Ok(RepoStatus {
        head_branch,
        head_oid: head_oid.map(|o| o.to_string()),
        head_subject,
        files,
        staged_count,
        unstaged_count,
        untracked_count,
        conflicted_count,
        clean: staged_count == 0 && unstaged_count == 0 && untracked_count == 0,
        ahead,
        behind,
        has_upstream: upstream.is_some(),
        upstream,
        stash_count: repo.reflog("refs/stash").map(|r| r.len()).unwrap_or(0),
    })
}

/// Calcula ahead/behind respecto al upstream de la rama actual.
pub fn upstream_relation(repo: &Repository) -> (usize, usize, Option<String>) {
    let Ok(head) = repo.head() else {
        return (0, 0, None);
    };
    if !head.is_branch() {
        return (0, 0, None);
    }
    let branch_name = head.shorthand().unwrap_or_default().to_string();
    let Ok(branch) = repo.find_branch(&branch_name, git2::BranchType::Local) else {
        return (0, 0, None);
    };
    let Ok(upstream) = branch.upstream() else {
        return (0, 0, None);
    };
    let upstream_name = upstream.name().ok().flatten().map(|n| n.to_string());
    let name = upstream_name
        .as_deref()
        .map(crate::git::util::shorten_ref)
        .unwrap_or_default();

    let upstream_ref = upstream.get().target();
    let local_ref = branch.get().target();

    let (Some(local_oid), Some(up_oid)) = (local_ref, upstream_ref) else {
        return (0, 0, Some(name));
    };

    let (ahead, behind) = repo
        .graph_ahead_behind(local_oid, up_oid)
        .unwrap_or((0, 0));
    (ahead, behind, Some(name))
}

/// lado de un diff global de estadisticas.
#[derive(Clone, Copy)]
enum DiffKind {
    /// HEAD contra el indice (cambios ya staged).
    Staged,
    /// Indice contra el working tree (cambios sin staged).
    Worktree,
}

/// Lineas anadidas/eliminadas y binariedad por archivo, en UNA sola pasada de
/// diff global. Sustituye al antiguo `delta_stats`, que abria un diff completo
/// por archivo (O(N) paseos del arbol) y congelaba la app en repos grandes.
fn bulk_diff_stats(repo: &Repository, kind: DiffKind) -> HashMap<String, (usize, usize, bool)> {
    let mut opts = DiffOptions::new();
    opts.ignore_submodules(true).show_binary(false);

    let diff = match kind {
        DiffKind::Staged => {
            let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
            match repo.diff_tree_to_index(head_tree.as_ref(), None, Some(&mut opts)) {
                Ok(diff) => diff,
                Err(error) => {
                    log::warn!("diff staged para estadisticas: {error}");
                    return HashMap::new();
                }
            }
        }
        DiffKind::Worktree => {
            opts.include_untracked(true).recurse_untracked_dirs(true);
            match repo.diff_index_to_workdir(None, Some(&mut opts)) {
                Ok(diff) => diff,
                Err(error) => {
                    log::warn!("diff worktree para estadisticas: {error}");
                    return HashMap::new();
                }
            }
        }
    };

    let mut stats = HashMap::with_capacity(diff.deltas().len());
    for index in 0..diff.deltas().len() {
        let Some(delta) = diff.get_delta(index) else {
            continue;
        };
        let Some(path) = delta.new_file().path().or_else(|| delta.old_file().path()) else {
            continue;
        };
        let path = path.to_string_lossy().to_string();

        // Archivos enormes: sin estadisticas (el panel las muestra vacias).
        let size = delta.new_file().size().max(delta.old_file().size());
        if size > DEFAULT_MAX_FILE_BYTES {
            stats.insert(path, (0, 0, false));
            continue;
        }

        match Patch::from_diff(&diff, index) {
            Ok(Some(patch)) => {
                let entry = match patch.line_stats() {
                    Ok((added, deleted, _tokens)) => (added, deleted, false),
                    Err(_) => (0, 0, false),
                };
                stats.insert(path, entry);
            }
            // `from_diff` devuelve None para binarios (sin show_binary) o sin
            // cambios: el flag binario del delta distingue uno de otro.
            Ok(None) => {
                let binary = delta.flags().contains(git2::DiffFlags::BINARY);
                stats.insert(path, (0, 0, binary));
            }
            Err(error) => {
                log::debug!("sin stats para {path}: {error}");
                stats.insert(path, (0, 0, false));
            }
        }
    }
    stats
}

// ---------------------------------------------------------------------------
// Diffs
// ---------------------------------------------------------------------------

/// Genera el diff solicitado.
pub fn diff(repo: &Repository, query: &DiffQuery) -> AppResult<DiffResult> {
    let max_bytes = query.max_file_bytes.unwrap_or(DEFAULT_MAX_FILE_BYTES);
    let mut files: Vec<FileDiff> = Vec::new();
    let mut total_additions = 0usize;
    let mut total_deletions = 0usize;
    let mut truncated = false;

    let mut opts = DiffOptions::new();
    opts.context_lines(query.context as u32)
        .interhunk_lines(0)
        .include_typechange(true)
        .ignore_submodules(true)
        .show_binary(false)
        .include_untracked(true)
        .id_abbrev(8);
    // `DiffOptions` no tiene `path`: el filtro se aplica con pathspec.
    if let Some(path) = query.path.as_deref() {
        opts.pathspec(path);
    }

    let diff = match query.side {
        DiffSide::Worktree => {
            // Cambios SIN anadir = working tree contra HEAD. Hace falta el indice
            // para detectar renombrados. Usar `diff_tree_to_index` aqui
            // devolveria los cambios staged, que es lo que hace `DiffSide::Staged`.
            let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
            repo.diff_tree_to_workdir_with_index(head_tree.as_ref(), Some(&mut opts))
                .map_err(AppError::from_git)?
        }
        DiffSide::Staged => {
            let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
            let index = repo.index().map_err(AppError::from_git)?;
            repo.diff_tree_to_index(head_tree.as_ref(), Some(&index), Some(&mut opts))
                .map_err(AppError::from_git)?
        }
        DiffSide::IndexToWorktree => {
            let index = repo.index().map_err(AppError::from_git)?;
            let workdir = repo.workdir().ok_or_else(|| {
                AppError::invalid_state("Los repositorios bare no tienen working tree")
            })?;
            // `with_path_prefix` ya no existe: las rutas del indice son relativas
            // al working tree, asi que el diff ya sale con rutas correctas.
            let _ = workdir;
            repo.diff_index_to_workdir(Some(&index), Some(&mut opts))
                .map_err(AppError::from_git)?
        }
        DiffSide::Commit => {
            let oid = query
                .old_oid
                .as_deref()
                .ok_or_else(|| AppError::validation("Falta el commit para el diff"))?;
            let commit = crate::git::refs::resolve_commit(repo, oid)?;
            let new_tree = commit.tree().map_err(AppError::from_git)?;
            let old_tree = commit
                .parent(0)
                .ok()
                .and_then(|p| p.tree().ok());
            repo.diff_tree_to_tree(old_tree.as_ref(), Some(&new_tree), Some(&mut opts))
                .map_err(AppError::from_git)?
        }
        DiffSide::Range => {
            let old_oid = query
                .old_oid
                .as_deref()
                .ok_or_else(|| AppError::validation("Falta la revision base del rango"))?;
            let new_oid = query
                .new_oid
                .as_deref()
                .ok_or_else(|| AppError::validation("Falta la revision destino del rango"))?;
            let old_commit = crate::git::refs::resolve_commit(repo, old_oid)?;
            let new_commit = crate::git::refs::resolve_commit(repo, new_oid)?;
            let old_tree = old_commit.tree().map_err(AppError::from_git)?;
            let new_tree = new_commit.tree().map_err(AppError::from_git)?;
            repo.diff_tree_to_tree(Some(&old_tree), Some(&new_tree), Some(&mut opts))
                .map_err(AppError::from_git)?
        }
    };

    // Filtrar por path si se solicito.
    let wanted: Option<HashSet<String>> = query.path.as_ref().map(|p| {
        HashSet::from([p.clone(), native_path(p)])
    });

    for i in 0..diff.deltas().len() {
        let delta = diff.get_delta(i).ok_or_else(|| {
            AppError::internal("No se pudo leer una diferencia del diff")
        })?;

        let Some(path) = delta.new_file().path().or_else(|| delta.old_file().path()) else {
            continue;
        };
        let path_str = path.to_string_lossy().to_string();

        if let Some(filter) = &wanted {
            if !filter.contains(&path_str) {
                continue;
            }
        }

        let old_path = (delta.status() == Delta::Renamed || delta.status() == Delta::Copied)
            .then(|| {
                delta
                    .old_file()
                    .path()
                    .map(|p| p.to_string_lossy().to_string())
            })
            .flatten();

        let size = delta
            .new_file()
            .size()
            .max(delta.old_file().size());
        let too_large = size > max_bytes;

        let file_diff = parse_delta(repo, &diff, i, &path_str, old_path, too_large, max_bytes)?;
        total_additions += file_diff.additions;
        total_deletions += file_diff.deletions;
        if file_diff.too_large {
            truncated = true;
        }
        files.push(file_diff);
    }

    files.sort_by(|a, b| a.path.cmp(&b.path));

    Ok(DiffResult {
        files,
        total_additions,
        total_deletions,
        truncated,
    })
}

/// Convierte un delta en un `FileDiff` con hunks y lineas parseadas.
fn parse_delta(
    repo: &Repository,
    diff: &git2::Diff,
    index: usize,
    path: &str,
    old_path: Option<String>,
    too_large: bool,
    max_bytes: u64,
) -> AppResult<FileDiff> {
    let delta = diff
        .get_delta(index)
        .ok_or_else(|| AppError::internal("Delta invalido"))?;

    let is_binary = delta.old_file().is_binary() || delta.new_file().is_binary();

    // `Diff::foreach` entrega `DiffHunk` y `DiffLine` estructurados. Sus tres
    // callbacks se pasan a la vez como `&mut`, asi que el estado que comparten
    // (contadores, parche y hunk en curso) vive en una `RefCell`.
    let state = RefCell::new(PatchState {
        line_budget: MAX_LINES_PER_FILE,
        ..Default::default()
    });

    let hunk_cb = {
        let state = &state;
        move |_delta: git2::DiffDelta<'_>, hunk: git2::DiffHunk<'_>| {
            let mut s = state.borrow_mut();
            if s.line_budget == 0 {
                return false;
            }

            let header = String::from_utf8_lossy(hunk.header()).to_string();
            s.raw.push_str(&header);
            s.raw.push('\n');

            s.old_lineno = hunk.old_start() as usize;
            s.new_lineno = hunk.new_start() as usize;

            s.current = Some(DiffHunk {
                header,
                old_start: hunk.old_start() as usize,
                old_lines: hunk.old_lines() as usize,
                new_start: hunk.new_start() as usize,
                new_lines: hunk.new_lines() as usize,
                lines: Vec::new(),
                is_binary: false,
            });
            true
        }
    };

    let line_cb = {
        let state = &state;
        move |_delta: git2::DiffDelta<'_>,
              _hunk: Option<git2::DiffHunk<'_>>,
              line: git2::DiffLine<'_>| {
            let mut s = state.borrow_mut();
            if s.line_budget == 0 {
                return false;
            }

            let origin = line.origin();
            let content = String::from_utf8_lossy(line.content()).to_string();

            match origin {
                '+' | '-' | ' ' => {
                    let (old_no, new_no) = match origin {
                        '+' => {
                            let no = s.new_lineno;
                            s.new_lineno += 1;
                            s.additions += 1;
                            (None, Some(no))
                        }
                        '-' => {
                            let no = s.old_lineno;
                            s.old_lineno += 1;
                            s.deletions += 1;
                            (Some(no), None)
                        }
                        _ => {
                            let o = s.old_lineno;
                            let n = s.new_lineno;
                            s.old_lineno += 1;
                            s.new_lineno += 1;
                            (Some(o), Some(n))
                        }
                    };

                    if let Some(hunk) = s.current.as_mut() {
                        hunk.lines.push(DiffLine {
                            origin: origin_char(origin),
                            content: content.clone(),
                            old_lineno: old_no,
                            new_lineno: new_no,
                        });
                    }
                    s.raw.push_str(&content);
                    s.raw.push('\n');
                    s.line_budget -= 1;
                }
                'F' => {
                    s.raw.push_str(&content);
                    s.raw.push('\n');
                }
                _ => {}
            }
            true
        }
    };

    let mut file_cb = |_delta: git2::DiffDelta<'_>, _total: f32| true;

    let mut hunk_cb = hunk_cb;
    let mut line_cb = line_cb;
    let _ = diff.foreach(&mut file_cb, None, Some(&mut hunk_cb), Some(&mut line_cb));

    let PatchState {
        raw,
        mut hunks,
        additions,
        deletions,
        current,
        ..
    } = state.into_inner();

    if let Some(hunk) = current {
        hunks.push(hunk);
    }

    let _ = repo;
    let _ = max_bytes;

    Ok(FileDiff {
        path: path.to_string(),
        old_path,
        is_binary,
        too_large,
        additions,
        deletions,
        hunks,
        raw,
        kind: delta_kind(delta.status()),
    })
}

/// Estado compartido por los tres callbacks de `Diff::foreach`.
#[derive(Default)]
struct PatchState {
    raw: String,
    hunks: Vec<DiffHunk>,
    additions: usize,
    deletions: usize,
    line_budget: usize,
    current: Option<DiffHunk>,
    old_lineno: usize,
    new_lineno: usize,
}

/// Letra de la columna "staged" segun los flags de `Status`.
///
/// En git2 0.20 `Status` dejo de ser un bitflags: expone metodos `is_*` en lugar
/// de `contains`/`intersect`, asi que la letra se deduce de las banderas.
fn status_letters(flags: git2::Status) -> char {
    if flags.is_index_new() {
        'A'
    } else if flags.is_index_deleted() {
        'D'
    } else if flags.is_index_renamed() {
        'R'
    } else if flags.is_index_typechange() {
        'T'
    } else if flags.is_index_modified() {
        'M'
    } else {
        ' '
    }
}

/// Letra de la columna "unstaged" segun los flags de `Status`.
fn worktree_letters(flags: git2::Status) -> char {
    if flags.is_wt_deleted() {
        'D'
    } else if flags.is_wt_renamed() {
        'R'
    } else if flags.is_wt_typechange() {
        'T'
    } else if flags.is_wt_modified() {
        'M'
    } else {
        ' '
    }
}

fn origin_char(c: char) -> char {
    c
}

fn delta_kind(status: Delta) -> ChangeKind {
    match status {
        Delta::Added => ChangeKind::Added,
        Delta::Deleted => ChangeKind::Deleted,
        Delta::Renamed => ChangeKind::Renamed,
        Delta::Copied => ChangeKind::Copied,
        Delta::Typechange => ChangeKind::TypeChanged,
        Delta::Ignored => ChangeKind::Ignored,
        Delta::Conflicted => ChangeKind::Conflicted,
        Delta::Unreadable | Delta::Unmodified => ChangeKind::Modified,
        _ => ChangeKind::Modified,
    }
}

// ---------------------------------------------------------------------------
// Staging
// ---------------------------------------------------------------------------

/// Anade al area de stage un conjunto de archivos.
pub fn stage(repo: &Repository, paths: &[String]) -> AppResult<usize> {
    let mut index = repo.index().map_err(AppError::from_git)?;
    let mut affected = 0usize;

    for path in paths {
        let full = crate::git::util::safe_worktree_path(&repo_workdir(repo), path)?;
        let entry = if full.exists() {
            Some(full.clone())
        } else {
            // Fichero borrado: stagear la ausencia.
            None
        };

        match entry {
            Some(_) => {
                index.add_path(std::path::Path::new(&native_path(path))).map_err(|e| {
                    AppError::from_git(e).with_detail(format!("Archivo: {path}"))
                })?;
            }
            None => {
                index.remove_path(std::path::Path::new(&native_path(path))).map_err(|e| {
                    AppError::from_git(e).with_detail(format!("Archivo: {path}"))
                })?;
            }
        }
        affected += 1;
    }

    index.write().map_err(AppError::from_git)?;
    refresh_workdir_file(repo, paths)?;
    Ok(affected)
}

/// Saca del area de stage un conjunto de archivos.
pub fn unstage(repo: &Repository, paths: &[String]) -> AppResult<usize> {
    let head_commit = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    let mut index = repo.index().map_err(AppError::from_git)?;
    let mut affected = 0usize;

    for path in paths {
        let relative = native_path(path);
        // `reset_default` con paths equivale a `git reset HEAD -- <path>`.
        let reset = repo.reset_default(head_commit.as_ref().map(|c| c.as_object()), [&relative]);

        if reset.is_err() {
            // Sin HEAD (repositorio sin commits) hay que quitar la entrada a mano.
            index
                .remove_path(std::path::Path::new(&relative))
                .map_err(AppError::from_git)?;
        }
        affected += 1;
    }

    index.write().map_err(AppError::from_git)?;
    Ok(affected)
}

/// Marca todos los cambios del working tree.
pub fn stage_all(repo: &Repository) -> AppResult<usize> {
    let mut index = repo.index().map_err(AppError::from_git)?;
    let workdir = repo
        .workdir()
        .ok_or_else(|| AppError::invalid_state("No se puede stagear en un repositorio bare"))?;

    index
        .add_all(["*"].iter(), IndexAddOption::DEFAULT, None)
        .map_err(AppError::from_git)?;
    index.update_all(["*"].iter(), None).ok();
    index.write().map_err(AppError::from_git)?;

    // `add_all` ignora directorios vacios no rastreados; usar `include_untracked` como red.
    let _ = workdir;
    Ok(index.iter().count())
}

/// Descarta cambios de archivos.
pub fn discard(repo: &Repository, paths: &[String]) -> AppResult<usize> {
    let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
    let mut index = repo.index().map_err(AppError::from_git)?;
    let mut count = 0usize;

    for path in paths {
        let relative = native_path(path);

        // 1. Restablecer el indice a HEAD.
        if let Some(tree) = &head_tree {
            repo.reset_default(Some(tree.as_object()), [&relative])
                .map_err(AppError::from_git)?;
        }

        // 2. Si el archivo no existe en HEAD, borrarlo del disco.
        let exists_in_head = head_tree
            .as_ref()
            .map(|tree| tree.get_path(std::path::Path::new(&relative)).is_ok())
            .unwrap_or(false);

        let full = crate::git::util::safe_worktree_path(&repo_workdir(repo), path)?;
        if !exists_in_head {
            if full.exists() {
                std::fs::remove_file(&full).map_err(AppError::from_io)?;
            }
            index.remove_path(std::path::Path::new(&relative)).ok();
        } else {
            // 3. Sobrescribir el archivo con el blob de HEAD.
            let target = head_tree
                .as_ref()
                .and_then(|tree| tree.get_path(std::path::Path::new(&relative)).ok());
            if let Some(entry) = target {
                let object = repo
                    .find_blob(entry.id())
                    .map_err(AppError::from_git)?;
                if let Some(parent) = full.parent() {
                    std::fs::create_dir_all(parent).map_err(AppError::from_io)?;
                }
                std::fs::write(&full, object.content()).map_err(AppError::from_io)?;
            }
        }
        count += 1;
    }

    index.write().map_err(AppError::from_git)?;
    Ok(count)
}

/// Descarta un unico hunk de los cambios sin anadir.
pub fn discard_hunk(
    repo: &Repository,
    path: &str,
    hunk_index: usize,
    reverse: bool,
) -> AppResult<OperationResult> {
    let query = DiffQuery {
        repo_id: String::new(),
        side: if reverse {
            DiffSide::Staged
        } else {
            DiffSide::Worktree
        },
        path: Some(path.to_string()),
        old_oid: None,
        new_oid: None,
        include_context: false,
        context: 3,
        max_file_bytes: None,
    };
    let current = diff(repo, &query)?;
    let Some(file) = current.files.iter().find(|f| f.path == path) else {
        return Err(AppError::not_found(format!("Sin cambios en {path}")));
    };
    if file.hunks.get(hunk_index).is_none() {
        return Err(AppError::validation(format!(
            "El hunk {hunk_index} ya no existe; el diff cambio"
        )));
    }

    let hunk_text = rebuild_patch(file, &[hunk_index], &[]);
    apply_discard_patch(repo, path, &hunk_text)?;

    Ok(OperationResult::ok(format!(
        "Hunk {hunk_index} quitado del area de preparacion en {path}"
    ))
    .with_refs(vec![]))
}

/// Staging/unstaging parcial por hunks y lineas.
pub fn apply_hunk_selection(repo: &Repository, selections: &[HunkSelection]) -> AppResult<usize> {
    let mut count = 0usize;

    for selection in selections {
        let query = DiffQuery {
            repo_id: String::new(),
            side: if selection.unstage {
                DiffSide::Staged
            } else {
                DiffSide::Worktree
            },
            path: Some(selection.path.clone()),
            old_oid: None,
            new_oid: None,
            include_context: false,
            context: 3,
            max_file_bytes: None,
        };
        let current = diff(repo, &query)?;
        let Some(file) = current.files.iter().find(|f| f.path == selection.path) else {
            return Err(AppError::not_found(format!(
                "Sin cambios pendientes en {}",
                selection.path
            )));
        };

        let hunk_indices: Vec<usize> = if selection.hunk_indices.is_empty() {
            let mut all: Vec<usize> = selection
                .line_selections
                .iter()
                .map(|l| l.hunk_index)
                .collect();
            all.sort_unstable();
            all.dedup();
            all
        } else {
            selection.hunk_indices.clone()
        };

        if hunk_indices.iter().any(|i| *i >= file.hunks.len()) {
            return Err(AppError::validation(
                "El diff cambio desde que lo cargaste; recargalo e intenta de nuevo",
            ));
        }

        // Lineas excluidas dentro de hunks marcados.
        let excluded: Vec<(usize, usize)> = selection
            .line_selections
            .iter()
            .filter(|l| !l.include)
            .map(|l| (l.hunk_index, l.line_index))
            .collect();

        let patch = rebuild_patch(file, &hunk_indices, &excluded);

        if selection.unstage {
            apply_reverse_patch(repo, &selection.path, &patch)?;
        } else {
            apply_patch(repo, &selection.path, &patch)?;
        }
        count += hunk_indices.len();
    }

    Ok(count)
}

/// Reconstruye un parche unificado con los hunks y lineas seleccionados.
///
/// libgit2 (`git_patch_parse`) exige la cabecera `diff --git` para reconocer un
/// parche; sin ella `Diff::from_buffer` siempre falla. Se emiten tambien las
/// cabeceras git-extendidas (`new file mode`, `deleted file mode`) para que el
/// parser sepa recrear/eliminar el archivo.
fn rebuild_patch(file: &FileDiff, hunk_indices: &[usize], excluded: &[(usize, usize)]) -> String {
    let mut patch = String::new();

    let old_path = file.old_path.as_deref().unwrap_or(&file.path);

    patch.push_str(&format!("diff --git a/{old_path} b/{}\n", file.path));

    if file.is_binary {
        patch.push_str("GIT binary patch\n");
        return patch;
    }

    if file.kind == ChangeKind::Added {
        patch.push_str("new file mode 100644\n");
    } else if file.kind == ChangeKind::Deleted {
        patch.push_str("deleted file mode 100644\n");
    }

    patch.push_str(&format!("--- a/{old_path}\n+++ b/{}\n", file.path));

    for &hunk_index in hunk_indices {
        let Some(hunk) = file.hunks.get(hunk_index) else {
            continue;
        };
        patch.push_str(&hunk.header);
        patch.push('\n');
        for (line_index, line) in hunk.lines.iter().enumerate() {
            if excluded.contains(&(hunk_index, line_index)) {
                continue;
            }
            patch.push(line.origin);
            patch.push_str(&line.content);
            patch.push('\n');
        }
    }

    patch
}

/// Aplica un parche al area de preparacion (indice).
///
/// Un parche del lado worktree (HEAD..worktree) aplicado al indice stagea el
/// hunk: libgit2 escribe el resultado en el indice sin tocar el working tree.
fn apply_patch(repo: &Repository, path: &str, patch: &str) -> AppResult<()> {
    apply_raw_patch(repo, path, patch, false, git2::ApplyLocation::Index)
}

/// Reaplica un parche del lado staged de vuelta al working tree (unstage).
///
/// La seleccion viene del diff HEAD..index; para des-stagear hay que devolver
/// ese contenido al working tree => se aplica invertido sobre WorkDir.
fn apply_reverse_patch(repo: &Repository, path: &str, patch: &str) -> AppResult<()> {
    apply_raw_patch(repo, path, patch, true, git2::ApplyLocation::WorkDir)
}

/// Descarta un hunk del working tree aplicando su parche invertido a WorkDir.
fn apply_discard_patch(repo: &Repository, path: &str, patch: &str) -> AppResult<()> {
    apply_raw_patch(repo, path, patch, true, git2::ApplyLocation::WorkDir)
}

fn apply_raw_patch(
    repo: &Repository,
    path: &str,
    patch: &str,
    reverse: bool,
    location: git2::ApplyLocation,
) -> AppResult<()> {
    let body = if reverse { reverse_patch_text(patch) } else { patch.to_string() };

    let diff = git2::Diff::from_buffer(body.as_bytes()).map_err(|e| {
        AppError::validation(format!("No se pudo interpretar el diff de {path}: {e}"))
    })?;

    if diff.deltas().len() == 0 {
        return Err(AppError::invalid_state(format!(
            "El parche de {path} no contenia cambios aplicables"
        )));
    }

    let mut opts = git2::ApplyOptions::new();
    opts.check(true);

    repo.apply(&diff, location, Some(&mut opts))
        .map_err(|e| {
            AppError::invalid_state(format!(
                "No se pudo {} el cambio en {path}: {}",
                if reverse { "revertir" } else { "aplicar" },
                e.message()
            ))
            .with_detail("El contenido del archivo cambio desde que generaste el diff")
        })
}

/// Invierte un parche unificado intercambiando los signos de las lineas.
///
/// Es la contraparte textual de `git apply -R`, necesaria porque libgit2 no
/// expone un modo inverso en `Repository::apply`.
fn reverse_patch_text(patch: &str) -> String {
    let mut out = String::with_capacity(patch.len());
    for line in patch.lines() {
        match line.as_bytes().first() {
            Some(b'+') => {
                out.push('-');
                out.push_str(&line[1..]);
            }
            Some(b'-') => {
                out.push('+');
                out.push_str(&line[1..]);
            }
            _ => out.push_str(line),
        }
        out.push('\n');
    }
    out
}

// ---------------------------------------------------------------------------
// Utilidades internas
// ---------------------------------------------------------------------------

fn repo_workdir(repo: &Repository) -> std::path::PathBuf {
    repo.workdir().map(|p| p.to_path_buf()).unwrap_or_default()
}

/// Vuelve a escanear directorios sin rastrear tras anadir archivos.
fn refresh_workdir_file(repo: &Repository, paths: &[String]) -> AppResult<()> {
    let mut index = repo.index().map_err(AppError::from_git)?;
    for path in paths {
        let workdir_path = crate::git::util::safe_worktree_path(&repo_workdir(repo), path)?;
        if !workdir_path.exists() {
            continue;
        }
        let metadata = std::fs::metadata(&workdir_path);
        if metadata.map(|m| m.is_dir()).unwrap_or(false) {
            index
                .add_all(
                    [workdir_path.to_string_lossy().to_string()].iter(),
                    IndexAddOption::DEFAULT,
                    None,
                )
                .ok();
        }
    }
    index.write().ok();
    Ok(())
}

/// Ordena entradas de indice de forma estable (util para la vista de archivos).
pub fn sorted_paths(mut paths: Vec<String>) -> Vec<String> {
    paths.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()).then(a.cmp(b)));
    paths
}

/// Orden de sort de git usado al listar archivos.
pub fn sort_mode() -> Sort {
    Sort::TOPOLOGICAL
}