/** Utilidades de etiquetas (tags) y deteccion de la rama principal. */

/** Nombres de rama considerados "principales" a efectos de release. */
export const MAIN_BRANCHES = ['main', 'master'];

/** `true` si la rama es una de las principales (main/master). */
export function isMainBranch(branch: string): boolean {
  return MAIN_BRANCHES.includes(branch.trim().toLowerCase());
}
