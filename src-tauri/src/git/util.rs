//! Utilidades compartidas: formato de tiempo, OIDs, firmas y conversion de tipos.

use crate::error::{AppError, AppResult};
use git2::Oid;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

/// Firma unica para timestamp unix -> ISO 8601 UTC.
pub fn iso8601(timestamp: i64) -> String {
    OffsetDateTime::from_unix_timestamp(timestamp)
        .ok()
        .and_then(|dt| dt.format(&Rfc3339).ok())
        .unwrap_or_else(|| "1970-01-01T00:00:00Z".to_string())
}

/// Abreviatura estandar de un OID a 7 caracteres hex.
pub fn short_oid(oid: &Oid) -> String {
    oid.to_string().chars().take(7).collect()
}

/// Abreviatura configurable (git usa core.abbrev, tipicamente 7).
pub fn short_oid_n(oid: &Oid, len: usize) -> String {
    oid.to_string().chars().take(len).collect()
}

pub fn oid_from_str(value: &str) -> AppResult<Oid> {
    Oid::from_str(value.trim())
        .map_err(|_| AppError::validation(format!("OID invalido: {value}")))
}

/// Nombre corto de una referencia completa.
pub fn shorten_ref(full_name: &str) -> String {
    full_name
        .strip_prefix("refs/heads/")
        .or_else(|| full_name.strip_prefix("refs/remotes/"))
        .or_else(|| full_name.strip_prefix("refs/tags/"))
        .unwrap_or(full_name)
        .to_string()
}

/// Convierte una ruta relativa de git a separador nativo.
pub fn native_path(path: &str) -> String {
    path.replace('/', std::path::MAIN_SEPARATOR_STR)
}

/// Resuelve una ruta relativa del frontend dentro del working tree.
///
/// Rechaza rutas absolutas y cualquier componente `..`: sin esto una llamada IPC
/// manipulada podria escribir o borrar archivos fuera del repositorio.
pub fn safe_worktree_path(
    workdir: &std::path::Path,
    path: &str,
) -> AppResult<std::path::PathBuf> {
    use std::path::Component;

    let relative = std::path::Path::new(path);
    if relative.is_absolute() {
        return Err(AppError::validation(format!(
            "La ruta {path} debe ser relativa al repositorio"
        )));
    }
    for component in relative.components() {
        match component {
            Component::Normal(_) => {}
            Component::CurDir => {}
            _ => {
                return Err(AppError::validation(format!(
                    "La ruta {path} sale del repositorio"
                )));
            }
        }
    }
    Ok(workdir.join(relative))
}

/// Escapa una ruta para usarla dentro de un pathspec de libgit2.
pub fn pathspec(path: &str) -> AppResult<git2::Pathspec> {
    git2::Pathspec::new([path]).map_err(AppError::from_git)
}

/// Determina el tipo de cambio a partir de los codigos de estado de git.
pub fn change_kind(index_status: char, worktree_status: char) -> crate::types::ChangeKind {
    use crate::types::ChangeKind;
    let c = if worktree_status != ' ' && worktree_status != '\0' {
        worktree_status
    } else {
        index_status
    };
    match c {
        'A' => ChangeKind::Added,
        'D' => ChangeKind::Deleted,
        'R' => ChangeKind::Renamed,
        'C' => ChangeKind::Copied,
        'T' => ChangeKind::TypeChanged,
        '?' => ChangeKind::Untracked,
        'I' => ChangeKind::Ignored,
        'U' => ChangeKind::Conflicted,
        _ => ChangeKind::Modified,
    }
}

/// Extrae la letra de estado de una cadena XY de `git status --porcelain`.
pub fn status_letter(xy: &str) -> char {
    xy.chars().next().unwrap_or(' ')
}

/// Nombre de rama legible, o descripcion de HEADOJ detached.
pub fn head_label(repo: &git2::Repository) -> String {
    match repo.head() {
        Ok(head) => head
            .shorthand()
            .map(|s| s.to_string())
            .unwrap_or_else(|| "HEAD".to_string()),
        Err(_) => "HEAD".to_string(),
    }
}

/// Escribe un mensaje en el log interno de la aplicacion.
#[macro_export]
macro_rules! log_warn {
    ($($arg:tt)*) => {
        log::warn!($($arg)*)
    };
}

/// Escribe un mensaje de depuracion en el log interno.
#[macro_export]
macro_rules! log_info {
    ($($arg:tt)*) => {
        log::info!($($arg)*)
    };
}