/**
 * Codificación base64 para la terminal.
 *
 * La salida de la PTY viaja en base64 porque es binaria: convertirla a texto
 * antes de tiempo destruiría los bytes que no son UTF-8 (salidas de `less`,
 * dibujos con UTF-8 inválido, etc).
 */

/** Codifica texto UTF-8 a base64. */
export function encodeBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  // En bloques: `fromCharCode(...bytes)` desbordaria la pila con salidas largas.
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Decodifica base64 a los bytes originales. */
export function decodeBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
