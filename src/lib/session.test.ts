import { describe, expect, it } from 'vitest';
import { loadSession, saveSession, SESSION_STORAGE_KEY } from './session';

describe('session', () => {
  it('devuelve una sesión vacía si no hay nada guardado', () => {
    localStorage.clear();
    expect(loadSession()).toEqual({ paths: [], active: null });
  });

  it('hace roundtrip de una sesión válida', () => {
    saveSession({ paths: ['/a', '/b'], active: '/b' });
    expect(loadSession()).toEqual({ paths: ['/a', '/b'], active: '/b' });
  });

  it('descarta JSON corrupto', () => {
    localStorage.setItem(SESSION_STORAGE_KEY, '{no es json');
    expect(loadSession()).toEqual({ paths: [], active: null });
  });

  it('descarta valores con forma incorrecta', () => {
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ paths: 'nope', active: 3 }));
    expect(loadSession()).toEqual({ paths: [], active: null });
  });

  it('filtra rutas que no sean strings no vacíos', () => {
    localStorage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify({ paths: ['/ok', '', 42, null, '/también'], active: '/ok' }),
    );
    expect(loadSession()).toEqual({ paths: ['/ok', '/también'], active: '/ok' });
  });

  it('anula `active` si no está en la lista de rutas', () => {
    localStorage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify({ paths: ['/a'], active: '/fantasma' }),
    );
    expect(loadSession()).toEqual({ paths: ['/a'], active: null });
  });
});
