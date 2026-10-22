/**
 * Capa IPC de Foxen.
 *
 * Cada funcion es un wrapper tipado sobre `invoke`. Tauri convierte las claves
 * del objeto de argumentos de camelCase a los parametros snake_case de Rust,
 * asi que aqui se usan nombres camelCase. Los `Option<T>` del backend se pasan
 * como `null` explicito, que serde deserializa a `None`.
 */

import { Channel, invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type {
  AppError,
  BranchComparison,
  BranchList,
  CommitDetail,
  CommitGraph,
  DiffQuery,
  DiffResult,
  FetchResult,
  FileHistoryEntry,
  FlowConfig,
  FlowOperationResult,
  FlowStatus,
  GraphQuery,
  HunkSelection,
  MergeResult,
  OperationResult,
  PushResult,
  PtyOutput,
  RebasePlan,
  ReflogEntry,
  RemoteInfo,
  RepositoryHandle,
  RepositoryOpenResult,
  RepositoryOperationState,
  RepoStatus,
  StashEntry,
  TagDetail,
  TagSuggestion,
  Credential,
  CredentialStatus,
  GitHubLoginState,
  GitHubLoginResult,
  GitHubUser,
  GitHubRepo,
} from './types';
import type { ErrorKind } from './types';

/** Error normalizado de una llamada IPC fallida. */
export class FoxenError extends Error {
  readonly kind: ErrorKind;
  readonly code: number;
  readonly detail?: string;

  constructor(raw: Partial<AppError> & { message?: string }) {
    super(raw.message ?? 'Error desconocido');
    this.name = 'FoxenError';
    this.kind = raw.kind ?? 'internal';
    this.code = raw.code ?? 0;
    if (raw.detail) this.detail = raw.detail;
  }
}

/** Traduce el rechazo de `invoke` a un `FoxenError`. */
async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (raw) {
    throw new FoxenError(raw as Partial<AppError>);
  }
}

/** `true` si el error corresponde a una operacion cancelada por el usuario. */
export function isCancelled(error: unknown): boolean {
  return error instanceof FoxenError && error.kind === 'cancelled';
}

/** Mensaje listo para mostrar al usuario. */
export function errorMessage(error: unknown): string {
  if (error instanceof FoxenError) {
    return error.detail ? `${error.message}: ${error.detail}` : error.message;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

// ---------------------------------------------------------------------------
// Repositorios
// ---------------------------------------------------------------------------

export const openRepository = (path: string, allowBare = false) =>
  call<RepositoryOpenResult>('open_repository', { path, allowBare });

export const cloneRepository = (url: string, path: string) =>
  call<RepositoryOpenResult>('clone_repository', { url, path });

export const closeRepository = (repoId: string) =>
  call<void>('close_repository', { repoId });

export const listRepositories = () => call<RepositoryHandle[]>('list_repositories');

export const recentRepositories = () => call<string[]>('recent_repositories');

export const scanForRepositories = (path: string, maxDepth: number | null = null) =>
  call<string[]>('scan_for_repositories', { path, maxDepth });

// ---------------------------------------------------------------------------
// Grafo y ramas
// ---------------------------------------------------------------------------

export const loadGraph = (query: GraphQuery) => call<CommitGraph>('load_graph', { query });

export const listBranches = (repoId: string) => call<BranchList>('list_branches', { repoId });

export const createBranch = (
  repoId: string,
  name: string,
  startPoint: string | null,
  checkout: boolean,
  force = false,
  track = false,
) =>
  call<OperationResult>('create_branch', {
    repoId,
    name,
    startPoint,
    checkout,
    force,
    track,
  });

export const checkoutBranch = (repoId: string, target: string) =>
  call<OperationResult>('checkout_branch', { repoId, target });

export const deleteBranch = (repoId: string, name: string, force = false) =>
  call<OperationResult>('delete_branch', { repoId, name, force });

export const renameBranch = (repoId: string, oldName: string, newName: string) =>
  call<OperationResult>('rename_branch', { repoId, oldName, newName });

export const setUpstream = (repoId: string, branch: string, upstream: string | null) =>
  call<OperationResult>('set_upstream', { repoId, branch, upstream });

export const resetBranch = (repoId: string, branch: string, target: string, mode: string) =>
  call<OperationResult>('reset_branch', { repoId, branch, target, mode });

export const listTags = (repoId: string) => call<TagDetail[]>('list_tags', { repoId });

/** Crea un tag; con `message` es anotado, sin el es ligero. */
export const createTag = (
  repoId: string,
  name: string,
  message: string | null = null,
  target: string | null = null,
  force = false,
) => call<OperationResult>('create_tag', { repoId, name, message, target, force });

export const deleteTag = (repoId: string, name: string) =>
  call<OperationResult>('delete_tag', { repoId, name });

export const suggestTag = (repoId: string) =>
  call<TagSuggestion>('suggest_tag', { repoId });

// ---------------------------------------------------------------------------
// Commits
// ---------------------------------------------------------------------------

export const createCommit = (
  repoId: string,
  message: string,
  amend = false,
  allowEmpty = false,
  stagedOnly = true,
  target: string | null = null,
) =>
  call<OperationResult>('create_commit', {
    repoId,
    message,
    amend,
    allowEmpty,
    stagedOnly,
    target,
  });

export const getCommitDetail = (repoId: string, oid: string) =>
  call<CommitDetail>('get_commit_detail', { repoId, oid });

export const cherryPick = (
  repoId: string,
  oid: string,
  noCommit = false,
  mainline: number | null = null,
) => call<OperationResult>('cherry_pick', { repoId, oid, noCommit, mainline });

export const revertCommit = (
  repoId: string,
  oid: string,
  noCommit = false,
  mainline: number | null = null,
) => call<OperationResult>('revert_commit', { repoId, oid, noCommit, mainline });

export const deleteCommit = (repoId: string, oid: string) =>
  call<OperationResult>('delete_commit', { repoId, oid });

export const moveBranchTo = (repoId: string, branch: string, target: string) =>
  call<OperationResult>('move_branch_to', { repoId, branch, target });

export const listFileHistory = (repoId: string, path: string, limit: number | null = null) =>
  call<FileHistoryEntry[]>('list_file_history', { repoId, path, limit });

export const listReflog = (repoId: string, limit: number | null = null) =>
  call<ReflogEntry[]>('list_reflog', { repoId, limit });

// ---------------------------------------------------------------------------
// Estado y staging
// ---------------------------------------------------------------------------

export const getStatus = (repoId: string) => call<RepoStatus>('get_status', { repoId });

export const getDiff = (query: DiffQuery) => call<DiffResult>('get_diff', { query });

export const stageFiles = (repoId: string, paths: string[]) =>
  call<RepoStatus>('stage_files', { repoId, paths });

export const unstageFiles = (repoId: string, paths: string[]) =>
  call<RepoStatus>('unstage_files', { repoId, paths });

export const stageAll = (repoId: string) => call<RepoStatus>('stage_all', { repoId });

export const discardFiles = (repoId: string, paths: string[]) =>
  call<RepoStatus>('discard_files', { repoId, paths });

export const stageHunks = (repoId: string, selections: HunkSelection[]) =>
  call<RepoStatus>('stage_hunks', { repoId, selections });

export const discardHunk = (
  repoId: string,
  path: string,
  hunkIndex: number,
  reverse = false,
) => call<RepoStatus>('discard_hunk', { repoId, path, hunkIndex, reverse });

export const resolveConflict = (repoId: string, path: string, side: string | null) =>
  call<RepoStatus>('resolve_conflict', { repoId, path, side });

// ---------------------------------------------------------------------------
// Merge y rebase
// ---------------------------------------------------------------------------

export const mergeBranch = (
  repoId: string,
  target: string,
  noFf = false,
  ffOnly = false,
  squash = false,
  message: string | null = null,
) =>
  call<MergeResult>('merge_branch', {
    repoId,
    target,
    noFf,
    ffOnly,
    squash,
    message,
  });

export const abortMerge = (repoId: string) => call<MergeResult>('abort_merge', { repoId });

/** Fusiona `source` en `destination`, cambiando de rama si hace falta. */
export const mergeInto = (
  repoId: string,
  source: string,
  destination: string,
  noFf = false,
  ffOnly = false,
  squash = false,
  message: string | null = null,
) =>
  call<MergeResult>('merge_into', {
    repoId,
    source,
    destination,
    noFf,
    ffOnly,
    squash,
    message,
  });

export const mergeContinue = (repoId: string, message: string | null = null) =>
  call<OperationResult>('merge_continue', { repoId, message });

export const planRebase = (repoId: string, onto: string, branch: string | null = null) =>
  call<RebasePlan>('plan_rebase', { repoId, onto, branch });

export const rebaseOnto = (repoId: string, onto: string, force = false) =>
  call<MergeResult>('rebase_onto', { repoId, onto, force });

export const rebaseContinue = (repoId: string) => call<MergeResult>('rebase_continue', { repoId });

export const rebaseSkip = (repoId: string) => call<MergeResult>('rebase_skip', { repoId });

export const rebaseAbort = (repoId: string) => call<MergeResult>('rebase_abort', { repoId });

export const compareBranches = (repoId: string, base: string, target: string) =>
  call<BranchComparison>('compare_branches', { repoId, base, target });

export const repositoryOperationState = (repoId: string) =>
  call<RepositoryOperationState>('repository_operation_state', { repoId });

// ---------------------------------------------------------------------------
// Stash
// ---------------------------------------------------------------------------

export const listStashes = (repoId: string) => call<StashEntry[]>('list_stashes', { repoId });

export const pushStash = (
  repoId: string,
  message: string | null = null,
  includeUntracked = true,
  keepIndex = false,
  all = false,
) =>
  call<OperationResult>('push_stash', {
    repoId,
    message,
    includeUntracked,
    keepIndex,
    all,
  });

export const applyStash = (repoId: string, index: number, reinstateIndex = false) =>
  call<OperationResult>('apply_stash', { repoId, index, reinstateIndex });

export const popStash = (repoId: string, index: number) =>
  call<OperationResult>('pop_stash', { repoId, index });

export const dropStash = (repoId: string, index: number) =>
  call<OperationResult>('drop_stash', { repoId, index });

export const clearStashes = (repoId: string) =>
  call<OperationResult>('clear_stashes', { repoId });

export const branchFromStash = (repoId: string, index: number, branchName: string) =>
  call<OperationResult>('branch_from_stash', { repoId, index, branchName });

// ---------------------------------------------------------------------------
// Remotos
// ---------------------------------------------------------------------------

export const listRemotes = (repoId: string) => call<RemoteInfo[]>('list_remotes', { repoId });

export const addRemote = (
  repoId: string,
  name: string,
  url: string,
  pushUrl: string | null = null,
  mirror = false,
) => call<RemoteInfo>('add_remote', { repoId, name, url, pushUrl, mirror });

export const renameRemote = (repoId: string, oldName: string, newName: string) =>
  call<OperationResult>('rename_remote', { repoId, oldName, newName });

export const removeRemote = (repoId: string, name: string) =>
  call<OperationResult>('remove_remote', { repoId, name });

export const fetchRemote = (
  repoId: string,
  remoteName: string | null = null,
  prune = false,
  credential: Credential | null = null,
) => call<FetchResult>('fetch_remote', { repoId, remoteName, prune, credential });

export const pushRemote = (
  repoId: string,
  remoteName: string,
  branch: string | null = null,
  force = false,
  setUpstream = false,
  deleteRemote = false,
  credential: Credential | null = null,
) =>
  call<PushResult>('push_remote', {
    repoId,
    remoteName,
    branch,
    force,
    setUpstream,
    deleteRemote,
    credential,
  });

export const pullRemote = (
  repoId: string,
  remoteName: string | null = null,
  branch: string | null = null,
  rebase = false,
  prune = false,
  credential: Credential | null = null,
) =>
  call<FetchResult>('pull_remote', { repoId, remoteName, branch, rebase, prune, credential });

/** Guarda usuario y contrasena para un host en el llavero del sistema. */
export const storeCredential = (host: string, credential: Credential) =>
  call<void>('store_credential', { host, credential });

/** Olvida la credencial guardada para un host. */
export const forgetCredential = (host: string) => call<void>('forget_credential', { host });

/** Dice si hay credencial guardada para un host, y de que usuario. */
export const credentialStatus = (host: string) =>
  call<CredentialStatus>('credential_status', { host });

export const testRemote = (
  repoId: string,
  remoteName: string,
  credential: Credential | null = null,
) => call<FetchResult>('test_remote', { repoId, remoteName, credential });

// ---------------------------------------------------------------------------
// Git Flow
// ---------------------------------------------------------------------------

export const flowStatus = (repoId: string) => call<FlowStatus>('flow_status', { repoId });

export const flowInit = (repoId: string, config: FlowConfig) =>
  call<FlowStatus>('flow_init', { repoId, config });

export const flowDisable = (repoId: string) => call<FlowStatus>('flow_disable', { repoId });

export const flowFeatureStart = (repoId: string, name: string, checkout = true) =>
  call<FlowOperationResult>('flow_feature_start', { repoId, name, checkout });

export const flowFeatureFinish = (repoId: string, name: string, del = false) =>
  call<OperationResult>('flow_feature_finish', { repoId, name, delete: del });

export const flowReleaseStart = (repoId: string, version: string, checkout = true) =>
  call<FlowOperationResult>('flow_release_start', { repoId, version, checkout });

export const flowReleaseFinish = (repoId: string, name: string) =>
  call<OperationResult>('flow_release_finish', { repoId, name });

export const flowHotfixStart = (repoId: string, name: string, checkout = true) =>
  call<FlowOperationResult>('flow_hotfix_start', { repoId, name, checkout });

export const flowHotfixFinish = (repoId: string, name: string) =>
  call<OperationResult>('flow_hotfix_finish', { repoId, name });

// ---------------------------------------------------------------------------
// Sistema
// ---------------------------------------------------------------------------

/** Abre una terminal del sistema en la carpeta del repositorio. */
export const openTerminal = (repoId: string) => call<OperationResult>('open_terminal', { repoId });

// ---------------------------------------------------------------------------
// Terminal embebida
// ---------------------------------------------------------------------------

/** Arranca el shell del usuario; su salida llega por `channel`. */
export const startPty = (
  repoId: string,
  cwd: string,
  cols: number,
  rows: number,
  channel: Channel<PtyOutput>,
) => call<void>('start_pty', { repoId, cwd, cols, rows, channel });

/** Escribe en la PTY lo que teclea el usuario (en base64). */
export const writePty = (repoId: string, data: string) =>
  call<void>('write_pty', { repoId, data });

export const resizePty = (repoId: string, cols: number, rows: number) =>
  call<void>('resize_pty', { repoId, cols, rows });

/** Cierra la terminal y mata el shell. */
export const stopPty = (repoId: string) => call<void>('stop_pty', { repoId });

// ---------------------------------------------------------------------------
// GitHub OAuth y API
// ---------------------------------------------------------------------------

/** Inicia el flujo OAuth Device Flow con GitHub y abre el navegador. */
export const githubStartLogin = (clientId: string | null = null) =>
  call<GitHubLoginState>('github_start_login', { clientId });

/** Consulta si el usuario ya autorizo la aplicacion en GitHub. */
export const githubPollLogin = (state: GitHubLoginState) =>
  call<GitHubLoginResult>('github_poll_login', { state });

/** Guarda manualmente el token obtenido y actualiza el usuario. */
export const githubLoginComplete = (token: string, username: string | null = null) =>
  call<GitHubLoginResult>('github_login_complete', { token, username });

/** Inicia sesión reutilizando la sesión de la GitHub CLI (`gh`). */
export const githubLoginWithGh = () => call<GitHubLoginResult>('github_login_with_gh');

/** Dice si el Device Flow está configurado (Client ID en el entorno). */
export const githubDeviceFlowConfigured = () =>
  call<boolean>('github_device_flow_configured');

/** Obtiene el usuario autenticado en GitHub si hay credencial guardada. */
export const githubGetUser = () => call<GitHubUser | null>('github_get_user');

/** Cierra la sesion de GitHub eliminando la credencial guardada. */
export const githubLogout = () => call<void>('github_logout');

/** Lista los repositorios del usuario autenticado en GitHub. */
export const githubListRepos = () => call<GitHubRepo[]>('github_list_repos');

/** Crea un repositorio vacío en la cuenta personal o de una organización. */
export const githubCreateRepo = (
  name: string,
  isPrivate: boolean,
  description: string | null,
  owner: string | null,
) => call<GitHubRepo>('github_create_repo', { name, private: isPrivate, description, owner });

export const githubPublishRepo = (
  repoId: string,
  name: string,
  isPrivate: boolean,
  description: string | null,
  owner: string | null,
  replaceOrigin = false,
) =>
  call<GitHubRepo>('github_publish_repo', {
    repoId,
    name,
    private: isPrivate,
    description,
    owner,
    replaceOrigin,
  });

// ---------------------------------------------------------------------------
// Eventos del backend
// ---------------------------------------------------------------------------

/**
 * Escucha los cambios detectados por el watcher (inotify) del backend.
 *
 * Devuelve la funcion para dejar de escuchar. El `repoId` permite ignorar
 * repositorios que no estan activos en la UI.
 */
export const onGitChanged = (handler: (repoId: string) => void) =>
  listen<{ repoId: string }>('git://changed', (event) => handler(event.payload.repoId));

/**
 * Recoge la URL de clonado recibida al arrancar (enlace `git://` de xdg-open).
 *
 * Se usa al montar porque el enlace puede llegar antes de que la webview
 * empiece a escuchar eventos.
 */
export const takePendingCloneUrl = () => call<string | null>('take_pending_clone_url');

/** Escucha enlaces `git://` recibidos con la app ya abierta (segunda instancia). */
export const onCloneRequest = (handler: (url: string) => void) =>
  listen<{ url: string }>('git://clone-request', (event) => handler(event.payload.url));

// ---------------------------------------------------------------------------
// Ajustes persistentes (settings.json en el directorio de configuracion)
// ---------------------------------------------------------------------------

export interface StoredSession {
  paths: string[];
  active: string | null;
}

export interface StoredSettings {
  session: StoredSession;
  theme: string | null;
  locale: string | null;
}

export const settingsLoad = () => call<StoredSettings>('settings_load');

export const settingsSaveSession = (session: StoredSession) =>
  call<void>('settings_save_session', { session });

export const settingsSaveTheme = (theme: string) =>
  call<void>('settings_save_theme', { theme });

export const settingsSaveLocale = (locale: string) =>
  call<void>('settings_save_locale', { locale });
