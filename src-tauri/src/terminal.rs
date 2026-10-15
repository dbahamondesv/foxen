//! Apertura de una terminal del sistema en una carpeta.
//!
//! Foxen no emula terminales: delega en el emulador que el usuario tenga
//! configurado en su escritorio. La prioridad va de lo generico a lo
//! concreto: primero la especificacion de terminal por defecto
//! (`xdg-terminal-exec`), que traduce los argumentos al emulador elegido por
//! el usuario, y despues una lista de emuladores habituales.

use std::path::Path;
use std::process::Command;

use crate::error::{AppError, AppResult, ErrorKind};

/// Un emulador candidato: binario y argumentos con que indicarle la carpeta.
struct Candidate {
    program: &'static str,
    args: Vec<String>,
}

/// `xdg-terminal-exec` solo sirve si el escritorio tiene una terminal
/// configurada: sin ella termina en silencio y con exito 0, lo que daria un
/// falso positivo. Se comprueba antes de lanzarlo.
fn xdg_terminal_exec(dir: &Path) -> Option<Candidate> {
    let out = Command::new("xdg-terminal-exec").arg("--print-id").output().ok()?;
    if !out.status.success() {
        return None;
    }
    if String::from_utf8_lossy(&out.stdout).trim().is_empty() {
        return None;
    }
    Some(Candidate {
        program: "xdg-terminal-exec",
        // Forma `--dir=<ruta>`: es la que documenta y la que su analizador de
        // argumentos (basado en shell) acepta sin ambiguedad.
        args: vec![format!("--dir={}", dir.display())],
    })
}

/// Emuladores conocidos, en orden de preferencia.
///
/// Todos se lanzan ademas con `current_dir` apuntando al repositorio, por si
/// el emulador hereda el directorio de trabajo del proceso padre en lugar de
/// usar el argumento.
fn candidates(dir: &Path) -> Vec<Candidate> {
    let d = dir.display().to_string();
    let mut list: Vec<Candidate> = Vec::new();

    if let Some(candidate) = xdg_terminal_exec(dir) {
        list.push(candidate);
    }

    // Cada emulador pide la carpeta de trabajo a su manera.
    let single = [
        "gnome-terminal",
        "xfce4-terminal",
        "tilix",
        "terminator",
        "kitty",
        "alacritty",
        "foot",
    ];
    for program in single {
        list.push(Candidate {
            program,
            args: vec![format!("--working-directory={d}")],
        });
    }

    // Ptyxis es de instancia unica: sin `--new-window` reaprovecha la ventana
    // abierta e ignora `--working-directory`.
    list.push(Candidate {
        program: "ptyxis",
        args: vec![
            "--new-window".into(),
            format!("--working-directory={d}"),
        ],
    });

    list.push(Candidate {
        program: "konsole",
        args: vec!["--workdir".into(), d.clone()],
    });

    list.push(Candidate {
        program: "wezterm",
        args: vec!["start".into(), "--cwd".into(), d.clone()],
    });

    // Sin argumento de carpeta: heredan `current_dir`.
    for program in ["xterm", "st"] {
        list.push(Candidate {
            program,
            args: Vec::new(),
        });
    }

    list
}

/// Lanza el emulador de terminal disponible en `dir`.
///
/// Devuelve el nombre del emulador usado para poder informar al usuario. El
/// hijo se separa del proceso: cerrar Foxen no cierra la terminal.
pub fn open(dir: &Path) -> AppResult<String> {
    if !dir.is_dir() {
        return Err(AppError::new(
            ErrorKind::Io,
            format!("{} no es una carpeta", dir.display()),
        ));
    }

    let mut tried: Vec<&'static str> = Vec::new();

    for candidate in candidates(dir) {
        match Command::new(candidate.program)
            .args(&candidate.args)
            .current_dir(dir)
            .spawn()
        {
            Ok(_) => return Ok(candidate.program.to_string()),
            // El binario no esta instalado: sigue con el siguiente.
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                tried.push(candidate.program);
            }
            // Instalado pero no se pudo lanzar (permisos, ejecucion...): no
            // tiene sentido probar otros, el fallo es del sistema.
            Err(err) => {
                return Err(AppError::new(
                    ErrorKind::Io,
                    format!("No se pudo abrir la terminal con {}", candidate.program),
                )
                .with_detail(err.to_string()));
            }
        }
    }

    Err(AppError::new(
        ErrorKind::Io,
        "No se encontro ningun emulador de terminal instalado",
    )
    .with_detail(format!("Se probo: {}", tried.join(", "))))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Cada emulador recibe la carpeta con el argumento que documenta.
    #[test]
    fn candidates_point_at_the_working_directory() {
        let list = candidates(Path::new("/tmp/repo"));

        // El emulador por defecto del escritorio, si esta configurado, va
        // primero: es el que respeta la preferencia del usuario.
        if let Some(pos) = list.iter().position(|c| c.program == "xdg-terminal-exec") {
            assert_eq!(pos, 0);
        }

        let find = |program: &str| {
            list.iter()
                .find(|c| c.program == program)
                .unwrap_or_else(|| panic!("falta el candidato {program}"))
        };
        assert_eq!(
            find("ptyxis").args,
            ["--new-window", "--working-directory=/tmp/repo"]
        );
        assert_eq!(find("gnome-terminal").args, ["--working-directory=/tmp/repo"]);
        assert_eq!(find("konsole").args, ["--workdir", "/tmp/repo"]);
        assert_eq!(find("wezterm").args, ["start", "--cwd", "/tmp/repo"]);
        assert!(find("xterm").args.is_empty());
    }

    #[test]
    fn rejects_a_path_that_is_not_a_directory() {
        let error = open(Path::new("/no/existe/foxen")).expect_err("debia fallar");
        assert_eq!(error.kind, crate::error::ErrorKind::Io);
        assert!(error.message.contains("no es una carpeta"));
    }

    /// Prueba de extremo a extremo: arranca un emulador real.
    ///
    /// `#[ignore]` porque aparece una ventana en el escritorio; se ejecuta a
    /// mano con `cargo test --lib -- --ignored terminal`.
    #[test]
    #[ignore = "abre una ventana en el escritorio"]
    fn opens_a_terminal() {
        let program = open(std::env::temp_dir().as_path()).expect("terminal");
        eprintln!("terminal abierta: {program}");
    }
}
