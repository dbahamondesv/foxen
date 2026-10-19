import { beforeAll, describe, expect, it } from 'vitest';
import { disableBrowserFeatures, isBrowserShortcut } from './desktop';

/** Construye un evento de teclado con la combinación indicada. */
function key(key_: string, opts: Partial<KeyboardEventInit> = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', { key: key_, cancelable: true, ...opts });
}

describe('isBrowserShortcut', () => {
  it('bloquea las teclas de función del navegador en ambos modos', () => {
    for (const isDev of [true, false]) {
      expect(isBrowserShortcut(key('F5'), isDev)).toBe(true);
      expect(isBrowserShortcut(key('F7'), isDev)).toBe(true);
    }
  });

  it('bloquea recarga, impresión y atajos de página con Ctrl', () => {
    for (const isDev of [true, false]) {
      expect(isBrowserShortcut(key('r', { ctrlKey: true }), isDev)).toBe(true);
      expect(isBrowserShortcut(key('p', { ctrlKey: true }), isDev)).toBe(true);
      expect(isBrowserShortcut(key('u', { ctrlKey: true }), isDev)).toBe(true);
      expect(isBrowserShortcut(key('s', { ctrlKey: true }), isDev)).toBe(true);
    }
  });

  it('bloquea el zoom del WebView (Ctrl + rueda de teclas)', () => {
    for (const isDev of [true, false]) {
      expect(isBrowserShortcut(key('+', { ctrlKey: true }), isDev)).toBe(true);
      expect(isBrowserShortcut(key('-', { ctrlKey: true }), isDev)).toBe(true);
      expect(isBrowserShortcut(key('0', { metaKey: true }), isDev)).toBe(true);
    }
  });

  it('permite las devtools en desarrollo y las bloquea en producción', () => {
    expect(isBrowserShortcut(key('F12'), true)).toBe(false);
    expect(isBrowserShortcut(key('F12'), false)).toBe(true);
    expect(isBrowserShortcut(key('I', { ctrlKey: true, shiftKey: true }), true)).toBe(false);
    expect(isBrowserShortcut(key('I', { ctrlKey: true, shiftKey: true }), false)).toBe(true);
    expect(isBrowserShortcut(key('J', { ctrlKey: true, shiftKey: true }), false)).toBe(true);
    expect(isBrowserShortcut(key('C', { ctrlKey: true, shiftKey: true }), false)).toBe(true);
  });

  it('no bloquea atajos propios de la app (Ctrl+B, Ctrl+G…)', () => {
    for (const isDev of [true, false]) {
      expect(isBrowserShortcut(key('b', { ctrlKey: true }), isDev)).toBe(false);
      expect(isBrowserShortcut(key('g', { ctrlKey: true }), isDev)).toBe(false);
      expect(isBrowserShortcut(key('Enter'), isDev)).toBe(false);
    }
  });
});

describe('disableBrowserFeatures', () => {
  beforeAll(() => {
    disableBrowserFeatures();
  });

  it('anula el menú contextual', () => {
    const event = new MouseEvent('contextmenu', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('anula la recarga con Ctrl+R capturando el evento', () => {
    const event = key('r', { ctrlKey: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('anula el zoom con Ctrl+rueda', () => {
    const event = new WheelEvent('wheel', { ctrlKey: true, cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
});
