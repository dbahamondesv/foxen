/**
 * Persistencia de la sesion de trabajo.
 *
 * Foxen reabre los repositorios que el usuario tenia abiertos al cerrar la app,
 * para no obligarlo a abrirlos de nuevo cada vez. Se guarda la lista de rutas
 * abiertas y cual estaba activa.
 */

export interface SessionState {
  /** Rutas de los repositorios que estaban abiertos. */
  paths: string[];
  /** Ruta del repositorio activo, o `null` si ninguno. */
  active: string | null;
}

export const SESSION_STORAGE_KEY = 'foxen.session';

const EMPTY_SESSION: SessionState = { paths: [], active: null };

/** Lee la sesion guardada, descartando cualquier dato con forma invalida. */
export function loadSession(): SessionState {
  try {
    const raw = window.localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return { ...EMPTY_SESSION };
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return { ...EMPTY_SESSION };
    const stored = parsed as Record<string, unknown>;
    const paths = Array.isArray(stored.paths)
      ? stored.paths.filter((p): p is string => typeof p === 'string' && p.length > 0)
      : [];
    const active = typeof stored.active === 'string' && paths.includes(stored.active)
      ? stored.active
      : null;
    return { paths, active };
  } catch {
    return { ...EMPTY_SESSION };
  }
}

export function saveSession(session: SessionState): void {
  try {
    window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
  } catch {
    // Sin persistencia la sesion solo vive en esta ejecucion.
  }
}
