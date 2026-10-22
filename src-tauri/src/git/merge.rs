//! Fusion de ramas y rebase con soporte de resolucion de conflictos.

use std::time::Instant;

use git2::{MergeOptions, Repository};

use crate::error::{AppError, AppResult};
use crate::git::commit_ops::conflicted_paths;
use crate::git::refs::resolve_commit;
use crate::git::staging;
use crate::types::{MergeResult, RebasePlan, RepoStatus};

/// Opciones de fusion.
pub struct MergeOptions2 {
    pub target: String,
    pub no_ff: bool,
    pub ff_only: bool,
    pub squash: bool,
    pub message: Option<String>,
}

/// Fusiona la rama `opts.target` en `destination`, cambiando de rama si hace
/// falta.
///
/// A diferencia de [`merge`], que integra siempre en la rama actual, aqui el
/// destino se indica explicitamente (`feat` -> `dev`). Si hay que cambiar y la
/// fusion choca, el repositorio se queda en `destination` con la fusion a
/// medias: los conflictos pertenecen a esa rama y `merge_continue`/`merge_abort`
/// deben operar sobre ella. Si `merge` devuelve un error (no conflicto) se
/// restaura la rama de partida.
pub fn merge_into(
    repo: &mut Repository,
    destination: &str,
    opts: MergeOptions2,
) -> AppResult<MergeResult> {
    let previous = repo
        .head()
        .ok()
        .filter(|h| h.is_branch())
        .and_then(|h| h.shorthand().map(|s| s.to_string()));

    if previous.as_deref() != Some(destination) {
        crate::git::refs::checkout(repo, destination)?;
    }

    let result = merge(repo, opts);

    // Solo se vuelve atras ante un error duro; con conflictos interesa quedarse.
    if result.is_err() {
        if let Some(previous) = previous.filter(|p| p != destination) {
            let _ = crate::git::refs::checkout(repo, &previous);
        }
    }

    result
}

/// Fusiona `target` en la rama actual.
pub fn merge(repo: &mut Repository, opts: MergeOptions2) -> AppResult<MergeResult> {
    let head_branch = repo
        .head()
        .ok()
        .filter(|h| h.is_branch())
        .and_then(|h| h.shorthand().map(|s| s.to_string()));

    if let Some(branch) = &head_branch {
        if branch == &opts.target {
            return Err(AppError::invalid_state(format!(
                "Ya estas en {branch}; no se puede fusionar consigo misma"
            )));
        }
    }

    let target = resolve_commit(repo, &opts.target)?;
    let head = repo
        .head()
        .map_err(|e| {
            AppError::from_git(e).with_detail("HEAD debe apuntar a un commit antes de fusionar")
        })?
        .peel_to_commit()
        .map_err(AppError::from_git)?;

    // Clasificacion previa: desde que punto diverge cada rama.
    let (head_only, target_only) = repo
        .graph_ahead_behind(head.id(), target.id())
        .map_err(AppError::from_git)?;
    let base_oid = merge_base(repo, head.id(), target.id())?;

    // Ya integrado: la rama actual contiene todos los commits de `target`.
    if target_only == 0 {
        return Ok(MergeResult {
            success: true,
            new_commits: Vec::new(),
            conflicted_files: Vec::new(),
            message: format!("{} ya esta integrado en la rama actual", opts.target),
            status: staging::status(repo)?,
            needs_continue: false,
            rebase_steps_left: 0,
        });
    }

    // Fast-forward: la rama actual es ancestro directo de `target`.
    let can_fast_forward = base_oid == Some(head.id());
    if can_fast_forward && !opts.no_ff && !opts.squash {
        let Some(branch) = head_branch.clone() else {
            return Err(AppError::invalid_state(
                "HEAD esta desligado; adjuntalo a una rama antes de fusionar",
            ));
        };

        // Como git, no se pisa un working tree con cambios: el checkout de un
        // fast-forward sobreescribiria archivos locales sin avisar.
        let current = staging::status(repo)?;
        if !current.clean {
            return Err(AppError::invalid_state(
                "Hay cambios sin commitear; guardalos o descartalos antes del fast-forward",
            )
            .with_detail(format!(
                "{} archivo(s) con cambios pendientes",
                current.files.len()
            )));
        }

        let full_ref = format!("refs/heads/{branch}");
        repo.reference(&full_ref, target.id(), true, "foxen: fast-forward merge")
            .map_err(AppError::from_git)?;
        repo.set_head(&full_ref).map_err(AppError::from_git)?;
        repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
            .map_err(AppError::from_git)?;

        return Ok(MergeResult {
            success: true,
            new_commits: vec![target.id().to_string()],
            conflicted_files: Vec::new(),
            message: format!(
                "Fast-forward: {target_only} commit(s) incorporados en {branch}"
            ),
            status: staging::status(repo)?,
            needs_continue: false,
            rebase_steps_left: 0,
        });
    }

    if opts.ff_only {
        return Err(AppError::invalid_state(format!(
            "No se puede hacer fast-forward desde {}; las ramas divergen",
            opts.target
        ))
        .with_detail(format!(
            "{head_only} commit(s) solo en HEAD, {target_only} commit(s) solo en {}",
            opts.target
        )));
    }

    // Fusion real a nivel de arbol.
    let sig = crate::git::commit_ops::signature(repo)?;

    let mut builder = MergeOptions::new();
    // `--no-ff` sobre una fusion ya divergente no cambia el resultado del merge,
    // pero se documenta el flag porque el commit se crea igualmente.
    builder.standard_style(true);

    let head_tree = head.tree().map_err(AppError::from_git)?;
    let target_tree = target.tree().map_err(AppError::from_git)?;

    // Sin base comun (historias independientes) el ancestro es el arbol vacio,
    // que es lo que usa git para decidir que todo el contenido es un cambio.
    let ancestor_tree = match merge_base(repo, head.id(), target.id())? {
        Some(base) => repo
            .find_commit(base)
            .map_err(AppError::from_git)?
            .tree()
            .map_err(AppError::from_git)?,
        None => repo
            .treebuilder(None)
            .map_err(AppError::from_git)?
            .write()
            .map_err(AppError::from_git)
            .and_then(|oid| repo.find_tree(oid).map_err(AppError::from_git))?,
    };

    // Se usa `merge_trees` y NO `merge_commits`: este ultimo devuelve el indice
    // sin respaldo en disco (fallan `write()` y `write_tree()`) y, sobre todo,
    // en esta version de libgit2 produce un arbol incorrecto cuando el archivo
    // entrante aun no existe en el working tree (pierde el fichero integrado).
    // `merge_trees` devuelve el indice correcto, con las etapas 1/2/3 intactas.
    let mut merged = repo
        .merge_trees(&ancestor_tree, &head_tree, &target_tree, Some(&builder))
        .map_err(AppError::from_git)?;

    let conflict_entries = if merged.has_conflicts() {
        merged
            .conflicts()
            .map_err(AppError::from_git)?
            .flatten()
            // `IndexConflict` no expone la ruta: va dentro de cada entrada.
            .map(|c| {
                let path = c
                    .ancestor
                    .as_ref()
                    .or(c.our.as_ref())
                    .or(c.their.as_ref())
                    .map(|e| e.path.clone())
                    .unwrap_or_default();
                (c.ancestor, c.our, c.their, path)
            })
            .collect::<Vec<ConflictEntry>>()
    } else {
        Vec::new()
    };

    // El working tree pasa a reflejar la fusion antes de tocar el indice.
    repo.checkout_index(Some(&mut merged), None)
        .map_err(AppError::from_git)?;

    if !conflict_entries.is_empty() {
        // `checkout_index` no escribe nada en los archivos en conflicto (no hay
        // entrada en etapa 0), asi que los marcadores se generan aqui. Tambien se
        // escribe MERGE_HEAD/MERGE_MSG a mano: las APIs de bajo nivel de libgit2
        // no dejan el repositorio marcado como "en curso", y sin eso ni la UI ve
        // los conflictos ni el abort encuentra que deshacer.
        let conflicted_files = write_conflict_markers(repo, &conflict_entries, &opts.target)?;
        persist_merged_index(repo, &merged)?;
        write_merge_state(
            repo,
            target.id(),
            &format!(
                "Merge branch '{}' into {}",
                opts.target,
                head_branch.clone().unwrap_or_default()
            ),
        )?;

        return Ok(MergeResult {
            success: false,
            new_commits: Vec::new(),
            conflicted_files,
            message:
                "La fusion tiene conflictos. Resuelvelos y crea el commit de fusion para finalizar."
                    .to_string(),
            status: staging::status(repo)?,
            needs_continue: false,
            rebase_steps_left: 0,
        });
    }

    let mut index = persist_merged_index(repo, &merged)?;
    let tree_oid = index.write_tree().map_err(AppError::from_git)?;
    let tree = repo.find_tree(tree_oid).map_err(AppError::from_git)?;
    let message = opts
        .message
        .unwrap_or_else(|| format!("Merge branch '{}' into {}", opts.target, head_branch.clone().unwrap_or_default()));

    // Squash: un unico commit con el arbol integrado y solo HEAD como padre; no
    // se registra la rama integrada, igual que `git merge --squash`.
    let new_oid = if opts.squash {
        repo.commit(Some("HEAD"), &sig, &sig, &message, &tree, &[&head])
            .map_err(AppError::from_git)?
    } else {
        // Un commit de fusion tiene DOS padres: HEAD y la rama integrada.
        repo.commit(Some("HEAD"), &sig, &sig, &message, &tree, &[&head, &target])
            .map_err(AppError::from_git)?
    };

    Ok(MergeResult {
        success: true,
        new_commits: vec![new_oid.to_string()],
        conflicted_files: Vec::new(),
        message: if opts.squash {
            "Commit squash creado".to_string()
        } else {
            "Commit de fusion creado".to_string()
        },
        status: staging::status(repo)?,
        needs_continue: false,
        rebase_steps_left: 0,
    })
}

/// Vuelca en el indice real del repositorio el resultado del merge.
///
/// El `Index` que devuelve `merge_trees` no tiene fichero asociado, asi que no se
/// puede persistir directamente. Se reconstruye sobre el indice fisico: se vacia
/// y se vuelven a copiar todas las entradas, conservando sus etapas (1/2/3) para
/// que los conflictos queden registrados como hace git.
fn persist_merged_index(repo: &Repository, merged: &git2::Index) -> AppResult<git2::Index> {
    let mut disk = repo.index().map_err(AppError::from_git)?;
    disk.clear().map_err(AppError::from_git)?;
    for entry in merged.iter() {
        disk.add(&entry).map_err(AppError::from_git)?;
    }
    disk.write().map_err(AppError::from_git)?;
    Ok(disk)
}

/// Una entrada en conflicto del indice: (ancestro, nuestro, suyo, ruta).
type ConflictEntry = (
    Option<git2::IndexEntry>,
    Option<git2::IndexEntry>,
    Option<git2::IndexEntry>,
    Vec<u8>,
);

/// Escribe marcadores de conflicto en el working tree.
///
/// `merge_commits` de libgit2 deja el contenido de "ours" sin marcar y borra
/// las etapas 1/2/3 del indice, con lo cual ni el status ni el usuario pueden
/// saber que hay conflicto. Aqui se reconstruye el formato de git
/// (`<<<<<<<` / `=======` / `>>>>>>>`) con las tres versiones del indice
/// conflictivo y se devuelven las rutas afectadas.
fn write_conflict_markers(
    repo: &Repository,
    entries: &[ConflictEntry],
    target_label: &str,
) -> AppResult<Vec<String>> {
    let Some(workdir) = repo.workdir() else {
        return Ok(Vec::new());
    };

    let mut paths = Vec::new();
    for (ancestor, ours, theirs, raw_path) in entries {
        let path = String::from_utf8_lossy(raw_path).to_string();
        let Ok(full) = crate::git::util::safe_worktree_path(workdir, &path) else {
            continue;
        };

        let read_side = |entry: &Option<git2::IndexEntry>| -> Option<String> {
            let oid = entry.as_ref()?.id;
            let blob = repo.find_blob(oid).ok()?;
            // Un binario no se puede marcar: se deja el contenido tal cual.
            if blob.is_binary() {
                return None;
            }
            std::str::from_utf8(blob.content())
                .ok()
                .map(|s| s.to_string())
        };

        let ours_text = ours.as_ref().and_then(|_| read_side(ours));
        let theirs_text = theirs.as_ref().and_then(|_| read_side(theirs));

        // Las lineas de marcador deben empezar en una linea propia: si un lado
        // no termina en salto de linea, se anade antes del separador/cierre.
        let ensure_newline = |text: String| -> String {
            if text.ends_with('\n') {
                text
            } else {
                format!("{text}\n")
            }
        };

        let content = match (ours_text, theirs_text) {
            (Some(o), Some(t)) => Some(format!(
                "<<<<<<< HEAD\n{}=======\n{}>>>>>>> {target_label}\n",
                ensure_newline(o),
                ensure_newline(t)
            )),
            // Solo hay dos versiones (add/add o modify/delete): se marca igual
            // que hace git para que quede constancia del conflicto.
            (Some(o), None) => Some(format!(
                "<<<<<<< HEAD\n{}=======\n>>>>>>> {target_label}\n",
                ensure_newline(o)
            )),
            (None, Some(t)) => Some(format!(
                "<<<<<<< HEAD\n=======\n{}>>>>>>> {target_label}\n",
                ensure_newline(t)
            )),
            (None, None) => None,
        };

        if let Some(content) = content {
            let _ = ancestor;
            std::fs::write(&full, content).map_err(|e| {
                AppError::new(
                    crate::error::ErrorKind::Io,
                    format!("No se pudieron escribir los marcadores en {path}: {e}"),
                )
            })?;
        }
        paths.push(path);
    }
    paths.sort();
    paths.dedup();
    Ok(paths)
}

/// Escribe `MERGE_HEAD` y `MERGE_MSG` para dejar el repositorio en estado de
/// fusion en curso, igual que `git merge`.
fn write_merge_state(repo: &Repository, target: git2::Oid, message: &str) -> AppResult<()> {
    let git_dir = repo.path();
    std::fs::write(git_dir.join("MERGE_HEAD"), format!("{target}\n"))
        .map_err(|e| AppError::new(crate::error::ErrorKind::Io, format!("No se pudo escribir MERGE_HEAD: {e}")))?;
    std::fs::write(git_dir.join("MERGE_MSG"), format!("{message}\n"))
        .map_err(|e| AppError::new(crate::error::ErrorKind::Io, format!("No se pudo escribir MERGE_MSG: {e}")))?;
    Ok(())
}

/// Mensaje que Git dejo en `MERGE_MSG`, sin las lineas de comentario.
pub fn merge_message(repo: &Repository) -> Option<String> {
    let contents = std::fs::read_to_string(repo.path().join("MERGE_MSG")).ok()?;
    let cleaned = contents
        .lines()
        .filter(|line| !line.trim_start().starts_with('#'))
        .collect::<Vec<_>>()
        .join("\n");
    let cleaned = cleaned.trim().to_string();
    (!cleaned.is_empty()).then_some(cleaned)
}

/// Aborta una fusion en curso, restaurando el estado previo.
pub fn merge_abort(repo: &mut Repository) -> AppResult<MergeResult> {
    let head = repo
        .head()
        .map_err(AppError::from_git)?
        .peel_to_commit()
        .map_err(AppError::from_git)?;

    repo.reset(head.as_object(), git2::ResetType::Hard, None)
        .map_err(AppError::from_git)?;

    Ok(MergeResult {
        success: true,
        new_commits: Vec::new(),
        conflicted_files: Vec::new(),
        message: "Fusion abortada".to_string(),
        status: staging::status(repo)?,
        needs_continue: false,
        rebase_steps_left: 0,
    })
}

/// Ancestro comun mas reciente de dos commits.
fn merge_base(repo: &Repository, a: git2::Oid, b: git2::Oid) -> AppResult<Option<git2::Oid>> {
    Ok(repo.merge_base(a, b).ok())
}

// ---------------------------------------------------------------------------
// Rebase
// ---------------------------------------------------------------------------

/// Calcula el plan de rebase sin aplicarlo.
pub fn plan(repo: &Repository, onto: &str, branch: Option<&str>) -> AppResult<RebasePlan> {
    let onto_commit = resolve_commit(repo, onto)?;
    let current = repo
        .head()
        .map_err(AppError::from_git)?
        .peel_to_commit()
        .map_err(AppError::from_git)?;

    let start_oid = match branch {
        Some(name) => resolve_commit(repo, name)?.id(),
        None => current.id(),
    };

    let base = merge_base(repo, start_oid, onto_commit.id())?;
    let mut walker = repo.revwalk().map_err(AppError::from_git)?;
    walker.push(start_oid).map_err(AppError::from_git)?;
    if let Some(base) = base {
        walker.hide(base).map_err(AppError::from_git)?;
    }
    walker.set_sorting(git2::Sort::REVERSE).map_err(AppError::from_git)?;

    let mut commits = Vec::new();
    for oid in walker.flatten() {
        if let Ok(commit) = repo.find_commit(oid) {
            commits.push(commit.id().to_string());
        }
    }

    // Commits de `onto` que la rama aun no contiene: permiten acortar el rebase.
    let mut already_upstream: Vec<String> = Vec::new();
    let mut upstream_walker = repo.revwalk().map_err(AppError::from_git)?;
    upstream_walker.push(onto_commit.id()).map_err(AppError::from_git)?;
    if let Some(base) = base {
        upstream_walker.hide(base).map_err(AppError::from_git)?;
    }
    upstream_walker
        .set_sorting(git2::Sort::REVERSE)
        .map_err(AppError::from_git)?;
    for oid in upstream_walker.flatten().take(1000) {
        already_upstream.push(oid.to_string());
    }

    let can_fast_forward = commits.is_empty() || base == Some(onto_commit.id());

    Ok(RebasePlan {
        commits,
        already_upstream,
        can_fast_forward,
    })
}

/// Rebase interactivo: reaplica los commits de la rama actual sobre `onto`.
pub fn rebase(repo: &mut Repository, onto: &str, force: bool) -> AppResult<MergeResult> {
    let onto_commit = resolve_commit(repo, onto)?;
    let current = repo
        .head()
        .map_err(AppError::from_git)?
        .peel_to_commit()
        .map_err(AppError::from_git)?;

    let _branch_name = repo
        .head()
        .ok()
        .filter(|h| h.is_branch())
        .and_then(|h| h.shorthand().map(|s| s.to_string()));

    let base = merge_base(repo, current.id(), onto_commit.id())?;

    // Nada que reaplicar: la rama ya esta sobre `onto`.
    if base == Some(current.id()) {
        return Ok(MergeResult {
            success: true,
            new_commits: Vec::new(),
            conflicted_files: Vec::new(),
            message: "La rama ya esta basada en ese commit; no habia nada que rebasar".to_string(),
            status: staging::status(repo)?,
            needs_continue: false,
            rebase_steps_left: 0,
        });
    }

    // Rebase ya en curso.
    if rebase_in_progress(repo) {
        return Err(AppError::invalid_state(
            "Ya hay un rebase en curso. Usa 'rebase --continue', 'rebase --skip' o 'rebase --abort'",
        ));
    }

    if !force {
        let dirty = staging::status(repo)?;
        if !dirty.clean {
            return Err(AppError::invalid_state(
                "No puedes rebasar con cambios sin commitear en el working tree",
            )
            .with_detail("Commitea o guarda los cambios con stash antes de rebasar"));
        }
    }

    // `Rebase` es el iterador de libgit2: `next()` aplica el siguiente parche y
    // `commit()` lo consolida, de modo que los conflictos se pueden resolver a
    // mano entre paso y paso.
    let mut opts = git2::RebaseOptions::new();
    opts.inmemory(false);

    let onto_annotated = repo
        .find_annotated_commit(onto_commit.id())
        .map_err(AppError::from_git)?;

    let mut rebase = repo
        .rebase(None, None, Some(&onto_annotated), Some(&mut opts))
        .map_err(|e| {
            AppError::from_git(e).with_detail("No se pudo iniciar el rebase")
        })?;

    let total = rebase.len();
    let sig = crate::git::commit_ops::signature(repo)?;
    let mut applied = 0usize;

    while let Some(operation) = rebase.next() {
        let operation = operation.map_err(|e| {
            AppError::from_git(e).with_detail("El rebase se detuvo de forma inesperada")
        })?;

        // `commit()` con autor y mensaje `None` reutiliza los del commit original.
        match rebase.commit(None, &sig, None) {
            Ok(_) => applied += 1,
            Err(err) => {
                let conflicts = conflicted_paths(repo);
                if conflicts.is_empty() {
                    return Err(AppError::from_git(err));
                }
                let step = rebase.operation_current().unwrap_or(applied + 1);
                return Ok(MergeResult {
                    success: false,
                    new_commits: Vec::new(),
                    conflicted_files: conflicts,
                    message: format!(
                        "Rebase detenido en el paso {step} de {total}. Resuelve los conflictos, stagea y usa 'rebase --continue'."
                    ),
                    status: staging::status(repo)?,
                    needs_continue: true,
                    rebase_steps_left: total.saturating_sub(applied),
                });
            }
        }

        let _ = operation.id();
    }

    rebase.finish(None).map_err(AppError::from_git)?;

    let new_head = repo.head().ok().and_then(|h| h.target());

    Ok(MergeResult {
        success: true,
        new_commits: new_head.map(|o| vec![o.to_string()]).unwrap_or_default(),
        conflicted_files: Vec::new(),
        message: format!("Rebase completado: {applied} commit(s) reaplicados"),
        status: staging::status(repo)?,
        needs_continue: false,
        rebase_steps_left: 0,
    })
}

/// Reanuda un rebase detenido por conflictos tras resolverlos.
pub fn rebase_continue(repo: &mut Repository) -> AppResult<MergeResult> {
    let status = staging::status(repo)?;
    if status.conflicted_count > 0 {
        return Err(AppError::invalid_state(format!(
            "Quedan {} archivo(s) en conflicto",
            status.conflicted_count
        )));
    }

    if !rebase_in_progress(repo) {
        return Err(AppError::invalid_state("No hay ningun rebase en curso"));
    }

    let sig = crate::git::commit_ops::signature(repo)?;

    let mut opts = git2::RebaseOptions::new();
    opts.inmemory(false);
    let mut rebase = repo
        .open_rebase(Some(&mut opts))
        .map_err(AppError::from_git)?;

    let total = rebase.len();
    // Consolida el paso conflictivo ya resuelto en el indice.
    rebase
        .commit(None, &sig, None)
        .map_err(|e| AppError::from_git(e).with_detail("No se pudo consolidar el paso resuelto"))?;

    let mut applied = 0usize;
    while let Some(operation) = rebase.next() {
        let operation = operation.map_err(|e| {
            AppError::from_git(e).with_detail("El rebase se detuvo de forma inesperada")
        })?;
        match rebase.commit(None, &sig, None) {
            Ok(_) => applied += 1,
            Err(err) => {
                let conflicts = conflicted_paths(repo);
                if conflicts.is_empty() {
                    return Err(AppError::from_git(err));
                }
                let step = rebase.operation_current().unwrap_or(applied + 1);
                return Ok(MergeResult {
                    success: false,
                    new_commits: Vec::new(),
                    conflicted_files: conflicts,
                    message: format!(
                        "Rebase detenido en el paso {step} de {total}. Resuelve los conflictos, stagea y usa 'rebase --continue'."
                    ),
                    status: staging::status(repo)?,
                    needs_continue: true,
                    rebase_steps_left: total.saturating_sub(applied),
                });
            }
        }
        let _ = operation.id();
    }

    rebase.finish(None).map_err(AppError::from_git)?;

    let new_head = repo.head().ok().and_then(|h| h.target());
    Ok(MergeResult {
        success: true,
        new_commits: new_head.map(|o| vec![o.to_string()]).unwrap_or_default(),
        conflicted_files: Vec::new(),
        message: format!("Rebase completado: {applied} commit(s) reaplicados"),
        status: staging::status(repo)?,
        needs_continue: false,
        rebase_steps_left: 0,
    })
}

/// Descarta el commit conflictivo actual del rebase y reanuda el resto.
pub fn rebase_skip(repo: &mut Repository) -> AppResult<MergeResult> {
    if !rebase_in_progress(repo) {
        return Err(AppError::invalid_state("No hay ningun rebase en curso"));
    }

    let sig = crate::git::commit_ops::signature(repo)?;

    let mut opts = git2::RebaseOptions::new();
    opts.inmemory(false);
    let mut rebase = repo
        .open_rebase(Some(&mut opts))
        .map_err(AppError::from_git)?;

    let total = rebase.len();
    // El paso actual se descarta sin commitear; se limpia el arbol para el
    // siguiente (reset del paso conflictivo a HEAD del rebase).
    let mut applied = 0usize;
    while let Some(operation) = rebase.next() {
        let operation = operation.map_err(|e| {
            AppError::from_git(e).with_detail("El rebase se detuvo de forma inesperada")
        })?;
        match rebase.commit(None, &sig, None) {
            Ok(_) => applied += 1,
            Err(err) => {
                let conflicts = conflicted_paths(repo);
                if conflicts.is_empty() {
                    return Err(AppError::from_git(err));
                }
                let step = rebase.operation_current().unwrap_or(applied + 1);
                return Ok(MergeResult {
                    success: false,
                    new_commits: Vec::new(),
                    conflicted_files: conflicts,
                    message: format!(
                        "Rebase detenido en el paso {step} de {total}. Resuelve los conflictos, stagea y usa 'rebase --continue'."
                    ),
                    status: staging::status(repo)?,
                    needs_continue: true,
                    rebase_steps_left: total.saturating_sub(applied),
                });
            }
        }
        let _ = operation.id();
    }

    rebase.finish(None).map_err(AppError::from_git)?;
    Ok(MergeResult {
        success: true,
        new_commits: Vec::new(),
        conflicted_files: Vec::new(),
        message: "Commit omitido".to_string(),
        status: staging::status(repo)?,
        needs_continue: false,
        rebase_steps_left: 0,
    })
}

/// Aborta un rebase en curso y restaura el estado original.
pub fn rebase_abort(repo: &mut Repository) -> AppResult<MergeResult> {
    if !rebase_in_progress(repo) {
        return Err(AppError::invalid_state("No hay ningun rebase en curso"));
    }

    let mut opts = git2::RebaseOptions::new();
    opts.inmemory(false);
    let mut rebase = repo
        .open_rebase(Some(&mut opts))
        .map_err(AppError::from_git)?;

    // `abort` restaura la rama original y limpia todo el estado del rebase.
    rebase.abort().map_err(AppError::from_git)?;

    Ok(MergeResult {
        success: true,
        new_commits: Vec::new(),
        conflicted_files: Vec::new(),
        message: "Rebase abortado".to_string(),
        status: staging::status(repo)?,
        needs_continue: false,
        rebase_steps_left: 0,
    })
}

/// `true` si hay un rebase o merge registrado en el repositorio.
pub fn rebase_in_progress(repo: &Repository) -> bool {
    repo.state() == git2::RepositoryState::RebaseMerge
        || repo.state() == git2::RepositoryState::RebaseInteractive
        || repo.state() == git2::RepositoryState::Rebase
}

pub fn merge_in_progress(repo: &Repository) -> bool {
    repo.state() == git2::RepositoryState::Merge
}

/// Cronometra una operacion de red y devuelve la duracion en ms.
pub fn elapsed_ms(start: Instant) -> u64 {
    start.elapsed().as_millis() as u64
}

/// Compara dos ramas y devuelve su relacion.
pub fn compare_branches(
    repo: &Repository,
    base: &str,
    target: &str,
) -> AppResult<(usize, usize, bool)> {
    let base_commit = resolve_commit(repo, base)?;
    let target_commit = resolve_commit(repo, target)?;
    let (ahead, behind) = repo
        .graph_ahead_behind(target_commit.id(), base_commit.id())
        .map_err(AppError::from_git)?;
    let ancestor = repo
        .merge_base(base_commit.id(), target_commit.id())
        .map(|oid| oid == base_commit.id())
        .unwrap_or(false);
    Ok((ahead, behind, ancestor))
}

/// Estado completo del repositorio, reexportado para los comandos.
pub fn repo_status(repo: &Repository) -> AppResult<RepoStatus> {
    staging::status(repo)
}

