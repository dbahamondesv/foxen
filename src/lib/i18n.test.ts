import { describe, expect, it } from 'vitest';
import { interpolate, normalizeLocale, translate } from './i18n';

describe('normalizeLocale', () => {
  it('acepta solo los idiomas soportados', () => {
    expect(normalizeLocale('es')).toBe('es');
    expect(normalizeLocale('en')).toBe('en');
    expect(normalizeLocale('fr')).toBeNull();
    expect(normalizeLocale(null)).toBeNull();
  });
});

describe('interpolate', () => {
  it('sustituye marcadores y conserva los que faltan', () => {
    expect(interpolate('Hola {name}', { name: 'Foxen' })).toBe('Hola Foxen');
    expect(interpolate('Hola {name}')).toBe('Hola {name}');
    expect(interpolate('{a} + {b}', { a: 1, b: 2 })).toBe('1 + 2');
  });
});

describe('translate', () => {
  it('usa el diccionario inglés con interpolación', () => {
    expect(translate('Cerrar', undefined, 'en')).toBe('Close');
    expect(translate('Cerrar', undefined, 'es')).toBe('Cerrar');
    expect(translate('Usando la cuenta @{user}', { user: 'ana' }, 'en')).toBe(
      'Using the account @ana',
    );
  });

  it('deja el texto original si no hay traducción', () => {
    expect(translate('Texto sin traducción', undefined, 'en')).toBe('Texto sin traducción');
  });
});
