/**
 * Contratos del backend Rust (`src-tauri/src/types.rs`).
 *
 * Los tipos Rust usan `#[serde(rename_all = "camelCase")]`, por lo que estas
 * definiciones deben coincidir exactamente con las del backend. Si cambias un
 * DTO en Rust, actualiza el equivalente aqui.
 */

// ---------------------------------------------------------------------------
// Errores
// ---------------------------------------------------------------------------

export type ErrorKind =
  | 'notARepository'
  | 'repositoryNotFound'
  | 'notFound'
  | 'git'
  | 'io'
  | 'invalidState'
  | 'cancelled'
  | 'authentication'
  | 'network'
  | 'busy'
  | 'validation'
  | 'internal';

export interface AppError {
  kind: ErrorKind;
  message: string;
  detail?: string;
  code: number;
}

// ---------------------------------------------------------------------------
// Repositorios
// ---------------------------------------------------------------------------

export interface RepositoryHandle {
  id: string;
  path: string;
  name: string;
  bare: boolean;
  headBranch: string | null;
  detached: boolean;
  defaultBranch: string | null;
}

export interface RepositoryOpenResult {
  handle: RepositoryHandle;
  alreadyOpen: boolean;
}

// ---------------------------------------------------------------------------
// Referencias y ramas
// ---------------------------------------------------------------------------

export type RefKind = 'branch' | 'remoteBranch' | 'tag' | 'other';

export interface RefLabel {
  name: string;
  fullName: string;
  kind: RefKind;
  isHead: boolean;
  isDetached: boolean;
}

export interface BranchInfo {
  name: string;
  fullName: string;
  oid: string;
  shortOid: string;
  subject: string;
  authorName: string;
  authorEmail: string;
  authorTime: number;
  isHead: boolean;
  isRemote: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  hasUncommittedChanges: boolean;
  lastCommitMessage: string;
}

export interface BranchList {
  branches: BranchInfo[];
  head: string | null;
}

export interface TagDetail {
  name: string;
  fullName: string;
  oid: string;
  shortOid: string;
  message: string | null;
}

export interface TagSuggestion {
  suggested: string;
  latest: string | null;
  tags: TagDetail[];
}

// ---------------------------------------------------------------------------
// Grafo de commits
// ---------------------------------------------------------------------------

export interface CommitNode {
  oid: string;
  shortOid: string;
  row: number;
  lane: number;
  parents: string[];
  subject: string;
  body: string | null;
  authorName: string;
  authorEmail: string;
  authorTime: number;
  authorTimeIso: string;
  commitTimeIso: string;
  labels: RefLabel[];
  isMerge: boolean;
  isHead: boolean;
  isRoot: boolean;
}

export interface GraphEdge {
  fromRow: number;
  fromLane: number;
  toRow: number;
  toLane: number;
  isMergeEdge: boolean;
}

export interface CommitGraph {
  nodes: CommitNode[];
  edges: GraphEdge[];
  laneCount: number;
  truncated: boolean;
  totalReachable: number;
}

export interface GraphQuery {
  repoId: string;
  limit?: number;
  heads: string[];
  allRefs?: boolean;
  currentOnly?: boolean;
  highlight?: string | null;
}

// ---------------------------------------------------------------------------
// Detalle de commit
// ---------------------------------------------------------------------------

export type ChangeKind =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'typeChanged'
  | 'untracked'
  | 'ignored'
  | 'conflicted';

export interface CommitStats {
  filesChanged: number;
  insertions: number;
  deletions: number;
}

export interface CommitFileChange {
  path: string;
  oldPath: string | null;
  kind: ChangeKind;
  isBinary: boolean;
  insertions: number;
  deletions: number;
  statusChar: string;
}

export interface CommitDetail {
  oid: string;
  shortOid: string;
  subject: string;
  body: string | null;
  authorName: string;
  authorEmail: string;
  authorTime: number;
  authorTimeIso: string;
  committerName: string;
  committerEmail: string;
  commitTimeIso: string;
  parents: string[];
  isMerge: boolean;
  stats: CommitStats;
  files: CommitFileChange[];
  bodyRaw: string;
  reachableFromHead: boolean;
}

// ---------------------------------------------------------------------------
// Estado del working tree / staging
// ---------------------------------------------------------------------------

export interface FileStatus {
  path: string;
  oldPath: string | null;
  indexStatus: string;
  worktreeStatus: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  ignored: boolean;
  conflicted: boolean;
  isBinary: boolean;
  insertions: number;
  deletions: number;
  kind: ChangeKind;
}

export interface RepoStatus {
  headBranch: string | null;
  headOid: string | null;
  headSubject: string | null;
  files: FileStatus[];
  stagedCount: number;
  unstagedCount: number;
  untrackedCount: number;
  conflictedCount: number;
  clean: boolean;
  ahead: number;
  behind: number;
  upstream: string | null;
  hasUpstream: boolean;
  stashCount: number;
}

// ---------------------------------------------------------------------------
// Diffs
// ---------------------------------------------------------------------------

export type DiffSide = 'worktree' | 'staged' | 'indexToWorktree' | 'commit' | 'range';

export interface DiffLine {
  origin: string;
  content: string;
  oldLineno: number | null;
  newLineno: number | null;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
  isBinary: boolean;
}

export interface FileDiff {
  path: string;
  oldPath: string | null;
  isBinary: boolean;
  tooLarge: boolean;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  raw: string;
  kind: ChangeKind;
}

export interface DiffResult {
  files: FileDiff[];
  totalAdditions: number;
  totalDeletions: number;
  truncated: boolean;
}

export interface DiffQuery {
  repoId: string;
  side: DiffSide;
  path: string | null;
  oldOid: string | null;
  newOid: string | null;
  includeContext?: boolean;
  context?: number;
  maxFileBytes: number | null;
}

// ---------------------------------------------------------------------------
// Staging por fragmentos
// ---------------------------------------------------------------------------

export interface LineSelection {
  hunkIndex: number;
  lineIndex: number;
  include: boolean;
}

export interface HunkSelection {
  path: string;
  oldPath: string | null;
  hunkIndices: number[];
  lineSelections: LineSelection[];
  unstage?: boolean;
}

// ---------------------------------------------------------------------------
// Stashes
// ---------------------------------------------------------------------------

export interface StashEntry {
  index: number;
  oid: string;
  message: string;
  branch: string;
  authorName: string;
  authorTime: number;
  authorTimeIso: string;
  stagedCount: number;
  unstagedCount: number;
  untrackedCount: number;
  isTop: boolean;
}

// ---------------------------------------------------------------------------
// Remotos
// ---------------------------------------------------------------------------

export interface RemoteInfo {
  name: string;
  url: string;
  /** Host de la URL: la clave con la que se guardan las credenciales. */
  host: string;
  pushUrl: string | null;
  fetchRefspecs: string[];
  pushRefspecs: string[];
  reachable: boolean;
}

export interface FetchResult {
  remote: string;
  refsUpdated: number;
  refsDeleted: number;
  newBranches: string[];
  deletedBranches: string[];
  objectsReceived: number;
  durationMs: number;
  message: string;
}

export interface PushResult {
  remote: string;
  branch: string;
  refsUpdated: number;
  refsDeleted: number;
  forced: boolean;
  upToDate: boolean;
  message: string;
  durationMs: number;
}

export interface Credential {
  username: string;
  password: string;
}

/** Estado de la credencial guardada para el host de un remoto. */
export interface CredentialStatus {
  /** Host indexado en el llavero del sistema. */
  host: string;
  saved: boolean;
  /** Usuario guardado, si lo hay. La contraseña nunca sale del llavero. */
  username: string | null;
}

export interface GitIdentity {
  name: string;
  email: string;
  signingKey: string | null;
}

// ---------------------------------------------------------------------------
// Resultados de operaciones
// ---------------------------------------------------------------------------

export interface OperationResult {
  ok: boolean;
  message: string;
  headOid: string | null;
  headBranch: string | null;
  affectedRefs: string[];
}

export interface MergeResult {
  success: boolean;
  newCommits: string[];
  conflictedFiles: string[];
  message: string;
  status: RepoStatus;
  needsContinue: boolean;
  rebaseStepsLeft: number;
}

export interface RebasePlan {
  commits: string[];
  alreadyUpstream: string[];
  canFastForward: boolean;
}

export interface RepositoryOperationState {
  mergeInProgress: boolean;
  rebaseInProgress: boolean;
  conflictedFiles: string[];
}

export interface BranchComparison {
  base: string;
  target: string;
  ahead: number;
  behind: number;
  canFastForward: boolean;
}

// ---------------------------------------------------------------------------
// Git Flow
// ---------------------------------------------------------------------------

export interface FlowConfig {
  enabled: boolean;
  mainBranch: string;
  developBranch: string;
  featurePrefix: string;
  releasePrefix: string;
  hotfixPrefix: string;
}

export type FlowBranchType =
  | 'main'
  | 'develop'
  | 'feature'
  | 'release'
  | 'hotfix'
  | 'support'
  | 'unknown';

export interface FlowStatus {
  config: FlowConfig;
  initialized: boolean;
  currentBranch: string | null;
  currentType: FlowBranchType;
  mainExists: boolean;
  developExists: boolean;
  activeFeatures: string[];
  activeReleases: string[];
  activeHotfixes: string[];
}

export interface FlowOperationResult {
  branch: string;
  operation: OperationResult;
}

// ---------------------------------------------------------------------------
// Historial y reflog
// ---------------------------------------------------------------------------

export interface FileHistoryEntry {
  oid: string;
  shortOid: string;
  authorName: string;
  authorTime: number;
  authorTimeIso: string;
  subject: string;
  statusChar: string;
  kind: ChangeKind;
  oldPath: string | null;
}

export interface ReflogEntry {
  index: number;
  oid: string;
  shortOid: string;
  previousOid: string | null;
  message: string;
  authorName: string;
  timestamp: number;
  timestampIso: string;
  committer: string;
}

// ---------------------------------------------------------------------------
// Terminal embebida
// ---------------------------------------------------------------------------

/** Trozo de salida de la terminal embebida. */
export interface PtyOutput {
  /** Salida codificada en base64. */
  data: string;
  /** `true` solo en el ultimo mensaje: el shell ha terminado. */
  exited: boolean;
}

// ---------------------------------------------------------------------------
// GitHub OAuth y API
// ---------------------------------------------------------------------------

export interface GitHubLoginState {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string | null;
  expiresIn: number;
  interval: number;
  intervalMs: number;
  pollIntervalMs: number;
  clientId?: string | null;
}

export interface GitHubUser {
  login: string;
  name?: string | null;
  avatarUrl?: string | null;
  htmlUrl?: string | null;
  email?: string | null;
  publicRepos?: number | null;
  totalPrivateRepos?: number | null;
}

export interface GitHubRepo {
  id: number;
  name: string;
  fullName: string;
  private: boolean;
  htmlUrl: string;
  cloneUrl: string;
  sshUrl?: string | null;
  defaultBranch?: string | null;
  description?: string | null;
  updatedAt?: string | null;
  fork?: boolean | null;
  stargazersCount?: number | null;
}

export interface GitHubLoginResult {
  success: boolean;
  token?: string | null;
  username?: string | null;
  user?: GitHubUser | null;
  error?: string | null;
  errorDescription?: string | null;
}
