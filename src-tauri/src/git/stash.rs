//! Gestion de la pila de stashes.

use git2::Repository;

use crate::error::{AppError, AppResult};
use crate::git::util::{iso8601, short_oid};
use crate::types::{OperationResult, StashEntry};

/// Lista la pila de stashes (indice 0 = mas reciente).
pub fn list(repo: &Repository) -> AppResult<Vec<StashEntry>> {
    let Ok(log) = repo.reflog("refs/stash") else {
        return Ok(Vec::new());
    };

    let mut entries = Vec::new();
    // `reflog.iter()` va de mas antiguo a mas reciente: se invierte el orden.
    let records: Vec<_> = log.iter().collect();

    for (position, record) in records.iter().rev().enumerate() {
        let oid = record.id_new();
        let Ok(commit) = repo.find_commit(oid) else {
            continue;
        };

        let when = record.committer().when();
        let summary = commit.summary().unwrap_or_default().to_string();

        // El mensaje de git tiene la forma "WIP on <rama>: <sha> <asunto>"
        // o "On <rama>: <asunto>". Extraer la rama deja el resto como etiqueta.
        let branch = summary
            .strip_prefix("WIP on ")
            .or_else(|| summary.strip_prefix("On "))
            .and_then(|rest| rest.split(':').next())
            .unwrap_or("")
            .trim()
            .to_string();

        let display_message = match summary.split_once(": ") {
            Some((prefix, rest)) if prefix.starts_with("WIP on ") || prefix.starts_with("On ") => {
                rest.to_string()
            }
            _ => summary.clone(),
        };

        let (staged, unstaged, untracked) = stash_counts(repo, oid);

        entries.push(StashEntry {
            index: position,
            oid: oid.to_string(),
            message: display_message,
            branch,
            author_name: record.committer().name().unwrap_or_default().to_string(),
            author_time: when.seconds(),
            author_time_iso: iso8601(when.seconds()),
            staged_count: staged,
            unstaged_count: unstaged,
            untracked_count: untracked,
            is_top: position == 0,
        });
    }

    Ok(entries)
}

/// Cuenta archivos staged / unstaged / untracked dentro de un stash.
///
/// El commit de stash tiene tres padres: HEAD, el indice y (opcionalmente) los
/// untracked. Compararlos da exactamente esas tres cifras.
fn stash_counts(repo: &Repository, stash_oid: git2::Oid) -> (usize, usize, usize) {
    let Ok(commit) = repo.find_commit(stash_oid) else {
        return (0, 0, 0);
    };

    let head_tree = commit.parent(0).ok().and_then(|p| p.tree().ok());
    let index_tree = commit.parent(1).ok().and_then(|p| p.tree().ok());
    let _untracked_count = commit
        .parent_count()
        .checked_sub(2)
        .filter(|_| commit.parent_count() > 2)
        .map(|_count| {
            let untracked = commit.parent(2).ok().and_then(|p| p.tree().ok());
            count_entries(&untracked)
        })
        .unwrap_or(0);

    let mut opts = git2::DiffOptions::new();
    opts.include_untracked(false);

    let staged = match (&head_tree, &index_tree) {
        (Some(h), Some(i)) => repo
            .diff_tree_to_tree(Some(h), Some(i), Some(&mut opts))
            .map(|d| d.deltas().len())
            .unwrap_or(0),
        _ => 0,
    };

    let untracked = repo
        .statuses(Some(git2::StatusOptions::new().include_untracked(true)))
        .map(|list| list.iter().filter(|s| s.status().is_wt_new()).count())
        .unwrap_or(0);

    let unstaged = match (&index_tree, commit.tree().ok().as_ref()) {
        (Some(i), Some(w)) => repo
            .diff_tree_to_tree(Some(i), Some(w), Some(&mut opts))
            .map(|d| d.deltas().len())
            .unwrap_or(0),
        _ => 0,
    };

    (staged, unstaged, untracked)
}

fn count_entries(tree: &Option<git2::Tree<'_>>) -> usize {
    tree.as_ref().map(|t| t.len()).unwrap_or(0)
}

/// Guarda los cambios actuales en un stash.
///
/// `include_untracked` equivale a `git stash -u` y `keep_index` a `--keep-index`.
pub fn push(
    repo: &mut Repository,
    message: Option<&str>,
    include_untracked: bool,
    keep_index: bool,
    all: bool,
) -> AppResult<OperationResult> {
    let status = crate::git::staging::status(repo)?;
    let has_changes = !status.clean || status.untracked_count > 0;

    if !has_changes && !all {
        return Err(AppError::invalid_state(
            "No hay cambios locales que guardar en el stash",
        ));
    }

    let sig = crate::git::commit_ops::signature(repo)?;

    let flags = if all {
        git2::StashFlags::all()
    } else if keep_index {
        git2::StashFlags::KEEP_INDEX
    } else if include_untracked {
        git2::StashFlags::INCLUDE_UNTRACKED
    } else {
        git2::StashFlags::empty()
    };

    let message = message.unwrap_or("WIP on Foxen");
    let oid = repo
        .stash_save2(&sig, Some(message), Some(flags))
        .map_err(|e| AppError::from_git(e).with_detail("No se pudo crear el stash"))?;

    Ok(OperationResult::ok(format!(
        "Cambios guardados en stash {}",
        short_oid(&oid)
    ))
    .with_head(
        repo.head().ok().and_then(|h| h.target()).map(|o| o.to_string()),
        status.head_branch,
    )
    .with_refs(vec!["refs/stash".to_string()]))
}

/// Aplica un stash sin eliminarlo (`git stash apply`).
pub fn apply(repo: &mut Repository, index: usize, reinstate_index: bool) -> AppResult<OperationResult> {
    let oid = stash_oid(repo, index)?;

    let mut opts = git2::StashApplyOptions::new();
    if reinstate_index {
        opts.reinstantiate_index();
    }

    repo.stash_apply(index, Some(&mut opts)).map_err(|e| {
        AppError::from_git(e).with_detail(
            "El stash no aplica limpiamente; resuelve los conflictos manualmente",
        )
    })?;

    Ok(OperationResult::ok(format!(
        "Stash {} aplicado",
        short_oid(&oid)
    )))
}

/// Aplica un stash y lo elimina de la pila (`git stash pop`).
pub fn pop(repo: &mut Repository, index: usize) -> AppResult<OperationResult> {
    let oid = stash_oid(repo, index)?;

    repo.stash_pop(index, None).map_err(|e| {
        AppError::from_git(e).with_detail(
            "El stash no aplica limpiamente; el stash se conserva, resuelve los conflictos",
        )
    })?;

    Ok(
        OperationResult::ok(format!("Stash {} aplicado y eliminado", short_oid(&oid)))
            .with_refs(vec!["refs/stash".to_string()]),
    )
}

/// Crea una rama a partir de un stash y lo aplica (`git stash branch`).
pub fn branch_from(
    repo: &mut Repository,
    index: usize,
    branch_name: &str,
) -> AppResult<OperationResult> {
    crate::git::refs::validate_branch_name(repo, branch_name)?;

    let head_oid = repo
        .head()
        .map_err(AppError::from_git)?
        .peel_to_commit()
        .map_err(AppError::from_git)?
        .id();

    let branch = repo
        .branch(branch_name, &repo.find_commit(head_oid).map_err(AppError::from_git)?, false)
        .map_err(AppError::from_git)?;
    drop(branch);

    repo.set_head(&format!("refs/heads/{branch_name}"))
        .map_err(AppError::from_git)?;
    repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
        .map_err(AppError::from_git)?;

    repo.stash_apply(index, None).map_err(|e| {
        AppError::from_git(e)
            .with_detail(format!("Rama {branch_name} creada; revisa los conflictos"))
    })?;

    repo.stash_drop(index).map_err(AppError::from_git)?;

    Ok(OperationResult::ok(format!("Rama {branch_name} creada desde el stash"))
        .with_head(
            repo.head().ok().and_then(|h| h.target()).map(|o| o.to_string()),
            Some(branch_name.to_string()),
        )
        .with_refs(vec![format!("refs/heads/{branch_name}")]))
}

/// Elimina una entrada de la pila (`git stash drop`).
pub fn drop_entry(repo: &mut Repository, index: usize) -> AppResult<OperationResult> {
    let oid = stash_oid(repo, index)?;
    repo.stash_drop(index).map_err(AppError::from_git)?;
    Ok(
        OperationResult::ok(format!("Stash {} eliminado", short_oid(&oid)))
            .with_refs(vec!["refs/stash".to_string()]),
    )
}

/// Borra la pila de stashes completa.
pub fn clear(repo: &mut Repository) -> AppResult<OperationResult> {
    let entries = list(repo)?;
    for index in (0..entries.len()).rev() {
        repo.stash_drop(index).map_err(AppError::from_git)?;
    }
    Ok(OperationResult::ok(format!(
        "{} stash(es) eliminados",
        entries.len()
    ))
    .with_refs(vec!["refs/stash".to_string()]))
}

/// Renombra el mensaje del stash en su posicion.
pub fn rename(repo: &mut Repository, index: usize, message: &str) -> AppResult<OperationResult> {
    let entries = list(repo)?;
    if index >= entries.len() {
        return Err(AppError::validation(format!(
            "El stash {index} no existe (hay {})",
            entries.len()
        )));
    }
    // Reconstruir la entrada con el nuevo mensaje.
    let oid = crate::git::util::oid_from_str(&entries[index].oid)?;
    let commit = repo.find_commit(oid).map_err(AppError::from_git)?;
    let sig = crate::git::commit_ops::signature(repo)?;
    let tree = commit.tree().map_err(AppError::from_git)?;
    let parent_ids: Vec<git2::Oid> = commit.parent_ids().collect();
    let parent_commits: Vec<git2::Commit<'_>> = parent_ids
        .iter()
        .map(|oid| repo.find_commit(*oid).map_err(AppError::from_git))
        .collect::<AppResult<Vec<_>>>()?;
    let parents: Vec<&git2::Commit<'_>> = parent_commits.iter().collect();

    repo.commit(Some("refs/stash"), &sig, &sig, message, &tree, &parents)
        .map_err(AppError::from_git)?;

    Ok(OperationResult::ok("Stash renombrado".to_string()))
}

/// Resuelve el OID del stash en la posicion indicada.
fn stash_oid(repo: &Repository, index: usize) -> AppResult<git2::Oid> {
    let log = repo
        .reflog("refs/stash")
        .map_err(|_| AppError::not_found("No hay stashes guardados"))?;

    let total = log.len();
    if total == 0 {
        return Err(AppError::not_found("No hay stashes guardados"));
    }
    if index >= total {
        return Err(AppError::validation(format!(
            "El stash {index} no existe (hay {total})"
        )));
    }

    // Indice 0 = el mas reciente = ultimo registro del reflog.
    let position = total - 1 - index;
    log.get(position)
        .map(|e| e.id_new())
        .ok_or_else(|| AppError::not_found(format!("No se pudo leer el stash {index}")))
}
