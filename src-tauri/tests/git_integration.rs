//! Tests de integracion del motor Git contra repositorios temporales reales.
//!
//! Estos tests validan la logica de `src-tauri/src/git/*` contra repositorios
//! creados y modificados en disco, que es lo que despues expone la capa IPC.

use foxen_lib::git::commit_ops::CommitOptions;
use foxen_lib::git::merge::MergeOptions2;
use foxen_lib::git::refs::NewBranch;
use foxen_lib::git::{commit_ops, graph, merge, refs, staging, stash};
use foxen_lib::types::{ChangeKind, DiffQuery, DiffSide, GraphQuery};
use std::fs;
use std::path::PathBuf;

/// Repositorio temporal con identidad de autor configurada.
///
/// Se mantiene vivo durante todo el test y se borra alFinalizar.
struct TestRepo {
    path: PathBuf,
}

impl TestRepo {
    /// Crea un repositorio en un directorio temporal unico.
    fn new(label: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "foxen-test-{label}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).expect("crear directorio temporal");

        // `initial_head` evita que git cree HEAD apuntando a `master`, que es
        // lo que hace `Repository::init` a secas.
        let mut init_opts = git2::RepositoryInitOptions::new();
        init_opts.initial_head("main");
        let repo = git2::Repository::init_opts(&path, &init_opts)
            .expect("inicializar repositorio");
        let mut config = repo.config().expect("config");
        config.set_str("user.name", "Foxen Test").unwrap();
        config.set_str("user.email", "test@foxen.local").unwrap();
        config
            .set_str("commit.gpgsign", "false")
            .unwrap();


        Self { path }
    }

    fn open(&self) -> git2::Repository {
        git2::Repository::open(&self.path).expect("abrir repositorio")
    }

    /// Escribe un archivo con contenido y lo deja sin stagear.
    fn write(&self, name: &str, content: &str) {
        let full = self.path.join(name);
        if let Some(parent) = full.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(full, content).unwrap();
    }

    #[allow(dead_code)]
    fn remove(&self, name: &str) {
        let _ = fs::remove_file(self.path.join(name));
    }

    fn head_subject(&self) -> String {
        let repo = self.open();
        repo.head()
            .ok()
            .and_then(|h| h.peel_to_commit().ok())
            .map(|c| c.summary().unwrap_or_default().to_string())
            .unwrap_or_default()
    }

    fn head_oid(&self) -> String {
        let repo = self.open();
        repo.head().ok().and_then(|h| h.target()).map(|o| o.to_string()).unwrap_or_default()
    }

    /// Commit simple de todo el working tree.
    fn commit_all(&self, message: &str) -> String {
        let repo = self.open();
        staging::stage_all(&repo).expect("stage all");
        let result = commit_ops::commit(
            &repo,
            CommitOptions {
                message,
                amend: false,
                allow_empty: false,
                sign: false,
                staged_only: false,
                target: None,
            },
        )
        .expect("crear commit");
        result
            .head_oid
            .expect("el commit debe devolver el nuevo HEAD")
    }
}

impl Drop for TestRepo {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn graph_query(repo_id: &str) -> GraphQuery {
    GraphQuery {
        repo_id: repo_id.to_string(),
        limit: 100,
        heads: Vec::new(),
        all_refs: true,
        current_only: false,
        highlight: None,
    }
}

fn diff_query(repo_id: &str, side: DiffSide, path: Option<&str>) -> DiffQuery {
    DiffQuery {
        repo_id: repo_id.to_string(),
        side,
        path: path.map(|p| p.to_string()),
        old_oid: None,
        new_oid: None,
        include_context: false,
        context: 3,
        max_file_bytes: None,
    }
}

// ---------------------------------------------------------------------------
// Estado y staging
// ---------------------------------------------------------------------------

#[test]
fn detecta_archivos_nuevos_y_modificados() {
    let fixture = TestRepo::new("status");
    fixture.write("nuevo.txt", "hola\n");
    fixture.write("existente.txt", "contenido\n");
    fixture.commit_all("inicial");

    // Modificar sin stagear debe aparecer en `unstaged`.
    fixture.write("existente.txt", "contenido modificado\n");
    let repo = fixture.open();
    let status = staging::status(&repo).expect("status");

    assert!(!status.clean, "el repo no debe estar limpio");
    assert_eq!(status.unstaged_count, 1, "un archivo modificado sin stagear");
    assert_eq!(status.staged_count, 0);
    assert_eq!(status.files.len(), 1);
    assert_eq!(status.files[0].path, "existente.txt");
    assert_eq!(status.files[0].kind, ChangeKind::Modified);
}

#[test]
fn detecta_untracked() {
    let fixture = TestRepo::new("untracked");
    fixture.write("base.txt", "base\n");
    fixture.commit_all("inicial");

    fixture.write("sujeto.txt", "nuevo\n");
    let repo = fixture.open();
    let status = staging::status(&repo).expect("status");

    assert_eq!(status.untracked_count, 1, "debe detectar el archivo nuevo");
    assert!(status.files[0].untracked);
}

#[test]
fn stage_mueve_el_archivo_entre_columnas() {
    let fixture = TestRepo::new("stage");
    fixture.write("a.txt", "uno\n");
    fixture.commit_all("inicial");

    fixture.write("a.txt", "uno\ndos\n");
    let repo = fixture.open();

    staging::stage(&repo, &["a.txt".to_string()]).expect("stage");
    let status = staging::status(&repo).expect("status");
    assert_eq!(status.staged_count, 1);
    assert_eq!(status.unstaged_count, 0);
    assert!(status.files[0].staged);

    // Unstage debe devolverlo al working tree.
    staging::unstage(&repo, &["a.txt".to_string()]).expect("unstage");
    let status = staging::status(&repo).expect("status");
    assert_eq!(status.staged_count, 0);
    assert_eq!(status.unstaged_count, 1);
}

#[test]
fn stage_all_incluye_untracked() {
    let fixture = TestRepo::new("stage-all");
    fixture.write("base.txt", "base\n");
    fixture.commit_all("inicial");

    fixture.write("base.txt", "base\nmas\n");
    fixture.write("extra.txt", "extra\n");

    let repo = fixture.open();
    staging::stage_all(&repo).expect("stage all");
    let status = staging::status(&repo).expect("status");

    assert_eq!(status.staged_count, 2, "incluye el archivo nuevo");
    assert!(!status.files.iter().any(|f| f.untracked));
}

#[test]
fn diff_de_worktree_muestra_hunks() {
    let fixture = TestRepo::new("diff");
    fixture.write("archivo.txt", "uno\ndos\ntres\n");
    fixture.commit_all("inicial");

    fixture.write("archivo.txt", "uno\ndos modificado\ntres\n");
    let repo = fixture.open();

    let diff = staging::diff(&repo, &diff_query("r", DiffSide::Worktree, Some("archivo.txt")))
        .expect("diff");
    assert_eq!(diff.files.len(), 1);
    assert_eq!(diff.total_additions, 1);
    assert_eq!(diff.total_deletions, 1);
    assert!(!diff.files[0].hunks.is_empty(), "debe haber al menos un hunk");

    // El hunk debe contener la linea modificada.
    let content: String = diff.files[0]
        .hunks
        .iter()
        .flat_map(|h| h.lines.iter())
        .map(|l| l.content.clone())
        .collect();
    assert!(content.contains("dos modificado"), "el diff debe incluir la linea nueva");
}

#[test]
fn diff_por_defecto_devuelve_todo_el_working_tree() {
    let fixture = TestRepo::new("diff-todo");
    fixture.write("uno.txt", "a\n");
    fixture.write("dos.txt", "b\n");
    fixture.commit_all("inicial");

    fixture.write("uno.txt", "a2\n");
    fixture.write("dos.txt", "b2\n");

    let repo = fixture.open();
    let diff = staging::diff(&repo, &diff_query("r", DiffSide::Worktree, None)).expect("diff");
    assert_eq!(diff.files.len(), 2, "sin ruta debe traer todos los archivos");
}

/// Regresion: el diff sin ruta debia separar correctamente cada archivo.
///
/// Antes `parse_delta` recorria el diff completo y recortaba por presupuesto de
/// lineas, asi que cada `FileDiff` mezclaba lineas de otros deltas: los stats
/// salian invertidos (un archivo nuevo con 0 inserciones) y los hunks no
/// correspondian a su ruta.
#[test]
fn diff_sin_ruta_reparte_stats_por_archivo() {
    let fixture = TestRepo::new("diff-stats");
    fixture.write("base.txt", "linea\n");
    fixture.commit_all("inicial");

    // Archivo nuevo con tres lineas.
    fixture.write("nuevo.txt", "uno\ndos\ntres\n");
    // Archivo existente modificado (una linea anadida).
    fixture.write("base.txt", "linea\nanadida\n");

    let repo = fixture.open();
    staging::stage_all(&repo).expect("stage");

    let diff = staging::diff(&repo, &diff_query("r", DiffSide::Staged, None)).expect("diff");
    assert_eq!(diff.files.len(), 2);

    let nuevo = diff
        .files
        .iter()
        .find(|f| f.path == "nuevo.txt")
        .expect("nuevo.txt presente");
    assert_eq!(nuevo.additions, 3, "el archivo nuevo aporta sus 3 inserciones");
    assert_eq!(nuevo.deletions, 0);
    assert!(!nuevo.hunks.is_empty());

    let base = diff
        .files
        .iter()
        .find(|f| f.path == "base.txt")
        .expect("base.txt presente");
    assert_eq!(base.additions, 1, "base.txt aporta solo su linea anadida");
    assert_eq!(base.deletions, 0);
}


// ---------------------------------------------------------------------------
// Commits
// ---------------------------------------------------------------------------

#[test]
fn commit_exige_mensaje_no_vacio() {
    let fixture = TestRepo::new("commit-vacio");
    let repo = fixture.open();
    let err = commit_ops::commit(
        &repo,
        CommitOptions {
            message: "   ",
            amend: false,
            allow_empty: false,
            sign: false,
            staged_only: false,
            target: None,
        },
    )
    .expect_err("debe fallar con mensaje vacio");
    assert_eq!(err.code, 1011, "debe ser un error de validacion");
}

#[test]
fn commit_devuelve_el_nuevo_head() {
    let fixture = TestRepo::new("commit-ok");
    fixture.write("a.txt", "contenido\n");
    let oid = fixture.commit_all("primer commit");

    assert_eq!(fixture.head_subject(), "primer commit");
    assert_eq!(fixture.head_oid(), oid);
}

#[test]
fn amend_reemplaza_el_commit_anterior() {
    let fixture = TestRepo::new("amend");
    fixture.write("a.txt", "uno\n");
    let first = fixture.commit_all("mensaje original");

    fixture.write("a.txt", "uno\ndos\n");
    let repo = fixture.open();
    staging::stage_all(&repo).expect("stage");
    commit_ops::commit(
        &repo,
        CommitOptions {
            message: "mensaje corregido",
            amend: true,
            allow_empty: false,
            sign: false,
            staged_only: false,
            target: None,
        },
    )
    .expect("amend");

    assert_eq!(fixture.head_subject(), "mensaje corregido");
    assert_ne!(
        fixture.head_oid(),
        first,
        "el amend debe crear un commit nuevo con el mismo padre"
    );

    let repo = fixture.open();
    let mut walk = repo.revwalk().unwrap();
    walk.push_head().unwrap();
    let count = walk.count();
    assert_eq!(count, 1, "sigue habiendo un solo commit en el historial");
}

#[test]
fn detalle_del_commit_lista_los_archivos() {
    let fixture = TestRepo::new("detalle");
    fixture.write("a.txt", "uno\n");
    fixture.commit_all("inicial");

    fixture.write("a.txt", "uno\ndos\n");
    fixture.write("b.txt", "nuevo\n");
    let oid = fixture.commit_all("segundo commit");

    let repo = fixture.open();
    let detail = commit_ops::detail(&repo, &oid).expect("detalle");

    assert_eq!(detail.subject, "segundo commit");
    assert_eq!(detail.stats.files_changed, 2);
    assert_eq!(detail.files.len(), 2);
    assert!(detail.reachable_from_head);

    let paths: Vec<&str> = detail.files.iter().map(|f| f.path.as_str()).collect();
    assert!(paths.contains(&"a.txt"));
    assert!(paths.contains(&"b.txt"));
}

#[test]
fn archivo_nuevo_aparece_como_added_en_el_detalle() {
    let fixture = TestRepo::new("detalle-added");
    fixture.write("base.txt", "base\n");
    fixture.commit_all("inicial");

    fixture.write("nuevo.txt", "contenido\n");
    let oid = fixture.commit_all("anade archivo");

    let repo = fixture.open();
    let detail = commit_ops::detail(&repo, &oid).expect("detalle");
    let added = detail
        .files
        .iter()
        .find(|f| f.path == "nuevo.txt")
        .expect("debe listar el archivo nuevo");
    assert_eq!(added.kind, ChangeKind::Added);
}

#[test]
fn reflog_registra_los_commits() {
    let fixture = TestRepo::new("reflog");
    fixture.write("a.txt", "uno\n");
    fixture.commit_all("uno");
    fixture.write("a.txt", "dos\n");
    fixture.commit_all("dos");

    let repo = fixture.open();
    let entries = commit_ops::reflog(&repo, 50).expect("reflog");
    assert!(entries.len() >= 2, "debe registrar al menos los dos commits");
    assert!(entries[0].message.contains("dos"));
    assert!(!entries[0].short_oid.is_empty());
}

// ---------------------------------------------------------------------------
// Ramas
// ---------------------------------------------------------------------------

#[test]
fn crea_y_cambia_de_rama() {
    let fixture = TestRepo::new("ramas");
    fixture.write("a.txt", "uno\n");
    fixture.commit_all("inicial");

    let mut repo = fixture.open();
    refs::create(
        &mut repo,
        NewBranch {
            name: "feature/login",
            start_point: None,
            checkout: true,
            force: false,
            track: false,
        },
    )
    .expect("crear rama");

    assert_eq!(fixture.head_subject(), "inicial");
    let list = refs::list(&repo).expect("listar ramas");
    assert_eq!(list.head.as_deref(), Some("feature/login"));
    assert!(list.branches.iter().any(|b| b.name == "feature/login" && b.is_head));
}

#[test]
fn commit_en_rama_no_toca_main() {
    let fixture = TestRepo::new("aislamiento");
    fixture.write("a.txt", "uno\n");
    fixture.commit_all("inicial");

    let mut repo = fixture.open();
    refs::create(
        &mut repo,
        NewBranch {
            name: "feature/x",
            start_point: None,
            checkout: true,
            force: false,
            track: false,
        },
    )
    .expect("crear rama");

    fixture.write("b.txt", "solo en la feature\n");
    fixture.commit_all("commit de la feature");

    let mut repo = fixture.open();
    refs::checkout(&mut repo, "main").expect("volver a main");

    let repo = fixture.open();
    let status = staging::status(&repo).expect("status");
    assert!(
        !status.files.iter().any(|f| f.path == "b.txt"),
        "b.txt no debe existir en main"
    );
    assert_eq!(fixture.head_subject(), "inicial");
}

#[test]
fn checkout_rechaza_destino_inexistente() {
    let fixture = TestRepo::new("checkout-fallido");
    fixture.write("a.txt", "uno\n");
    fixture.commit_all("inicial");

    let mut repo = fixture.open();
    let err = refs::checkout(&mut repo, "no-existe").expect_err("debe fallar");
    assert!(
        err.code == 1003 || err.code == 1006,
        "error esperado notFound/invalidState, came: {}",
        err.code
    );
}

#[test]
fn elimina_rama_con_force() {
    let fixture = TestRepo::new("borra-rama");
    fixture.write("a.txt", "uno\n");
    fixture.commit_all("inicial");

    let mut repo = fixture.open();
    refs::create(
        &mut repo,
        NewBranch {
            name: "temporal",
            start_point: None,
            checkout: false,
            force: false,
            track: false,
        },
    )
    .expect("crear rama");

    refs::delete(&mut repo, "temporal", true).expect("borrar rama");
    let list = refs::list(&repo).expect("listar");
    assert!(!list.branches.iter().any(|b| b.name == "temporal"));
}

#[test]
fn no_puede_borrar_la_rama_actual() {
    let fixture = TestRepo::new("borra-head");
    fixture.write("a.txt", "uno\n");
    fixture.commit_all("inicial");

    let mut repo = fixture.open();
    let err = refs::delete(&mut repo, "main", true).expect_err("no debe borrar HEAD");
    assert_eq!(err.code, 1006, "debe ser invalidState");
}

// ---------------------------------------------------------------------------
// Grafo
// ---------------------------------------------------------------------------

#[test]
fn grafo_topologico_con_ramas() {
    let fixture = TestRepo::new("grafo");
    fixture.write("a.txt", "1\n");
    fixture.commit_all("c1");

    let mut repo = fixture.open();
    refs::create(
        &mut repo,
        NewBranch {
            name: "feature/a",
            start_point: None,
            checkout: true,
            force: false,
            track: false,
        },
    )
    .expect("crear feature");

    fixture.write("b.txt", "2\n");
    fixture.commit_all("c2 en feature");

    let repo = fixture.open();
    let g = graph::build_graph(&repo, &graph_query("r")).expect("grafo");

    assert_eq!(g.nodes.len(), 2, "dos commits alcanzables");
    assert!(!g.truncated);

    // El nodo mas reciente (fila 0) debe ser el commit de la feature.
    let newest = &g.nodes[0];
    assert_eq!(newest.subject, "c2 en feature");
    assert!(newest.is_head, "el commit de HEAD debe estar marcado");
    assert!(newest.labels.iter().any(|l| l.name == "feature/a" && l.is_head));

    // El commit raiz debe tener la etiqueta de main.
    let oldest = g.nodes.iter().find(|n| n.is_root).expect("commit raiz");
    assert!(oldest.labels.iter().any(|l| l.name == "main"));
}

#[test]
fn grafo_de_merge_tiene_aristas_de_merge() {
    let fixture = TestRepo::new("grafo-merge");
    fixture.write("a.txt", "base\n");
    fixture.commit_all("base");

    let mut repo = fixture.open();
    refs::create(
        &mut repo,
        NewBranch {
            name: "feature/b",
            start_point: None,
            checkout: true,
            force: false,
            track: false,
        },
    )
    .expect("crear feature");
    fixture.write("b.txt", "feature\n");
    fixture.commit_all("c1 feature");

    let mut repo = fixture.open();
    refs::checkout(&mut repo, "main").expect("volver a main");
    fixture.write("c.txt", "main\n");
    fixture.commit_all("c2 main");

    let mut repo = fixture.open();
    merge::merge(
        &mut repo,
        MergeOptions2 {
            target: "feature/b".to_string(),
            no_ff: true,
            ff_only: false,
            squash: false,
            message: None,
        },
    )
    .expect("merge");

    let repo = fixture.open();
    let g = graph::build_graph(&repo, &graph_query("r")).expect("grafo");
    let merge_node = g.nodes.iter().find(|n| n.is_merge).expect("debe existir un merge");
    assert_eq!(merge_node.parents.len(), 2);
    assert!(
        g.edges.iter().any(|e| e.is_merge_edge),
        "debe haber al menos una arista de merge"
    );
}

// ---------------------------------------------------------------------------
// Stash
// ---------------------------------------------------------------------------

#[test]
fn stash_guarda_y_limpia_el_working_tree() {
    let fixture = TestRepo::new("stash");
    fixture.write("a.txt", "uno\n");
    fixture.commit_all("inicial");

    fixture.write("a.txt", "uno\nmodificado\n");
    let mut repo = fixture.open();
    stash::push(&mut repo, Some("mi stash"), false, false, false).expect("stash");

    let repo = fixture.open();
    let status = staging::status(&repo).expect("status");
    assert!(status.clean, "el working tree debe quedar limpio tras el stash");

    let entries = stash::list(&repo).expect("listar stashes");
    assert_eq!(entries.len(), 1);
    assert!(entries[0].message.contains("mi stash"));
    assert_eq!(entries[0].unstaged_count, 1);
    assert!(entries[0].is_top);
}

#[test]
fn stash_pop_restaura_los_cambios() {
    let fixture = TestRepo::new("stash-pop");
    fixture.write("a.txt", "uno\n");
    fixture.commit_all("inicial");

    fixture.write("a.txt", "uno\nmodificado\n");
    let mut repo = fixture.open();
    stash::push(&mut repo, Some("trabajo"), false, false, false).expect("stash");
    stash::pop(&mut repo, 0).expect("pop");

    let repo = fixture.open();
    let status = staging::status(&repo).expect("status");
    assert_eq!(status.unstaged_count, 1, "los cambios deben volver al working tree");
    assert!(stash::list(&repo).expect("listar").is_empty(), "el stash debe desaparecer");
}

#[test]
fn stash_sin_cambios_falla() {
    let fixture = TestRepo::new("stash-vacio");
    fixture.write("a.txt", "uno\n");
    fixture.commit_all("inicial");

    let mut repo = fixture.open();
    let err = stash::push(&mut repo, None, false, false, false).expect_err("no hay nada que guardar");
    assert_eq!(err.code, 1006, "debe ser invalidState");
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

#[test]
fn merge_de_rama_sin_conflictos() {
    let fixture = TestRepo::new("merge-ok");
    fixture.write("base.txt", "base\n");
    fixture.commit_all("base");

    let mut repo = fixture.open();
    refs::create(
        &mut repo,
        NewBranch {
            name: "feature/x",
            start_point: None,
            checkout: true,
            force: false,
            track: false,
        },
    )
    .expect("crear feature");
    fixture.write("nuevo.txt", "desde la feature\n");
    fixture.commit_all("commit de la feature");

    let mut repo = fixture.open();
    refs::checkout(&mut repo, "main").expect("volver a main");

    let mut repo = fixture.open();
    let result = merge::merge(
        &mut repo,
        MergeOptions2 {
            target: "feature/x".to_string(),
            no_ff: true,
            ff_only: false,
            squash: false,
            message: None,
        },
    )
    .expect("merge");

    assert!(result.success, "el merge deberia tener exito: {}", result.message);
    assert!(result.conflicted_files.is_empty());
    assert!(!result.needs_continue);

    // Tras un merge limpio el working tree queda limpio, asi que el archivo
    // integrado se comprueba en el arbol del commit, no en el status.
    let repo = fixture.open();
    let head_tree = repo.head().unwrap().peel_to_commit().unwrap().tree().unwrap();
    assert!(
        head_tree.get_name("nuevo.txt").is_some(),
        "el archivo de la feature debe estar en el arbol de main"
    );
    let status = staging::status(&repo).expect("status");
    assert!(status.files.is_empty(), "el working tree debe quedar limpio");
    assert_eq!(status.conflicted_count, 0);
}

#[test]
fn merge_con_conflicto_lo_reporta() {
    let fixture = TestRepo::new("merge-conflicto");
    fixture.write("a.txt", "linea original\n");
    fixture.commit_all("base");

    let mut repo = fixture.open();
    refs::create(
        &mut repo,
        NewBranch {
            name: "feature/y",
            start_point: None,
            checkout: true,
            force: false,
            track: false,
        },
    )
    .expect("crear feature");
    fixture.write("a.txt", "version de la feature\n");
    fixture.commit_all("cambia en la feature");

    let mut repo = fixture.open();
    refs::checkout(&mut repo, "main").expect("volver a main");
    fixture.write("a.txt", "version de main\n");
    fixture.commit_all("cambia en main");

    let mut repo = fixture.open();
    let result = merge::merge(
        &mut repo,
        MergeOptions2 {
            target: "feature/y".to_string(),
            no_ff: true,
            ff_only: false,
            squash: false,
            message: None,
        },
    )
    .expect("merge debe devolver resultado, no error");

    assert!(!result.success, "el merge debe fallar por conflicto");
    assert!(!result.conflicted_files.is_empty(), "debe listar los conflictos");
    assert!(result.status.conflicted_count > 0);
}

#[test]
fn abort_merge_deja_el_repo_como_estaba() {
    let fixture = TestRepo::new("merge-abort");
    fixture.write("a.txt", "original\n");
    fixture.commit_all("base");

    let mut repo = fixture.open();
    refs::create(
        &mut repo,
        NewBranch {
            name: "feature/z",
            start_point: None,
            checkout: true,
            force: false,
            track: false,
        },
    )
    .expect("crear feature");
    fixture.write("a.txt", "feature\n");
    fixture.commit_all("feature");

    let mut repo = fixture.open();
    refs::checkout(&mut repo, "main").expect("volver a main");
    fixture.write("a.txt", "main\n");
    fixture.commit_all("main");

    let mut repo = fixture.open();
    let _ = merge::merge(
        &mut repo,
        MergeOptions2 {
            target: "feature/z".to_string(),
            no_ff: true,
            ff_only: false,
            squash: false,
            message: None,
        },
    );

    assert!(merge::merge_in_progress(&repo), "debe haber un merge en curso");

    let mut repo = fixture.open();
    merge::merge_abort(&mut repo).expect("abortar merge");

    let repo = fixture.open();
    assert!(!merge::merge_in_progress(&repo), "el merge debe quedar abortado");
    let status = staging::status(&repo).expect("status");
    assert!(status.clean, "tras abortar el working tree queda limpio");
    assert_eq!(fixture.head_subject(), "main");
}

#[test]
fn cerrar_merge_con_conflicto_crea_commit_de_dos_padres() {
    let fixture = TestRepo::new("merge-continue");
    fixture.write("a.txt", "linea original\n");
    fixture.commit_all("base");

    let mut repo = fixture.open();
    refs::create(
        &mut repo,
        NewBranch {
            name: "feature/m",
            start_point: None,
            checkout: true,
            force: false,
            track: false,
        },
    )
    .expect("crear feature");
    fixture.write("a.txt", "version de la feature\n");
    fixture.commit_all("feature");

    let mut repo = fixture.open();
    refs::checkout(&mut repo, "main").expect("volver a main");
    fixture.write("a.txt", "version de main\n");
    fixture.commit_all("main");

    let mut repo = fixture.open();
    let result = merge::merge(
        &mut repo,
        MergeOptions2 {
            target: "feature/m".to_string(),
            no_ff: true,
            ff_only: false,
            squash: false,
            message: None,
        },
    )
    .expect("merge");
    assert!(!result.success, "debe haber conflicto");
    assert!(merge::merge_in_progress(&repo), "la fusion queda en curso");

    // Resolver a favor de la feature y cerrar la fusion con un commit.
    commit_ops::checkout_conflict_side(
        &repo,
        "a.txt",
        commit_ops::ConflictSide::parse("theirs").expect("lado"),
    )
    .expect("resolver conflicto");
    let outcome = commit_ops::commit(
        &repo,
        commit_ops::CommitOptions {
            message: "Merge feature/m",
            amend: false,
            allow_empty: true,
            sign: false,
            staged_only: true,
            target: None,
        },
    )
    .expect("commit de merge");
    assert!(outcome.message.contains("Creado"), "{}", outcome.message);

    let repo = fixture.open();
    assert!(!merge::merge_in_progress(&repo), "la fusion debe quedar cerrada");
    let head = repo.head().expect("head").peel_to_commit().expect("commit");
    assert_eq!(head.parent_count(), 2, "el commit de merge debe tener dos padres");
}

#[test]
fn merge_into_cambia_al_destino_y_fusiona() {
    let fixture = TestRepo::new("merge-into");
    fixture.write("a.txt", "base\n");
    fixture.commit_all("base");

    // develop parte de main y estara en pausa; feat avanza por su lado.
    let mut repo = fixture.open();
    refs::create(
        &mut repo,
        NewBranch {
            name: "develop",
            start_point: None,
            checkout: true,
            force: false,
            track: false,
        },
    )
    .expect("crear develop");

    let mut repo = fixture.open();
    refs::create(
        &mut repo,
        NewBranch {
            name: "feat",
            start_point: None,
            checkout: true,
            force: false,
            track: false,
        },
    )
    .expect("crear feat");
    fixture.write("b.txt", "solo en feat\n");
    fixture.commit_all("avanza feat");

    // Estando en feat, fusionar feat dentro de develop.
    let mut repo = fixture.open();
    let result = merge::merge_into(
        &mut repo,
        "develop",
        MergeOptions2 {
            target: "feat".to_string(),
            no_ff: true,
            ff_only: false,
            squash: false,
            message: None,
        },
    )
    .expect("merge_into");
    assert!(result.success, "{}", result.message);

    let repo = fixture.open();
    // El destino contiene el commit de merge y queda como rama actual.
    assert_eq!(
        repo.head().unwrap().shorthand(),
        Some("develop"),
        "tras fusionar se queda en el destino"
    );
    let head = repo.head().unwrap().peel_to_commit().unwrap();
    assert_eq!(head.parent_count(), 2, "debe ser un commit de merge");
    assert!(repo.find_branch("feat", git2::BranchType::Local).is_ok());
}

#[test]
fn compara_dos_ramas() {
    let fixture = TestRepo::new("compara");
    fixture.write("a.txt", "uno\n");
    fixture.commit_all("c1");

    let mut repo = fixture.open();
    refs::create(
        &mut repo,
        NewBranch {
            name: "feature/w",
            start_point: None,
            checkout: true,
            force: false,
            track: false,
        },
    )
    .expect("crear feature");
    fixture.write("b.txt", "dos\n");
    fixture.commit_all("c2");

    let repo = fixture.open();
    let (ahead, behind, ancestor) = merge::compare_branches(&repo, "main", "feature/w").expect("comparar");
    assert_eq!(ahead, 1, "feature/w tiene un commit mas");
    assert_eq!(behind, 0);
    assert!(ancestor, "main es ancestro de feature/w");
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

#[test]
fn valida_nombres_de_rama() {
    let fixture = TestRepo::new("nombre-rama");
    fixture.write("a.txt", "uno\n");
    fixture.commit_all("inicial");

    let repo = fixture.open();
    assert!(refs::validate_branch_name(&repo, "feature/login").is_ok());

    for invalid in ["", "con espacio", "doble//barra", "termina/", "con~tilde"] {
        assert!(
            refs::validate_branch_name(&repo, invalid).is_err(),
            "deberia rechazar: {invalid:?}"
        );
    }
}

#[test]
fn describe_head_usa_el_nombre_de_rama() {
    let fixture = TestRepo::new("describe");
    fixture.write("a.txt", "uno\n");
    fixture.commit_all("inicial");

    let repo = fixture.open();
    let description = refs::describe_head(&repo);
    assert!(
        description.starts_with("main @"),
        "debe describir la rama, el commit y la fecha: {description}"
    );
}

#[test]
fn ref_kinds_cubre_las_cuatro_categorias() {
    let kinds = refs::ref_kinds();
    assert_eq!(kinds.len(), 4, "branch, remoteBranch, tag y other");
}

#[test]
fn sorted_paths_es_deterministic() {
    let mut paths = vec!["z.txt".to_string(), "a.txt".to_string(), "m.txt".to_string()];
    paths = staging::sorted_paths(paths);
    assert_eq!(paths, vec!["a.txt", "m.txt", "z.txt"]);
}

#[test]
fn parse_reset_mode_rechaza_valores_desconocidos() {
    assert!(commit_ops::parse_reset_mode("soft").is_ok());
    assert!(commit_ops::parse_reset_mode("mixed").is_ok());
    assert!(commit_ops::parse_reset_mode("hard").is_ok());
    assert!(commit_ops::parse_reset_mode("nonsense").is_err());
}

#[test]
fn abrir_un_path_que_no_es_repo_falla() {
    let dir = std::env::temp_dir().join(format!("foxen-no-repo-{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    let result = foxen_lib::git::repo::open_discovered(&dir);
    let _ = fs::remove_dir_all(&dir);
    assert!(result.is_err(), "una carpeta normal no es un repositorio");
}

#[test]
fn descubre_repositorios_anidados() {
    let root = std::env::temp_dir().join(format!("foxen-scan-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(root.join("proyecto-a")).unwrap();
    fs::create_dir_all(root.join("proyecto-b/")).unwrap();
    git2::Repository::init(root.join("proyecto-a")).unwrap();
    git2::Repository::init(root.join("proyecto-b")).unwrap();
    fs::create_dir_all(root.join("no-es-repo")).unwrap();

    let found = foxen_lib::git::repo::scan_repositories(&root, 2);
    let _ = fs::remove_dir_all(&root);

    assert_eq!(found.len(), 2, "debe encontrar los dos repositorios");
    assert!(found.iter().all(|p| p.ends_with("proyecto-a") || p.ends_with("proyecto-b")));
}