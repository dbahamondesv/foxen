//! Operaciones de red: remotos, fetch, pull, push y credenciales.
//!
//! Las credenciales se resuelven en este orden:
//! 1. Credenciales de sesion en memoria, aportadas por el usuario.
//! 2. Llavero del sistema operativo (keyring), con clave por host.
//! 3. Agente SSH del sistema para accessing por clave publica.
//!
//! Nunca se escriben credenciales en disco en texto plano.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Instant;

use git2::{Cred, CredentialType, FetchOptions, PushOptions, RemoteCallbacks, Repository};

use crate::error::{AppError, AppResult, ErrorKind};
use crate::git::merge::elapsed_ms;
use crate::types::{Credential, FetchResult, OperationResult, PushResult, RemoteInfo};

/// Credenciales de sesion en memoria, indexadas por host.
static MEMORY_CREDENTIALS: Mutex<Vec<(String, Credential)>> = Mutex::new(Vec::new());

/// Clave de una credencial en el llavero del sistema.
fn keyring_key(host: &str) -> String {
    format!("foxen:credential:{host}")
}

fn memory_store() -> std::sync::MutexGuard<'static, Vec<(String, Credential)>> {
    MEMORY_CREDENTIALS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Guarda credenciales para un host.
///
/// Si el llavero del sistema no esta disponible se degrada a memoria de sesion,
/// de modo que el flujo de trabajo nunca se rompe por falta de secret-service.
pub fn store_credential(host: &str, credential: &Credential) -> AppResult<()> {
    let json = serde_json::to_string(credential)
        .map_err(|e| AppError::internal(format!("No se pudo serializar la credencial: {e}")))?;

    let persisted = keyring::Entry::new("foxen", &keyring_key(host))
        .and_then(|entry| entry.set_password(&json))
        .is_ok();

    if !persisted {
        let mut store = memory_store();
        store.retain(|(h, _)| h != host);
        store.push((host.to_string(), credential.clone()));
    }
    Ok(())
}

/// Recupera credenciales guardadas para un host.
pub fn lookup_credential(host: &str) -> Option<Credential> {
    if let Ok(entry) = keyring::Entry::new("foxen", &keyring_key(host)) {
        if let Ok(json) = entry.get_password() {
            if let Ok(credential) = serde_json::from_str::<Credential>(&json) {
                return Some(credential);
            }
        }
    }
    memory_store()
        .iter()
        .find(|(h, _)| h == host)
        .map(|(_, c)| c.clone())
}

/// Olvida las credenciales de un host.
pub fn forget_credential(host: &str) -> AppResult<()> {
    let _ = keyring::Entry::new("foxen", &keyring_key(host)).and_then(|e| e.delete_credential());
    memory_store().retain(|(h, _)| h != host);
    Ok(())
}

/// Extrae el host de una URL de remoto para indexar credenciales.
pub fn url_host(url: &str) -> String {
    url::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_string()))
        .or_else(|| {
            // Formato scp-like: git@github.com:owner/repo.git
            url.split('@')
                .nth(1)
                .and_then(|rest| rest.split(':').next())
                .map(|h| h.to_string())
        })
        .unwrap_or_else(|| url.to_string())
}

/// Callbacks de autenticacion para una operacion de red.
///
/// Cuando no hay credenciales disponibles se devuelve `None`, lo que hace que
/// libgit2 falle con un error de autenticacion claro en vez de bloquear la UI.
pub fn callbacks(host: String, credential: Option<Credential>) -> RemoteCallbacks<'static> {
    let mut cb = RemoteCallbacks::new();

    // `Cred` es una struct en git2 0.20 y el callback debe devolver
    // `Result<Cred, Error>`: se construye con los helpers correspondant al tipo
    // de credencial que el servidor admite.
    cb.credentials(move |url, username_from_url, allowed_types| {
        if allowed_types.contains(CredentialType::SSH_KEY)
            || allowed_types.contains(CredentialType::SSH_CUSTOM)
        {
            return Cred::ssh_key_from_agent(username_from_url.unwrap_or("git"));
        }

        if !allowed_types.contains(CredentialType::USER_PASS_PLAINTEXT) {
            return Err(git2::Error::from_str("tipo de credencial no soportado"));
        }

        // Orden de resolucion:
        // 1. Credencial de sesion (aportada explicitamente por el usuario).
        // 2. Llavero del sistema (PAT o token guardado por Foxen).
        // 3. Helpers de git del sistema (gh, Git Credential Manager, libsecret...).
        let credential = credential
            .clone()
            .or_else(|| lookup_credential(&host))
            .or_else(|| credential_from_helper(&host, url));

        match credential {
            Some(c) => {
                let user = if c.username.is_empty() {
                    username_from_url
                        .map(|u| u.to_string())
                        .unwrap_or_else(|| default_username(url).to_string())
                } else {
                    c.username
                };
                Cred::userpass_plaintext(&user, &c.password)
            }
            None => Err(git2::Error::from_str(
                "No hay credenciales para este host; inicia sesion en GitHub o guarda un token en Foxen",
            )),
        }
    });

    cb.transfer_progress(|_| true);
    cb
}

/// Resuelve credenciales con los helpers de git del sistema (`git credential fill`).
///
/// libgit2 no ejecuta por si solo los `credential.helper` configurados (el que
/// instala `gh auth login`, `osxkeychain`, `libsecret`, etc.), asi que se invocan
/// aqui como ultimo recurso. Solo aplica a HTTP(S): SSH va por `ssh-agent`.
fn credential_from_helper(host: &str, url: &str) -> Option<Credential> {
    use std::io::Write;
    use std::process::{Command, Stdio};

    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return None;
    }
    let protocol = if url.starts_with("http://") {
        "http"
    } else {
        "https"
    };

    let mut child = Command::new("git")
        .args(["credential", "fill"])
        // Sin prompts de terminal ni ventanas: si el helper no tiene nada, falla.
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;

    {
        let stdin = child.stdin.as_mut()?;
        let input = format!("protocol={protocol}\nhost={host}\n\n");
        stdin.write_all(input.as_bytes()).ok()?;
    }

    let output = child.wait_with_output().ok()?;
    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut username = String::new();
    let mut password = String::new();
    for line in stdout.lines() {
        if let Some(value) = line.strip_prefix("username=") {
            username = value.to_string();
        } else if let Some(value) = line.strip_prefix("password=") {
            password = value.to_string();
        }
    }

    if password.is_empty() {
        return None;
    }

    Some(Credential { username, password })
}

/// Usuario por defecto segun el esquema de la URL.
///
/// HTTPS y SSH usan el mismo helper de git, asi que el usuario es siempre
/// `git`; se mantiene la funcion para dejar el punto unico de cambio.
fn default_username(_url: &str) -> &'static str {
    "git"
}

// ---------------------------------------------------------------------------
// Remotos
// ---------------------------------------------------------------------------

/// Lista los remotos configurados.
pub fn list_remotes(repo: &Repository) -> AppResult<Vec<RemoteInfo>> {
    let mut remotes = Vec::new();

    for name in repo.remotes().map_err(AppError::from_git)?.iter().flatten() {
        let Ok(remote) = repo.find_remote(name) else {
            continue;
        };
        let url = remote.url().unwrap_or_default().to_string();
        remotes.push(RemoteInfo {
            name: name.to_string(),
            host: url_host(&url),
            url,
            push_url: remote.pushurl().map(|u| u.to_string()),
            fetch_refspecs: fetch_refspecs(&remote),
            push_refspecs: push_refspecs(&remote),
            reachable: false,
        });
    }

    Ok(remotes)
}

/// Agrega un remoto.
pub fn add_remote(
    repo: &Repository,
    name: &str,
    url: &str,
    push_url: Option<&str>,
    mirror: bool,
) -> AppResult<RemoteInfo> {
    validate_remote_name(name)?;
    validate_url(url)?;

    if repo.find_remote(name).is_ok() {
        return Err(AppError::invalid_state(format!(
            "Ya existe un remoto llamado {name}"
        )));
    }

    // `Repository::remote` crea el remoto con el refspec estandar de fetch.
    let _remote = repo.remote(name, url).map_err(AppError::from_git)?;

    // Los setters de push URL y refspecs viven en `Repository` en git2 0.20.
    if let Some(push) = push_url.filter(|p| !p.is_empty()) {
        validate_url(push)?;
        repo.remote_set_pushurl(name, Some(push))
            .map_err(AppError::from_git)?;
    }

    if mirror {
        repo.remote_add_fetch(name, "+refs/*:refs/*")
            .map_err(AppError::from_git)?;
        repo.remote_add_push(name, "+refs/*:refs/*")
            .map_err(AppError::from_git)?;
    }

    let remote = repo.find_remote(name).map_err(AppError::from_git)?;
    let url = remote.url().unwrap_or_default().to_string();

    Ok(RemoteInfo {
        name: name.to_string(),
        host: url_host(&url),
        url,
        push_url: remote.pushurl().map(|u| u.to_string()),
        fetch_refspecs: fetch_refspecs(&remote),
        push_refspecs: push_refspecs(&remote),
        reachable: false,
    })
}

/// Refspecs de fetch de un remoto.
fn fetch_refspecs(remote: &git2::Remote<'_>) -> Vec<String> {
    remote
        .refspecs()
        .map(|r| r.str().unwrap_or_default().to_string())
        .collect()
}

/// Refspecs de push de un remoto (configurables, no usan `Remote::refspecs`).
fn push_refspecs(remote: &git2::Remote<'_>) -> Vec<String> {
    remote
        .push_refspecs()
        .map(|array| array.iter().flatten().map(|s| s.to_string()).collect())
        .unwrap_or_default()
}

/// Renombra un remoto.
pub fn rename_remote(repo: &Repository, old: &str, new: &str) -> AppResult<OperationResult> {
    validate_remote_name(new)?;
    if repo.find_remote(old).is_err() {
        return Err(AppError::not_found(format!("No existe el remoto {old}")));
    }
    repo.remote_rename(old, new).map_err(AppError::from_git)?;
    Ok(OperationResult::ok(format!("Remoto {old} renombrado a {new}")))
}

/// Elimina un remoto.
pub fn remove_remote(repo: &Repository, name: &str) -> AppResult<OperationResult> {
    if repo.find_remote(name).is_err() {
        return Err(AppError::not_found(format!("No existe el remoto {name}")));
    }
    repo.remote_delete(name).map_err(AppError::from_git)?;
    Ok(OperationResult::ok(format!("Remoto {name} eliminado")))
}

fn validate_remote_name(name: &str) -> AppResult<()> {
    if name.trim().is_empty() {
        return Err(AppError::validation("El nombre del remoto esta vacio"));
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
    {
        return Err(AppError::validation(
            "El nombre del remoto solo admite letras, digitos, punto, guion y guion bajo",
        ));
    }
    Ok(())
}

fn validate_url(url: &str) -> AppResult<()> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err(AppError::validation("La URL del remoto esta vacia"));
    }
    let supported = ["http://", "https://", "ssh://", "git://", "file://", "git@"];
    if !supported.iter().any(|p| trimmed.starts_with(p)) {
        return Err(AppError::validation(format!(
            "URL no soportada: {trimmed}. Se admiten http, https, ssh, git, file y scp-like (git@host:repo)"
        )));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

/// Descarga objetos y refs de uno o todos los remotos.
pub fn fetch(
    repo: &Repository,
    remote_name: Option<&str>,
    prune: bool,
    credential: Option<&Credential>,
) -> AppResult<FetchResult> {
    let start = Instant::now();

    let names: Vec<String> = match remote_name {
        Some(name) => vec![name.to_string()],
        None => repo
            .remotes()
            .map_err(AppError::from_git)?
            .iter()
            .flatten()
            .map(|s| s.to_string())
            .collect(),
    };

    if names.is_empty() {
        return Err(AppError::invalid_state("El repositorio no tiene remotos configurados"));
    }

    let mut total = FetchResult {
        remote: names[0].clone(),
        ..Default::default()
    };
    let mut messages: Vec<String> = Vec::new();

    for name in &names {
        let result = fetch_one(repo, name, prune, credential)?;
        total.refs_updated += result.refs_updated;
        total.refs_deleted += result.refs_deleted;
        total.new_branches.extend(result.new_branches);
        total.deleted_branches.extend(result.deleted_branches);
        if !result.message.is_empty() {
            messages.push(result.message);
        }
    }

    total.message = if messages.is_empty() {
        format!("{} al dia", names.join(", "))
    } else {
        messages.join("; ")
    };
    total.duration_ms = elapsed_ms(start);
    Ok(total)
}

/// Fetch de un unico remoto, con deteccion de altas y bajas de refs.
fn fetch_one(
    repo: &Repository,
    name: &str,
    prune: bool,
    credential: Option<&Credential>,
) -> AppResult<FetchResult> {
    let mut remote = repo
        .find_remote(name)
        .map_err(|_| AppError::not_found(format!("No existe el remoto {name}")))?;

    let url = remote.url().unwrap_or_default().to_string();
    let host = url_host(&url);

    let before = remote_refs(repo, name);

    let mut options = FetchOptions::new();
    options.remote_callbacks(callbacks(host.clone(), credential.cloned()));
    options.download_tags(git2::AutotagOption::All);
    options.update_fetchhead(true);
    if prune {
        options.prune(git2::FetchPrune::On);
    }

    // `remote.fetch` conecta internamente usando `options` (y por tanto los
    // callbacks de autenticacion). No hay que llamar a `remote.connect` antes:
    // esa variante conecta SIN callbacks y falla con repos privados.
    let refspecs: Vec<String> = Vec::new();
    remote
        .fetch(&refspecs, Some(&mut options), None)
        .map_err(|e| network_error(e, name))?;

    if let Some(cred) = credential {
        // Persistir solo si el fetch tuvo exito con esas credenciales.
        store_credential(&host, cred)?;
    }

    let after = remote_refs(repo, name);
    let new_branches: Vec<String> = after
        .keys()
        .filter(|k| !before.contains_key(*k))
        .cloned()
        .collect();
    let deleted_branches: Vec<String> = before
        .keys()
        .filter(|k| !after.contains_key(*k))
        .cloned()
        .collect();
    let refs_updated = after
        .iter()
        .filter(|(k, v)| before.get(*k) != Some(*v))
        .count();

    let mut message = format!(
        "{name}: {refs_updated} ref(s) actualizada(s), {} nueva(s), {} eliminada(s)",
        new_branches.len(),
        deleted_branches.len()
    );
    if new_branches.is_empty() && deleted_branches.is_empty() && refs_updated == 0 {
        message = format!("{name}: sin cambios");
    }

    Ok(FetchResult {
        remote: name.to_string(),
        refs_updated,
        refs_deleted: deleted_branches.len(),
        new_branches,
        deleted_branches,
        objects_received: 0,
        duration_ms: 0,
        message,
    })
}

/// Refs de seguimiento remoto de un remoto concreto.
fn remote_refs(repo: &Repository, remote: &str) -> HashMap<String, git2::Oid> {
    let mut map = HashMap::new();
    let Ok(references) = repo.references_glob(&format!("refs/remotes/{remote}/*")) else {
        return map;
    };
    for reference in references.flatten() {
        if let (Some(name), Some(oid)) = (reference.name(), reference.target()) {
            map.insert(name.to_string(), oid);
        }
    }
    map
}

/// Traduce errores de red a mensajes accionables.
fn network_error(err: git2::Error, remote: &str) -> AppError {
    let hint = match err.class() {
        git2::ErrorClass::Net => "Verifica la conexion, el proxy y la URL del remoto",
        git2::ErrorClass::Ssh => {
            "Comprueba que tu clave SSH este en el agente (ssh-add) y autorizada en el servidor"
        }
        git2::ErrorClass::Http => {
            "El servidor rechazo la peticion: revisa token, usuario y permisos de escritura"
        }
        _ => "",
    };

    let (kind, message) = match err.code() {
        git2::ErrorCode::Auth => (
            ErrorKind::Authentication,
            format!("Fallo de autenticacion en {remote}"),
        ),
        git2::ErrorCode::Certificate => (
            ErrorKind::Network,
            format!("Certificado no valido en {remote}"),
        ),
        _ => (
            ErrorKind::Network,
            format!("Fallo de red con {remote}: {}", err.message()),
        ),
    };

    AppError::new(kind, message).with_detail(hint)
}

// ---------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------

/// Envia refs locales al remoto.
#[allow(clippy::too_many_arguments)]
pub fn push(
    repo: &Repository,
    remote_name: &str,
    branch: Option<&str>,
    force: bool,
    set_upstream: bool,
    delete_remote: bool,
    credential: Option<&Credential>,
) -> AppResult<PushResult> {
    use std::sync::{Arc, Mutex};

    let start = Instant::now();

    let mut remote = repo
        .find_remote(remote_name)
        .map_err(|_| AppError::not_found(format!("No existe el remoto {remote_name}")))?;

    let host = url_host(remote.url().unwrap_or_default());

    let mut refspecs: Vec<String> = Vec::new();
    if let Some(name) = branch {
        let full = if name.starts_with("refs/") {
            name.to_string()
        } else {
            format!("refs/heads/{name}")
        };
        refspecs.push(if delete_remote {
            format!(":{full}")
        } else if force {
            // `+` es lo que convierte el refspec en un force push real.
            format!("+{full}:{full}")
        } else {
            format!("{full}:{full}")
        });
    } else if !delete_remote {
        let prefix = if force { "+" } else { "" };
        refspecs.push(format!("{prefix}refs/heads/*:refs/heads/*"));
    }

    if refspecs.is_empty() {
        return Err(AppError::validation("No hay refs que enviar"));
    }

    // El callback de actualizacion informa que refs cambio el servidor de verdad:
    // asi el resultado refleja la realidad (y no el numero de refspecs).
    let updated_refs: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let rejected: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));

    let mut options = PushOptions::new();
    {
        let mut cbs = callbacks(host.clone(), credential.cloned());
        let updated_refs = Arc::clone(&updated_refs);
        let rejected = Arc::clone(&rejected);
        cbs.push_update_reference(move |refname, status| {
            match status {
                None => {
                    if let Ok(mut refs) = updated_refs.lock() {
                        refs.push(refname.to_string());
                    }
                }
                Some(error) => {
                    if let Ok(mut refs) = rejected.lock() {
                        refs.push(format!("{refname}: {error}"));
                    }
                }
            }
            Ok(())
        });
        options.remote_callbacks(cbs);
    }

    let specs: Vec<&str> = refspecs.iter().map(|s| s.as_str()).collect();

    // `remote.push` conecta internamente usando `options` (con los callbacks de
    // autenticacion). No llamar antes a `remote.connect`: conecta sin callbacks.
    remote
        .push(&specs, Some(&mut options))
        .map_err(|e| network_error(e, remote_name))?;

    let updated_refs = updated_refs.lock().map(|r| r.clone()).unwrap_or_default();
    let rejected = rejected.lock().map(|r| r.clone()).unwrap_or_default();

    if set_upstream {
        if let Some(name) = branch {
            let short = name.strip_prefix("refs/heads/").unwrap_or(name);
            // Fijar el upstream no es fatal: el push ya se completo, la rama
            // simplemente no quedaria marcada como de seguimiento.
            let _ = set_branch_upstream(repo, short, remote_name);
        }
    }

    if let Some(cred) = credential {
        store_credential(&host, cred)?;
    }

    let updated = updated_refs.len();
    let rejected_updates = !rejected.is_empty();
    let up_to_date = updated == 0 && !rejected_updates;

    let message = if rejected_updates {
        format!("El remoto rechazo: {}", rejected.join("; "))
    } else if delete_remote && updated > 0 {
        format!("{updated} ref(s) eliminada(s) en {remote_name}")
    } else if up_to_date {
        "Todo estaba actualizado".to_string()
    } else {
        format!("{updated} ref(s) enviada(s) a {remote_name}")
    };

    if rejected_updates {
        return Err(AppError::new(
            ErrorKind::Network,
            format!("El remoto {remote_name} rechazo la actualizacion"),
        )
        .with_detail(rejected.join("; ")));
    }

    Ok(PushResult {
        remote: remote_name.to_string(),
        branch: branch.unwrap_or("*").to_string(),
        refs_updated: updated,
        refs_deleted: if delete_remote { updated } else { 0 },
        forced: force,
        up_to_date,
        message,
        duration_ms: elapsed_ms(start),
    })
}

/// Marca `branch` como de seguimiento de `remote/branch`.
///
/// `Branch::set_upstream` exige que ya exista la ref de seguimiento remoto; si
/// el push aun no la ha creado (p. ej. primer push de una rama nueva) se cae a
/// escribir la configuracion `branch.<name>.remote/merge` directamente.
fn set_branch_upstream(repo: &Repository, branch: &str, remote: &str) -> AppResult<()> {
    if let Ok(mut local) = repo.find_branch(branch, git2::BranchType::Local) {
        if local.set_upstream(Some(&format!("{remote}/{branch}"))).is_ok() {
            return Ok(());
        }
    }

    let mut config = repo.config().map_err(AppError::from_git)?;
    config
        .set_str(&format!("branch.{branch}.remote"), remote)
        .map_err(AppError::from_git)?;
    config
        .set_str(
            &format!("branch.{branch}.merge"),
            &format!("refs/heads/{branch}"),
        )
        .map_err(AppError::from_git)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Pull
// ---------------------------------------------------------------------------

/// Integra los cambios de un remoto en la rama actual.
///
/// Siempre hace fetch primero: integrar sin tener los objetos en disco fallaria.
pub fn pull(
    repo: &mut Repository,
    remote_name: Option<&str>,
    branch: Option<&str>,
    rebase: bool,
    prune: bool,
    credential: Option<&Credential>,
) -> AppResult<FetchResult> {
    let start = Instant::now();
    let (remote, branch) = resolve_pull_target(repo, remote_name, branch)?;

    // 1. Fetch.
    let fetched = fetch(repo, Some(&remote), prune, credential)?;

    // 2. Rama remota de destino.
    let remote_ref = format!("refs/remotes/{remote}/{branch}");
    if repo.find_reference(&remote_ref).is_err() {
        return Err(AppError::not_found(format!(
            "El remoto {remote} no tiene la rama {branch}"
        ))
        .with_detail("Ejecuta fetch y verifica el nombre de la rama remota"));
    }

    // 3. Integrar (merge o rebase).
    let integration = if rebase {
        crate::git::merge::rebase(repo, &remote_ref, true)
    } else {
        crate::git::merge::merge(
            repo,
            crate::git::merge::MergeOptions2 {
                target: remote_ref,
                no_ff: false,
                ff_only: false,
                squash: false,
                message: None,
            },
        )
    }?;

    let summary = fetched_message(&fetched);
    let mut message = format!("{summary} {}", integration.message);

    if !integration.conflicted_files.is_empty() {
        message.push_str(&format!(
            " Conflictos: {}",
            integration.conflicted_files.join(", ")
        ));
    }

    Ok(FetchResult {
        remote,
        refs_updated: fetched.refs_updated,
        refs_deleted: fetched.refs_deleted,
        new_branches: fetched.new_branches,
        deleted_branches: fetched.deleted_branches,
        objects_received: fetched.objects_received,
        duration_ms: elapsed_ms(start),
        message,
    })
}

fn fetched_message(result: &FetchResult) -> String {
    if result.message.is_empty() {
        format!("Pull desde {}:", result.remote)
    } else {
        format!("Pull: {}", result.message)
    }
}

/// Determina el remoto y la rama a integrar.
fn resolve_pull_target(
    repo: &Repository,
    remote_name: Option<&str>,
    branch: Option<&str>,
) -> AppResult<(String, String)> {
    let current = repo
        .head()
        .ok()
        .filter(|h| h.is_branch())
        .and_then(|h| h.shorthand().map(|s| s.to_string()));

    if let Some(remote) = remote_name {
        let branch = branch
            .map(|b| b.to_string())
            .or(current)
            .ok_or_else(|| {
                AppError::invalid_state(
                    "HEAD esta desligado; indica la rama de destino del pull",
                )
            })?;
        return Ok((remote.to_string(), branch));
    }

    // Sin remoto explicito: preferir el upstream de la rama actual.
    if let Some(current) = current {
        if let Ok(local) = repo.find_branch(&current, git2::BranchType::Local) {
            if let Ok(upstream) = local.upstream() {
                if let Ok(Some(name)) = upstream.name() {
                    let short = crate::git::util::shorten_ref(name);
                    if let Some((remote, branch)) = short.split_once('/') {
                        return Ok((remote.to_string(), branch.to_string()));
                    }
                }
            }
        }
        let remote = repo
            .remotes()
            .map_err(AppError::from_git)?
            .iter()
            .flatten()
            .next()
            .map(|s| s.to_string())
            .unwrap_or_else(|| "origin".to_string());
        return Ok((remote, current));
    }

    let branch = branch.ok_or_else(|| {
        AppError::invalid_state("HEAD esta desligado; indica la rama de destino del pull")
    })?;
    Ok(("origin".to_string(), branch.to_string()))
}

// ---------------------------------------------------------------------------
// Estado del remoto
// ---------------------------------------------------------------------------

/// Indica si un remoto tiene al menos una rama local siguiendo una remota suya.
pub fn has_tracking_branches(repo: &Repository, remote: &str) -> bool {
    !remote_refs(repo, remote).is_empty()
}

/// Estado del worktree antes de una operacion de red, por seguridad.
pub fn worktree_snapshot(repo: &Repository) -> StatusSummary {
    let mut options = git2::StatusOptions::new();
    options.include_untracked(true).recurse_untracked_dirs(true);
    match repo.statuses(Some(&mut options)) {
        Ok(list) => StatusSummary {
            clean: list.is_empty(),
            entries: list.len(),
        },
        Err(_) => StatusSummary {
            clean: true,
            entries: 0,
        },
    }
}

/// Resumen del estado del working tree.
pub struct StatusSummary {
    pub clean: bool,
    pub entries: usize,
}

/// Clona un repositorio en una ruta de destino usando las credenciales guardadas si existen.
pub fn clone_repository(url: &str, destination: &std::path::Path) -> AppResult<()> {
    let host = url_host(url);
    let credential = lookup_credential(&host);

    let mut fetch_opts = FetchOptions::new();
    fetch_opts.remote_callbacks(callbacks(host, credential));

    let mut builder = git2::build::RepoBuilder::new();
    builder.fetch_options(fetch_opts);

    builder
        .clone(url, destination)
        .map_err(|e| AppError::from_git(e).with_detail(format!("URL: {url}, Destino: {}", destination.display())))?;
    Ok(())
}