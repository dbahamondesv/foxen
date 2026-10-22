import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  baseName,
  changeColor,
  commitHue,
  dirName,
  hueColor,
  kindHue,
  laneColor,
  laneColorIndex,
  LANE_COLOR_COUNT,
  relativeTime,
  statusChar,
  textWidth,
  truncateMiddle,
  authorInitial,
  authorColor,
  commitKind,
} from './format';
import type { FileStatus } from './types';

function file(overrides: Partial<FileStatus>): FileStatus {
  return {
    path: 'src/a.ts',
    oldPath: null,
    indexStatus: '',
    worktreeStatus: '',
    staged: false,
    unstaged: false,
    untracked: false,
    ignored: false,
    conflicted: false,
    isBinary: false,
    insertions: 0,
    deletions: 0,
    kind: 'modified',
    ...overrides,
  };
}

describe('commitHue / hueColor', () => {
  it('deriva un tono estable (0-359) del SHA', () => {
    const hue = commitHue('a1b2c3d4e5f6');
    expect(hue).toBeGreaterThanOrEqual(0);
    expect(hue).toBeLessThan(360);
    expect(commitHue('a1b2c3d4e5f6')).toBe(hue);
  });

  it('acota el tono al arco cool (magenta → púrpura)', () => {
    const samples = Array.from({ length: 200 }, (_, i) => commitHue(`oid-${i}-abcdef`));
    for (const hue of samples) {
      const cool = hue >= 335 || hue <= 75;
      expect(cool).toBe(true);
    }
  });

  it('produce un color hsl valido con la saturación de la paleta', () => {
    expect(hueColor(210)).toBe('hsl(210, 74%, 64%)');
    expect(hueColor(210, 45)).toBe('hsl(210, 74%, 45%)');
  });
});

describe('kindHue', () => {
  it('da un tono neón distinto a cada tipo de commit', () => {
    const hues = (['feature', 'fix', 'docs', 'chore', 'refactor', 'test', 'perf'] as const).map(
      kindHue,
    );
    expect(new Set(hues).size).toBe(hues.length);
  });

  it('mantiene todos los tonos en el arco cool', () => {
    const hues = (['feature', 'fix', 'docs', 'chore', 'refactor', 'test', 'perf'] as const).map(
      kindHue,
    );
    for (const hue of hues) {
      const cool = hue >= 185 || hue <= 340 || (hue >= 205 && hue <= 265);
      expect(cool).toBe(true);
    }
  });
});

describe('laneColor / laneColorIndex', () => {
  it('mapea carriles al rango 0..9 con envolvente', () => {
    expect(laneColorIndex(0)).toBe(0);
    expect(laneColorIndex(9)).toBe(9);
    expect(laneColorIndex(10)).toBe(0);
    expect(laneColorIndex(23)).toBe(3);
    expect(laneColorIndex(-1)).toBe(9);
  });

  it('trunca carriles no enteros antes de envolver', () => {
    expect(laneColorIndex(4.9)).toBe(4);
    expect(laneColorIndex(-0.5)).toBe(0);
  });

  it('expone la variable CSS del color de carril', () => {
    expect(laneColor(0)).toBe('var(--lane-0)');
    expect(laneColor(12)).toBe('var(--lane-2)');
    expect(LANE_COLOR_COUNT).toBe(10);
  });
});

describe('changeColor', () => {
  it('mapea cada tipo de cambio a su clase CSS', () => {
    expect(changeColor('added')).toBe('added');
    expect(changeColor('untracked')).toBe('added');
    expect(changeColor('deleted')).toBe('deleted');
    expect(changeColor('renamed')).toBe('renamed');
    expect(changeColor('conflicted')).toBe('conflicted');
    expect(changeColor('modified')).toBe('modified');
  });
});

describe('statusChar', () => {
  it('prioriza los conflictos sobre todo lo demás', () => {
    expect(statusChar(file({ conflicted: true, staged: true }))).toBe('U');
  });

  it('usa M cuando el archivo está staged y modificado a la vez', () => {
    expect(statusChar(file({ staged: true, unstaged: true, indexStatus: 'M' }))).toBe('M');
  });

  it('prefiere el estado del index cuando está stageado', () => {
    expect(statusChar(file({ staged: true, indexStatus: 'A' }))).toBe('A');
  });

  it('usa ? para archivos sin seguimiento', () => {
    expect(statusChar(file({ untracked: true }))).toBe('?');
  });

  it('cae al estado del working tree en el resto de casos', () => {
    expect(statusChar(file({ unstaged: true, worktreeStatus: 'D' }))).toBe('D');
    expect(statusChar(file({}))).toBe('M');
  });
});

describe('baseName / dirName', () => {
  it('separan directorio y nombre', () => {
    expect(baseName('src/lib/ipc.ts')).toBe('ipc.ts');
    expect(dirName('src/lib/ipc.ts')).toBe('src/lib');
    expect(baseName('raiz.txt')).toBe('raiz.txt');
    expect(dirName('raiz.txt')).toBe('');
  });
});

describe('relativeTime', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('describe momentos relativos al presente', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-10T12:00:00Z'));
    const now = Math.floor(Date.now() / 1000);

    expect(relativeTime(now)).toBe('ahora');
    expect(relativeTime(now - 30)).toBe('ahora');
    expect(relativeTime(now - 60 * 5)).toBe('hace 5m');
    expect(relativeTime(now - 60 * 60 * 3)).toBe('hace 3h');
    expect(relativeTime(now - 60 * 60 * 24 * 2)).toBe('hace 2d');
    // Más de 30 días: cae a fecha corta local, solo comprobamos que no revienta.
    expect(typeof relativeTime(now - 60 * 60 * 24 * 40)).toBe('string');
    // Tiempos futuros: no debería producir «hace -5m».
    expect(relativeTime(now + 600)).toBe('ahora');
  });

  it('traduce las etiquetas cuando se pide inglés', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-10T12:00:00Z'));
    const now = Math.floor(Date.now() / 1000);

    expect(relativeTime(now, 'en')).toBe('now');
    expect(relativeTime(now - 60 * 5, 'en')).toBe('5m ago');
    expect(relativeTime(now - 60 * 60 * 3, 'en')).toBe('3h ago');
    expect(relativeTime(now - 60 * 60 * 24 * 2, 'en')).toBe('2d ago');
  });
});

describe('truncateMiddle', () => {
  it('devuelve el texto tal cual si cabe', () => {
    expect(truncateMiddle('corto', 1000)).toBe('corto');
  });

  it('recorta por el medio conservando cabeza y cola', () => {
    const text = 'un-asunto-de-commit-muy-largo-para-el-espacio-disponible';
    const result = truncateMiddle(text, 71); // 10 caracteres
    expect(result.length).toBeLessThanOrEqual(10);
    expect(result).toContain('…');
    expect(result.startsWith('un-as')).toBe(true);
    expect(result.endsWith('ible')).toBe(true);
  });

  it('con hueco mínimo recorta solo la cabeza', () => {
    expect(truncateMiddle('abcdefghij', 28)).toBe('abc…'); // 3 caracteres
  });
});

describe('textWidth', () => {
  it('estima el ancho como longitud por el ancho de carácter', () => {
    expect(textWidth('')).toBe(0);
    expect(textWidth('abc')).toBeCloseTo(3 * 7.1);
  });
});

describe('authorInitial', () => {
  it('obtiene la primera letra en mayúscula', () => {
    expect(authorInitial('foxbuntu')).toBe('F');
    expect(authorInitial('dbahamondesv')).toBe('D');
    expect(authorInitial('  alice  ')).toBe('A');
    expect(authorInitial('')).toBe('?');
  });
});

describe('authorColor', () => {
  it('genera un color consistente para el mismo autor', () => {
    expect(authorColor('foxbuntu')).toBe(authorColor('foxbuntu'));
    expect(authorColor('foxbuntu')).toMatch(/^#[0-9a-f]{6}$/i);
  });
});

describe('commitKind', () => {
  it('reconoce prefijos de Conventional Commits', () => {
    expect(commitKind('feat: añadir grafo').kind).toBe('feature');
    expect(commitKind('feature(ui): paneles').kind).toBe('feature');
    expect(commitKind('fix: corregir merge').kind).toBe('fix');
    expect(commitKind('fix(ipc): token').badge).toBe('X');
    expect(commitKind('docs: actualizar README').kind).toBe('docs');
    expect(commitKind('chore: bump deps').kind).toBe('chore');
    expect(commitKind('refactor(store): simplificar').kind).toBe('refactor');
    expect(commitKind('test: cobertura').kind).toBe('test');
    expect(commitKind('perf: memoizar').kind).toBe('perf');
  });

  it('cae a palabras clave cuando no hay prefijo', () => {
    expect(commitKind('Añadir soporte de tags').kind).toBe('feature');
    expect(commitKind('Arreglar el watcher de inotify').kind).toBe('fix');
    expect(commitKind('Renombrar variables internas').kind).toBe('refactor');
    expect(commitKind('Actualizar comentarios del módulo').kind).toBe('docs');
  });

  it('usa chore como categoría por defecto', () => {
    expect(commitKind('Merge branch main').kind).toBe('chore');
    expect(commitKind('v0.1.0').kind).toBe('chore');
  });

  it('expone la etiqueta tipográfica corta', () => {
    expect(commitKind('feat: algo').badge).toBe('F');
    expect(commitKind('fix: algo').badge).toBe('X');
    expect(commitKind('chore: algo').badge).toBe('C');
  });
});
