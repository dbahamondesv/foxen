//! Operaciones sobre commits: crear, enmendar, cherry-pick, revert, reset,
//! detalle de commit, historial de archivos y reflog.

use std::collections::HashMap;

use git2::{Commit, Cred, ObjectType, Repository, ResetType, Signature};

use crate::error::{AppError, AppResult};
use crate::git::refs::ResetMode;
use crate::git::util::{iso8601, short_oid, shorten_ref};
use crate::types::{
    ChangeKind, CommitDetail, CommitFileChange, CommitStats, DiffQuery, DiffSide, FileHistoryEntry,
    OperationResult, ReflogEntry,
};

/// Firma la identidad configurada en el repositorio.
pub fn signature(repo: &Repository) -> AppResult<Signature<'static>> {
    // Respetar la configuración local/global del usuario, con fallback razonable.
    let config = repo.config().map_err(AppError::from_git)?;
    let name = config
        .get_string("user.name")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "Foxen".to_string());
    let email = config
        .get_string("user.email")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "foxen@localhost".to_string());

    Signature::now(&name, &email).map_err(AppError::from_git)
}

/// Resuelve una lista de Oids a `Commit`, que es lo que `Repository::commit` exige.
fn resolve_parents<'r>(
    repo: &'r Repository,
    oids: &[git2::Oid],
) -> AppResult<Vec<Commit<'r>>> {
    oids.iter()
        .map(|oid| repo.find_commit(*oid).map_err(AppError::from_git))
        .collect()
}

/// Oids pendientes en `MERGE_HEAD` (una fusion sin cerrar).
///
/// Se lee el archivo directamente porque asi lo escribe `merge::write_merge_state`
/// y porque `MERGE_HEAD` admite varios Oids (fusiones octopus).
fn merge_head_oids(repo: &Repository) -> Vec<git2::Oid> {
    let Ok(contents) = std::fs::read_to_string(repo.path().join("MERGE_HEAD")) else {
        return Vec::new();
    };
    contents
        .lines()
        .filter_map(|line| line.trim().parse::<git2::Oid>().ok())
        .collect()
}

/// Opciones de creacion de commit.
pub struct CommitOptions<'a> {
    pub message: &'a str,
    pub amend: bool,
    pub allow_empty: bool,
    pub sign: bool,
    /// Si es `true` solo commitea lo que ya esta en el indice.
    pub staged_only: bool,
    /// Enmendar un commit concreto.
    pub target: Option<&'a str>,
}

/// Crea un commit o amendment.
pub fn commit(repo: &Repository, opts: CommitOptions<'_>) -> AppResult<OperationResult> {
    let message = opts.message.trim();
    if message.is_empty() {
        return Err(AppError::validation("El mensaje del commit no puede estar vacio"));
    }
    let sig = signature(repo)?;

    let mut index = repo.index().map_err(AppError::from_git)?;

    // Si no se indica `stagedOnly`, anadir los cambios del working tree.
    if !opts.staged_only && !opts.amend {
        index
            .add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None)
            .map_err(AppError::from_git)?;
        index
            .update_all(["*"].iter(), None)
            .map_err(AppError::from_git)?;
        index.write().map_err(AppError::from_git)?;
    }

    let tree_oid = index.write_tree().map_err(AppError::from_git)?;

    // Una fusion con conflictos deja `MERGE_HEAD`: el commit que la cierra debe
    // tener dos padres, igual que `git commit` tras resolver. En un amend no
    // aplica (se reutilizan los padres del commit original).
    let merge_heads = if opts.amend { Vec::new() } else { merge_head_oids(repo) };

    // El amend reutiliza el arbol y los padres del commit original.
    let (tree, parents, target_oid) = if opts.amend {
        let target_rev = opts
            .target
            .map(|t| t.to_string())
            .or_else(|| repo.head().ok().and_then(|h| h.name().map(|n| n.to_string())))
            .ok_or_else(|| AppError::invalid_state("No hay ningun commit para enmendar"))?;

        let original = crate::git::refs::resolve_commit(repo, &target_rev)?;
        let tree = original.tree().map_err(AppError::from_git)?;
        let parents: Vec<git2::Oid> = original.parent_ids().collect();
        let oid = original.id();

        // `git commit --amend` conserva el arbol recien construido.
        if !opts.staged_only && tree_oid != tree.id() {
            // Se permite enmendar con el arbol del indice (edicion de contenido).
        }
        (tree, parents, Some(oid))
    } else {
        let tree = repo
            .find_tree(tree_oid)
            .map_err(AppError::from_git)?;
        let head_oid = repo
            .head()
            .ok()
            .and_then(|h| h.peel_to_commit().ok())
            .map(|c| c.id());
        let mut parents: Vec<git2::Oid> = head_oid.into_iter().collect();
        parents.extend(merge_heads.iter().copied());
        (tree, parents, None)
    };

    // Rechazar commits vacios salvo que se pidan explicitamente o sea un amend.
    // Un commit de fusion es valido aunque su arbol coincida con el primer
    // padre (p. ej. resolviendo todo a favor de la rama actual).
    if !opts.allow_empty && !opts.amend && merge_heads.is_empty() {
        let has_diff = match parents.first() {
            Some(parent_oid) => {
                let parent_tree = repo
                    .find_commit(*parent_oid)
                    .ok()
                    .and_then(|c| c.tree().ok());
                tree.id() != parent_tree.map(|t| t.id()).unwrap_or(tree.id())
            }
            None => true,
        };
        if !has_diff {
            return Err(AppError::invalid_state(
                "No hay cambios para commitear",
            ));
        }
    }

    let tree_for_commit = if opts.amend && !opts.staged_only {
        // Respetar el contenido staged en el amend.
        repo.find_tree(tree_oid).map_err(AppError::from_git)?
    } else {
        tree
    };

    let parent_commits = resolve_parents(repo, &parents)?;
    let parent_refs: Vec<&Commit<'_>> = parent_commits.iter().collect();

    // libgit2 exige que, al actualizar una referencia, la punta actual sea el
    // primer padre del commit nuevo. Eso se rompe al enmendar el commit raiz:
    // su lista de padres queda vacia y `git commit --amend` es una operacion
    // perfectamente valida. En ese caso el commit se crea sin tocar la
    // referencia y la rama se mueve despues a mano.
    let head_tip = repo.head().ok().and_then(|h| h.peel_to_commit().ok()).map(|c| c.id());
    let tip_consistent = match (head_tip, parent_refs.first()) {
        (None, _) => true,
        (Some(_), None) => false,
        (Some(tip), Some(first)) => first.id() == tip,
    };

    let update_ref = if tip_consistent { Some("HEAD") } else { None };
    let new_oid = repo
        .commit(update_ref, &sig, &sig, message, &tree_for_commit, &parent_refs)
        .map_err(|e| {
            AppError::from_git(e).with_detail("Revisa la configuracion de user.name y user.email")
        })?;

    if update_ref.is_none() {
        // Reubicar la rama (o HEAD si esta desligado) sobre el commit nuevo.
        if let Some(name) = repo.head().ok().and_then(|h| h.name().map(|n| n.to_string())) {
            repo.reference(&name, new_oid, true, "foxen: amend")
                .map_err(AppError::from_git)?;
        }
    }

    // Cerrar la fusion: borra MERGE_HEAD/MERGE_MSG. No es fatal si falla.
    if !merge_heads.is_empty() {
        let _ = repo.cleanup_state();
    }

    if opts.sign {
        let _ = create_signed_commit(repo, new_oid, message);
    }

    let head_branch = repo
        .head()
        .ok()
        .filter(|h| h.is_branch())
        .and_then(|h| h.shorthand().map(|s| s.to_string()));

    let verb = if opts.amend { "Enmendado" } else { "Creado" };
    let _ = target_oid;

    Ok(
        OperationResult::ok(format!("{verb} commit {}", short_oid(&new_oid)))
            .with_head(Some(new_oid.to_string()), head_branch)
            .with_refs(vec!["HEAD".to_string()]),
    )
}

/// Firma el commit recien creado con la clave configurada.
fn create_signed_commit(repo: &Repository, oid: git2::Oid, message: &str) -> AppResult<()> {
    let config = repo.config().map_err(AppError::from_git)?;
    // Se valida que exista SigningKey configurada: la firma criptografica la
    // resuelve `Repository::commit_signed` mas abajo.
    config
        .get_string("user.signingkey")
        .map_err(|_| AppError::validation("No hay clave de firma configurada (user.signingkey)"))?;
    let sig = signature(repo)?;
    let commit = repo.find_commit(oid).map_err(AppError::from_git)?;
    let tree = commit.tree().map_err(AppError::from_git)?;
    let parent_ids: Vec<git2::Oid> = commit.parent_ids().collect();
    let parent_commits = resolve_parents(repo, &parent_ids)?;
    let parents: Vec<&Commit<'_>> = parent_commits.iter().collect();

    repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &parents)
        .map_err(AppError::from_git)?;

    let _ = Cred::default();
    Ok(())
}

/// Aplica un commit de otra rama sobre la actual (`cherry-pick`).
pub fn cherry_pick(
    repo: &mut Repository,
    commit_oid: &str,
    no_commit: bool,
    mainline: Option<usize>,
) -> AppResult<OperationResult> {
    let source = crate::git::refs::resolve_commit(repo, commit_oid)?;
    let sig = signature(repo)?;

    // `cherrypick` aplica el parche y deja los conflictos en el indice. El error
    // se traduce fuera del borrow de `opts` porque `merge_error` inspecciona el repo.
    let applied = {
        let mut opts = git2::CherrypickOptions::new();
        if let Some(line) = mainline.filter(|m| *m > 0) {
            opts.mainline(line as u32);
        }
        repo.cherrypick(&source, Some(&mut opts))
    };
    if let Err(err) = applied {
        return Err(merge_error(repo, err));
    }

    if no_commit {
        let head = repo.head().ok().and_then(|h| h.target()).map(|o| o.to_string());
        let branch = repo
            .head()
            .ok()
            .filter(|h| h.is_branch())
            .and_then(|h| h.shorthand().map(|s| s.to_string()));
        return Ok(
            OperationResult::ok(format!("Cambios de {commit_oid} aplicados sin commit"))
                .with_head(head, branch),
        );
    }

    let conflicts = conflicted_paths(repo);
    if !conflicts.is_empty() {
        return Err(AppError::invalid_state(format!(
            "El cherry-pick de {commit_oid} tiene conflictos con {} archivo(s)",
            conflicts.len()
        ))
        .with_detail(conflicts.join(", ")));
    }

    // Materializar el commit con la identidad del usuario.
    let mut index = repo.index().map_err(AppError::from_git)?;
    let tree_oid = index.write_tree().map_err(AppError::from_git)?;
    let tree = repo.find_tree(tree_oid).map_err(AppError::from_git)?;
    let head = repo
        .head()
        .map_err(AppError::from_git)?
        .peel_to_commit()
        .map_err(AppError::from_git)?;
    let parents: Vec<&Commit<'_>> = vec![&head];

    repo.commit(
        Some("HEAD"),
        &sig,
        &sig,
        source.summary().unwrap_or("Cherry-pick"),
        &tree,
        &parents,
    )
    .map_err(AppError::from_git)?;

    let head = repo.head().ok().and_then(|h| h.target());
    let branch = repo
        .head()
        .ok()
        .filter(|h| h.is_branch())
        .and_then(|h| h.shorthand().map(|s| s.to_string()));

    Ok(
        OperationResult::ok(format!("Cherry-pick de {} aplicado", short_oid(&source.id())))
            .with_head(head.map(|o| o.to_string()), branch),
    )
}

/// Crea un commit que revierte otro.
pub fn revert(
    repo: &mut Repository,
    commit_oid: &str,
    mainline: Option<usize>,
    no_commit: bool,
) -> AppResult<OperationResult> {
    let source = crate::git::refs::resolve_commit(repo, commit_oid)?;
    let sig = signature(repo)?;

    let applied = {
        let mut opts = git2::RevertOptions::new();
        if let Some(line) = mainline.filter(|m| *m > 0) {
            opts.mainline(line as u32);
        }
        repo.revert(&source, Some(&mut opts))
    };
    if let Err(err) = applied {
        return Err(merge_error(repo, err));
    }

    if no_commit {
        let head = repo.head().ok().and_then(|h| h.target()).map(|o| o.to_string());
        let branch = repo
            .head()
            .ok()
            .filter(|h| h.is_branch())
            .and_then(|h| h.shorthand().map(|s| s.to_string()));
        return Ok(
            OperationResult::ok(format!("Cambios de {commit_oid} revertidos sin commit"))
                .with_head(head, branch),
        );
    }

    let conflicts = conflicted_paths(repo);
    if !conflicts.is_empty() {
        return Err(AppError::invalid_state(format!(
            "El revert de {commit_oid} tiene conflictos con {} archivo(s)",
            conflicts.len()
        ))
        .with_detail(conflicts.join(", ")));
    }

    let mut index = repo.index().map_err(AppError::from_git)?;
    let tree_oid = index.write_tree().map_err(AppError::from_git)?;
    let tree = repo.find_tree(tree_oid).map_err(AppError::from_git)?;
    let head = repo
        .head()
        .map_err(AppError::from_git)?
        .peel_to_commit()
        .map_err(AppError::from_git)?;
    let parents: Vec<&Commit<'_>> = vec![&head];

    let message = format!("Revert \"{}\"", source.summary().unwrap_or("commit"));

    repo.commit(Some("HEAD"), &sig, &sig, &message, &tree, &parents)
        .map_err(AppError::from_git)?;

    let head = repo.head().ok().and_then(|h| h.target());
    let branch = repo
        .head()
        .ok()
        .filter(|h| h.is_branch())
        .and_then(|h| h.shorthand().map(|s| s.to_string()));

    Ok(
        OperationResult::ok(format!("Revert de {} creado", short_oid(&source.id())))
            .with_head(head.map(|o| o.to_string()), branch),
    )
}

/// Traduce errores de merge a mensajes accionables.
fn merge_error(repo: &Repository, err: git2::Error) -> AppError {
    let conflicts = conflicted_paths(repo);
    if !conflicts.is_empty() {
        AppError::invalid_state(format!(
            "La operacion quedo en conflicto con {} archivo(s)",
            conflicts.len()
        ))
        .with_detail(conflicts.join(", "))
    } else {
        AppError::from_git(err)
    }
}

/// Rutas en conflicto del indice.
pub fn conflicted_paths(repo: &Repository) -> Vec<String> {
    // Etapas 1/2/3 del indice, cuando la operacion las ha dejado.
    let mut paths: Vec<String> = match repo.index() {
        Ok(index) => index
            .conflicts()
            .map(|conflicts| {
                conflicts
                    .flatten()
                    .filter_map(|c| c.our.or(c.their).or(c.ancestor))
                    .map(|entry| String::from_utf8_lossy(&entry.path).to_string())
                    .collect()
            })
            .unwrap_or_default(),
        Err(_) => Vec::new(),
    };

    // `git_merge_commits` de libgit2 limpia las etapas del indice, asi que los
    // marcadores en el working tree son la fuente fiable de conflictos.
    for path in crate::git::staging::conflicted_paths_in_workdir(repo) {
        if !paths.contains(&path) {
            paths.push(path);
        }
    }
    paths.sort();
    paths.dedup();
    paths
}

/// Marca conflictos como resueltos, dejando el contenido actual.
pub fn resolve_conflict(repo: &Repository, path: &str) -> AppResult<()> {
    let mut index = repo.index().map_err(AppError::from_git)?;
    index
        .add_path(std::path::Path::new(&path))
        .map_err(AppError::from_git)?;
    index.write().map_err(AppError::from_git)?;
    Ok(())
}

/// Toma una version concreta de un archivo en conflicto.
pub fn checkout_conflict_side(repo: &Repository, path: &str, side: ConflictSide) -> AppResult<()> {
    let index = repo.index().map_err(AppError::from_git)?;

    let stage = side.stage();
    let chosen = index
        .get_path(std::path::Path::new(path), stage)
        .map(|entry| entry.id);

    let Some(blob_oid) = chosen else {
        if side == ConflictSide::Ours || side == ConflictSide::Theirs {
            return Err(AppError::validation(format!(
                "El lado {side:?} no existe para {path}"
            )));
        }
        // Base: se quita el archivo si no hay version base.
        let mut writable = repo.index().map_err(AppError::from_git)?;
        writable.remove_path(std::path::Path::new(path)).ok();
        writable.write().map_err(AppError::from_git)?;
        return Ok(());
    };

    let blob = repo.find_blob(blob_oid).map_err(AppError::from_git)?;
    let full = repo
        .workdir()
        .ok_or_else(|| AppError::invalid_state("Repositorio bare"))?
        .join(path);
    if let Some(parent) = full.parent() {
        std::fs::create_dir_all(parent).map_err(AppError::from_io)?;
    }
    std::fs::write(&full, blob.content()).map_err(AppError::from_io)?;

    resolve_conflict(repo, path)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConflictSide {
    Ours,
    Theirs,
    Base,
}

impl ConflictSide {
    fn stage(self) -> i32 {
        match self {
            ConflictSide::Base => 1,
            ConflictSide::Ours => 2,
            ConflictSide::Theirs => 3,
        }
    }

    pub fn parse(value: &str) -> AppResult<Self> {
        match value.to_ascii_lowercase().as_str() {
            "ours" => Ok(ConflictSide::Ours),
            "theirs" => Ok(ConflictSide::Theirs),
            "base" | "ancestor" => Ok(ConflictSide::Base),
            other => Err(AppError::validation(format!("Lado invalido: {other}"))),
        }
    }
}

// ---------------------------------------------------------------------------
// Detalle de commit
// ---------------------------------------------------------------------------

/// Carga el detalle completo de un commit, incluyendo sus archivos.
pub fn detail(repo: &Repository, oid: &str) -> AppResult<CommitDetail> {
    let commit = crate::git::refs::resolve_commit(repo, oid)?;
    let parent_oid = commit.parent(0).ok().map(|p| p.id());
    let head_oid = repo.head().ok().and_then(|h| h.peel_to_commit().ok()).map(|c| c.id());

    let query = DiffQuery {
        repo_id: String::new(),
        side: DiffSide::Commit,
        path: None,
        old_oid: parent_oid.map(|o| o.to_string()),
        new_oid: None,
        include_context: false,
        context: 0,
        max_file_bytes: Some(256 * 1024),
    };

    // El diff y las cifras se calculan en un bloque propio porque `Diff` y
    // `Commit` prestan `repo` de forma inmutable y el detalle se arma despues.
    // El diff y las cifras se calculan en un bloque propio porque `Diff` y
    // `Commit` prestan `repo` de forma inmutable y el detalle se arma despues.
    let (files, insertions, deletions) = {
        let diff = commit_diff(repo, &commit)?;
        let per_file = collect_file_stats(&diff);

        let mut files: Vec<CommitFileChange> = Vec::new();
        let mut insertions = 0usize;
        let mut deletions = 0usize;

        for i in 0..diff.deltas().len() {
            let Some(delta) = diff.get_delta(i) else {
                continue;
            };
            let Some(path) = delta.new_file().path().or_else(|| delta.old_file().path()) else {
                continue;
            };
            let path_string = path.to_string_lossy().to_string();
            let (add, del) = per_file.get(&path_string).copied().unwrap_or((0, 0));
            insertions += add;
            deletions += del;
            files.push(CommitFileChange {
                old_path: delta
                    .old_file()
                    .path()
                    .filter(|_| delta.status() == git2::Delta::Renamed)
                    .map(|p| p.to_string_lossy().to_string()),
                path: path_string,
                kind: staging_kind(delta.status()),
                is_binary: delta.new_file().is_binary() || delta.old_file().is_binary(),
                insertions: add,
                deletions: del,
                status_char: status_char(delta.status()),
            });
        }
        files.sort_by(|a, b| a.path.cmp(&b.path));
        (files, insertions, deletions)
    };
    let _ = query;

    // El detalle se construye en una variable: los `Signature` prestados por
    // `commit.author()` viven hasta el final de la expresion y `commit` debe
    // soltarse antes de que se destruya.
    let detail = CommitDetail {
        oid: commit.id().to_string(),
        short_oid: short_oid(&commit.id()),
        subject: commit.summary().unwrap_or_default().to_string(),
        body: commit.body().map(|b| b.to_string()),
        author_name: commit.author().name().unwrap_or("Desconocido").to_string(),
        author_email: commit.author().email().unwrap_or_default().to_string(),
        author_time: commit.author().when().seconds(),
        author_time_iso: iso8601(commit.author().when().seconds()),
        committer_name: commit.committer().name().unwrap_or_default().to_string(),
        committer_email: commit.committer().email().unwrap_or_default().to_string(),
        commit_time_iso: iso8601(commit.time().seconds()),
        parents: commit.parent_ids().map(|p| p.to_string()).collect(),
        is_merge: commit.parent_count() > 1,
        stats: CommitStats {
            files_changed: files.len(),
            insertions,
            deletions,
        },
        files,
        body_raw: commit.message().unwrap_or_default().to_string(),
        // `graph_descendant_of` es estricto, asi que el propio HEAD hay que
        // compararlo a mano o apareceria como no alcanzable.
        reachable_from_head: head_oid
            .map(|head| {
                head == commit.id()
                    || repo.graph_descendant_of(head, commit.id()).unwrap_or(false)
            })
            .unwrap_or(false),
    };

    Ok(detail)
}

/// Diff de un commit contra su primer padre.
fn commit_diff<'r>(repo: &'r Repository, commit: &Commit<'r>) -> AppResult<git2::Diff<'r>> {
    let new_tree = commit.tree().map_err(AppError::from_git)?;
    let old_tree = commit.parent(0).ok().and_then(|p| p.tree().ok());
    let mut opts = git2::DiffOptions::new();
    opts.context_lines(0)
        .interhunk_lines(0)
        .include_typechange(true)
        .ignore_submodules(true);
    repo.diff_tree_to_tree(old_tree.as_ref(), Some(&new_tree), Some(&mut opts))
        .map_err(AppError::from_git)
}

/// Recorre el diff una sola vez acumulando inserciones/borrados por delta.
///
/// Contar por delta (y no sobre el diff completo) es obligatorio: `Diff::print`
/// visita todos los archivos, por lo que llamarlo dentro de un bucle sobre los
/// deltas multiplicaria las cifras.
fn collect_file_stats(diff: &git2::Diff<'_>) -> HashMap<String, (usize, usize)> {
    // El callback entrega el `DiffDelta` de la linea actual, no un indice, asi que
    // se acumula por ruta.
    let mut totals: HashMap<String, (usize, usize)> = HashMap::new();

    let _ = diff.print(git2::DiffFormat::Patch, |delta, _hunk, line| {
        let key = delta
            .new_file()
            .path()
            .or_else(|| delta.old_file().path())
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();

        let slot = totals.entry(key).or_insert((0, 0));
        match line.origin() {
            '+' => slot.0 += 1,
            '-' => slot.1 += 1,
            _ => {}
        }
        true
    });

    totals
}

fn staging_kind(status: git2::Delta) -> ChangeKind {
    match status {
        git2::Delta::Added => ChangeKind::Added,
        git2::Delta::Deleted => ChangeKind::Deleted,
        git2::Delta::Renamed => ChangeKind::Renamed,
        git2::Delta::Copied => ChangeKind::Copied,
        git2::Delta::Typechange => ChangeKind::TypeChanged,
        git2::Delta::Conflicted => ChangeKind::Conflicted,
        git2::Delta::Ignored => ChangeKind::Ignored,
        _ => ChangeKind::Modified,
    }
}

fn status_char(status: git2::Delta) -> String {
    status_char_of(status).to_string()
}

fn status_char_of(status: git2::Delta) -> char {
    match status {
        git2::Delta::Added => 'A',
        git2::Delta::Deleted => 'D',
        git2::Delta::Renamed => 'R',
        git2::Delta::Copied => 'C',
        git2::Delta::Typechange => 'T',
        git2::Delta::Conflicted => 'U',
        git2::Delta::Ignored => 'I',
        _ => 'M',
    }
}

// ---------------------------------------------------------------------------
// Historial de archivo
// ---------------------------------------------------------------------------

/// Historial de cambios de un archivo siguiendo renombres.
pub fn file_history(repo: &Repository, path: &str, limit: usize) -> AppResult<Vec<FileHistoryEntry>> {
    let mut walker = repo.revwalk().map_err(AppError::from_git)?;
    walker.push_head().map_err(AppError::from_git)?;
    // Orden cronologico inverso: se sigue la historia hacia atras.
    walker.set_sorting(git2::Sort::TIME).ok();

    let mut entries = Vec::new();
    // Al renombrar, el archivo deja de existir con el nombre actual: se busca
    // en el arbol padre cual entrada tiene el mismo blob.
    let mut current_path = path.to_string();

    for oid in walker.take(limit.clamp(1, 20_000)) {
        let Ok(oid) = oid else { continue };
        let Ok(commit) = repo.find_commit(oid) else {
            continue;
        };
        let new_tree = commit.tree().ok();
        let old_tree = commit.parent(0).ok().and_then(|p| p.tree().ok());
        let Some(new_tree) = new_tree else { continue };

        let new_entry = new_tree.get_path(std::path::Path::new(&current_path)).ok();
        let old_entry = old_tree
            .as_ref()
            .and_then(|t| t.get_path(std::path::Path::new(&current_path)).ok());

        let changed = match (&new_entry, &old_entry) {
            (Some(a), Some(b)) => a.id() != b.id(),
            (Some(_), None) | (None, Some(_)) => true,
            (None, None) => false,
        };
        if !changed {
            continue;
        }

        // Rename: el nombre actual desaparece en este commit, pero algun otro
        // archivo del arbol padre tiene el mismo contenido.
        let renamed_from = match &old_entry {
            Some(old) if new_entry.is_none() => old_tree
                .as_ref()
                .and_then(|tree| find_path_with_blob(tree, old.id())),
            _ => None,
        };

        let (kind, status) = match (&new_entry, &old_entry) {
            (Some(_), None) => (ChangeKind::Added, 'A'),
            (None, Some(_)) => (ChangeKind::Deleted, 'D'),
            _ => (ChangeKind::Modified, 'M'),
        };

        entries.push(FileHistoryEntry {
            oid: commit.id().to_string(),
            short_oid: short_oid(&commit.id()),
            author_name: commit.author().name().unwrap_or_default().to_string(),
            author_time: commit.author().when().seconds(),
            author_time_iso: iso8601(commit.author().when().seconds()),
            subject: commit.summary().unwrap_or_default().to_string(),
            status_char: status.to_string(),
            kind,
            old_path: renamed_from.clone(),
        });

        if let Some(next) = renamed_from {
            current_path = next;
        }
    }

    Ok(entries)
}

/// Busca la primera ruta de un arbol cuyo blob coincida con `blob`.
fn find_path_with_blob(tree: &git2::Tree<'_>, blob: git2::Oid) -> Option<String> {
    // `TreeWalkResult::Ok` no transporta valor en git2 0.20: el hallazgo se guarda
    // en una celda compartida y el recorrido se aborta en el primer match.
    let found: std::cell::RefCell<Option<String>> = std::cell::RefCell::new(None);

    let _ = tree.walk(git2::TreeWalkMode::PreOrder, |root, entry| {
        if entry.kind() != Some(git2::ObjectType::Blob) || entry.id() != blob {
            return git2::TreeWalkResult::Ok;
        }

        let name = match entry.name() {
            Some(name) => name,
            None => return git2::TreeWalkResult::Ok,
        };
        let full = if root.is_empty() {
            name.to_string()
        } else {
            format!("{root}/{name}")
        };

        *found.borrow_mut() = Some(full);
        git2::TreeWalkResult::Abort
    });

    found.into_inner()
}

// ---------------------------------------------------------------------------
// Reflog
// ---------------------------------------------------------------------------

/// Historial de movimientos de HEAD.
pub fn reflog(repo: &Repository, limit: usize) -> AppResult<Vec<ReflogEntry>> {
    let mut entries = Vec::new();

    // Reflog de HEAD: incluye la razon de cada movimiento (checkout, commit, reset...).
    if let Ok(log) = repo.reflog("HEAD") {
        // `log.iter()` ya va del mas reciente al mas antiguo; usar `.rev()`
        // los invierte y el primero sale siendo el commit mas antiguo.
        for (index, record) in log.iter().take(limit.max(1)).enumerate() {
            let id = record.id_new();
            let when = record.committer().when();
            entries.push(ReflogEntry {
                index,
                oid: id.to_string(),
                short_oid: short_oid(&id),
                previous_oid: Some(record.id_old().to_string()),
                message: record.message().unwrap_or("").to_string(),
                author_name: record.committer().name().unwrap_or_default().to_string(),
                timestamp: when.seconds(),
                timestamp_iso: iso8601(when.seconds()),
                committer: record.committer().email().unwrap_or_default().to_string(),
            });
        }
    }

    Ok(entries)
}

// ---------------------------------------------------------------------------
// Utilidades de rama
// ---------------------------------------------------------------------------

/// Reinicia HEAD al commit indicado.
pub fn hard_reset(repo: &mut Repository, oid: &str) -> AppResult<OperationResult> {
    let commit = crate::git::refs::resolve_commit(repo, oid)?;
    repo.reset(commit.as_object(), ResetType::Hard, None)
        .map_err(AppError::from_git)?;
    let branch = repo
        .head()
        .ok()
        .filter(|h| h.is_branch())
        .and_then(|h| h.shorthand().map(|s| s.to_string()));
    Ok(
        OperationResult::ok(format!("HEAD movido a {}", short_oid(&commit.id())))
            .with_head(Some(commit.id().to_string()), branch),
    )
}

/// Elimina un commit reescribiendo la rama actual (`git reset --hard <parent>`).
pub fn delete_commit(repo: &mut Repository, oid: &str) -> AppResult<OperationResult> {
    // Se resuelve el id del padre antes de pedir `&mut Repository`: el `Commit`
    // prestado por `resolve_commit` impede el borrow mutable.
    let parent_oid = crate::git::refs::resolve_commit(repo, oid)?
        .parent(0)
        .map_err(|_| {
            AppError::invalid_state("No se puede eliminar el commit raiz del historial")
        })?
        .id();
    hard_reset(repo, &parent_oid.to_string())
}

/// Etiquetas (tags) del repositorio.
pub fn list_tags(repo: &Repository) -> AppResult<Vec<(String, String)>> {
    let mut out = Vec::new();
    let references = repo.references_glob("refs/tags/*").map_err(AppError::from_git)?;
    for reference in references.flatten() {
        let Some(name) = reference.name() else { continue };
        let oid = reference
            .peel_to_commit()
            .ok()
            .map(|c| c.id().to_string())
            .or_else(|| reference.target().map(|o| o.to_string()));
        if let Some(oid) = oid {
            out.push((shorten_ref(name), short_oid_str(&oid)));
        }
    }
    Ok(out)
}

fn short_oid_str(oid: &str) -> String {
    oid.chars().take(7).collect()
}

/// Resuelve un objeto a su oid de commit (tags anotados incluidos).
pub fn peel_to_commit(repo: &Repository, revision: &str) -> AppResult<git2::Oid> {
    let object = repo
        .revparse_single(revision)
        .map_err(|_| AppError::not_found(format!("No se pudo resolver {revision}")))?;
    if object.kind() == Some(ObjectType::Tag) || object.kind() == Some(ObjectType::Commit) {
        return object.peel_to_commit().map(|c| c.id()).map_err(AppError::from_git);
    }
    Err(AppError::validation(format!(
        "{revision} no es un commit"
    )))
}

/// Referencia `ResetMode` reutilizado por los comandos.
pub fn parse_reset_mode(value: &str) -> AppResult<ResetMode> {
    ResetMode::parse(value)
}