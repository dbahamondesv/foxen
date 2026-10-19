/**
 * Persistencia de la sesion de trabajo.
 *
 * Foxen reabre los repositorios que el usuario tenia abiertos al cerrar la app.
 * La fuente de verdad es `settings.json` en el directorio de configuracion
 * (backend Rust); `localStorage` solo se lee una vez para migrar datos de
 * versiones anteriores y se borra despues.
 */

import * as ipc from './ipc';

export interface SessionState {
  /** Rutas de los repositorios que estaban abiertos. */
  paths: string[];
  /** Ruta del repositorio activo, o `null` si ninguno. */
  active: string | null;
}

/** Clave de la version anterior (solo migracion). */
export const SESSION_STORAGE_KEY = 'foxen.session';

const EMPTY_SESSION: SessionState = { paths: [], active: null };

/** Cache en memoria: las lecturas normales no vuelven a tocar el disco. */
let cache: SessionState = { ...EMPTY_SESSION };
let hydrated = false;

/** Valida y normaliza datos con forma desconocida (archivo o localStorage). */
export function normalizeSession(value: unknown): SessionState {
  if (typeof value !== 'object' || value === null) return { ...EMPTY_SESSION };
  const stored = value as Record<string, unknown>;
  const paths = Array.isArray(stored.paths)
    ? stored.paths.filter((p): p is string => typeof p === 'string' && p.length > 0)
    : [];
  const active =
    typeof stored.active === 'string' && paths.includes(stored.active) ? stored.active : null;
  return { paths, active };
}

function readLegacySession(): SessionState {
  try {
    const raw = window.localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return { ...EMPTY_SESSION };
    return normalizeSession(JSON.parse(raw) as unknown);
  } catch {
    return { ...EMPTY_SESSION };
  }
}

/**
 * Carga la sesion desde Rust (una sola vez) y migra `localStorage` si hace
 * falta. Los errores de persistencia no rompen el arranque: se degrada a la
 * sesion de esta ejecucion.
 */
export async function loadSession(): Promise<SessionState> {
  if (hydrated) return cache;

  const legacy = readLegacySession();
  try {
    const settings = await ipc.settingsLoad();
    const stored = normalizeSession(settings.session);
    cache = stored.paths.length > 0 || stored.active ? stored : legacy;
    if (legacy.paths.length > 0 && stored.paths.length === 0) {
      // Migracion: lo que habia en el webview pasa a ser la fuente en Rust.
      void ipc.settingsSaveSession(cache).catch(() => undefined);
    }
  } catch {
    cache = legacy;
  }

  if (legacy.paths.length > 0) {
    try {
      window.localStorage.removeItem(SESSION_STORAGE_KEY);
    } catch {
      // localStorage bloqueado: da igual, ya migramos lo leible.
    }
  }

  hydrated = true;
  return cache;
}

/** Sesion actual sin tocar el disco (tras `loadSession`). */
export function currentSession(): SessionState {
  return cache;
}

/** Guarda la sesion: actualiza la cache y persiste en Rust sin bloquear. */
export function saveSession(session: SessionState): void {
  cache = normalizeSession(session);
  void ipc.settingsSaveSession(cache).catch(() => undefined);
}
