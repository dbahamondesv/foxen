//! Contratos de datos entre el backend Rust y el frontend React.
//!
//! Todos los tipos derivan `Serialize` y usan `rename_all = "camelCase"`, de modo
//! que el TypeScript generado a mano en `src/lib/types.ts` coincida 1:1.

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Repositorios
// ---------------------------------------------------------------------------

/// Repositorio abierto en la aplicacion.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryHandle {
    pub id: String,
    pub path: String,
    pub name: String,
    pub bare: bool,
    pub head_branch: Option<String>,
    pub detached: bool,
    pub default_branch: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryOpenResult {
    pub handle: RepositoryHandle,
    /// `true` si el repositorio ya estaba abierto antes de esta llamada.
    pub already_open: bool,
}

// ---------------------------------------------------------------------------
// Referencias y ramas
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RefKind {
    /// Rama local (`refs/heads/*`)
    Branch,
    /// Referencia de seguimiento remoto (`refs/remotes/*`)
    RemoteBranch,
    /// Tag (`refs/tags/*`)
    Tag,
    /// Otra referencia suelta (`refs/*`)
    Other,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefLabel {
    /// Nombre corto mostrado en el grafo, p.ej. `main` u `origin/main`.
    pub name: String,
    /// Nombre completo, p.ej. `refs/heads/feature/login`.
    pub full_name: String,
    pub kind: RefKind,
    pub is_head: bool,
    /// `true` para la referencia symbolic `HEAD`.
    pub is_detached: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    /// Nombre corto, p.ej. `feature/login`.
    pub name: String,
    pub full_name: String,
    pub oid: String,
    pub short_oid: String,
    pub subject: String,
    pub author_name: String,
    pub author_email: String,
    pub author_time: i64,
    pub is_head: bool,
    pub is_remote: bool,
    pub upstream: Option<String>,
    /// Commits presentes en la rama local y ausentes del upstream.
    pub ahead: usize,
    /// Commits presentes en el upstream y ausentes de la rama local.
    pub behind: usize,
    pub has_uncommitted_changes: bool,
    pub last_commit_message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchList {
    pub branches: Vec<BranchInfo>,
    pub head: Option<String>,
}

// ---------------------------------------------------------------------------
// Grafo de commits
// ---------------------------------------------------------------------------

/// Nodo del grafo: un commit mas su lane (columna) asignada.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitNode {
    pub oid: String,
    pub short_oid: String,
    /// Indice de fila, topologicamente ordenado (0 = mas reciente).
    pub row: usize,
    /// Columna (lane) donde se dibuja el commit.
    pub lane: usize,
    pub parents: Vec<String>,
    pub subject: String,
    pub body: Option<String>,
    pub author_name: String,
    pub author_email: String,
    /// Timestamp del autor en segundos unix.
    pub author_time: i64,
    /// Timestamp del autor en ISO 8601 UTC.
    pub author_time_iso: String,
    pub commit_time_iso: String,
    /// Referencias (ramas, tags) que apuntan exactamente a este commit.
    pub labels: Vec<RefLabel>,
    pub is_merge: bool,
    pub is_head: bool,
    /// `true` si es un commit raiz (sin padres visibles en el grafo).
    pub is_root: bool,
}

/// Conexion entre un commit y uno de sus padres.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphEdge {
    pub from_row: usize,
    pub from_lane: usize,
    pub to_row: usize,
    pub to_lane: usize,
    /// `true` para aristas que nacen de un merge (segundo padre en adelante).
    pub is_merge_edge: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitGraph {
    pub nodes: Vec<CommitNode>,
    pub edges: Vec<GraphEdge>,
    /// Numero maximo de lanes simultaneos. Determina el ancho del grafo.
    pub lane_count: usize,
    /// `true` si se alcanzo el limite de commits solicitados.
    pub truncated: bool,
    /// Total de commits alcanzables, puede exceder `nodes.len()`.
    pub total_reachable: usize,
}

/// Filtros de la vista de grafo.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphQuery {
    pub repo_id: String,
    /// Maximum de commits a devolver. Por defecto 750.
    #[serde(default = "default_limit")]
    pub limit: usize,
    /// Ramas/tag/HEAD a tomar como raices del recorrido.
    pub heads: Vec<String>,
    /// Si es `false` solo se incluyen las ramas indicadas en `heads`.
    #[serde(default = "default_true")]
    pub all_refs: bool,
    /// Incluir solo los commits alcanzables desde HEAD.
    #[serde(default)]
    pub current_only: bool,
    /// Cadena para resaltar commits (resaltado, no filtro).
    pub highlight: Option<String>,
}

fn default_limit() -> usize {
    750
}

fn default_true() -> bool {
    true
}

// ---------------------------------------------------------------------------
// Detalle de commit
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ChangeKind {
    Added,
    Modified,
    Deleted,
    Renamed,
    Copied,
    TypeChanged,
    Untracked,
    Ignored,
    Conflicted,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitStats {
    pub files_changed: usize,
    pub insertions: usize,
    pub deletions: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitFileChange {
    pub path: String,
    pub old_path: Option<String>,
    pub kind: ChangeKind,
    pub is_binary: bool,
    pub insertions: usize,
    pub deletions: usize,
    pub status_char: String,
}

/// Detalle completo de un commit, cargado bajo demanda.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetail {
    pub oid: String,
    pub short_oid: String,
    pub subject: String,
    pub body: Option<String>,
    pub author_name: String,
    pub author_email: String,
    pub author_time: i64,
    pub author_time_iso: String,
    pub committer_name: String,
    pub committer_email: String,
    pub commit_time_iso: String,
    pub parents: Vec<String>,
    pub is_merge: bool,
    pub stats: CommitStats,
    pub files: Vec<CommitFileChange>,
    pub body_raw: String,
    /// `true` si el commit es alcanzable desde HEAD (esta en el historial).
    pub reachable_from_head: bool,
}

// ---------------------------------------------------------------------------
// Estado del working tree / staging
// ---------------------------------------------------------------------------

/// Estado de un archivo en el working tree.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStatus {
    pub path: String,
    /// Ruta anterior cuando es rename o copy.
    pub old_path: Option<String>,
    /// Estado en el indice (columna izquierda de GitKraken).
    pub index_status: char,
    /// Estado en el working tree (columna derecha).
    pub worktree_status: char,
    /// `true` si tiene cambios ya anadidos al area de stage.
    pub staged: bool,
    /// `true` si tiene cambios sin anadir.
    pub unstaged: bool,
    pub untracked: bool,
    pub ignored: bool,
    pub conflicted: bool,
    pub is_binary: bool,
    pub insertions: usize,
    pub deletions: usize,
    pub kind: ChangeKind,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoStatus {
    pub head_branch: Option<String>,
    pub head_oid: Option<String>,
    pub head_subject: Option<String>,
    pub files: Vec<FileStatus>,
    pub staged_count: usize,
    pub unstaged_count: usize,
    pub untracked_count: usize,
    pub conflicted_count: usize,
    pub clean: bool,
    /// Numero de commits respecto al upstream (ahead/behind).
    pub ahead: usize,
    pub behind: usize,
    pub upstream: Option<String>,
    pub has_upstream: bool,
    /// Numero de entradas en el stash.
    pub stash_count: usize,
}

// ---------------------------------------------------------------------------
// Diffs
// ---------------------------------------------------------------------------

/// Which side of the index/worktree a diff compares.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DiffSide {
    /// working tree contra HEAD (cambios sin anadir)
    Worktree,
    /// indice contra HEAD (cambios anadidos)
    Staged,
    /// indice contra working tree
    IndexToWorktree,
    /// un commit contra su primer padre
    Commit,
    /// dos commits arbitrarios
    Range,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    /// `+`, `-`, ` ` o `\`.
    pub origin: char,
    pub content: String,
    pub old_lineno: Option<usize>,
    pub new_lineno: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffHunk {
    pub header: String,
    pub old_start: usize,
    pub old_lines: usize,
    pub new_start: usize,
    pub new_lines: usize,
    pub lines: Vec<DiffLine>,
    pub is_binary: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    pub old_path: Option<String>,
    pub is_binary: bool,
    pub too_large: bool,
    pub additions: usize,
    pub deletions: usize,
    pub hunks: Vec<DiffHunk>,
    /// Diff unificado sin parsear, por si el frontend necesita el texto plano.
    pub raw: String,
    pub kind: ChangeKind,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffResult {
    pub files: Vec<FileDiff>,
    pub total_additions: usize,
    pub total_deletions: usize,
    pub truncated: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffQuery {
    pub repo_id: String,
    pub side: DiffSide,
    /// Ruta del archivo. `None` produce el diff de todo el working tree.
    pub path: Option<String>,
    /// Base para `DiffSide::Commit` / `Range`.
    pub old_oid: Option<String>,
    /// Destino para `DiffSide::Range`.
    pub new_oid: Option<String>,
    /// Incluir archivos sin cambios.
    #[serde(default)]
    pub include_context: bool,
    /// Numero maximo de lineas por hunk.
    #[serde(default = "default_context")]
    pub context: usize,
    /// Cortar diffs de archivos mayores a este tamaño (bytes).
    pub max_file_bytes: Option<u64>,
}

fn default_context() -> usize {
    3
}

// ---------------------------------------------------------------------------
// Staging por hunks
// ---------------------------------------------------------------------------

/// Seleccion de lineas para stagear/unstagear parcialmente.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HunkSelection {
    pub path: String,
    pub old_path: Option<String>,
    /// Indices de hunk dentro del array `hunks` del diff.
    pub hunk_indices: Vec<usize>,
    /// Lineas incluidas dentro de esos hunks. Vacio = hunk completo.
    /// Formato: `{ hunkIndex, lineIndex, include }`.
    pub line_selections: Vec<LineSelection>,
    #[serde(default)]
    pub unstage: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LineSelection {
    pub hunk_index: usize,
    pub line_index: usize,
    pub include: bool,
}

// ---------------------------------------------------------------------------
// Stashes
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StashEntry {
    /// Indice en la pila de stash (0 = mas reciente).
    pub index: usize,
    pub oid: String,
    pub message: String,
    pub branch: String,
    pub author_name: String,
    pub author_time: i64,
    pub author_time_iso: String,
    pub staged_count: usize,
    pub unstaged_count: usize,
    pub untracked_count: usize,
    pub is_top: bool,
}

// ---------------------------------------------------------------------------
// Remotos
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteInfo {
    pub name: String,
    pub url: String,
    /// Host de la URL: la clave con la que se guardan las credenciales.
    pub host: String,
    pub push_url: Option<String>,
    pub fetch_refspecs: Vec<String>,
    pub push_refspecs: Vec<String>,
    /// `true` si se pudo contactar con el remoto en la ultima operacion.
    pub reachable: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchResult {
    pub remote: String,
    pub refs_updated: usize,
    pub refs_deleted: usize,
    pub new_branches: Vec<String>,
    pub deleted_branches: Vec<String>,
    pub objects_received: usize,
    pub duration_ms: u64,
    pub message: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushResult {
    pub remote: String,
    pub branch: String,
    pub refs_updated: usize,
    pub refs_deleted: usize,
    pub forced: bool,
    pub up_to_date: bool,
    pub message: String,
    pub duration_ms: u64,
}

/// Credenciales de acceso a un remoto.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Credential {
    pub username: String,
    pub password: String,
}

/// Estado de la credencial guardada para el host de un remoto.
///
/// No incluye la contrasena: solo si existe y el usuario, que es lo necesario
/// para poder indicarlo en la interfaz sin abrir el llavero.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialStatus {
    /// Host indexado en el llavero del sistema.
    pub host: String,
    pub saved: bool,
    pub username: Option<String>,
}

/// Identidad del usuario usada para firmar commits.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitIdentity {
    pub name: String,
    pub email: String,
    pub signing_key: Option<String>,
}



/// Respuesta del endpoint de device code de GitHub.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct GitHubDeviceCode {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub verification_uri_complete: Option<String>,
    pub expires_in: u64,
    pub interval: u64,
}

/// Respuesta al solicitar token (éxito).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct GitHubAccessToken {
    pub access_token: Option<String>,
    pub token_type: Option<String>,
    pub scope: Option<String>,
    pub error: Option<String>,
    pub error_description: Option<String>,
    pub interval: Option<u64>,
}

/// Estado del flujo de login de GitHub.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubLoginState {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub verification_uri_complete: Option<String>,
    pub expires_in: u64,
    pub interval: u64,
    pub interval_ms: u64,
    pub poll_interval_ms: u64,
    pub client_id: Option<String>,
}

/// Información de usuario autenticado en GitHub.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitHubUser {
    pub login: String,
    pub name: Option<String>,
    #[serde(alias = "avatar_url", rename = "avatarUrl")]
    pub avatar_url: Option<String>,
    #[serde(alias = "html_url", rename = "htmlUrl")]
    pub html_url: Option<String>,
    pub email: Option<String>,
    #[serde(alias = "public_repos", rename = "publicRepos")]
    pub public_repos: Option<u64>,
    #[serde(alias = "total_private_repos", rename = "totalPrivateRepos")]
    pub total_private_repos: Option<u64>,
}

/// Repositorio en GitHub del usuario.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitHubRepo {
    pub id: u64,
    pub name: String,
    #[serde(alias = "full_name", rename = "fullName")]
    pub full_name: String,
    pub private: bool,
    #[serde(alias = "html_url", rename = "htmlUrl")]
    pub html_url: String,
    #[serde(alias = "clone_url", rename = "cloneUrl")]
    pub clone_url: String,
    #[serde(alias = "ssh_url", rename = "sshUrl")]
    pub ssh_url: Option<String>,
    #[serde(alias = "default_branch", rename = "defaultBranch")]
    pub default_branch: Option<String>,
    pub description: Option<String>,
    #[serde(alias = "updated_at", rename = "updatedAt")]
    pub updated_at: Option<String>,
    pub fork: Option<bool>,
    #[serde(alias = "stargazers_count", rename = "stargazersCount")]
    pub stargazers_count: Option<u64>,
}

/// Resultado del login de GitHub.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubLoginResult {
    pub success: bool,
    pub token: Option<String>,
    pub username: Option<String>,
    pub user: Option<GitHubUser>,
    pub error: Option<String>,
    pub error_description: Option<String>,
}



// ---------------------------------------------------------------------------
// Resultados de acciones
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationResult {
    pub ok: bool,
    pub message: String,
    /// Nuevo HEAD tras la operacion, si cambio.
    pub head_oid: Option<String>,
    pub head_branch: Option<String>,
    /// Refs afectadas (para refrescar el grafo de forma incremental).
    pub affected_refs: Vec<String>,
}

impl OperationResult {
    pub fn ok(message: impl Into<String>) -> Self {
        Self {
            ok: true,
            message: message.into(),
            head_oid: None,
            head_branch: None,
            affected_refs: Vec::new(),
        }
    }

    pub fn with_head(mut self, oid: Option<String>, branch: Option<String>) -> Self {
        self.head_oid = oid;
        self.head_branch = branch;
        self
    }

    pub fn with_refs(mut self, refs: Vec<String>) -> Self {
        self.affected_refs = refs;
        self
    }
}

/// Resultado de un rebase/merge, con estado de conflictos.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeResult {
    pub success: bool,
    /// Commits introducidos por la operacion.
    pub new_commits: Vec<String>,
    pub conflicted_files: Vec<String>,
    pub message: String,
    /// Estado del repositorio tras la operacion.
    pub status: RepoStatus,
    /// `true` si queda pendiente un `git rebase --continue`.
    pub needs_continue: bool,
    /// Pasos pendientes de rebase (0 si no hay rebase en curso).
    pub rebase_steps_left: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RebasePlan {
    /// Commits que se van a reaplicar, en orden.
    pub commits: Vec<String>,
    /// Commits que se pueden dejar intactos via `--onto`/fast-forward.
    pub already_upstream: Vec<String>,
    /// `true` si la operacion podria resolverse con fast-forward.
    pub can_fast_forward: bool,
}

// ---------------------------------------------------------------------------
// Git Flow
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowConfig {
    pub enabled: bool,
    pub main_branch: String,
    pub develop_branch: String,
    pub feature_prefix: String,
    pub release_prefix: String,
    pub hotfix_prefix: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowStatus {
    pub config: FlowConfig,
    pub initialized: bool,
    pub current_branch: Option<String>,
    pub current_type: FlowBranchType,
    pub main_exists: bool,
    pub develop_exists: bool,
    pub active_features: Vec<String>,
    pub active_releases: Vec<String>,
    pub active_hotfixes: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FlowBranchType {
    Main,
    Develop,
    Feature,
    Release,
    Hotfix,
    Support,
    Unknown,
}

// ---------------------------------------------------------------------------
// Historial de un archivo
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileHistoryEntry {
    pub oid: String,
    pub short_oid: String,
    pub author_name: String,
    pub author_time: i64,
    pub author_time_iso: String,
    pub subject: String,
    pub status_char: String,
    pub kind: ChangeKind,
    pub old_path: Option<String>,
}

// ---------------------------------------------------------------------------
// Reflog
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReflogEntry {
    pub index: usize,
    pub oid: String,
    pub short_oid: String,
    pub previous_oid: Option<String>,
    pub message: String,
    pub author_name: String,
    pub timestamp: i64,
    pub timestamp_iso: String,
    pub committer: String,
}

// ---------------------------------------------------------------------------
// Comparacion y estado de operaciones
// ---------------------------------------------------------------------------

/// Relacion entre dos ramas.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchComparison {
    pub base: String,
    pub target: String,
    /// Commits que `target` tiene y `base` no.
    pub ahead: usize,
    /// Commits que `base` tiene y `target` no.
    pub behind: usize,
    /// `true` si `base` es ancestro de `target` (se puede hacer fast-forward).
    pub can_fast_forward: bool,
}

/// Operaciones de git pendientes de resolucion.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryOperationState {
    pub merge_in_progress: bool,
    pub rebase_in_progress: bool,
    pub conflicted_files: Vec<String>,
}

/// Resultado de una operacion de Git Flow.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowOperationResult {
    /// Nombre completo de la rama creada.
    pub branch: String,
    pub operation: OperationResult,
}

/// Tag con detalle suficiente para la UI de releases.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagDetail {
    /// Nombre corto (sin `refs/tags/`).
    pub name: String,
    /// Nombre completo de la referencia.
    pub full_name: String,
    /// OID completo del commit etiquetado.
    pub oid: String,
    /// OID abreviado a 7 caracteres.
    pub short_oid: String,
    /// Mensaje del tag anotado; `None` si es ligero.
    pub message: Option<String>,
}

/// Sugerencia de version para el dialogo de creacion de tag.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagSuggestion {
    /// Version sugerida (p.ej. `v0.1.1`).
    pub suggested: String,
    /// Ultima version semver detectada, si la hay.
    pub latest: Option<String>,
    /// Tags existentes en el repositorio.
    pub tags: Vec<TagDetail>,
}