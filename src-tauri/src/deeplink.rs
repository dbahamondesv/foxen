//! Enlaces de clonado recibidos por linea de comandos o segunda instancia.
//!
//! El `.desktop` registra `x-scheme-handler/git`, asi que al pulsar un enlace
//! `git://…` el navegador lanza `foxen <url>` (o se lo pasa a la instancia ya
//! abierta, via `tauri-plugin-single-instance`). Aqui se filtra la URL, se
//! guarda como pendiente y el frontend decide donde clonar.

use parking_lot::Mutex;

/// Evento con una URL de clonado recibida mientras la app ya estaba abierta.
pub const CLONE_REQUEST_EVENT: &str = "git://clone-request";

/// URL pendiente de recoger por el frontend (primer arranque).
#[derive(Default)]
pub struct PendingCloneUrl(Mutex<Option<String>>);

impl PendingCloneUrl {
    pub fn set(&self, url: String) {
        *self.0.lock() = Some(url);
    }

    pub fn take(&self) -> Option<String> {
        self.0.lock().take()
    }
}

/// Extrae la primera URL de clonado de los argumentos del proceso.
///
/// Se aceptan solo enlaces inequivocamente git: `git://`, `ssh://` y
/// `http(s)://…*.git`. Asi un `xdg-open` accidental con otra URL no dispara un
/// clonado.
pub fn clone_url_from_args<I>(args: I) -> Option<String>
where
    I: IntoIterator<Item = String>,
{
    args.into_iter().find_map(|arg| normalize_clone_url(&arg))
}

fn normalize_clone_url(arg: &str) -> Option<String> {
    let url = url::Url::parse(arg.trim()).ok()?;
    let accepted = match url.scheme() {
        "git" | "ssh" => url.host_str().is_some_and(|host| !host.is_empty()),
        "http" | "https" => url.path().ends_with(".git"),
        _ => false,
    };
    accepted.then(|| url.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn acepta_esquemas_git() {
        assert_eq!(
            clone_url_from_args(args(&["git://github.com/foxen/foxen.git"])),
            Some("git://github.com/foxen/foxen.git".to_string())
        );
        assert_eq!(
            clone_url_from_args(args(&["ssh://git@github.com/foxen/foxen.git"])),
            Some("ssh://git@github.com/foxen/foxen.git".to_string())
        );
        assert_eq!(
            clone_url_from_args(args(&["https://github.com/foxen/foxen.git"])),
            Some("https://github.com/foxen/foxen.git".to_string())
        );
    }

    #[test]
    fn ignora_urls_ajenas_y_argumentos() {
        assert_eq!(clone_url_from_args(args(&["--flag"])), None);
        assert_eq!(clone_url_from_args(args(&["https://example.com/docs"])), None);
        assert_eq!(clone_url_from_args(args(&["file:///tmp/x.git"])), None);
    }

    #[test]
    fn acepta_ssh_sin_usuario() {
        assert_eq!(
            clone_url_from_args(args(&["ssh://github.com/foxen/foxen.git"])),
            Some("ssh://github.com/foxen/foxen.git".to_string())
        );
    }

    #[test]
    fn el_primero_gana() {
        assert_eq!(
            clone_url_from_args(args(&[
                "foxen",
                "https://github.com/a/b.git",
                "https://github.com/c/d.git",
            ])),
            Some("https://github.com/a/b.git".to_string())
        );
    }
}
