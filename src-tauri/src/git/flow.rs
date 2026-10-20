//! Flujo Git Flow: ramas feature/release/hotfix con convenciones.
//!
//! La configuracion se persiste en el propio repositorio (`foxen.flow.*` en
//! `git config`), por lo que viaja con el repo y no depende de Foxen.

use git2::Repository;

use crate::error::{AppError, AppResult};
use crate::git::refs::{checkout, create, NewBranch};
use crate::types::{FlowBranchType, FlowConfig, FlowStatus, OperationResult};

/// Prefijo de clave en la configuracion de git.
const KEY_PREFIX: &str = "foxen.flow";

const DEFAULT_MAIN: &str = "main";
const DEFAULT_DEVELOP: &str = "develop";

/// Lee la configuracion de Git Flow.
pub fn read_config(repo: &Repository) -> AppResult<FlowConfig> {
    let config = repo.config().map_err(AppError::from_git)?;
    let get = |key: &str, default: &str| {
        config
            .get_string(&format!("{KEY_PREFIX}.{key}"))
            .unwrap_or_else(|_| default.to_string())
    };

    Ok(FlowConfig {
        enabled: config
            .get_bool(&format!("{KEY_PREFIX}.enabled"))
            .unwrap_or(false),
        main_branch: get("main", DEFAULT_MAIN),
        develop_branch: get("develop", DEFAULT_DEVELOP),
        feature_prefix: get("featurePrefix", "feature/"),
        release_prefix: get("releasePrefix", "release/"),
        hotfix_prefix: get("hotfixPrefix", "hotfix/"),
    })
}

/// Escribe la configuracion de Git Flow.
pub fn write_config(repo: &Repository, config: &FlowConfig) -> AppResult<FlowConfig> {
    let mut git = repo.config().map_err(AppError::from_git)?;
    git.set_bool(&format!("{KEY_PREFIX}.enabled"), config.enabled)
        .map_err(AppError::from_git)?;
    git.set_str(&format!("{KEY_PREFIX}.main"), &config.main_branch)
        .map_err(AppError::from_git)?;
    git.set_str(&format!("{KEY_PREFIX}.develop"), &config.develop_branch)
        .map_err(AppError::from_git)?;
    git.set_str(
        &format!("{KEY_PREFIX}.featurePrefix"),
        &config.feature_prefix,
    )
    .map_err(AppError::from_git)?;
    git.set_str(
        &format!("{KEY_PREFIX}.releasePrefix"),
        &config.release_prefix,
    )
    .map_err(AppError::from_git)?;
    git.set_str(
        &format!("{KEY_PREFIX}.hotfixPrefix"),
        &config.hotfix_prefix,
    )
    .map_err(AppError::from_git)?;
    Ok(config.clone())
}

/// Clasifica el tipo de una rama segun la configuracion del flujo.
pub fn classify(config: &FlowConfig, branch: &str) -> FlowBranchType {
    if branch == config.main_branch {
        FlowBranchType::Main
    } else if branch == config.develop_branch {
        FlowBranchType::Develop
    } else if branch.starts_with(&config.feature_prefix) {
        FlowBranchType::Feature
    } else if branch.starts_with(&config.release_prefix) {
        FlowBranchType::Release
    } else if branch.starts_with(&config.hotfix_prefix) {
        FlowBranchType::Hotfix
    } else if branch.starts_with("support/") {
        FlowBranchType::Support
    } else {
        FlowBranchType::Unknown
    }
}

/// Estado completo del flujo en el repositorio.
pub fn status(repo: &Repository) -> AppResult<FlowStatus> {
    let config = read_config(repo)?;
    let branches: Vec<String> = repo
        .branches(Some(git2::BranchType::Local))
        .map_err(AppError::from_git)?
        .flatten()
        .filter_map(|(b, _)| b.name().ok().flatten().map(|n| n.to_string()))
        .collect();

    let collect = |prefix: &str| -> Vec<String> {
        branches
            .iter()
            .filter(|b| b.starts_with(prefix))
            .cloned()
            .collect()
    };

    let current_branch = repo
        .head()
        .ok()
        .filter(|h| h.is_branch())
        .and_then(|h| h.shorthand().map(|s| s.to_string()));

    Ok(FlowStatus {
        initialized: branches.contains(&config.develop_branch),
        current_branch: current_branch.clone(),
        current_type: current_branch
            .as_deref()
            .map(|b| classify(&config, b))
            .unwrap_or(FlowBranchType::Unknown),
        main_exists: branches.contains(&config.main_branch),
        develop_exists: branches.contains(&config.develop_branch),
        active_features: collect(&config.feature_prefix),
        active_releases: collect(&config.release_prefix),
        active_hotfixes: collect(&config.hotfix_prefix),
        config,
    })
}

/// Inicializa Git Flow creando la rama de desarrollo desde main.
pub fn init(repo: &mut Repository, config: FlowConfig) -> AppResult<FlowStatus> {
    if config.main_branch.is_empty() || config.develop_branch.is_empty() {
        return Err(AppError::validation(
            "Los nombres de rama main y develop no pueden estar vacios",
        ));
    }
    if config.main_branch == config.develop_branch {
        return Err(AppError::validation(
            "main y develop deben ser ramas distintas",
        ));
    }

    let has_main = repo
        .find_branch(&config.main_branch, git2::BranchType::Local)
        .is_ok();
    if !has_main {
        return Err(AppError::not_found(format!(
            "No existe la rama {}. Crealo antes de inicializar Git Flow.",
            config.main_branch
        )));
    }

    // Crear develop desde main si no existe.
    let has_develop = repo
        .find_branch(&config.develop_branch, git2::BranchType::Local)
        .is_ok();
    if !has_develop {
        create(
            repo,
            NewBranch {
                name: &config.develop_branch,
                start_point: Some(&config.main_branch),
                checkout: false,
                force: false,
                track: false,
            },
        )?;
    }

    let mut config = config;
    config.enabled = true;
    write_config(repo, &config)?;
    status(repo)
}

/// Desactiva Git Flow sin borrar ramas.
pub fn disable(repo: &Repository) -> AppResult<FlowStatus> {
    let mut config = read_config(repo)?;
    config.enabled = false;
    write_config(repo, &config)?;
    status(repo)
}

/// Nombres de rama validados contra los prefijos del flujo.
fn flow_name(prefix: &str, raw: &str) -> AppResult<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(AppError::validation("El nombre de la rama esta vacio"));
    }
    let slug: String = trimmed
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let slug = slug.trim_matches('-').to_string();
    if slug.is_empty() {
        return Err(AppError::validation(format!(
            "'{raw}' no produce un nombre de rama valido"
        )));
    }
    Ok(format!("{prefix}{slug}"))
}

/// Inicia una feature desde develop.
pub fn feature_start(
    repo: &mut Repository,
    raw_name: &str,
    checkout: bool,
) -> AppResult<(String, OperationResult)> {
    let config = read_config(repo)?;
    require_branch(repo, &config.develop_branch, "Git Flow no esta inicializado")?;

    let name = flow_name(&config.feature_prefix, raw_name)?;
    let result = create(
        repo,
        NewBranch {
            name: &name,
            start_point: Some(&config.develop_branch),
            checkout,
            force: false,
            track: false,
        },
    )?;

    Ok((name, result))
}

/// Finaliza una feature fusionandola en develop y eliminandola.
pub fn feature_finish(repo: &mut Repository, name: &str, delete: bool) -> AppResult<OperationResult> {
    let config = read_config(repo)?;
    let full = if name.starts_with(&config.feature_prefix) {
        name.to_string()
    } else {
        format!("{}{}", config.feature_prefix, name)
    };

    merge_into(repo, &config.develop_branch, &full)?;
    if delete {
        crate::git::refs::delete(repo, &full, true)?;
    }
    Ok(OperationResult::ok(format!("Feature {full} finalizada")))
}

/// Inicia una release desde develop.
pub fn release_start(
    repo: &mut Repository,
    version: &str,
    checkout: bool,
) -> AppResult<(String, OperationResult)> {
    let config = read_config(repo)?;
    require_branch(repo, &config.develop_branch, "Git Flow no esta inicializado")?;
    let name = flow_name(&config.release_prefix, version)?;
    let result = create(
        repo,
        NewBranch {
            name: &name,
            start_point: Some(&config.develop_branch),
            checkout,
            force: false,
            track: false,
        },
    )?;
    Ok((name, result))
}

/// Finaliza una release fusionandola en main y develop.
pub fn release_finish(repo: &mut Repository, name: &str) -> AppResult<OperationResult> {
    let config = read_config(repo)?;
    let full = if name.starts_with(&config.release_prefix) {
        name.to_string()
    } else {
        format!("{}{}", config.release_prefix, name)
    };

    merge_into(repo, &config.main_branch, &full)?;
    merge_into(repo, &config.develop_branch, &full)?;
    crate::git::refs::delete(repo, &full, true)?;

    Ok(OperationResult::ok(format!(
        "Release {full} fusionada en {} y {}",
        config.main_branch, config.develop_branch
    ))
    .with_refs(vec![
        format!("refs/heads/{}", config.main_branch),
        format!("refs/heads/{}", config.develop_branch),
    ]))
}

/// Inicia un hotfix desde main.
pub fn hotfix_start(
    repo: &mut Repository,
    raw_name: &str,
    checkout: bool,
) -> AppResult<(String, OperationResult)> {
    let config = read_config(repo)?;
    require_branch(repo, &config.main_branch, "Git Flow no esta inicializado")?;
    let name = flow_name(&config.hotfix_prefix, raw_name)?;
    let result = create(
        repo,
        NewBranch {
            name: &name,
            start_point: Some(&config.main_branch),
            checkout,
            force: false,
            track: false,
        },
    )?;
    Ok((name, result))
}

/// Finaliza un hotfix fusionandolo en main y develop.
pub fn hotfix_finish(repo: &mut Repository, name: &str) -> AppResult<OperationResult> {
    let config = read_config(repo)?;
    let full = if name.starts_with(&config.hotfix_prefix) {
        name.to_string()
    } else {
        format!("{}{}", config.hotfix_prefix, name)
    };

    merge_into(repo, &config.main_branch, &full)?;
    merge_into(repo, &config.develop_branch, &full)?;
    crate::git::refs::delete(repo, &full, true)?;

    Ok(OperationResult::ok(format!(
        "Hotfix {full} fusionado en {} y {}",
        config.main_branch, config.develop_branch
    )))
}

/// Fusiona `branch` en `target`, volviendo a la rama original al terminar.
fn merge_into(repo: &mut Repository, target: &str, branch: &str) -> AppResult<()> {
    let previous = repo
        .head()
        .ok()
        .filter(|h| h.is_branch())
        .and_then(|h| h.shorthand().map(|s| s.to_string()));

    checkout(repo, target)?;
    let result = crate::git::merge::merge(
        repo,
        crate::git::merge::MergeOptions2 {
            target: branch.to_string(),
            no_ff: true,
            ff_only: false,
            squash: false,
            message: Some(format!("Merge branch '{branch}'")),
        },
    );

    let merged = result?;
    if !merged.success {
        // Con conflictos NO se vuelve a la rama previa: los conflictos deben
        // quedar en `target` para que Continuar/Abortar operen sobre la rama
        // correcta (antes se volvia y el commit de cierre caia en la erronea).
        return Err(AppError::invalid_state(format!(
            "La fusion de {branch} en {target} tiene conflictos: {}",
            merged.conflicted_files.join(", ")
        )));
    }

    // Volver a la rama previa tras una fusion limpia, para no dejar al usuario
    // en un estado inesperado.
    if let Some(previous) = previous.filter(|p| p != target) {
        if repo.find_branch(&previous, git2::BranchType::Local).is_ok() {
            checkout(repo, &previous).ok();
        }
    }
    Ok(())
}

/// Verifica que exista una rama requerida por el flujo.
fn require_branch(repo: &Repository, branch: &str, context: &str) -> AppResult<()> {
    if repo
        .find_branch(branch, git2::BranchType::Local)
        .is_ok()
    {
        Ok(())
    } else {
        Err(AppError::invalid_state(format!(
            "{context}: falta la rama {branch}"
        )))
    }
}