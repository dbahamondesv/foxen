//! Operaciones sobre ramas: listado, creacion, checkout, renombrado y borrado.

use git2::{BranchType, Commit, ObjectType, Repository};

use crate::error::{AppError, AppResult};
use crate::git::util::{iso8601, short_oid, shorten_ref};
use crate::types::{BranchInfo, BranchList, OperationResult, RefKind};

/// Parametros de creacion de rama.
pub struct NewBranch<'a> {
    pub name: &'a str,
    pub start_point: Option<&'a str>,
    pub checkout: bool,
    pub force: bool,
    pub track: bool,
}

/// Lista ramas locales y remotas con su estado respecto al upstream.
pub fn list(repo: &Repository) -> AppResult<BranchList> {
    let head_name = repo
        .head()
        .ok()
        .filter(|h| h.is_branch())
        .and_then(|h| h.shorthand().map(|s| s.to_string()));

    let dirty = worktree_dirty(repo);

    let mut branches = Vec::new();

    for (branch_type, is_remote) in [(BranchType::Local, false), (BranchType::Remote, true)] {
        let iter = repo.branches(Some(branch_type))?;
        for (branch, _) in iter.flatten() {
            // `Branch::name` devuelve `Result<Option<&str>>` en git2 0.20.
            let Some(name) = branch.name().ok().flatten() else {
                continue;
            };
            let Some(oid) = branch.get().target() else {
                continue;
            };
            let Some(commit) = repo.find_commit(oid).ok() else {
                continue;
            };

            let upstream = branch
                .upstream()
                .ok()
                .and_then(|u| u.name().ok().flatten().map(|n| n.to_string()))
                .map(|n| shorten_ref(&n));

            let (ahead, behind) = match (&upstream, branch_type == BranchType::Local) {
                (Some(upstream_name), true) => {
                    let full = if upstream_name.starts_with("refs/") {
                        upstream_name.clone()
                    } else {
                        format!("refs/remotes/{upstream_name}")
                    };
                    match repo.revparse_single(&full).ok().and_then(|o| o.peel_to_commit().ok()) {
                        Some(up) => repo
                            .graph_ahead_behind(commit.id(), up.id())
                            .unwrap_or((0, 0)),
                        None => (0, 0),
                    }
                }
                _ => (0, 0),
            };

            let author = commit.author();
            branches.push(BranchInfo {
                name: name.to_string(),
                full_name: branch
                    .get()
                    .name()
                    .unwrap_or_default()
                    .to_string(),
                oid: oid.to_string(),
                short_oid: short_oid(&oid),
                subject: commit.summary().unwrap_or_default().to_string(),
                last_commit_message: commit.message().unwrap_or_default().to_string(),
                author_name: author.name().unwrap_or("Desconocido").to_string(),
                author_email: author.email().unwrap_or_default().to_string(),
                author_time: author.when().seconds(),
                is_head: head_name.as_deref() == Some(name),
                is_remote,
                upstream,
                ahead,
                behind,
                has_uncommitted_changes: dirty && head_name.as_deref() == Some(name),
            });
        }
    }

    // Ramas locales primero, luego remotas; alfabetico dentro de cada grupo.
    branches.sort_by(|a, b| {
        a.is_remote
            .cmp(&b.is_remote)
            .then_with(|| a.name.cmp(&b.name))
    });

    Ok(BranchList {
        branches,
        head: head_name,
    })
}

/// Resuelve un nombre de rama a su referencia completa, probando locales y remotas.
pub fn resolve_branch_ref(repo: &Repository, name: &str) -> AppResult<String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(AppError::validation("El nombre de la rama esta vacio"));
    }
    for candidate in [
        format!("refs/heads/{trimmed}"),
        format!("refs/remotes/{trimmed}"),
        format!("refs/tags/{trimmed}"),
    ] {
        if repo.find_reference(&candidate).is_ok() {
            return Ok(candidate);
        }
    }
    if repo.find_reference(trimmed).is_ok() {
        return Ok(trimmed.to_string());
    }
    Err(AppError::not_found(format!("No existe la rama {trimmed}")))
}

/// Resuelve un nombre de rama a un commit.
pub fn resolve_commit<'r>(repo: &'r Repository, revision: &str) -> AppResult<Commit<'r>> {
    let object = repo
        .revparse_single(revision)
        .or_else(|_| repo.revparse_single(&format!("refs/heads/{revision}")))
        .or_else(|_| repo.revparse_single(&format!("refs/remotes/{revision}")))
        .map_err(|_| AppError::not_found(format!("No se pudo resolver la revision {revision}")))?;

    if object.kind() == Some(ObjectType::Tag) {
        return object
            .peel_to_commit()
            .map_err(AppError::from_git);
    }
    object
        .peel_to_commit()
        .map_err(|_| AppError::validation(format!("{revision} no apunta a un commit")))
}

/// Crea una rama.
pub fn create(repo: &mut Repository, params: NewBranch<'_>) -> AppResult<OperationResult> {
    validate_branch_name(repo, params.name)?;

    let target_oid = match params.start_point {
        Some(point) => resolve_commit(repo, point)?.id(),
        None => repo
            .head()
            .map_err(|e| {
                AppError::from_git(e)
                    .with_detail("HEAD no apunta a ningun commit; indica un punto de partida")
            })?
            .peel_to_commit()
            .map_err(AppError::from_git)?
            .id(),
    };

    // `--force` equivale a reiniciar la rama si ya existe.
    if let Ok(mut existing) = repo.find_branch(params.name, BranchType::Local) {
        if !params.force {
            let current = existing.get().target();
            if current != Some(target_oid) {
                return Err(AppError::invalid_state(format!(
                    "La rama {} ya existe en otro commit. Usa la opcion de forzar.",
                    params.name
                )));
            }
        }
        // `set_target` es metodo de Reference, no de Branch.
        existing
            .get_mut()
            .set_target(target_oid, params.name)
            .map_err(AppError::from_git)?;
    } else {
        // El `Commit` se resuelve en un bloque propio: `checkout` despues pide
        // `&mut Repository` y el/prestamo lo impediria.
        let commit = repo.find_commit(target_oid).map_err(AppError::from_git)?;
        repo.branch(params.name, &commit, params.force)
            .map_err(|e| {
                AppError::from_git(e).with_detail(format!("No se pudo crear {}", params.name))
            })?;
    }

    if params.checkout {
        checkout(repo, params.name)?;
    }

    if params.track {
        // Tras el posible checkout, para no mezclar el borrow de `repo`.
        let upstream = format!("origin/{}", params.name);
        let tracked = repo.find_branch(params.name, BranchType::Local);
        if let Ok(mut new_branch) = tracked {
            let _ = new_branch.set_upstream(Some(&upstream));
        }
    }

    let short = short_oid(&target_oid);
    Ok(
        OperationResult::ok(format!("Rama {} creada en {short}", params.name))
            .with_head(Some(target_oid.to_string()), Some(params.name.to_string()))
            .with_refs(vec![format!("refs/heads/{}", params.name)]),
    )
}

/// Cambia HEAD a una rama o commit.
pub fn checkout(repo: &mut Repository, target: &str) -> AppResult<OperationResult> {
    // Bloquear si el working tree tiene cambios que se perderian.
    if !worktree_dirty(repo) {
        // Continua: checkout limpio.
    } else if !is_safe_checkout(repo, target) {
        return Err(AppError::invalid_state(
            "Tienes cambios sin commitear que se perderian al cambiar de rama",
        )
        .with_detail("Commitea, guarda con stash o usa 'force' para descartarlos"));
    }

    // 1. Si `target` es una referencia completa, se checkout a la rama.
    if let Ok(reference) = repo.find_reference(target) {
        if let Some(name) = reference.name().map(|n| n.to_string()) {
            if name.starts_with("refs/heads/") {
                let short = shorten_ref(&name);
                let head_oid = reference.peel_to_commit().ok().map(|c| c.id());
                repo.set_head(&name).map_err(AppError::from_git)?;
                repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
                    .map_err(AppError::from_git)?;
                return Ok(OperationResult::ok(format!("Cambiado a {short}")).with_head(
                    head_oid.map(|o| o.to_string()),
                    Some(short),
                ));
            }
        }
    }

    // 2. Nombre corto de rama: se expande a su referencia completa.
    for candidate in [format!("refs/heads/{target}"), format!("refs/remotes/{target}")] {
        if let Ok(reference) = repo.find_reference(&candidate) {
            let short = shorten_ref(candidate.strip_prefix("refs/remotes/").unwrap_or(&candidate));
            let head_oid = reference.peel_to_commit().ok().map(|c| c.id());
            repo.set_head(&candidate).map_err(AppError::from_git)?;
            repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
                .map_err(AppError::from_git)?;
            return Ok(
                OperationResult::ok(format!("Cambiado a {short}"))
                    .with_head(head_oid.map(|o| o.to_string()), Some(short)),
            );
        }
    }

    // 3. Commit suelto: checkout desligado (equivale a `git checkout <sha>`).
    let object = repo
        .revparse_single(target)
        .map_err(|_| AppError::not_found(format!("No se pudo resolver {target}")))?;
    let commit = object
        .peel_to_commit()
        .map_err(|_| AppError::validation(format!("{target} no es un commit")))?;

    let short = short_oid(&commit.id());
    repo.set_head_detached(commit.id())
        .map_err(AppError::from_git)?;
    repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
        .map_err(AppError::from_git)?;

    Ok(OperationResult::ok(format!("HEAD desligado en {short}")).with_head(
        Some(commit.id().to_string()),
        None,
    ))
}

/// Verifica si el checkout a `target` es seguro (no sobrescribe trabajo local).
fn is_safe_checkout(repo: &Repository, target: &str) -> bool {
    let Ok(target_tree) = repo
        .revparse_single(target)
        .and_then(|o| o.peel_to_tree())
    else {
        return false;
    };

    // Si el indice no difiere entre HEAD y el destino, el checkout es seguro.
    match repo.head().ok().and_then(|h| h.peel_to_tree().ok()) {
        Some(head_tree) => repo
            .diff_tree_to_tree(Some(&head_tree), Some(&target_tree), None)
            .map(|diff| diff.deltas().len() == 0)
            .unwrap_or(false),
        None => true,
    }
}

/// Elimina una rama local.
pub fn delete(repo: &mut Repository, name: &str, force: bool) -> AppResult<OperationResult> {
    let mut branch = repo
        .find_branch(name, BranchType::Local)
        .map_err(|_| AppError::not_found(format!("No existe la rama local {name}")))?;

    if branch.is_head() {
        return Err(AppError::invalid_state(format!(
            "No puedes eliminar {name} porque es la rama actual. Cambia de rama primero."
        )));
    }

    let full = branch.name().ok().flatten().unwrap_or_default().to_string();

    if !force && unmerged_commit_count(repo, &full)? > 0 {
        let commits = unmerged_commit_count(repo, &full)?;
        return Err(AppError::invalid_state(format!(
            "{name} tiene {commits} commit(s) sin integrar. Usa la opcion de forzar."
        )));
    }

    branch.delete().map_err(AppError::from_git)?;

    Ok(
        OperationResult::ok(format!("Rama {name} eliminada")).with_refs(vec![full]),
    )
}

fn unmerged_commit_count(repo: &Repository, full_name: &str) -> AppResult<usize> {
    let head = repo
        .head()
        .map_err(AppError::from_git)?
        .peel_to_commit()
        .map_err(AppError::from_git)?;

    let reference = repo
        .find_reference(full_name)
        .map_err(AppError::from_git)?;
    let branch_tip = reference
        .peel_to_commit()
        .map_err(AppError::from_git)?;

    let (ahead, _) = repo
        .graph_ahead_behind(branch_tip.id(), head.id())
        .unwrap_or((0, 0));
    Ok(ahead)
}

/// Renombra una rama local y su upstream.
pub fn rename(repo: &mut Repository, old: &str, new: &str) -> AppResult<OperationResult> {
    validate_branch_name(repo, new)?;

    let mut branch = repo
        .find_branch(old, BranchType::Local)
        .map_err(|_| AppError::not_found(format!("No existe la rama local {old}")))?;

    let old_full = branch
        .get()
        .name()
        .unwrap_or_default()
        .to_string();
    branch.rename(new, false).map_err(AppError::from_git)?;

    // Reapuntar el upstream si la rama remota existe. Se reutiliza el nombre
    // completo (`refs/remotes/origin/main`) sin recortar el remoto.
    if let Ok(mut renamed) = repo.find_branch(new, BranchType::Local) {
        if let Ok(upstream) = renamed.upstream() {
            if let Some(up_name) = upstream.name().ok().flatten() {
                let _ = renamed.set_upstream(Some(up_name));
            }
        }
    }

    Ok(OperationResult::ok(format!("Rama {old} renombrada a {new}")).with_refs(vec![
        old_full,
        format!("refs/heads/{new}"),
    ]))
}

/// Configura (o limpia) el upstream de una rama.
pub fn set_upstream(repo: &Repository, branch_name: &str, upstream: Option<&str>) -> AppResult<OperationResult> {
    let mut branch = repo
        .find_branch(branch_name, BranchType::Local)
        .map_err(|_| AppError::not_found(format!("No existe la rama local {branch_name}")))?;

    match upstream {
        Some(up) => {
            let full = if up.starts_with("refs/") {
                up.to_string()
            } else {
                format!("refs/remotes/{up}")
            };
            let upstream_branch = repo
                .find_branch(up, BranchType::Remote)
                .map_err(|_| AppError::not_found(format!("No existe la rama remota {up}")))?;
            let upstream_full = upstream_branch.get().name().unwrap_or_default().to_string();
            branch
                .set_upstream(Some(&upstream_full))
                .map_err(AppError::from_git)?;
            let _ = full;
            Ok(OperationResult::ok(format!(
                "{branch_name} ahora sigue a {up}"
            )))
        }
        None => {
            // `Branch` no expone `delete_upstream` en git2 0.20: hay que quitar la
            // configuracion del upstream directamente.
            let mut scope = repo.config().map_err(AppError::from_git)?;
            scope.remove(&format!("branch.{branch_name}.remote")).ok();
            scope.remove(&format!("branch.{branch_name}.merge")).ok();
            let _ = &mut branch;
            Ok(OperationResult::ok(format!(
                "Upstream eliminado de {branch_name}"
            )))
        }
    }
}

/// Reinicia una rama a un commit concreto (`git branch -f` / `git reset --hard`).
pub fn reset_to(
    repo: &mut Repository,
    branch_name: &str,
    target: &str,
    mode: ResetMode,
) -> AppResult<OperationResult> {
    let target_commit = resolve_commit(repo, target)?;
    let is_head = repo
        .head()
        .ok()
        .and_then(|h| h.shorthand().map(|s| s.to_string()))
        .as_deref()
        == Some(branch_name);

    if !is_head {
        let mut branch = repo
            .find_branch(branch_name, BranchType::Local)
            .map_err(|_| AppError::not_found(format!("No existe la rama local {branch_name}")))?;
        branch
            .get_mut()
            .set_target(target_commit.id(), &format!("reinicio a {}", short_oid(&target_commit.id())))
            .map_err(AppError::from_git)?;
        return Ok(OperationResult::ok(format!(
            "{branch_name} reiniciada a {}",
            short_oid(&target_commit.id())
        ))
        .with_refs(vec![format!("refs/heads/{branch_name}")]));
    }

    match mode {
        ResetMode::Hard => {
            repo.reset(target_commit.as_object(), git2::ResetType::Hard, None)
                .map_err(AppError::from_git)?;
        }
        ResetMode::Mixed => {
            repo.reset(target_commit.as_object(), git2::ResetType::Mixed, None)
                .map_err(AppError::from_git)?;
        }
        ResetMode::Soft => {
            repo.reset(target_commit.as_object(), git2::ResetType::Soft, None)
                .map_err(AppError::from_git)?;
        }
        ResetMode::Keep => {
            // git2 0.20 no expone `ResetType::Keep`; `--keep` equivale a un reset
            // mixed que aborta si el working tree difiere del origen.
            let dirty = worktree_dirty(repo);
            if dirty {
                return Err(AppError::invalid_state(
                    "El working tree tiene cambios: --keep abortaria para no perderlos",
                )
                .with_detail("Commitea o guarda los cambios antes de usar el modo keep"));
            }
            repo.reset(target_commit.as_object(), git2::ResetType::Mixed, None)
                .map_err(AppError::from_git)?;
        }
    }

    Ok(OperationResult::ok(format!(
        "HEAD movido a {}",
        short_oid(&target_commit.id())
    ))
    .with_head(
        Some(target_commit.id().to_string()),
        Some(branch_name.to_string()),
    ))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResetMode {
    Soft,
    Mixed,
    Hard,
    Keep,
}

impl ResetMode {
    pub fn parse(value: &str) -> AppResult<Self> {
        match value.to_ascii_lowercase().as_str() {
            "soft" => Ok(ResetMode::Soft),
            "mixed" | "default" => Ok(ResetMode::Mixed),
            "hard" => Ok(ResetMode::Hard),
            "keep" => Ok(ResetMode::Keep),
            other => Err(AppError::validation(format!("Modo de reset desconocido: {other}"))),
        }
    }
}

/// Valida un nombre de rama contra las reglas de git.
pub fn validate_branch_name(repo: &Repository, name: &str) -> AppResult<()> {
    if name.trim().is_empty() {
        return Err(AppError::validation("El nombre de la rama esta vacio"));
    }
    if name.starts_with('-') {
        return Err(AppError::validation(
            "El nombre de la rama no puede empezar con '-'",
        ));
    }
    // `Reference::is_valid_name` valida el nombre COMPLETO de la referencia,
    // por eso se pasa `refs/heads/{name}` y no el nombre pelado.
    if !git2::Reference::is_valid_name(&format!("refs/heads/{name}")) {
        return Err(AppError::validation(format!(
            "Nombre de rama invalido: {name}"
        )));
    }

    if name.contains(' ') {
        return Err(AppError::validation(
            "El nombre de la rama no puede contener espacios",
        ));
    }

    // Evitar colisiones con el prefijo de otro namespace de refs.
    for prefix in ["refs/", "heads/"] {
        if name.starts_with(prefix) {
            return Err(AppError::validation(format!(
                "El nombre {name} no puede empezar con {prefix}"
            )));
        }
    }

    if git2::Repository::open_bare(repo.path()).is_ok() && name == "HEAD" {
        return Err(AppError::validation("HEAD no es un nombre de rama valido"));
    }

    Ok(())
}

/// Devuelve las etiquetas de tipo de referencia (para la UI de filtros).
pub fn ref_kinds() -> Vec<RefKind> {
    vec![
        RefKind::Branch,
        RefKind::RemoteBranch,
        RefKind::Tag,
        RefKind::Other,
    ]
}

/// `true` si el working tree tiene cambios sin commitear.
pub fn worktree_dirty(repo: &Repository) -> bool {
    let mut flags = git2::StatusOptions::new();
    flags
        .include_untracked(false)
        .include_ignored(false)
        .recurse_untracked_dirs(false);
    repo.statuses(Some(&mut flags))
        .map(|list| !list.is_empty())
        .unwrap_or(false)
}

/// Resumen textual del estado, util para logs.
pub fn describe_head(repo: &Repository) -> String {
    match repo.head() {
        Ok(head) => {
            let branch = head.shorthand().unwrap_or("HEAD").to_string();
            let oid = head.target().map(|o| short_oid(&o)).unwrap_or_default();
            let when = match head.peel_to_commit() {
                Ok(commit) => iso8601(commit.author().when().seconds()),
                Err(_) => String::new(),
            };
            format!("{branch} @ {oid} ({when})")
        }
        Err(_) => "sin commits (HEAD unborn)".to_string(),
    }
}