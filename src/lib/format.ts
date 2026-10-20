/** Utilidades de presentacion compartidas. */

import type { ChangeKind, FileStatus } from './types';

/**
 * Colores de carril del grafo.
 *
 * Se referencian como variables CSS (`--lane-N`) definidas en `styles.css` en
 * lugar de hex literales: asi el grafo hereda la paleta del tema activo sin
 * que React tenga que repintarse al cambiar de tema.
 */
export const LANE_COLOR_COUNT = 10;

export function laneColor(lane: number): string {
  const index = ((lane % LANE_COLOR_COUNT) + LANE_COLOR_COUNT) % LANE_COLOR_COUNT;
  return `var(--lane-${index})`;
}

/** Clase CSS segun el tipo de cambio. */
export function changeColor(kind: ChangeKind): string {
  switch (kind) {
    case 'added':
    case 'untracked':
      return 'added';
    case 'deleted':
      return 'deleted';
    case 'renamed':
    case 'copied':
      return 'renamed';
    case 'typeChanged':
      return 'modified';
    case 'conflicted':
      return 'conflicted';
    case 'ignored':
      return 'ignored';
    default:
      return 'modified';
  }
}

/** Categorias de tipo de commit deducidas del prefijo del mensaje. */
export type CommitKind = 'feature' | 'fix' | 'docs' | 'chore' | 'refactor' | 'test' | 'perf';

interface CommitKindMeta {
  kind: CommitKind;
  /** Etiqueta tipografica corta que se muestra en el badge. */
  badge: string;
  label: string;
}

const COMMIT_KIND_MAP: Record<CommitKind, CommitKindMeta> = {
  feature: { kind: 'feature', badge: 'F', label: 'feature' },
  fix: { kind: 'fix', badge: 'D', label: 'fix' },
  docs: { kind: 'docs', badge: 'docs', label: 'documentación' },
  chore: { kind: 'chore', badge: 'chore', label: 'mantenimiento' },
  refactor: { kind: 'refactor', badge: 'refactor', label: 'refactor' },
  test: { kind: 'test', badge: 'test', label: 'pruebas' },
  perf: { kind: 'perf', badge: 'perf', label: 'rendimiento' },
};

/** Prefijos convencionales (Conventional Commits) que mapean a cada categoria. */
const COMMIT_PREFIXES: [RegExp, CommitKind][] = [
  [/^\s*(feat|feature)(\(|:|\b)/i, 'feature'],
  [/^\s*(fix|bugfix|hotfix)(\(|:|\b)/i, 'fix'],
  [/^\s*docs?(\(|:|\b)/i, 'docs'],
  [/^\s*(chore|build|ci|deps|release)(\(|:|\b)/i, 'chore'],
  [/^\s*refactor(\(|:|\b)/i, 'refactor'],
  [/^\s*tests?(\(|:|\b)/i, 'test'],
  [/^\s*perf(\(|:|\b)/i, 'perf'],
];

/**
 * Deduce la categoria de un commit a partir del asunto.
 *
 * Reconoce el estilo Conventional Commits (`feat:`, `fix(ui):`…) y, si no hay
 * prefijo, cae a palabras clave del mensaje para no dejar la fila sin badge.
 */
export function commitKind(subject: string): CommitKindMeta {
  for (const [pattern, kind] of COMMIT_PREFIXES) {
    if (pattern.test(subject)) return COMMIT_KIND_MAP[kind];
  }
  const text = subject.toLowerCase();
  if (/(añad|anad|implement|agreg|integra|crea|create|support|soporte|nuev|new)/.test(text)) {
    return COMMIT_KIND_MAP.feature;
  }
  if (/(fix|arregl|corrig|corrige|bug|error|resuelv|soluciona)/.test(text)) {
    return COMMIT_KIND_MAP.fix;
  }
  if (/(readme|doc|coment|nota)/.test(text)) return COMMIT_KIND_MAP.docs;
  if (/(refactor|limpia|clean|rename|renombr)/.test(text)) return COMMIT_KIND_MAP.refactor;
  if (/(test|prueb|spec)/.test(text)) return COMMIT_KIND_MAP.test;
  return COMMIT_KIND_MAP.chore;
}

/** Letra que representa el estado en las columnas del index/worktree. */
export function statusChar(file: FileStatus): string {
  if (file.conflicted) return 'U';
  if (file.staged && file.unstaged) return 'M';
  if (file.staged) return file.indexStatus || 'M';
  if (file.untracked) return '?';
  return file.worktreeStatus || 'M';
}

/** Ruta shown en la UI: solo el nombre del archivo. */
export function baseName(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? path : path.slice(idx + 1);
}

/** Directorio de una ruta, o cadena vacia si esta en la raiz. */
export function dirName(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '' : path.slice(0, idx);
}

/** Tiempo relativo corto: "hace 3h". */
export function relativeTime(unixSeconds: number): string {
  const delta = Math.floor(Date.now() / 1000) - unixSeconds;
  if (delta < 0) return 'ahora';
  if (delta < 60) return 'ahora';
  if (delta < 3600) return `hace ${Math.floor(delta / 60)}m`;
  if (delta < 86400) return `hace ${Math.floor(delta / 3600)}h`;
  if (delta < 2592000) return `hace ${Math.floor(delta / 86400)}d`;
  return new Date(unixSeconds * 1000).toLocaleDateString();
}

/** Ancho aproximado de un texto en pixeles, para el grafo. */
const CHAR_WIDTH = 7.1;
export function textWidth(text: string): number {
  return text.length * CHAR_WIDTH;
}

/** Recorta el asunto del commit para que quepa en el ancho disponible. */
export function truncateMiddle(text: string, maxPx: number): string {
  const chars = Math.floor(maxPx / CHAR_WIDTH);
  if (text.length <= chars) return text;
  if (chars < 8) return `${text.slice(0, chars)}…`;
  const head = Math.ceil((chars - 1) * 0.55);
  const tail = chars - 1 - head;
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}

/** Inicial de un autor para el avatar circular estilo GitFiend. */
export function authorInitial(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';
  const char = trimmed.charAt(0);
  return char ? char.toUpperCase() : '?';
}

/** Paleta de colores distintivos y armónicos para autores estilo GitFiend. */
const AUTHOR_PALETTE = [
  '#eb6f65', // Coral Foxen
  '#b470d0', // Orquídea / Violeta
  '#38bdf8', // Cyan cielo
  '#f59e0b', // Ámbar cálido
  '#34d399', // Menta esmeralda
  '#f472b6', // Rosa suave
  '#a78bfa', // Lavanda
  '#fb923c', // Mandarina
] as const;

/** Color determinista para el avatar a partir del nombre del autor. */
export function authorColor(name: string): string {
  let hash = 0;
  const key = name.trim().toLowerCase();
  for (let i = 0; i < key.length; i++) {
    hash = (hash << 5) - hash + key.charCodeAt(i);
    hash |= 0;
  }
  const index = Math.abs(hash) % AUTHOR_PALETTE.length;
  return AUTHOR_PALETTE[index] ?? '#eb6f65';
}
