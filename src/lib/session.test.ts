import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  settingsLoad: vi.fn(),
  settingsSaveSession: vi.fn(() => Promise.resolve()),
}));

vi.mock('./ipc', () => ({
  settingsLoad: h.settingsLoad,
  settingsSaveSession: h.settingsSaveSession,
}));

/** Importa `session.ts` con estado de modulo limpio (cache/hidratacion). */
async function freshSession() {
  vi.resetModules();
  return import('./session');
}

beforeEach(() => {
  localStorage.clear();
  h.settingsLoad.mockReset();
  h.settingsSaveSession.mockReset().mockResolvedValue(undefined);
});

describe('normalizeSession', () => {
  it('descarta valores con forma incorrecta', async () => {
    const { normalizeSession } = await freshSession();
    expect(normalizeSession(null)).toEqual({ paths: [], active: null });
    expect(normalizeSession({ paths: 'nope', active: 3 })).toEqual({ paths: [], active: null });
  });

  it('filtra rutas que no sean strings no vacios', async () => {
    const { normalizeSession } = await freshSession();
    expect(
      normalizeSession({ paths: ['/ok', '', 42, null, '/también'], active: '/ok' }),
    ).toEqual({ paths: ['/ok', '/también'], active: '/ok' });
  });

  it('anula `active` si no esta en la lista de rutas', async () => {
    const { normalizeSession } = await freshSession();
    expect(normalizeSession({ paths: ['/a'], active: '/fantasma' })).toEqual({
      paths: ['/a'],
      active: null,
    });
  });
});

describe('loadSession', () => {
  it('prefiere la sesion persistida en Rust', async () => {
    h.settingsLoad.mockResolvedValue({
      session: { paths: ['/rust'], active: '/rust' },
      theme: null,
    });
    const { loadSession } = await freshSession();
    await expect(loadSession()).resolves.toEqual({ paths: ['/rust'], active: '/rust' });
  });

  it('migra la sesion antigua de localStorage y limpia la clave', async () => {
    localStorage.setItem(
      'foxen.session',
      JSON.stringify({ paths: ['/legacy'], active: '/legacy' }),
    );
    h.settingsLoad.mockResolvedValue({
      session: { paths: [], active: null },
      theme: null,
    });
    const { loadSession, SESSION_STORAGE_KEY } = await freshSession();

    await expect(loadSession()).resolves.toEqual({ paths: ['/legacy'], active: '/legacy' });
    expect(h.settingsSaveSession).toHaveBeenCalledWith({ paths: ['/legacy'], active: '/legacy' });
    expect(localStorage.getItem(SESSION_STORAGE_KEY)).toBeNull();
  });

  it('degrada a localStorage si el backend falla', async () => {
    localStorage.setItem(
      'foxen.session',
      JSON.stringify({ paths: ['/legacy'], active: null }),
    );
    h.settingsLoad.mockRejectedValue(new Error('sin backend'));
    const { loadSession } = await freshSession();
    await expect(loadSession()).resolves.toEqual({ paths: ['/legacy'], active: null });
  });

  it('una sesion vacia devuelve la forma esperada', async () => {
    h.settingsLoad.mockResolvedValue({
      session: { paths: [], active: null },
      theme: null,
    });
    const { loadSession } = await freshSession();
    await expect(loadSession()).resolves.toEqual({ paths: [], active: null });
  });
});

describe('saveSession', () => {
  it('actualiza la cache y persiste sin bloquear', async () => {
    const { currentSession, saveSession } = await freshSession();
    saveSession({ paths: ['/a', '/b'], active: '/b' });

    expect(currentSession()).toEqual({ paths: ['/a', '/b'], active: '/b' });
    expect(h.settingsSaveSession).toHaveBeenCalledWith({ paths: ['/a', '/b'], active: '/b' });
  });

  it('normaliza antes de guardar', async () => {
    const { currentSession, saveSession } = await freshSession();
    saveSession({ paths: ['/ok', 7 as unknown as string], active: '/fantasma' });

    expect(currentSession()).toEqual({ paths: ['/ok'], active: null });
  });
});
