//! Preferencias persistentes de Foxen.
//!
//! Se guardan en `settings.json` dentro del directorio de configuracion del
//! usuario (`dirs::config_dir()/foxen/`), no en el almacenamiento del webview:
//! asi sobreviven a limpiezas de la cache de WebKit y son accesibles para el
//! backend. La escritura es atomica (temporal + rename) para no corromper el
//! archivo si la app se cierra a mitad.

use std::fs;
use std::io::ErrorKind;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

const FILE_NAME: &str = "settings.json";
const TEMP_NAME: &str = "settings.json.tmp";

/// Contenido completo del archivo de ajustes.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub session: Session,
    /// `light`, `dark`, `system` o `None` si nunca se ha elegido.
    pub theme: Option<String>,
}

/// Repositorios abiertos y cual estaba activo al cerrar la app.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Session {
    pub paths: Vec<String>,
    pub active: Option<String>,
}

fn file_path() -> AppResult<PathBuf> {
    let dir = dirs::config_dir().ok_or_else(|| {
        AppError::not_found("No se pudo determinar el directorio de configuracion del usuario")
    })?;
    Ok(dir.join("foxen").join(FILE_NAME))
}

/// Lee los ajustes. Un archivo corrupto no impide arrancar: se usan los valores
/// por defecto (la proxima escritura lo reemplaza).
pub fn load() -> AppResult<Settings> {
    let path = file_path()?;
    match fs::read_to_string(&path) {
        Ok(raw) => Ok(serde_json::from_str(&raw).unwrap_or_else(|error| {
            log::warn!("Ajustes ilegibles en {}: {error}", path.display());
            Settings::default()
        })),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(Settings::default()),
        Err(error) => Err(AppError::internal(format!(
            "No se pudieron leer los ajustes ({}): {error}",
            path.display()
        ))),
    }
}

fn save(settings: &Settings) -> AppResult<()> {
    let path = file_path()?;
    let dir = path
        .parent()
        .ok_or_else(|| AppError::internal("Ruta de ajustes invalida"))?;
    fs::create_dir_all(dir).map_err(|error| {
        AppError::internal(format!(
            "No se pudo crear el directorio de configuracion ({}): {error}",
            dir.display()
        ))
    })?;

    let json = serde_json::to_string_pretty(settings)
        .map_err(|error| AppError::internal(format!("Ajustes no serializables: {error}")))?;
    let temp = dir.join(TEMP_NAME);
    fs::write(&temp, json).map_err(|error| {
        AppError::internal(format!("No se pudieron escribir los ajustes: {error}"))
    })?;
    fs::rename(&temp, &path).map_err(|error| {
        AppError::internal(format!("No se pudo confirmar los ajustes: {error}"))
    })?;
    Ok(())
}

/// Reemplaza solo la sesion, conservando el tema.
pub fn save_session(session: Session) -> AppResult<()> {
    let mut settings = load()?;
    settings.session = session;
    save(&settings)
}

/// Reemplaza solo el tema, conservando la sesion.
pub fn save_theme(theme: Option<String>) -> AppResult<()> {
    let mut settings = load()?;
    settings.theme = theme;
    save(&settings)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializa_en_camel_case() {
        let settings = Settings {
            session: Session {
                paths: vec!["/a".to_string()],
                active: Some("/a".to_string()),
            },
            theme: Some("dark".to_string()),
        };
        let json = serde_json::to_string(&settings).unwrap();
        assert!(json.contains("\"active\""));
        assert!(json.contains("\"theme\":\"dark\""));
    }

    #[test]
    fn tolera_campos_ausentes() {
        let settings: Settings = serde_json::from_str("{}").unwrap();
        assert!(settings.session.paths.is_empty());
        assert!(settings.session.active.is_none());
        assert!(settings.theme.is_none());
    }
}
