//! Foxen: cliente de escritorio para gestionar repositorios y ramas git.
//!
//! La logica vive aqui; `main.rs` es solo un pasador fino porque Tauri reemplaza
//! `main()` por `mobile_entry_point` en compilaciones moviles.

pub mod commands;
pub mod deeplink;
pub mod error;
pub mod git;
pub mod pty;
pub mod settings;
pub mod terminal;
pub mod types;
pub mod watch;

use error::AppError;
use git::repo::AppState;

/// Registro de todos los comandos IPC-exposed.
///
/// Un comando ausente de esta lista falla en tiempo de ejecucion con
/// "command not found", no en tiempo de compilacion.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Debe ser el primer plugin: intercepta el arranque de la segunda
        // instancia para que la ventana existente reciba los argumentos.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            use tauri::{Emitter, Manager};
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
                let _ = window.unminimize();
            }
            // La segunda instancia puede traer un enlace git:// (xdg-open).
            if let Some(url) = deeplink::clone_url_from_args(argv) {
                app.state::<deeplink::PendingCloneUrl>().set(url.clone());
                let _ = app.emit(deeplink::CLONE_REQUEST_EVENT, serde_json::json!({ "url": url }));
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        // En Tauri 2 el estado se registra en el builder, no en `setup`.
        .manage(AppState::new())
        .manage(watch::WatchRegistry::default())
        .manage(deeplink::PendingCloneUrl::default())
        .manage(pty::PtyState::default())
        .setup(|app| {
            use std::fs::OpenOptions;
            use std::io::Write;
            
            let log_dir = dirs::cache_dir()
                .unwrap_or_else(std::env::temp_dir)
                .join("foxen");
            let _ = std::fs::create_dir_all(&log_dir);
            let log_path = log_dir.join(format!("foxen-dev-{}.log", chrono::Local::now().format("%Y%m%d-%H%M%S")));
            
            if let Ok(file) = OpenOptions::new().create(true).append(true).open(&log_path) {
                let file = std::sync::Arc::new(std::sync::Mutex::new(file));
                let file_clone = file.clone();
                env_logger::Builder::from_env(
                    env_logger::Env::default().default_filter_or("debug,foxen=trace"),
                )
                .format(move |buf, record| {
                    let ts = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
                    let line = format!("[{} {} {}] {}\n", ts, record.level(), record.target(), record.args());
                    let _ = writeln!(buf, "{}", line.trim_end());
                    if let Ok(mut f) = file_clone.lock() {
                        let _ = f.write_all(line.as_bytes());
                        let _ = f.flush();
                    }
                    Ok(())
                })
                .try_init()
                .ok();
                eprintln!("FOXEN_LOG_FILE={}", log_path.display());
            } else {
                env_logger::Builder::from_env(
                    env_logger::Env::default().default_filter_or("info,foxen=debug"),
                )
                .try_init()
                .ok();
            }

            use tauri::Manager;
            // Primer arranque con un enlace (xdg-open): queda pendiente hasta
            // que el frontend lo recoja con `take_pending_clone_url`.
            if let Some(url) = deeplink::clone_url_from_args(std::env::args().skip(1)) {
                app.state::<deeplink::PendingCloneUrl>().set(url);
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_title("Foxen");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Repositorios
            commands::open_repository,
            commands::clone_repository,
            commands::close_repository,
            commands::take_pending_clone_url,
            commands::settings_load,
            commands::settings_save_session,
            commands::settings_save_theme,
            commands::settings_save_locale,
            commands::list_repositories,
            commands::recent_repositories,
            commands::scan_for_repositories,
            // Grafo y ramas
            commands::load_graph,
            commands::list_branches,
            commands::create_branch,
            commands::checkout_branch,
            commands::delete_branch,
            commands::rename_branch,
            commands::set_upstream,
            commands::reset_branch,
            // Commits
            commands::create_commit,
            commands::get_commit_detail,
            commands::cherry_pick,
            commands::revert_commit,
            commands::delete_commit,
            commands::move_branch_to,
            commands::list_file_history,
            commands::list_reflog,
            // Estado y staging
            commands::get_status,
            commands::get_diff,
            commands::stage_files,
            commands::unstage_files,
            commands::stage_all,
            commands::discard_files,
            commands::stage_hunks,
            commands::discard_hunk,
            commands::resolve_conflict,
            // Merge y rebase
            commands::merge_branch,
            commands::merge_into,
            commands::abort_merge,
            commands::merge_continue,
            commands::plan_rebase,
            commands::rebase_onto,
            commands::rebase_continue,
            commands::rebase_skip,
            commands::rebase_abort,
            commands::compare_branches,
            commands::repository_operation_state,
            // Stash
            commands::list_stashes,
            commands::push_stash,
            commands::apply_stash,
            commands::pop_stash,
            commands::drop_stash,
            commands::clear_stashes,
            commands::branch_from_stash,
            // Remotos
            commands::list_remotes,
            commands::add_remote,
            commands::rename_remote,
            commands::remove_remote,
            commands::fetch_remote,
            commands::push_remote,
            commands::pull_remote,
            commands::store_credential,
            commands::forget_credential,
            commands::credential_status,
            commands::test_remote,
            // GitHub Auth
            commands::github_auth::github_start_login,
            commands::github_auth::github_poll_login,
            commands::github_auth::github_login_complete,
            commands::github_auth::github_login_with_gh,
            commands::git_auth_setup_gh,
            commands::git_auth_status_gh,
            commands::github_auth::github_device_flow_configured,
            commands::github_auth::github_get_user,
            commands::github_auth::github_logout,
            commands::github_auth::github_list_repos,
            commands::github_auth::github_create_repo,
            commands::github_auth::github_publish_repo,
            // Git Flow
            commands::flow_status,
            commands::flow_init,
            commands::flow_disable,
            commands::flow_feature_start,
            commands::flow_feature_finish,
            commands::flow_release_start,
            commands::flow_release_finish,
            commands::flow_hotfix_start,
            commands::flow_hotfix_finish,
            // Tags
            commands::list_tags,
            commands::create_tag,
            commands::delete_tag,
            commands::suggest_tag,
            // Sistema
            commands::open_terminal,
            // Terminal embebida
            commands::start_pty,
            commands::write_pty,
            commands::resize_pty,
            commands::stop_pty,
        ])
        .run(tauri::generate_context!())
        .expect("error al ejecutar Foxen");
}

/// Reexportado para que los comandos usen un unico tipo de error.
pub type Result<T> = error::AppResult<T>;

/// Silencia el warning de import no usado cuando no hay comandos que usen AppError.
#[allow(dead_code)]
fn _assert_error_type(_: AppError) {}
