//! Comandos Tauri para autenticación y operaciones con GitHub.

use crate::error::{AppError, AppResult};
use crate::git::github_auth::GitHubAuth;
use crate::types::{GitHubLoginResult, GitHubLoginState, GitHubRepo, GitHubUser};

/// Inicia el flujo de autenticación de GitHub (Device Flow).
///
/// Abre automáticamente el navegador en la URL de verificación con el código
/// para que el usuario autorice a la aplicación con permisos de repositorios.
#[tauri::command]
pub async fn github_start_login(client_id: Option<String>) -> AppResult<GitHubLoginState> {
    let auth = GitHubAuth::new();
    let state = auth.start_device_flow(client_id).await?;

    // Abre el navegador automáticamente en la URL de verificación con el código precompletado
    let url_to_open = state
        .verification_uri_complete
        .as_deref()
        .unwrap_or(&state.verification_uri);
    let _ = tauri_plugin_opener::open_url(url_to_open, None::<&str>);

    Ok(state)
}

/// Hace polling para consultar si el usuario ya autorizó la aplicación en GitHub.
///
/// Al autorizarse, guarda automáticamente el token en el llavero del sistema bajo `github.com`.
#[tauri::command]
pub async fn github_poll_login(state: GitHubLoginState) -> AppResult<GitHubLoginResult> {
    let auth = GitHubAuth::new();
    auth.poll_for_token(&state).await
}

/// Guarda manualmente un token y obtiene la información del usuario.
#[tauri::command]
pub async fn github_login_complete(
    token: String,
    username: Option<String>,
) -> AppResult<GitHubLoginResult> {
    let auth = GitHubAuth::new();
    let user = auth.get_user_info(&token).await.ok();
    let login_username = user
        .as_ref()
        .map(|u| u.login.clone())
        .or(username)
        .unwrap_or_else(|| "git".to_string());

    crate::git::remote::store_credential(
        "github.com",
        &crate::types::Credential {
            username: login_username.clone(),
            password: token.clone(),
        },
    )?;

    Ok(GitHubLoginResult {
        success: true,
        token: Some(token),
        username: Some(login_username),
        user,
        error: None,
        error_description: None,
    })
}

/// Inicia sesión reutilizando la sesión de la GitHub CLI (`gh`).
///
/// `gh auth login` ya resuelve el login con navegador y MFA; aquí solo se lee el
/// token vigente y se guarda en el llavero de Foxen bajo `github.com`.
#[tauri::command]
pub async fn github_login_with_gh() -> AppResult<GitHubLoginResult> {
    let token = crate::git::github_auth::token_from_gh().ok_or_else(|| {
        AppError::authentication(
            "No se encontró una sesión de GitHub CLI. Ejecuta `gh auth login` en una terminal (abre el navegador y pide MFA) e inténtalo de nuevo.",
        )
    })?;

    let auth = GitHubAuth::new();
    let user = auth.get_user_info(&token).await.ok();
    let username = user.as_ref().map(|u| u.login.clone());

    crate::git::remote::store_credential(
        "github.com",
        &crate::types::Credential {
            username: username.clone().unwrap_or_else(|| "git".to_string()),
            password: token.clone(),
        },
    )?;

    Ok(GitHubLoginResult {
        success: true,
        token: Some(token),
        username,
        user,
        error: None,
        error_description: None,
    })
}

/// Obtiene el usuario de GitHub actualmente autenticado (si hay credenciales guardadas en el llavero).
#[tauri::command]
pub async fn github_get_user() -> AppResult<Option<GitHubUser>> {
    if let Some(cred) = crate::git::remote::lookup_credential("github.com") {
        if !cred.password.is_empty() {
            let auth = GitHubAuth::new();
            if let Ok(user) = auth.get_user_info(&cred.password).await {
                return Ok(Some(user));
            }
        }
    }
    Ok(None)
}

/// Cierra la sesión de GitHub eliminando la credencial del llavero.
#[tauri::command]
pub async fn github_logout() -> AppResult<()> {
    crate::git::remote::forget_credential("github.com")
}

/// Lista los repositorios del usuario autenticado en GitHub.
#[tauri::command]
pub async fn github_list_repos() -> AppResult<Vec<GitHubRepo>> {
    let cred = crate::git::remote::lookup_credential("github.com")
        .ok_or_else(|| AppError::authentication("No hay sesión activa de GitHub. Inicia sesión primero."))?;

    if cred.password.is_empty() {
        return Err(AppError::authentication("No hay token de GitHub configurado."));
    }

    let auth = GitHubAuth::new();
    auth.list_repos(&cred.password).await
}

