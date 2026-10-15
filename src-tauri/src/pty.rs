//! Terminal embebida de Foxen.
//!
//! Cada repositorio con la terminal abierta tiene una PTY propia con el shell
//! del usuario como hijo. Foxen no interpreta ANSI: solo transporta bytes
//! entre la PTY y el emulador (`@xterm/xterm`) que vive en el frontend.
//!
//! La salida viaja en base64 dentro de un [`Channel`] de Tauri, que es el
//! conducto pensado para streaming en Tauri 2 (no satura el bus de eventos
//! como haria `emit` a cada trozo).

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::mpsc;
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use parking_lot::Mutex;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use tauri::ipc::Channel;

use crate::error::{AppError, AppResult, ErrorKind};

/// Mensaje de salida hacia el frontend.
#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyOutput {
    /// Trozo de salida codificado en base64.
    pub data: String,
    /// `true` solo en el ultimo mensaje: el proceso ha terminado.
    pub exited: bool,
}

/// Ventana de agrupacion: evita un mensaje IPC por cada `write()` del hijo.
const FLUSH_EVERY: Duration = Duration::from_millis(16);
/// Tamaño maximo de un mensaje antes de mandarlo sin esperar.
const FLUSH_BYTES: usize = 16 * 1024;
const READ_BUF: usize = 8 * 1024;

struct Session {
    writer: Box<dyn Write + Send>,
    master: Box<dyn portable_pty::MasterPty>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

/// Mapa compartido. El `Drop` vive aqui y no en [`PtyState`] para que clonar
/// el handle no mate los shells: solo el ultimo referencia lo cierra.
#[derive(Default)]
struct Sessions {
    inner: Mutex<HashMap<String, Session>>,
}

impl Drop for Sessions {
    fn drop(&mut self) {
        // Al cerrar la app los shells no deben quedar huerfanos.
        for (_, mut session) in self.inner.lock().drain() {
            let _ = session.child.kill();
        }
    }
}

/// Sesiones vivas, una por repositorio.
///
/// Va detras de `Arc` para que el handle clonado que recibe un comando sea
/// barato, igual que `AppState`.
#[derive(Clone, Default)]
pub struct PtyState {
    sessions: Arc<Sessions>,
}

/// Shell a arrancar: el preferido por el usuario si lo conocemos.
fn shell_program() -> String {
    std::env::var("SHELL")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "/bin/sh".to_string())
}

fn pty_error(context: &str, err: impl std::fmt::Display) -> AppError {
    AppError::new(ErrorKind::Io, context).with_detail(err.to_string())
}

impl PtyState {
    /// Arranca un shell en `cwd` y empieza a enviar su salida por `channel`.
    ///
    /// Si ya habia una terminal para este repositorio se mata antes: solo
    /// puede haber una abierta a la vez.
    pub fn start(
        &self,
        repo_id: &str,
        cwd: &Path,
        cols: u16,
        rows: u16,
        channel: Channel<PtyOutput>,
    ) -> AppResult<()> {
        self.stop(repo_id);

        let pair = native_pty_system()
            .openpty(PtySize {
                rows: rows.max(1),
                cols: cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| pty_error("No se pudo crear la terminal", e))?;

        let mut cmd = CommandBuilder::new(shell_program());
        cmd.cwd(cwd);
        // Sin TERM se rompen los colores y las flechas del prompt.
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| pty_error("No se pudo arrancar el shell", e))?;
        // Soltar el extremo eslavo del padre es lo que hace que el lector vea
        // EOF cuando el hijo termina; el hijo conserva su propia copia.
        drop(pair.slave);

        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| pty_error("No se pudo leer la terminal", e))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| pty_error("No se pudo escribir en la terminal", e))?;

        self.sessions.inner.lock().insert(
            repo_id.to_string(),
            Session {
                writer,
                master: pair.master,
                child,
            },
        );

        std::thread::spawn(move || pump(reader, channel));
        Ok(())
    }

    /// Escribe en la PTY los bytes que trae `data` codificados en base64.
    pub fn write(&self, repo_id: &str, data: &str) -> AppResult<()> {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data.as_bytes())
            .map_err(|e| {
                AppError::new(ErrorKind::Validation, "Entrada de terminal no valida")
                    .with_detail(e.to_string())
            })?;

        let mut sessions = self.sessions.inner.lock();
        let session = sessions
            .get_mut(repo_id)
            .ok_or_else(|| AppError::new(ErrorKind::NotFound, "La terminal no esta abierta"))?;
        session
            .writer
            .write_all(&bytes)
            .and_then(|_| session.writer.flush())
            .map_err(|e| pty_error("No se pudo escribir en la terminal", e))
    }

    /// Redimensiona la PTY; el kernel avisa al hijo con `SIGWINCH`.
    pub fn resize(&self, repo_id: &str, cols: u16, rows: u16) -> AppResult<()> {
        let sessions = self.sessions.inner.lock();
        let session = sessions
            .get(repo_id)
            .ok_or_else(|| AppError::new(ErrorKind::NotFound, "La terminal no esta abierta"))?;
        session
            .master
            .resize(PtySize {
                rows: rows.max(1),
                cols: cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| pty_error("No se pudo redimensionar la terminal", e))
    }

    /// Mata el shell y cierra la sesion. No falla si no estaba abierta.
    pub fn stop(&self, repo_id: &str) {
        if let Some(mut session) = self.sessions.inner.lock().remove(repo_id) {
            let _ = session.child.kill();
            // Soltar `master`/`writer` cierra la PTY por si el hijo no murio.
            drop(session);
        }
    }
}

/// Lee la PTY en un hilo y manda la salida agrupada en otro.
///
/// Estan separados porque la lectura bloquea: sin el despachador no habria
/// forma de mandar lo que ya esta encolado cuando el hijo deja de escribir.
fn pump(mut reader: Box<dyn Read + Send>, channel: Channel<PtyOutput>) {
    let (tx, rx) = mpsc::channel::<Vec<u8>>();

    std::thread::spawn(move || {
        let mut buf = [0u8; READ_BUF];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
        // Al salir se suelta `tx`: el despachador ve el canal cortado.
    });

    let mut pending: Vec<u8> = Vec::new();
    loop {
        match rx.recv_timeout(FLUSH_EVERY) {
            Ok(chunk) => {
                pending.extend_from_slice(&chunk);
                if pending.len() >= FLUSH_BYTES {
                    send(&channel, &mut pending);
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if !pending.is_empty() {
                    send(&channel, &mut pending);
                }
            }
            // Todo leido y el lector ha terminado: suelta lo que quede.
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    if !pending.is_empty() {
        send(&channel, &mut pending);
    }
    let _ = channel.send(PtyOutput {
        data: String::new(),
        exited: true,
    });
}

fn send(channel: &Channel<PtyOutput>, pending: &mut Vec<u8>) {
    if pending.is_empty() {
        return;
    }
    let data = base64::engine::general_purpose::STANDARD.encode(&pending);
    pending.clear();
    let _ = channel.send(PtyOutput {
        data,
        exited: false,
    });
}

#[cfg(test)]
mod tests {
    use std::time::Instant;

    use tauri::ipc::InvokeResponseBody;

    use super::*;

    /// Prueba de extremo a extremo sin interfaz: arranca un shell real,
    /// teclea un comando y comprueba que la respuesta llega por el canal.
    #[test]
    fn a_shell_runs_and_answers() {
        let (tx, rx) = mpsc::channel::<PtyOutput>();
        // `Sender` no es `Sync` y el canal exige un cierre que lo sea.
        let tx = Mutex::new(tx);
        let channel = Channel::<PtyOutput>::new(move |body| {
            let InvokeResponseBody::Json(json) = body else {
                return Ok(());
            };
            let message: PtyOutput = serde_json::from_str(&json).expect("mensaje valido");
            let _ = tx.lock().send(message);
            Ok(())
        });

        let state = PtyState::default();
        state
            .start("test", std::env::temp_dir().as_path(), 80, 24, channel)
            .expect("terminal");

        // La salida es `zqxjwk-42`, algo que no aparece en lo tecleado: si
        // llega, el shell ha ejecutado el comando y no se ha limitado a eco.
        let command = base64::engine::general_purpose::STANDARD
            .encode("echo zqxjwk-$((6*7))\r");
        state.write("test", &command).expect("escritura");

        let mut output = String::new();
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            assert!(!remaining.is_zero(), "sin respuesta del shell: {output}");
            let message = rx.recv_timeout(remaining).expect("mensaje del canal");
            if !message.data.is_empty() {
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(message.data.as_bytes())
                    .expect("base64 valido");
                output.push_str(&String::from_utf8_lossy(&bytes));
            }
            assert!(!message.exited, "el shell termino antes de tiempo: {output}");
            if output.contains("zqxjwk-42") {
                break;
            }
        }

        state.resize("test", 100, 30).expect("resize");
        state.stop("test");
        assert!(
            state.sessions.inner.lock().is_empty(),
            "la sesion debia cerrarse"
        );
    }
}
