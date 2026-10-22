import { describe, expect, it } from 'vitest';
import { isMainBranch, MAIN_BRANCHES } from './tags';

describe('isMainBranch', () => {
  it('reconoce main y master', () => {
    expect(isMainBranch('main')).toBe(true);
    expect(isMainBranch('master')).toBe(true);
  });

  it('es insensible a mayusculas y espacios', () => {
    expect(isMainBranch('Main')).toBe(true);
    expect(isMainBranch('  MASTER  ')).toBe(true);
  });

  it('rechaza otras ramas', () => {
    expect(isMainBranch('develop')).toBe(false);
    expect(isMainBranch('feature/x')).toBe(false);
    expect(isMainBranch('main-2')).toBe(false);
  });

  it('expone la lista de ramas principales', () => {
    expect(MAIN_BRANCHES).toContain('main');
    expect(MAIN_BRANCHES).toContain('master');
  });
});
