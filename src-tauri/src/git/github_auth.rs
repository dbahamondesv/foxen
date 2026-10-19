//! Autenticación OAuth Device Flow y API con GitHub.
//!
//! Este flujo es ideal para aplicaciones de escritorio porque no requiere
//! un servidor local para recibir el callback: el usuario abre el navegador
//! con el código mostrado y autoriza la aplicación.

use crate::error::{AppError, AppResult};
use crate::types::{
    GitHubAccessToken, GitHubDeviceCode, GitHubLoginResult, GitHubLoginState, GitHubRepo,
    GitHubUser,
};
use std::time::{Duration, Instant};

const GITHUB_DEVICE_CODE_URL: &str = "https://github.com/login/device/code";
const GITHUB_TOKEN_URL: &str = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL: &str = "https://api.github.com/user";
const GITHUB_REPOS_URL: &str = "https://api.github.com/user/repos";

/// Variable de entorno con el Client ID de la OAuth App de GitHub.
///
/// Sin ella el Device Flow no puede funcionar: GitHub exige un Client ID
/// propio con «Enable Device Flow» activado. Foxen no lleva un Client ID
/// embebido porque el de la app de desarrollo devolvio HTTP 404 ( OAuth App
/// inexistente o sin device flow habilitado).
const CLIENT_ID_ENV: &str = "FOXEN_GITHUB_CLIENT_ID";

/// Client ID configurado en el entorno, si lo hay.
fn env_client_id() -> Option<String> {
    std::env::var(CLIENT_ID_ENV)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// `true` si el Device Flow esta configurado (existe Client ID en el entorno).
pub fn device_flow_configured() -> bool {
    env_client_id().is_some()
}

/// Valida un nombre de repositorio segun las reglas de GitHub.
///
/// GitHub admite letras, digitos, `-`, `_` y `.`, con longitud 1-100 y sin
/// empezar ni terminar en `.`, ni empezar por `-`, ni ser solo `.`/`..`.
fn validate_repo_name(name: &str) -> AppResult<()> {
    if name.is_empty() {
        return Err(AppError::validation("El nombre del repositorio esta vacio"));
    }
    if name.len() > 100 {
        return Err(AppError::validation(
            "El nombre del repositorio no puede superar los 100 caracteres",
        ));
    }
    if name == "." || name == ".." {
        return Err(AppError::validation(
            "El nombre del repositorio no puede ser «.» ni «..»",
        ));
    }
    if name.starts_with('-') {
        return Err(AppError::validation(
            "El nombre del repositorio no puede empezar por «-»",
        ));
    }
    if name.starts_with('.') || name.ends_with('.') {
        return Err(AppError::validation(
            "El nombre del repositorio no puede empezar ni terminar por «.»",
        ));
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        return Err(AppError::validation(
            "El nombre del repositorio solo admite letras, digitos, «-», «_» y «.»",
        ));
    }
    Ok(())
}

/// Lee un token ya autenticado desde la GitHub CLI (`gh auth token`).
///
/// `gh` se encarga del login interactivo (navegador + MFA) y del almacenamiento
/// del token; aqui solo se reutiliza esa sesion para no duplicar credenciales.
pub fn token_from_gh() -> Option<String> {
    let output = std::process::Command::new("gh")
        .args(["auth", "token", "--hostname", "github.com"])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let token = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if token.is_empty() {
        None
    } else {
        Some(token)
    }
}

#[derive(Clone)]
pub struct GitHubAuth {
    client: reqwest::Client,
}

impl Default for GitHubAuth {
    fn default() -> Self {
        Self {
            client: reqwest::Client::builder()
                .user_agent("foxen/0.1.0")
                .build()
                .unwrap_or_else(|_| reqwest::Client::new()),
        }
    }
}

impl GitHubAuth {
    pub fn new() -> Self {
        Self::default()
    }

    /// Client ID a usar: el pasado explicitamente o el del entorno.
    fn resolve_client_id(custom: Option<String>) -> AppResult<String> {
        custom
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .or_else(env_client_id)
            .ok_or_else(|| {
                AppError::validation(
                    "El inicio de sesión en el navegador no está configurado: \
                     define FOXEN_GITHUB_CLIENT_ID con el Client ID de tu OAuth App \
                     (con «Enable Device Flow» activado), o inicia sesión con la \
                     GitHub CLI (gh) o un Personal Access Token.",
                )
            })
    }

    /// Solicita un device code a GitHub.
    pub async fn start_device_flow(
        &self,
        custom_client_id: Option<String>,
    ) -> AppResult<GitHubLoginState> {
        let client_id = Self::resolve_client_id(custom_client_id)?;

        let params = [
            ("client_id", client_id.as_str()),
            ("scope", "repo read:user user:email"),
        ];

        let response = self
            .client
            .post(GITHUB_DEVICE_CODE_URL)
            .header("Accept", "application/json")
            .form(&params)
            .send()
            .await
            .map_err(|e| AppError::network(format!("Error solicitando device code: {e}")))?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            if status.as_u16() == 404 {
                return Err(AppError::validation(
                    "GitHub devolvió 404 Not Found: asegúrate de que tu OAuth App en GitHub tenga marcada la casilla 'Enable Device Flow' (en GitHub: Settings > Developer settings > OAuth Apps > Tu App) o utiliza un Personal Access Token (PAT)."
                ));
            }
            return Err(AppError::internal(format!(
                "Error HTTP {status} al solicitar device code de GitHub: {body}"
            )));
        }

        let device_code: GitHubDeviceCode = response
            .json()
            .await
            .map_err(|e| AppError::internal(format!("Error parseando device code: {e}")))?;

        Ok(GitHubLoginState {
            device_code: device_code.device_code,
            user_code: device_code.user_code,
            verification_uri: device_code.verification_uri,
            verification_uri_complete: device_code.verification_uri_complete,
            expires_in: device_code.expires_in,
            interval: device_code.interval,
            interval_ms: device_code.interval * 1000,
            poll_interval_ms: device_code.interval * 1000,
            client_id: Some(client_id),
        })
    }

    /// Hace polling para obtener el token una vez que el usuario ha autorizado.
    pub async fn poll_for_token(&self, state: &GitHubLoginState) -> AppResult<GitHubLoginResult> {
        let client_id = state
            .client_id
            .clone()
            .filter(|s| !s.trim().is_empty())
            .or_else(env_client_id)
            .ok_or_else(|| {
                AppError::validation(
                    "El Client ID del Device Flow ya no está disponible (¿se reinició la app?).",
                )
            })?;
        let start = Instant::now();
        let expires_in = Duration::from_secs(state.expires_in);
        let mut poll_interval = Duration::from_millis(state.poll_interval_ms.max(5000));

        let mut next_poll = Instant::now();

        loop {
            if start.elapsed() >= expires_in {
                return Ok(GitHubLoginResult {
                    success: false,
                    token: None,
                    username: None,
                    user: None,
                    error: Some("authorization_expired".to_string()),
                    error_description: Some(
                        "El código de autorización ha expirado. Solicita uno nuevo.".to_string(),
                    ),
                });
            }

            if Instant::now() < next_poll {
                tokio::time::sleep_until(tokio::time::Instant::from(next_poll)).await;
            }
            next_poll = Instant::now() + poll_interval;

            let params = [
                ("client_id", client_id.as_str()),
                ("device_code", &state.device_code),
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ];

            let response = self
                .client
                .post(GITHUB_TOKEN_URL)
                .header("Accept", "application/json")
                .form(&params)
                .send()
                .await
                .map_err(|e| AppError::network(format!("Error consultando token: {e}")))?;

            if !response.status().is_success() {
                continue;
            }

            let token_response: GitHubAccessToken = response
                .json()
                .await
                .map_err(|e| AppError::internal(format!("Error parseando token: {e}")))?;

            if let Some(error) = &token_response.error {
                match error.as_str() {
                    "authorization_pending" => continue,
                    "slow_down" => {
                        if let Some(interval) = token_response.interval {
                            poll_interval = Duration::from_secs(interval);
                        } else {
                            poll_interval += Duration::from_secs(5);
                        }
                        next_poll = Instant::now() + poll_interval;
                        continue;
                    }
                    "expired_token" => {
                        return Ok(GitHubLoginResult {
                            success: false,
                            token: None,
                            username: None,
                            user: None,
                            error: Some(error.clone()),
                            error_description: token_response.error_description,
                        });
                    }
                    "access_denied" => {
                        return Ok(GitHubLoginResult {
                            success: false,
                            token: None,
                            username: None,
                            user: None,
                            error: Some(error.clone()),
                            error_description: Some("Acceso denegado por el usuario en GitHub.".to_string()),
                        });
                    }
                    _ => {
                        return Ok(GitHubLoginResult {
                            success: false,
                            token: None,
                            username: None,
                            user: None,
                            error: Some(error.clone()),
                            error_description: token_response.error_description,
                        });
                    }
                }
            }

            if let Some(token) = token_response.access_token {
                // Obtener perfil del usuario
                let user_info = self.get_user_info(&token).await.ok();
                let username = user_info.as_ref().map(|u| u.login.clone());

                // Guardar en el llavero para github.com
                if let Some(ref uname) = username {
                    let _ = crate::git::remote::store_credential(
                        "github.com",
                        &crate::types::Credential {
                            username: uname.clone(),
                            password: token.clone(),
                        },
                    );
                }

                return Ok(GitHubLoginResult {
                    success: true,
                    token: Some(token),
                    username,
                    user: user_info,
                    error: None,
                    error_description: None,
                });
            }

            continue;
        }
    }

    /// Obtiene información del usuario autenticado a partir del token.
    pub async fn get_user_info(&self, token: &str) -> AppResult<GitHubUser> {
        let response = self
            .client
            .get(GITHUB_USER_URL)
            .header("Accept", "application/vnd.github.v3+json")
            .header("Authorization", format!("Bearer {token}"))
            .send()
            .await
            .map_err(|e| AppError::network(format!("Error consultando usuario GitHub: {e}")))?;

        if !response.status().is_success() {
            let status = response.status();
            return Err(AppError::authentication(format!(
                "Token inválido o expirado (HTTP {status})"
            )));
        }

        let user: GitHubUser = response
            .json()
            .await
            .map_err(|e| AppError::internal(format!("Error parseando usuario: {e}")))?;

        Ok(user)
    }

    /// Crea un repositorio en GitHub.
    ///
    /// Sin `owner` crea el repositorio en la cuenta del usuario; con `owner`
    /// (una organizacion) lo crea en `POST /orgs/{owner}/repos`.
    pub async fn create_repo(
        &self,
        token: &str,
        name: &str,
        private: bool,
        description: Option<&str>,
        owner: Option<&str>,
    ) -> AppResult<GitHubRepo> {
        let name = name.trim();
        validate_repo_name(name)?;

        let url = match owner.map(str::trim).filter(|o| !o.is_empty()) {
            Some(owner) => format!("https://api.github.com/orgs/{owner}/repos"),
            None => GITHUB_REPOS_URL.to_string(),
        };

        let mut body = serde_json::json!({
            "name": name,
            "private": private,
            // El primer push trae el historial local; no dejar que GitHub cree uno.
            "auto_init": false,
        });
        if let Some(description) = description.map(str::trim).filter(|d| !d.is_empty()) {
            body["description"] = serde_json::Value::String(description.to_string());
        }

        let response = self
            .client
            .post(&url)
            .header("Accept", "application/vnd.github.v3+json")
            .header("Authorization", format!("Bearer {token}"))
            .json(&body)
            .send()
            .await
            .map_err(|e| AppError::network(format!("Error creando el repositorio: {e}")))?;

        let status = response.status();
        if status.as_u16() == 422 {
            return Err(AppError::validation(format!(
                "Ya existe un repositorio llamado «{name}» en tu cuenta de GitHub, o el nombre no es valido"
            )));
        }
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(AppError::internal(format!(
                "Error HTTP {status} al crear el repositorio: {body}"
            )));
        }

        response
            .json::<GitHubRepo>()
            .await
            .map_err(|e| AppError::internal(format!("Error parseando el repositorio creado: {e}")))
    }

    /// Lista los repositorios del usuario en GitHub (ordenados por última modificación).
    pub async fn list_repos(&self, token: &str) -> AppResult<Vec<GitHubRepo>> {
        let url = format!("{GITHUB_REPOS_URL}?sort=updated&per_page=100&affiliation=owner,collaborator");
        let response = self
            .client
            .get(&url)
            .header("Accept", "application/vnd.github.v3+json")
            .header("Authorization", format!("Bearer {token}"))
            .send()
            .await
            .map_err(|e| AppError::network(format!("Error obteniendo repositorios: {e}")))?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(AppError::internal(format!(
                "Error HTTP {status} al obtener repositorios: {body}"
            )));
        }

        let repos: Vec<GitHubRepo> = response
            .json()
            .await
            .map_err(|e| AppError::internal(format!("Error parseando repositorios: {e}")))?;

        Ok(repos)
    }
}
