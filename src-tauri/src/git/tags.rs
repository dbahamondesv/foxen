//! Etiquetas (tags): listado, creacion anotada, borrado y sugerencia de
//! version siguiente. Un tag marca un punto fijo del historial, tipicamente
//! una release sobre `main`.

use git2::{ObjectType, Repository};

use crate::error::{AppError, AppResult};
use crate::git::util::shorten_ref;
use crate::types::{OperationResult, TagDetail};

/// Parametros para crear un tag.
pub struct NewTag<'a> {
    /// Nombre del tag (sin `refs/tags/`).
    pub name: &'a str,
    /// Revision a etiquetar (rama, oid, tag…). `None` = HEAD.
    pub target: Option<&'a str>,
    /// Mensaje del tag anotado. `None` o vacio crea un tag ligero.
    pub message: Option<&'a str>,
    /// Sobrescribir un tag existente.
    pub force: bool,
}

/// Lista los tags con su mensaje (si son anotados) y oid.
pub fn list(repo: &Repository) -> AppResult<Vec<TagDetail>> {
    let mut out = Vec::new();
    let references = repo
        .references_glob("refs/tags/*")
        .map_err(AppError::from_git)?;

    for reference in references.flatten() {
        let Some(full_name) = reference.name().map(str::to_string) else {
            continue;
        };

        // Un tag puede apuntar a un objeto Tag (anotado) o directamente a un
        // commit (ligero). El mensaje solo existe en el anotado.
        let (message, oid) = match reference.peel(ObjectType::Tag) {
            Ok(tag) => {
                let msg = tag
                    .as_tag()
                    .and_then(|t| t.message().map(str::to_string));
                let oid = tag.peel_to_commit().ok().map(|c| c.id().to_string());
                (msg, oid)
            }
            Err(_) => {
                let oid = reference
                    .peel_to_commit()
                    .ok()
                    .map(|c| c.id().to_string())
                    .or_else(|| reference.target().map(|o| o.to_string()));
                (None, oid)
            }
        };

        let Some(oid) = oid else { continue };

        out.push(TagDetail {
            name: shorten_ref(&full_name),
            full_name,
            oid: oid.clone(),
            short_oid: oid.chars().take(7).collect(),
            message,
        });
    }

    // Orden estable: mas reciente por version/nombre descendente no aplica a
    // todos los esquemas; alfabetico es lo predecible.
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// Crea un tag (anotado si lleva mensaje, ligero si no).
pub fn create(repo: &Repository, params: NewTag<'_>) -> AppResult<OperationResult> {
    let name = params.name.trim();
    validate_tag_name(repo, name)?;

    if !params.force && repo.find_reference(&format!("refs/tags/{name}")).is_ok() {
        return Err(AppError::invalid_state(format!(
            "El tag {name} ya existe"
        )));
    }

    let object = match params.target {
        Some(revision) => repo.revparse_single(revision).map_err(|_| {
            AppError::not_found(format!("No se pudo resolver la revision {revision}"))
        })?,
        None => repo
            .head()
            .and_then(|h| h.peel(ObjectType::Commit))
            .map_err(|e| {
                AppError::from_git(e)
                    .with_detail("HEAD no apunta a ningun commit; indica un destino")
            })?,
    };

    // Solo se etiquetan commits (o tags que apunten a commits).
    let commit = object
        .peel_to_commit()
        .map_err(|_| AppError::validation(format!("{name} debe apuntar a un commit")))?;

    let message = params.message.map(str::trim).filter(|m| !m.is_empty());

    match message {
        Some(message) => {
            repo.tag(
                name,
                commit.as_object(),
                &repo.signature().map_err(AppError::from_git)?,
                message,
                params.force,
            )
            .map_err(AppError::from_git)?;
        }
        None => {
            repo.tag_lightweight(name, commit.as_object(), params.force)
                .map_err(AppError::from_git)?;
        }
    }

    let full_name = format!("refs/tags/{name}");
    Ok(OperationResult::ok(format!("Tag {name} creado")).with_refs(vec![full_name]))
}

/// Borra un tag por su nombre.
pub fn delete(repo: &Repository, name: &str) -> AppResult<OperationResult> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::validation("El nombre del tag esta vacio"));
    }

    let full_name = format!("refs/tags/{name}");
    let mut reference = repo
        .find_reference(&full_name)
        .map_err(|_| AppError::not_found(format!("No existe el tag {name}")))?;
    reference.delete().map_err(AppError::from_git)?;

    Ok(OperationResult::ok(format!("Tag {name} eliminado")).with_refs(vec![full_name]))
}

/// Sugiere la siguiente version semver a partir del ultimo tag `vX.Y.Z`.
///
/// Se apoya en `existing` (normalmente el resultado de `list`) para tomar el
/// mayor `MAJOR.MINOR.PATCH` con prefijo `v` y devolver el siguiente parche.
/// Si no hay ninguno, propone `v0.1.0`.
pub fn suggest_next_version(existing: &[TagDetail]) -> String {
    let mut best: Option<(u64, u64, u64)> = None;
    for tag in existing {
        if let Some(version) = parse_semver(&tag.name) {
            if best.is_none_or(|b| version > b) {
                best = Some(version);
            }
        }
    }

    match best {
        Some((major, minor, patch)) => format!("v{major}.{minor}.{}", patch + 1),
        None => "v0.1.0".to_string(),
    }
}

/// Interpreta `vMAJOR.MINOR.PATCH` (o sin la `v`) como tupla semver.
fn parse_semver(name: &str) -> Option<(u64, u64, u64)> {
    let rest = name.strip_prefix('v').unwrap_or(name);
    let mut parts = rest.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?.parse().ok()?;
    // Descarta pre-releases (`1.2.3-beta`), pero acepta el sufijo vacio.
    if parts.next().is_some() {
        // `1.2.3.4` no es semver: se ignora.
        return None;
    }
    Some((major, minor, patch))
}

/// Valida el nombre de un tag con las reglas de git (`refs/tags/{name}`).
fn validate_tag_name(repo: &Repository, name: &str) -> AppResult<()> {
    if name.is_empty() {
        return Err(AppError::validation("El nombre del tag esta vacio"));
    }
    if name.starts_with('-') {
        return Err(AppError::validation(
            "El nombre del tag no puede empezar por guion",
        ));
    }
    // `Reference::is_valid_name` exige el nombre COMPLETO de la referencia.
    if !git2::Reference::is_valid_name(&format!("refs/tags/{name}")) {
        return Err(AppError::validation(format!(
            "{name} no es un nombre de tag valido"
        )));
    }
    // Un tag no puede colisionar con una rama ni con otro tipo de ref.
    for other in [
        format!("refs/heads/{name}"),
        format!("refs/remotes/{name}"),
    ] {
        if repo.find_reference(&other).is_ok() {
            return Err(AppError::invalid_state(format!(
                "{name} ya existe como referencia"
            )));
        }
    }
    Ok(())
}
