//! Comandos Tauri para autenticación y operaciones con GitHub.

use tauri::State;

use crate::error::{AppError, AppResult};
use crate::git::github_auth::GitHubAuth;
use crate::git::repo::AppState;
use crate::types::{GitHubLoginResult, GitHubLoginState, GitHubRepo, GitHubUser};

/// Token de GitHub activo: primero el llavero de Foxen, luego la CLI `gh`.
fn github_token() -> AppResult<String> {
    if let Some(cred) = crate::git::remote::lookup_credential("github.com") {
        if !cred.password.is_empty() {
            return Ok(cred.password);
        }
    }
    crate::git::github_auth::token_from_gh().ok_or_else(|| {
        AppError::authentication(
            "No hay sesión de GitHub. Inicia sesión en Foxen o ejecuta `gh auth login` en una terminal.",
        )
    })
}

/// Prepara el remoto `origin` con la URL del repositorio recién creado y hace
/// push de la rama actual fijando su upstream.
///
/// Si ya existe un `origin` con otra URL, solo se sobreescribe si
/// `replace_origin` es `true`: pisar el remoto sin avisar deja al usuario sin
/// forma de saber a qué servidor apunta su repositorio.
///
/// Las credenciales del push las resuelve `remote::push` desde el llavero.
fn publish_remote_and_push(
    repo: &git2::Repository,
    clone_url: &str,
    replace_origin: bool,
) -> AppResult<()> {
    let head = repo.head().map_err(|_| {
        AppError::invalid_state(
            "El repositorio no tiene commits todavía. Crea el primero antes de publicar.",
        )
    })?;
    if !head.is_branch() {
        return Err(AppError::invalid_state(
            "HEAD está desligado; cámbiate a una rama antes de publicar.",
        ));
    }
    let branch = head
        .shorthand()
        .map(|s| s.to_string())
        .ok_or_else(|| AppError::invalid_state("No se pudo determinar la rama actual."))?;

    if let Ok(existing) = repo.find_remote("origin") {
        let current_url = existing.url().unwrap_or_default().to_string();
        if current_url != clone_url && !replace_origin {
            return Err(AppError::invalid_state(format!(
                "El remoto «origin» ya apunta a «{current_url}»."
            ))
            .with_detail(
                "Publicar sobreescribirá la URL de origin con la del repositorio creado. \
                 Confirma el reemplazo para continuar.",
            ));
        }
        repo.remote_set_url("origin", clone_url)
            .map_err(AppError::from_git)?;
    } else {
        repo.remote("origin", clone_url).map_err(AppError::from_git)?;
    }

    crate::git::remote::push(repo, "origin", Some(&branch), false, true, false, None).map_err(
        |push_error| {
            // El repo remoto ya existe: sin este contexto el usuario creeria
            // que todo fallo y volveria a crear repos duplicados.
            AppError::new(push_error.kind, format!("El push falló: {}", push_error.message))
                .with_detail(format!(
                    "El repositorio ya se creó en GitHub: {clone_url}. \
                     {} \
                     Puedes reintentar el push desde el panel de Remotos.",
                    push_error.detail.unwrap_or_default()
                ))
        },
    )?;
    Ok(())
}

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

/// Guarda manualmente un token **validándolo contra la API** antes de tocar el llavero.
///
/// Un PAT inválido o con scopes insuficientes nunca debe quedar guardado como
/// si fuese una sesión válida.
#[tauri::command]
pub async fn github_login_complete(
    token: String,
    username: Option<String>,
) -> AppResult<GitHubLoginResult> {
    let auth = GitHubAuth::new();
    let user = auth.get_user_info(&token).await?;

    if let Some(given) = username.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        if !given.eq_ignore_ascii_case(&user.login) {
            return Err(AppError::authentication(format!(
                "El usuario «{given}» no coincide con la cuenta del token (@{}).",
                user.login
            )));
        }
    }
    let login_username = user.login.clone();

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
        user: Some(user),
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
    let user = auth.get_user_info(&token).await?;
    let username = user.login.clone();

    crate::git::remote::store_credential(
        "github.com",
        &crate::types::Credential {
            username: username.clone(),
            password: token.clone(),
        },
    )?;

    Ok(GitHubLoginResult {
        success: true,
        token: Some(token),
        username: Some(username),
        user: Some(user),
        error: None,
        error_description: None,
    })
}

/// Indica si el Device Flow está configurado (Client ID en el entorno).
///
/// El frontend lo consulta para no ofrecer un inicio de navegador que
/// terminaría en error: sin Client ID propio GitHub no emite device codes.
#[tauri::command]
pub async fn github_device_flow_configured() -> AppResult<bool> {
    Ok(crate::git::github_auth::device_flow_configured())
}

/// Obtiene el usuario de GitHub actualmente autenticado (llavero o sesión de `gh`).
#[tauri::command]
pub async fn github_get_user() -> AppResult<Option<GitHubUser>> {
    let token = github_token()?;
    let auth = GitHubAuth::new();
    match auth.get_user_info(&token).await {
        Ok(user) => Ok(Some(user)),
        // Token caducado o revocado: no es un error del usuario, se trata como
        // «sin sesión» para que la UI muestre el botón de login.
        Err(_) => Ok(None),
    }
}

/// Cierra la sesión de GitHub eliminando la credencial del llavero.
#[tauri::command]
pub async fn github_logout() -> AppResult<()> {
    crate::git::remote::forget_credential("github.com")
}

/// Lista los repositorios del usuario autenticado en GitHub.
#[tauri::command]
pub async fn github_list_repos() -> AppResult<Vec<GitHubRepo>> {
    let token = github_token()?;
    let auth = GitHubAuth::new();
    auth.list_repos(&token).await
}

/// Crea un repositorio en GitHub (sin publicar contenido todavía).
#[tauri::command]
pub async fn github_create_repo(
    name: String,
    private: bool,
    description: Option<String>,
    owner: Option<String>,
) -> AppResult<GitHubRepo> {
    let token = github_token()?;
    let auth = GitHubAuth::new();
    auth.create_repo(&token, &name, private, description.as_deref(), owner.as_deref())
        .await
}

/// Publica un repositorio local en GitHub.
///
/// Crea el repositorio remoto, configura `origin` con su URL y empuja la rama
/// actual estableciendo su upstream, de modo que la rama queda sincronizada.
#[tauri::command]
pub async fn github_publish_repo(
    state: State<'_, AppState>,
    repo_id: String,
    name: String,
    private: bool,
    description: Option<String>,
    owner: Option<String>,
    replace_origin: bool,
) -> AppResult<GitHubRepo> {
    let token = github_token()?;
    let auth = GitHubAuth::new();
    let created = auth
        .create_repo(&token, &name, private, description.as_deref(), owner.as_deref())
        .await?;

    let handle = state.require(&repo_id)?;
    let op = handle.clone();
    let _guard = op.try_begin_op()?;
    let clone_url = created.clone_url.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let repo = handle.lock();
        publish_remote_and_push(&repo, &clone_url, replace_origin)
    })
    .await
    .map_err(|e| AppError::internal(format!("La publicación falló: {e}")))??;

    Ok(created)
}

