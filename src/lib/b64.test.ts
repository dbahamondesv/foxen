import { describe, expect, it } from 'vitest';
import { decodeBase64, encodeBase64 } from './b64';

describe('base64', () => {
  it('hace roundtrip de texto ASCII', () => {
    const text = 'hello world, git status';
    expect(new TextDecoder().decode(decodeBase64(encodeBase64(text)))).toBe(text);
  });

  it('hace roundtrip de UTF-8 (eñes y emojis)', () => {
    const text = 'ñandú 🦊 terminal — «carriles»';
    expect(new TextDecoder().decode(decodeBase64(encodeBase64(text)))).toBe(text);
  });

  it('codifica cadenas vacías', () => {
    expect(encodeBase64('')).toBe('');
    expect(decodeBase64('')).toHaveLength(0);
  });

  it('produce bytes exactos incluso con caracteres no UTF-8 en la entrada base64', () => {
    // «ÿ» en latin-1 es 0xFF, un byte que no es UTF-8 válido por sí solo.
    const bytes = decodeBase64('/w==');
    expect(Array.from(bytes)).toEqual([255]);
  });

  it('soporta entradas largas sin desbordar la pila', () => {
    const text = 'línea de terminal\n'.repeat(5000);
    expect(new TextDecoder().decode(decodeBase64(encodeBase64(text)))).toBe(text);
  });
});
