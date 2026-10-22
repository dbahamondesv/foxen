import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store/useAppStore';
import {
  authorColor,
  authorInitial,
  commitKind,
  hueColor,
  kindHue,
  laneColor,
  laneColorIndex,
  relativeTime,
  LANE_COLOR_COUNT,
  type CommitKind,
} from '../lib/format';
import type { CommitNode, GraphEdge, RefLabel } from '../lib/types';

/* Geometria base: filas amplias y grafo compacto (como GitFiend). El zoom
 * (Ctrl/Cmd+rueda) interpola estos valores en vivo, de forma imperativa
 * (CSS variables + canvas), sin re-renderizar las filas. */
const BASE_ROW_HEIGHT = 38;
const LANE_WIDTH = 15;
const GRAPH_PAD = 11;
const MIN_ZOOM = 0.7;
const MAX_ZOOM = 1.6;
const ZOOM_LERP = 0.3;

/* Animaciones del canvas. Todas se detienen solas y respetan
 * `prefers-reduced-motion` (el bucle rAF las desactiva por completo). */
const ENTRANCE_MS = 720;
const ENTRANCE_ROW_MS = 4;
const ENTRANCE_ROW_CAP = 90;
const ENTRANCE_NODE_MS = 300;
const ENTRANCE_EDGE_DELAY = 80;
const ENTRANCE_EDGE_MS = 460;
const PULSE_MS = 720;
const DIM_LERP = 0.2;

/** Slots de carril atenuados (carriles > 63 comparten el ultimo). */
const LANE_SLOTS = 64;
/** Retardo del tooltip contextual antes de mostrarse. */
const TIP_DELAY = 140;
const TAU = Math.PI * 2;

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const clamp01 = (v: number) => clamp(v, 0, 1);
const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;
const laneSlot = (lane: number) => clamp(Math.trunc(lane), 0, LANE_SLOTS - 1);

interface Props {
  nodes: CommitNode[];
  edges: GraphEdge[];
  laneCount: number;
  truncated: boolean;
  totalReachable: number;
}

/** Colores de tema leidos una vez por cambio de tema (canvas no ve CSS vars). */
interface Palette {
  theme: string;
  bg: string;
  added: string;
  lanes: string[];
}

/** Etiqueta legible del tipo de commit. */
const KIND_LABEL: Record<CommitKind, string> = {
  feature: 'feature',
  fix: 'fix',
  docs: 'docs',
  chore: 'chore',
  refactor: 'refactor',
  test: 'test',
  perf: 'perf',
};

/** Sincroniza el buffer del canvas con su tamano visible (px * dpr). */
function syncCanvas(canvas: HTMLCanvasElement, width: number, height: number) {
  const dpr = window.devicePixelRatio || 1;
  const bw = Math.max(1, Math.round(width * dpr));
  const bh = Math.max(1, Math.round(height * dpr));
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw;
    canvas.height = bh;
  }
  return dpr;
}

/**
 * Traza una arista con curvas bezier suaves (\"flujo continuo\"): el tramo recto
 * va por su carril y la transicion se hace con dos curvas encadenadas para que
 * merges y bifurcaciones se sientan fluidos, no rigidos.
 */
function traceEdge(
  ctx: CanvasRenderingContext2D,
  edge: GraphEdge,
  laneX: (lane: number) => number,
  rowHeight: number,
) {
  const x1 = laneX(edge.fromLane);
  const y1 = edge.fromRow * rowHeight + rowHeight / 2;
  const x2 = laneX(edge.toLane);
  const y2 = edge.toRow * rowHeight + rowHeight / 2;

  ctx.beginPath();
  ctx.moveTo(x1, y1);

  if (x1 === x2 || edge.toRow === edge.fromRow + 1) {
    const dx = x2 - x1;
    if (dx === 0) {
      ctx.lineTo(x2, y2);
    } else {
      const midY = (y1 + y2) / 2;
      ctx.bezierCurveTo(x1, midY, x2, midY, x2, y2);
    }
    return;
  }

  const curve = Math.min(rowHeight, Math.abs(y2 - y1));
  if (edge.isMergeEdge) {
    const kneeY = y1 + curve;
    ctx.bezierCurveTo(x1, y1 + curve * 0.55, x2, kneeY - curve * 0.45, x2, kneeY);
    ctx.lineTo(x2, y2);
  } else {
    const kneeY = y2 - curve;
    ctx.lineTo(x1, kneeY);
    ctx.bezierCurveTo(x1, kneeY + curve * 0.45, x2, y2 - curve * 0.55, x2, y2);
  }
}

/** Coloca el tooltip sin que se salga del viewport. */
function placeTip(el: HTMLElement, x: number, y: number) {
  const gap = 16;
  const w = el.offsetWidth || 300;
  const h = el.offsetHeight || 120;
  let left = x + gap;
  let top = y + gap;
  if (left + w > window.innerWidth - 8) left = x - gap - w;
  if (top + h > window.innerHeight - 8) top = y - gap - h;
  el.style.left = `${Math.max(8, left)}px`;
  el.style.top = `${Math.max(8, top)}px`;
}

export function CommitGraphView({ nodes, edges, laneCount, truncated, totalReachable }: Props) {
  const selectedOid = useStore((s) => s.selectedOid);
  const selectCommit = useStore((s) => s.selectCommit);
  const openDetail = useStore((s) => s.openDetail);
  const highlight = useStore((s) => s.graphHighlight);
  const setHighlight = useStore((s) => s.setGraphHighlight);
  const branches = useStore((s) => s.branches);
  const notify = useStore((s) => s.notify);
  const theme = useStore((s) => s.theme);

  const [hoverOid, setHoverOid] = useState<string | null>(null);
  const [tipNode, setTipNode] = useState<CommitNode | null>(null);
  const [tipOn, setTipOn] = useState(false);
  const [entrancing, setEntrancing] = useState(false);
  const [panning, setPanning] = useState(false);
  const [panReady, setPanReady] = useState(false);

  const viewRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const baseRef = useRef<HTMLCanvasElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);

  /* Zoom imperativo: el estado de React no interviene, asi la animacion no
   * re-renderiza las 750 filas (solo variables CSS + redibujado de canvas). */
  const zoomRef = useRef(clamp(useStore.getState().graphZoom, MIN_ZOOM, MAX_ZOOM));
  const zoomTargetRef = useRef(zoomRef.current);
  const cursorRef = useRef<{ x: number; y: number } | null>(null);
  const tipPosRef = useRef({ x: 0, y: 0 });
  const dimRef = useRef<Float32Array>(new Float32Array(LANE_SLOTS).fill(1));
  const dimTargetRef = useRef<Float32Array>(new Float32Array(LANE_SLOTS).fill(1));
  const paletteRef = useRef<Palette | null>(null);
  const entranceStartRef = useRef(0);
  const entranceActiveRef = useRef(false);
  const pulseStartRef = useRef(0);
  const dirtyRef = useRef(true);
  const loopRef = useRef<number | null>(null);
  const spaceRef = useRef(false);
  const panRef = useRef<{
    id: number;
    x: number;
    y: number;
    sl: number;
    st: number;
  } | null>(null);
  const pannedRef = useRef(false);
  const reducedMotionRef = useRef(false);

  /* ---------------------------------------------------------------- datos */

  const nodeHues = useMemo(() => nodes.map((n) => kindHue(commitKind(n.subject).kind)), [nodes]);

  const selectedNode = useMemo(
    () => (selectedOid ? (nodes.find((n) => n.oid === selectedOid) ?? null) : null),
    [nodes, selectedOid],
  );

  /** Indice fila -> commit: hit-testing de la franja derecha del grafo. */
  const rowToNode = useMemo(() => new Map(nodes.map((n) => [n.row, n])), [nodes]);

  /** Carriles en foco: el de la seleccion y los de la rama filtrada. */
  const focusLanes = useMemo(() => {
    const lanes = new Set<number>();
    if (selectedNode) lanes.add(selectedNode.lane);
    if (highlight) {
      for (const n of nodes) {
        if (n.labels.some((l) => l.name === highlight)) lanes.add(n.lane);
      }
    }
    return lanes.size > 0 ? lanes : null;
  }, [nodes, selectedNode, highlight]);

  /** Carriles que pertenecen al filtro de rama (atenuan las filas). */
  const highlightLanes = useMemo(() => {
    if (!highlight) return null;
    const lanes = new Set<number>();
    const needle = highlight.toLowerCase();
    for (const n of nodes) {
      if (n.labels.some((l) => l.name === highlight) || n.subject.toLowerCase().includes(needle)) {
        lanes.add(n.lane);
      }
    }
    return lanes.size > 0 ? lanes : null;
  }, [nodes, highlight]);

  const dimTarget = useMemo(() => {
    const target = new Float32Array(LANE_SLOTS).fill(1);
    if (focusLanes) {
      target.fill(0.16);
      for (const lane of focusLanes) target[laneSlot(lane)] = 1;
    }
    return target;
  }, [focusLanes]);

  /* -------------------------------------------------------------- geometria */

  const geom = useCallback(() => {
    const z = zoomRef.current;
    const rowHeight = BASE_ROW_HEIGHT * z;
    const laneWidth = LANE_WIDTH * z;
    const graphPad = GRAPH_PAD * z;
    return {
      rowHeight,
      laneWidth,
      graphPad,
      graphWidth: graphPad * 2 + Math.max(laneCount - 1, 0) * laneWidth,
      totalHeight: nodes.length * rowHeight,
    };
  }, [laneCount, nodes.length]);

  const syncDom = useCallback(() => {
    const g = geom();
    const body = bodyRef.current;
    if (body) {
      body.style.setProperty('--row-h', `${g.rowHeight}px`);
      body.style.setProperty('--graph-w', `${g.graphWidth}px`);
      body.style.setProperty('--graph-h', `${g.totalHeight}px`);
    }
  }, [geom]);

  const scrollerEl = useCallback(() => viewRef.current?.closest('.main') as HTMLElement | null, []);

  /** Colores del tema para canvas (cacheados por tema). */
  const palette = useCallback((): Palette => {
    const theme = document.documentElement.dataset.theme ?? 'dark';
    const cached = paletteRef.current;
    if (cached && cached.theme === theme) return cached;
    const s = getComputedStyle(document.documentElement);
    const lanes: string[] = [];
    for (let i = 0; i < LANE_COLOR_COUNT; i++) lanes.push(s.getPropertyValue(`--lane-${i}`).trim());
    const next: Palette = {
      theme,
      bg: s.getPropertyValue('--bg').trim() || '#0f1015',
      added: s.getPropertyValue('--added').trim() || '#34d399',
      lanes,
    };
    paletteRef.current = next;
    return next;
  }, []);

  /* ------------------------------------------------------------------ dibujo */

  const drawBase = useCallback(() => {
    const canvas = baseRef.current;
    if (!canvas) return;
    const g = geom();
    const dpr = syncCanvas(canvas, g.graphWidth, g.totalHeight);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, g.graphWidth, g.totalHeight);

    const pal = palette();
    const isDark = document.documentElement.dataset.theme !== 'light';
    const nodeLight = isDark ? 66 : 46;
    const dim = dimRef.current;
    const now = performance.now();
    const elapsed = entranceActiveRef.current ? now - entranceStartRef.current : Infinity;
    const laneX = (lane: number) => g.graphPad + lane * g.laneWidth;
    const midY = (row: number) => row * g.rowHeight + g.rowHeight / 2;
    const nodeT = (row: number) => {
      if (elapsed === Infinity) return 1;
      const start = Math.min(row, ENTRANCE_ROW_CAP) * ENTRANCE_ROW_MS;
      return clamp01((elapsed - start) / ENTRANCE_NODE_MS);
    };

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    /* Aristas: trazo fino por carril, dibujadas bajo los nodos. */
    const edgeT =
      elapsed === Infinity ? 1 : clamp01((elapsed - ENTRANCE_EDGE_DELAY) / ENTRANCE_EDGE_MS);
    if (edgeT > 0) {
      ctx.lineWidth = Math.max(1.2, 1.6 * zoomRef.current);
      for (const edge of edges) {
        const alpha =
          edgeT * Math.max(dim[laneSlot(edge.fromLane)] ?? 0, dim[laneSlot(edge.toLane)] ?? 0);
        if (alpha < 0.03) continue;
        const colorLane = laneColorIndex(edge.isMergeEdge ? edge.toLane : edge.fromLane);
        const color = pal.lanes[colorLane] || hueColor(265, nodeLight);
        traceEdge(ctx, edge, laneX, g.rowHeight);
        ctx.strokeStyle = color;
        ctx.globalAlpha = alpha * 0.64;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    /* Nodos: color por tipo de commit, compactos y sin sombra. */
    for (const node of nodes) {
      const t = nodeT(node.row);
      if (t <= 0) continue;
      const ease = easeOutCubic(t);
      const cx = laneX(node.lane);
      const cy = midY(node.row);
      const color = hueColor(nodeHues[node.row] ?? 265, nodeLight);
      const alpha = (dim[laneSlot(node.lane)] ?? 1) * Math.min(1, t * 1.7);
      const isSelected = node.oid === selectedOid;
      const isHovered = node.oid === hoverOid;
      const baseR = (node.isMerge ? 4.4 : 3.9) * zoomRef.current * (0.5 + 0.5 * ease);

      ctx.save();

      /* Halo de seleccion / hover. */
      if ((isSelected || isHovered) && alpha > 0.3) {
        ctx.globalAlpha = (isSelected ? 0.2 : 0.12) * alpha;
        ctx.beginPath();
        ctx.arc(cx, cy, baseR + (isSelected ? 4.5 : 3.5), 0, TAU);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.globalAlpha = (isSelected ? 0.55 : 0.38) * alpha;
        ctx.beginPath();
        ctx.arc(cx, cy, baseR + (isSelected ? 3.5 : 2.8), 0, TAU);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }

      /* Anillo exterior para HEAD (verde de marca). */
      if (node.isHead) {
        ctx.globalAlpha = 0.9 * alpha;
        ctx.beginPath();
        ctx.arc(cx, cy, baseR + 2.2, 0, TAU);
        ctx.strokeStyle = pal.added;
        ctx.lineWidth = 1.3;
        ctx.stroke();
      }

      /* Disco de fondo: deja un hueco limpio donde las lineas cruzan. */
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.arc(cx, cy, baseR + 1.4, 0, TAU);
      ctx.fillStyle = pal.bg;
      ctx.fill();

      /* Cuerpo del nodo. */
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.arc(cx, cy, baseR, 0, TAU);
      ctx.fillStyle = color;
      ctx.fill();

      if (node.isMerge) {
        ctx.beginPath();
        ctx.arc(cx, cy, baseR * 0.44, 0, TAU);
        ctx.fillStyle = pal.bg;
        ctx.fill();
      }

      ctx.restore();
    }

    /* Pulso del commit seleccionado: transicion ligera al cambiar de foco. */
    if (pulseStartRef.current > 0 && selectedNode) {
      const pt = (now - pulseStartRef.current) / PULSE_MS;
      if (pt < 1) {
        const cx = laneX(selectedNode.lane);
        const cy = midY(selectedNode.row);
        const color = hueColor(nodeHues[selectedNode.row] ?? 265, nodeLight);
        const r = (selectedNode.isMerge ? 4.4 : 3.9) * zoomRef.current + 4 + easeOutCubic(pt) * 14;
        ctx.globalAlpha = (1 - pt) * 0.5;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.3;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, TAU);
        ctx.stroke();
      }
    }

    ctx.globalAlpha = 1;
  }, [nodes, edges, geom, palette, nodeHues, selectedOid, selectedNode, hoverOid]);

  /* ------------------------------------------------------------- bucle rAF */

  /* El bucle vive en un useCallback estable; lee los cierres actualizados via
   * ref para que un cambio de datos/hover nunca deje grafos obsoletos. */
  const fnsRef = useRef({ syncDom, drawBase });
  fnsRef.current = { syncDom, drawBase };

  const tick = useCallback(
    (ts: number) => {
      loopRef.current = null;
      const reduced = reducedMotionRef.current;
      let dirty = dirtyRef.current;
      dirtyRef.current = false;
      let more = false;

      /* Zoom interpolado, anclado al cursor si lo hay. */
      const z0 = zoomRef.current;
      const zt = zoomTargetRef.current;
      if (z0 !== zt) {
        const nz = reduced ? zt : Math.abs(zt - z0) < 0.0015 ? zt : z0 + (zt - z0) * ZOOM_LERP;
        const f = nz / z0;
        zoomRef.current = nz;
        const sc = scrollerEl();
        if (sc && f !== 1) {
          const c = cursorRef.current ?? {
            x: sc.clientWidth / 2,
            y: sc.clientHeight / 2,
          };
          sc.scrollLeft = (sc.scrollLeft + c.x) * f - c.x;
          sc.scrollTop = (sc.scrollTop + c.y) * f - c.y;
        }
        fnsRef.current.syncDom();
        dirty = true;
        more = true;
        if (nz === zt) useStore.getState().setGraphZoom(zt);
      }

      /* Atenuacion animada por carril (seleccion / filtro de rama). */
      const cur = dimRef.current;
      const tgt = dimTargetRef.current;
      for (let i = 0; i < cur.length; i++) {
        const target = tgt[i] ?? 1;
        const value = cur[i] ?? 1;
        const d = target - value;
        if (Math.abs(d) > 0.004) {
          cur[i] = reduced ? target : value + d * DIM_LERP;
          dirty = true;
          more = true;
        } else if (value !== target) {
          cur[i] = target;
          dirty = true;
        }
      }

      /* Entrada escalonada. */
      if (entranceActiveRef.current) {
        dirty = true;
        if (ts - entranceStartRef.current >= ENTRANCE_MS) entranceActiveRef.current = false;
        else more = true;
      }

      /* Pulso de seleccion. */
      if (pulseStartRef.current > 0) {
        if (ts - pulseStartRef.current < PULSE_MS) {
          dirty = true;
          more = true;
        } else {
          pulseStartRef.current = 0;
        }
      }

      if (dirty) fnsRef.current.drawBase();

      if (more) loopRef.current = requestAnimationFrame(tick);
    },
    [scrollerEl],
  );

  const ensureLoop = useCallback(() => {
    if (loopRef.current !== null) return;
    loopRef.current = requestAnimationFrame(tick);
  }, [tick]);

  /* --------------------------------------------------------------- efectos */

  /* Cancela el rAF pendiente al desmontar para no dejar un tick colgando. */
  useEffect(
    () => () => {
      if (loopRef.current !== null) {
        cancelAnimationFrame(loopRef.current);
        loopRef.current = null;
      }
    },
    [],
  );

  /* Movimiento reducido: desactiva animaciones y redibuja de inmediato. */
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const apply = () => {
      reducedMotionRef.current = mq.matches;
      dirtyRef.current = true;
      ensureLoop();
    };
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [ensureLoop]);

  /* Entrada escalonada cuando cambia el conjunto de commits. */
  const signature = nodes.length > 0 ? `${nodes.length}:${nodes[0]?.oid}` : 'empty';
  const lastSigRef = useRef<string | null>(null);
  useEffect(() => {
    if (lastSigRef.current === signature) return;
    lastSigRef.current = signature;
    if (nodes.length === 0 || reducedMotionRef.current) return;
    entranceStartRef.current = performance.now();
    entranceActiveRef.current = true;
    setEntrancing(true);
    ensureLoop();
    const timer = window.setTimeout(() => {
      setEntrancing(false);
      dirtyRef.current = true;
      ensureLoop();
    }, ENTRANCE_MS + 80);
    return () => window.clearTimeout(timer);
  }, [signature, nodes.length, ensureLoop]);

  /* Pulso al cambiar la seleccion. */
  useEffect(() => {
    if (!selectedOid || reducedMotionRef.current) return;
    pulseStartRef.current = performance.now();
    ensureLoop();
  }, [selectedOid, ensureLoop]);

  /* Pintado sincrono ante cambios discretos (datos, seleccion, hover, tema). */
  useLayoutEffect(() => {
    dimTargetRef.current = dimTarget;
    syncDom();
    drawBase();
    const dimming = dimRef.current.some((v, i) => Math.abs((dimTarget[i] ?? 1) - v) > 0.004);
    if (dimming || entranceActiveRef.current) ensureLoop();
  }, [dimTarget, syncDom, drawBase, theme, ensureLoop]);

  /* Zoom con Ctrl/Cmd + rueda, anclado al cursor (listener no pasivo). */
  useEffect(() => {
    const el = viewRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const sc = scrollerEl();
      if (!sc) return;
      const rect = sc.getBoundingClientRect();
      cursorRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      zoomTargetRef.current = clamp(
        zoomTargetRef.current * (e.deltaY > 0 ? 0.92 : 1.08),
        MIN_ZOOM,
        MAX_ZOOM,
      );
      ensureLoop();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [scrollerEl, ensureLoop]);

  /* Espacio + arrastre / boton central: paneo con el scroller real (.main). */
  const endPan = useCallback(() => {
    panRef.current = null;
    setPanning(false);
  }, []);

  useEffect(() => {
    const editable = (t: EventTarget | null) =>
      t instanceof HTMLElement &&
      (t.tagName === 'INPUT' ||
        t.tagName === 'TEXTAREA' ||
        t.tagName === 'BUTTON' ||
        t.isContentEditable);
    const down = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat || editable(e.target)) return;
      spaceRef.current = true;
      setPanReady(true);
      e.preventDefault();
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      spaceRef.current = false;
      setPanReady(false);
      endPan();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, [endPan]);

  /* Tooltip: se muestra tras un breve retardo sobre el commit. */
  useEffect(() => {
    if (!tipNode) return;
    const timer = window.setTimeout(() => setTipOn(true), TIP_DELAY);
    return () => window.clearTimeout(timer);
  }, [tipNode]);

  useLayoutEffect(() => {
    const el = tipRef.current;
    if (!el || !tipNode || !tipOn) return;
    placeTip(el, tipPosRef.current.x, tipPosRef.current.y);
  }, [tipNode, tipOn]);

  /* Al seleccionar desde otro panel, el commit debe quedar a la vista. */
  useEffect(() => {
    if (!selectedOid) return;
    const node = nodes.find((n) => n.oid === selectedOid);
    if (!node) return;
    const scroller = viewRef.current?.closest('.main');
    if (!scroller) return;
    const top = node.row * BASE_ROW_HEIGHT * zoomRef.current;
    const rowH = BASE_ROW_HEIGHT * zoomRef.current;
    if (top < scroller.scrollTop || top + rowH > scroller.scrollTop + scroller.clientHeight) {
      scroller.scrollTo({
        top: Math.max(0, top - scroller.clientHeight / 2),
        behavior: reducedMotionRef.current ? 'auto' : 'smooth',
      });
    }
  }, [selectedOid, nodes]);

  /* ---------------------------------------------------------- interaccion */

  const rowClass = useCallback(
    (node: CommitNode) => {
      const classes = ['graph-row'];
      if (node.oid === selectedOid) classes.push('is-selected');
      else if (node.oid === hoverOid) classes.push('is-hover');
      if (node.isHead) classes.push('is-head');
      if (highlight && node.subject.toLowerCase().includes(highlight.toLowerCase())) {
        classes.push('is-highlight');
      }
      if (highlightLanes && !highlightLanes.has(node.lane)) classes.push('is-dim');
      return classes.join(' ');
    },
    [selectedOid, hoverOid, highlight, highlightLanes],
  );

  /** Clic en una etiqueta de rama/tag filtra el historial por ese nombre. */
  const onLabelClick = useCallback(
    (e: React.MouseEvent, label: RefLabel) => {
      e.stopPropagation();
      const current = useStore.getState().graphHighlight;
      if (current === label.name) setHighlight('');
      else setHighlight(label.name);
    },
    [setHighlight],
  );

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button === 1) e.preventDefault();
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      const pan = e.button === 1 || (e.button === 0 && spaceRef.current);
      if (!pan) {
        pannedRef.current = false;
        return;
      }
      const sc = scrollerEl();
      if (!sc) return;
      e.preventDefault();
      pannedRef.current = false;
      viewRef.current?.setPointerCapture(e.pointerId);
      panRef.current = {
        id: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        sl: sc.scrollLeft,
        st: sc.scrollTop,
      };
      setPanning(true);
    },
    [scrollerEl],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const pan = panRef.current;
      if (!pan || pan.id !== e.pointerId) return;
      const sc = scrollerEl();
      if (!sc) return;
      const dx = e.clientX - pan.x;
      const dy = e.clientY - pan.y;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) pannedRef.current = true;
      sc.scrollLeft = pan.sl - dx;
      sc.scrollTop = pan.st - dy;
    },
    [scrollerEl],
  );

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    if (panRef.current?.id !== e.pointerId) return;
    panRef.current = null;
    setPanning(false);
    if (viewRef.current?.hasPointerCapture(e.pointerId)) {
      viewRef.current.releasePointerCapture(e.pointerId);
    }
  }, []);

  const enterRow = useCallback((e: React.MouseEvent, node: CommitNode) => {
    tipPosRef.current = { x: e.clientX, y: e.clientY };
    setHoverOid(node.oid);
    setTipNode(node);
  }, []);

  const moveTip = useCallback((e: React.MouseEvent) => {
    tipPosRef.current = { x: e.clientX, y: e.clientY };
    const el = tipRef.current;
    if (el) placeTip(el, e.clientX, e.clientY);
  }, []);

  const leaveRow = useCallback(() => {
    setHoverOid(null);
    setTipNode(null);
    setTipOn(false);
  }, []);

  const toggleSelect = useCallback(
    (oid: string) => {
      void selectCommit(oid === selectedOid ? null : oid);
    },
    [selectCommit, selectedOid],
  );

  /** Commit bajo el cursor dentro de la franja del grafo. */
  const nodeAtStripY = useCallback(
    (el: HTMLElement, clientY: number) => {
      const rect = el.getBoundingClientRect();
      const row = Math.floor((clientY - rect.top) / (BASE_ROW_HEIGHT * zoomRef.current));
      return rowToNode.get(row) ?? null;
    },
    [rowToNode],
  );

  /** La franja del grafo tambien selecciona y muestra el tooltip de su fila. */
  const onStripMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const node = nodeAtStripY(e.currentTarget, e.clientY);
      tipPosRef.current = { x: e.clientX, y: e.clientY };
      if (!node) {
        leaveRow();
        return;
      }
      if (node.oid !== hoverOid) {
        setHoverOid(node.oid);
        setTipNode(node);
      } else {
        const el = tipRef.current;
        if (el) placeTip(el, e.clientX, e.clientY);
      }
    },
    [nodeAtStripY, hoverOid, leaveRow],
  );

  const onStripClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (pannedRef.current) return;
      const node = nodeAtStripY(e.currentTarget, e.clientY);
      if (node) toggleSelect(node.oid);
    },
    [nodeAtStripY, toggleSelect],
  );

  /* ---------------------------------------------------------------- render */

  return (
    <div
      className={`graph-view${panReady ? ' is-pan-ready' : ''}${panning ? ' is-panning' : ''}`}
      ref={viewRef}
      onMouseDown={onMouseDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {nodes.length === 0 ? (
        <p className="empty">Sin commits que mostrar.</p>
      ) : (
        <>
          <div className="graph-body" ref={bodyRef}>
            <div
              className="graph-canvas-wrap"
              title="Ctrl/Cmd + rueda para hacer zoom"
              onMouseMove={onStripMove}
              onMouseLeave={leaveRow}
              onClick={onStripClick}
            >
              <canvas
                ref={baseRef}
                className="graph-canvas"
                role="img"
                aria-label="Grafo de commits"
              />
            </div>

            <div className={`graph-rows${entrancing ? ' is-entrance' : ''}`}>
              {nodes.map((node) => {
                const kind = commitKind(node.subject);
                return (
                  <div
                    key={node.oid}
                    className={rowClass(node)}
                    style={
                      {
                        '--row-i': node.row,
                        '--ref-color': laneColor(node.lane),
                      } as React.CSSProperties
                    }
                    onClick={() => {
                      if (pannedRef.current) return;
                      toggleSelect(node.oid);
                    }}
                    onMouseEnter={(e) => enterRow(e, node)}
                    onMouseMove={moveTip}
                    onMouseLeave={leaveRow}
                    role="button"
                    tabIndex={0}
                    aria-label={`${node.subject}, commit de ${node.authorName}`}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        toggleSelect(node.oid);
                      }
                    }}
                  >
                    {node.labels.length > 0 && (
                      <div className="graph-labels-wrap">
                        {node.labels.map((label) => {
                          const branchInfo = branches?.branches.find((b) => b.name === label.name);
                          const aheadCount = branchInfo?.ahead ?? 0;
                          const isTag = label.kind === 'tag';
                          const isHead = label.isHead;
                          const filterActive = highlight === label.name;
                          return (
                            <button
                              type="button"
                              key={label.fullName}
                              className={`ref-pill ref-${label.kind}${isHead ? ' is-head' : ''}${
                                filterActive ? ' is-filter' : ''
                              }`}
                              title={`${label.fullName} — clic para filtrar`}
                              aria-pressed={filterActive}
                              onClick={(e) => onLabelClick(e, label)}
                            >
                              {isHead && (
                                <span className="ref-check" aria-hidden="true">
                                  ✓
                                </span>
                              )}
                              {isTag && (
                                <span className="ref-tag-icon" aria-hidden="true">
                                  🏷️
                                </span>
                              )}
                              <span className="ref-name">{label.name}</span>
                              {aheadCount > 0 && <span className="ref-ahead">+{aheadCount}</span>}
                            </button>
                          );
                        })}
                      </div>
                    )}

                    <span
                      className={`commit-badge kind-${kind.kind}`}
                      title={KIND_LABEL[kind.kind]}
                    >
                      {kind.badge}
                    </span>

                    <span className="graph-subject" title={node.subject}>
                      {node.subject}
                    </span>

                    {/* Franja reservada bajo la que se dibuja el grafo. */}
                    <span className="graph-spacer" aria-hidden="true" />

                    <span className="graph-meta">
                      <span className="graph-time" title={node.authorTimeIso}>
                        {relativeTime(node.authorTime)}
                      </span>
                      <span
                        className="graph-shortsha"
                        title={`SHA: ${node.oid} (clic para copiar)`}
                        onClick={(e) => {
                          e.stopPropagation();
                          void navigator.clipboard.writeText(node.oid);
                          notify('info', `SHA ${node.shortOid} copiado al portapapeles`);
                        }}
                      >
                        {node.shortOid}
                      </span>
                    </span>

                    <button
                      type="button"
                      className="graph-detail-btn"
                      title="Ver detalle del commit"
                      aria-label={`Ver detalle de ${node.subject}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (pannedRef.current) return;
                        openDetail(node.oid);
                      }}
                      onKeyDown={(e) => e.stopPropagation()}
                    >
                      ⋯
                    </button>
                  </div>
                );
              })}
            </div>
          </div>

          {truncated && (
            <p className="graph-truncated">
              Mostrando {nodes.length} de {totalReachable} commits alcanzables.
            </p>
          )}
        </>
      )}

      {/* Tooltip contextual: autor, fecha, mensaje, tipo y refs. */}
      {tipNode && tipOn && (
        <div className="graph-tooltip" ref={tipRef} role="tooltip">
          <div className="tooltip-head">
            <span
              className="tooltip-avatar"
              style={{ backgroundColor: authorColor(tipNode.authorName) }}
              aria-hidden="true"
            >
              {authorInitial(tipNode.authorName)}
            </span>
            <span className="tooltip-author">{tipNode.authorName}</span>
            <span className="tooltip-date">{tipNode.authorTimeIso.slice(0, 10)}</span>
          </div>
          <p className="tooltip-message">{tipNode.subject}</p>
          <div className="tooltip-foot">
            <span className={`commit-badge kind-${commitKind(tipNode.subject).kind}`}>
              {commitKind(tipNode.subject).badge}
            </span>
            <span className="tooltip-sha">{tipNode.shortOid}</span>
            {tipNode.labels.slice(0, 2).map((l) => (
              <span key={l.fullName} className="tooltip-ref">
                {l.name}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
