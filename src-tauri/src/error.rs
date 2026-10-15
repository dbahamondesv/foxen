//! Tipos de error de Foxen, serializables a traves del puente IPC de Tauri.

use serde::{Deserialize, Serialize};

/// Categoria de error. Se serializa como string en camelCase para el frontend.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ErrorKind {
    /// La ruta indicada no es un repositorio git.
    NotARepository,
    /// El repositorio no esta registrado/abierto en la app.
    RepositoryNotFound,
    /// Una referencia, commit, rama o archivo solicitado no existe.
    NotFound,
    /// Error devuelto por libgit2.
    Git,
    /// Error de sistema de archivos.
    Io,
    /// La operacion es invalida para el estado actual del repositorio.
    InvalidState,
    /// El usuario cancelo la operacion (por ejemplo un dialogo nativo).
    Cancelled,
    /// Faltan credenciales o son invalidas.
    Authentication,
    /// Fallo de red durante fetch/pull/push.
    Network,
    /// Ya hay una operacion en curso sobre el repositorio.
    Busy,
    /// Validacion de entrada fallida.
    Validation,
    /// Error inesperado.
    Internal,
}

impl ErrorKind {
    /// Codigo numerico estable para traduccion en el frontend.
    pub fn code(self) -> u16 {
        match self {
            ErrorKind::NotARepository => 1001,
            ErrorKind::RepositoryNotFound => 1002,
            ErrorKind::NotFound => 1003,
            ErrorKind::Git => 1004,
            ErrorKind::Io => 1005,
            ErrorKind::InvalidState => 1006,
            ErrorKind::Cancelled => 1007,
            ErrorKind::Authentication => 1008,
            ErrorKind::Network => 1009,
            ErrorKind::Busy => 1010,
            ErrorKind::Validation => 1011,
            ErrorKind::Internal => 1012,
        }
    }
}

/// Error de la aplicacion que cruza el puente IPC.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub kind: ErrorKind,
    pub message: String,
    /// Contexto adicional (salida de git, consejo de resolucion, etc).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    pub code: u16,
}

impl AppError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            detail: None,
            code: kind.code(),
        }
    }

    pub fn with_detail(mut self, detail: impl Into<String>) -> Self {
        let detail = detail.into();
        if !detail.trim().is_empty() {
            self.detail = Some(detail);
        }
        self
    }

    pub fn not_a_repository(path: impl AsRef<std::path::Path>) -> Self {
        Self::new(
            ErrorKind::NotARepository,
            format!("{} no es un repositorio git", path.as_ref().display()),
        )
    }

    pub fn repo_not_found(id: impl std::fmt::Display) -> Self {
        Self::new(
            ErrorKind::RepositoryNotFound,
            format!("Repositorio {id} no esta abierto"),
        )
    }

    pub fn not_found(what: impl Into<String>) -> Self {
        Self::new(ErrorKind::NotFound, what)
    }

    pub fn validation(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Validation, message)
    }

    pub fn invalid_state(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::InvalidState, message)
    }

    pub fn busy(repo: impl std::fmt::Display) -> Self {
        Self::new(
            ErrorKind::Busy,
            format!("Ya hay una operacion en curso en {repo}"),
        )
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Internal, message)
    }

    pub fn authentication(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Authentication, message)
    }

    pub fn network(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Network, message)
    }

    /// Traduce errores de libgit2 a la categoria correcta.
    pub fn from_git(err: git2::Error) -> Self {
        let kind = match err.class() {
            git2::ErrorClass::Repository => ErrorKind::NotARepository,
            git2::ErrorClass::Net => ErrorKind::Network,
            git2::ErrorClass::Ssh | git2::ErrorClass::Http => ErrorKind::Authentication,
            git2::ErrorClass::Os => ErrorKind::Io,
            git2::ErrorClass::Invalid | git2::ErrorClass::Reference => ErrorKind::InvalidState,
            _ => ErrorKind::Git,
        };
        let message = if err.code() == git2::ErrorCode::NotFound {
            ErrorKind::NotFound
        } else {
            kind
        };
        Self::new(message, err.message().to_string())
            .with_detail(format!("{:?}", err.class()))
    }

    pub fn from_io(err: std::io::Error) -> Self {
        let kind = match err.kind() {
            std::io::ErrorKind::NotFound => ErrorKind::NotFound,
            std::io::ErrorKind::PermissionDenied => ErrorKind::InvalidState,
            _ => ErrorKind::Io,
        };
        Self::new(kind, err.to_string())
    }
}

/// Permite usar `?` directamente sobre resultados de libgit2.
impl From<git2::Error> for AppError {
    fn from(err: git2::Error) -> Self {
        Self::from_git(err)
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match &self.detail {
            Some(detail) => write!(f, "{} ({detail})", self.message),
            None => f.write_str(&self.message),
        }
    }
}

impl std::error::Error for AppError {}

pub type AppResult<T> = Result<T, AppError>;