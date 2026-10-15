//! Capa de acceso a git. Cada submodulo agrupa las operaciones de su area y
//! devuelve `AppResult` con errores ya traducidos a `AppError`.

pub mod commit_ops;
pub mod flow;
pub mod graph;
pub mod merge;
pub mod refs;
pub mod remote;
pub mod repo;
pub mod staging;
pub mod stash;
pub mod util;
pub mod github_auth;
