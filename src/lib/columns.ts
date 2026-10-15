/**
 * Anchos de las columnas de la tabla de commits.
 *
 * Solo `labels` arranca en automatico (`null`): su ancho depende de la
 * referencia mas larga del repositorio. Las demas tienen valor fijo que el
 * usuario ajusta arrastrando el borde de la cabecera.
 */

export type ColumnKey = 'labels' | 'sha' | 'author' | 'time';

export interface ColumnWidths {
  labels: number | null;
  sha: number;
  author: number;
  time: number;
}

export const COLUMN_STORAGE_KEY = 'foxen.columns';

export const DEFAULT_COLUMN_WIDTHS: ColumnWidths = {
  labels: null,
  sha: 64,
  author: 110,
  time: 78,
};

export const COLUMN_LIMITS: Record<ColumnKey, { min: number; max: number }> = {
  labels: { min: 48, max: 360 },
  sha: { min: 48, max: 140 },
  author: { min: 70, max: 300 },
  time: { min: 56, max: 220 },
};

export const COLUMN_TITLES: Record<ColumnKey, string> = {
  labels: 'Refs',
  sha: 'SHA',
  author: 'Autor',
  time: 'Fecha',
};

export function clampColumnWidth(key: ColumnKey, width: number): number {
  const { min, max } = COLUMN_LIMITS[key];
  return Math.round(Math.min(max, Math.max(min, width)));
}

function readWidth(value: unknown, key: ColumnKey, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? clampColumnWidth(key, value)
    : fallback;
}

export function loadColumnWidths(): ColumnWidths {
  try {
    const raw = window.localStorage.getItem(COLUMN_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_COLUMN_WIDTHS };
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULT_COLUMN_WIDTHS };
    const stored = parsed as Record<string, unknown>;
    return {
      labels:
        typeof stored.labels === 'number' && Number.isFinite(stored.labels)
          ? clampColumnWidth('labels', stored.labels)
          : null,
      sha: readWidth(stored.sha, 'sha', DEFAULT_COLUMN_WIDTHS.sha),
      author: readWidth(stored.author, 'author', DEFAULT_COLUMN_WIDTHS.author),
      time: readWidth(stored.time, 'time', DEFAULT_COLUMN_WIDTHS.time),
    };
  } catch {
    return { ...DEFAULT_COLUMN_WIDTHS };
  }
}

export function saveColumnWidths(widths: ColumnWidths): void {
  try {
    window.localStorage.setItem(COLUMN_STORAGE_KEY, JSON.stringify(widths));
  } catch {
    // Sin persistencia los anchos solo viven en esta sesion.
  }
}
