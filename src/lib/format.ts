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