/**
 * Hosts que Foxen reconoce.
 *
 * Por ahora Foxen solo admite GitHub; la integracion con GitLab, Bitbucket u
 * otros forges llegara en proximas versiones, de modo que la interfaz oculta
 * (o deshabilita) cualquier acceso a servicios distintos de GitHub.
 */

/** Comprueba si un host pertenece a GitHub (web o gists). */
export function isGitHubHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return (
    normalized === 'github.com' ||
    normalized === 'gist.github.com' ||
    normalized.endsWith('.github.com')
  );
}

/** Simplifica una URL o referencia de remoto a su host. */
export function normalizeHost(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  try {
    return new URL(trimmed).host;
  } catch {
    // formato git@host:path
    const atIdx = trimmed.indexOf('@');
    if (atIdx >= 0) {
      const rest = trimmed.slice(atIdx + 1);
      const colonIdx = rest.indexOf(':');
      return colonIdx >= 0 ? rest.slice(0, colonIdx) : rest;
    }
    return trimmed;
  }
}
