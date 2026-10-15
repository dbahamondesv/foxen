import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { useStore } from '../store/useAppStore';
import { laneColor, relativeTime, truncateMiddle } from '../lib/format';
import { COLUMN_TITLES, clampColumnWidth, type ColumnKey } from '../lib/columns';
import type { CommitNode, GraphEdge } from '../lib/types';

const ROW_HEIGHT = 30;
const LANE_WIDTH = 13;
const GRAPH_PAD = 8;
const LABEL_GAP = 10;
/** Alto de la cabecera; debe coincidir con `.graph-head` en styles.css. */
const HEAD_HEIGHT = 28;
/** Margen que el asunto no puede perder al estirar el resto de columnas. */
const MIN_SUBJECT = 120;
/** Tienen que coincidir con los `gap` y el `padding-right` de `.graph-row`. */
const COLUMN_GAP = 10;
const ROW_PAD_END = 12;
const COLUMN_KEYS = ['labels', 'sha', 'author', 'time'] as const;

/**
 * Espacio para las columnas fijas de la tabla, dejando hueco al asunto.
 * `containerWidth` es el ancho de la cabecera, que llena la fila entera.
 */
const roomFor = (containerWidth: number, graphWidth: number): number =>
  containerWidth - graphWidth - 4 * COLUMN_GAP - ROW_PAD_END - MIN_SUBJECT;

interface Props {
  nodes: CommitNode[];
  edges: GraphEdge[];
  laneCount: number;
  truncated: boolean;
  totalReachable: number;
}

export function CommitGraphView({ nodes, edges, laneCount, truncated, totalReachable }: Props) {
  const selectedOid = useStore((s) => s.selectedOid);
  const selectCommit = useStore((s) => s.selectCommit);
  const highlight = useStore((s) => s.graphHighlight);
  const columnWidths = useStore((s) => s.columnWidths);
  const setColumnWidth = useStore((s) => s.setColumnWidth);

  const [hover, setHover] = useState<string | null>(null);
  /** Ancho en curso mientras se arrastra el borde de una columna. */
  const [drag, setDrag] = useState<{ key: ColumnKey; width: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ key: ColumnKey; startX: number; startWidth: number; width: number } | null>(
    null,
  );

  // Al seleccionar desde otro panel, el commit debe quedar a la vista.
  useEffect(() => {
    if (!selectedOid || !scrollRef.current) return;
    const node = nodes.find((n) => n.oid === selectedOid);
    if (!node) return;
    // El contenedor que scrollea es `.main`, no este nodo.
    const scroller = scrollRef.current.closest('.main');
    if (!scroller) return;
    const top = HEAD_HEIGHT + node.row * ROW_HEIGHT;
    const visibleTop = scroller.scrollTop + HEAD_HEIGHT;
    const visibleBottom = scroller.scrollTop + scroller.clientHeight;
    if (top < visibleTop || top + ROW_HEIGHT > visibleBottom) {
      scroller.scrollTop = Math.max(0, top - scroller.clientHeight / 2);
    }
  }, [selectedOid, nodes]);

  const laneX = useCallback((lane: number) => GRAPH_PAD + lane * LANE_WIDTH, []);

  /** Ancho de la columna del grafo: la unica columna fija a la izquierda. */
  const graphWidth = GRAPH_PAD * 2 + Math.max(laneCount, 1) * LANE_WIDTH;

  /** Tiempo maximo de las etiquetas de referencia, en px. */
  const labelWidth = useMemo(() => {
    let max = 0;
    for (const node of nodes) {
      for (const label of node.labels) max = Math.max(max, label.name.length);
    }
    return Math.min(max * 6.6 + LABEL_GAP, 260);
  }, [nodes]);

  /**
   * El ancho real de la cabecera no existe hasta despues de pintar, y cambia
   * al redimensionar la ventana.
   */
  const [containerWidth, setContainerWidth] = useState(0);
  const empty = nodes.length === 0;
  useLayoutEffect(() => {
    const head = headRef.current;
    if (!head) return;
    const update = () => setContainerWidth(head.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(head);
    return () => observer.disconnect();
  }, [empty]);

  /** Anchos pedidos por el usuario, con `labels` aun en automatico. */
  const baseWidths = useMemo(
    () => ({
      labels: columnWidths.labels ?? labelWidth,
      sha: columnWidths.sha,
      author: columnWidths.author,
      time: columnWidths.time,
    }),
    [columnWidths, labelWidth],
  );

  /**
   * Anchos efectivos. Las columnas fijas no encogen solas, asi que si no caben
   * se reducen todas proporcionalmente antes de que la tabla se desborde. El
   * ajuste es solo visual: lo guardado se conserva y vuelve al ensanchar.
   */
  const effWidths = useMemo(() => {
    if (containerWidth <= 0) return baseWidths;
    const room = roomFor(containerWidth, graphWidth);
    const sum = baseWidths.labels + baseWidths.sha + baseWidths.author + baseWidths.time;
    if (sum <= room) return baseWidths;
    const scale = Math.max(room, 0) / sum;
    return {
      labels: Math.round(baseWidths.labels * scale),
      sha: Math.round(baseWidths.sha * scale),
      author: Math.round(baseWidths.author * scale),
      time: Math.round(baseWidths.time * scale),
    };
  }, [containerWidth, baseWidths, graphWidth]);

  /** Ancho con el que se pinta la columna, ya ajustado al espacio disponible. */
  const colWidth = useCallback(
    (key: ColumnKey): number => (drag?.key === key ? drag.width : effWidths[key]),
    [drag, effWidths],
  );

  /**
   * Ancho maximo que puede tomar una columna: las fijas no encogen solas, solo
   * lo hace `subject`, y no debe quedar por debajo de `MIN_SUBJECT`.
   */
  const clampToRoom = (key: ColumnKey, width: number): number => {
    if (containerWidth <= 0) return width;
    const others = COLUMN_KEYS.reduce(
      (sum, other) => (other === key ? sum : sum + colWidth(other)),
      0,
    );
    return Math.min(width, roomFor(containerWidth, graphWidth) - others);
  };

  /**
   * Ancho que hay que guardar para que al soltar se pinte exactamente `shown`.
   *
   * Con la tabla estrecha `effWidths` escala todos los valores: guardar
   * `shown` tal cual haria que se volviera a escalar y el ancho saltara al
   * soltar el raton.
   */
  const toStored = (key: ColumnKey, shown: number): number => {
    if (containerWidth <= 0) return shown;
    const room = roomFor(containerWidth, graphWidth);
    const sum = baseWidths.labels + baseWidths.sha + baseWidths.author + baseWidths.time;
    if (sum <= room) return shown;
    const others = COLUMN_KEYS.reduce(
      (total, other) => (other === key ? total : total + baseWidths[other]),
      0,
    );
    const free = room - shown;
    return free > 0 ? (shown * others) / free : shown;
  };

  /** Solo la seleccion atenua el resto: el hover parpadeaba al mover el raton. */
  const activeLane = useMemo(() => {
    if (!selectedOid) return null;
    return nodes.find((n) => n.oid === selectedOid)?.lane ?? null;
  }, [selectedOid, nodes]);

  const edgeOpacity = (edge: GraphEdge) =>
    activeLane === null ? 1.0 : edge.fromLane === activeLane || edge.toLane === activeLane ? 1 : 0.25;

  /** Color de fila: azul claro si es HEAD, Tenue si es el commit resaltado. */
  const rowClass = (node: CommitNode) => {
    const classes = ['graph-row'];
    if (node.oid === selectedOid) classes.push('is-selected');
    else if (node.oid === hover) classes.push('is-hover');
    if (node.isHead) classes.push('is-head');
    if (highlight && node.subject.toLowerCase().includes(highlight.toLowerCase())) {
      classes.push('is-highlight');
    }
    return classes.join(' ');
  };

  /**
   * Relleno de la fila dentro del SVG, para que hover y seleccion crucen el
   * grafo sin costura con la tabla.
   */
  const bandClass = (node: CommitNode) => {
    const classes = ['graph-band'];
    if (node.oid === selectedOid) classes.push('is-selected');
    else if (node.oid === hover) classes.push('is-hover');
    return classes.join(' ');
  };

  /**
   * Traza la arista de un commit a su padre.
   *
   * Mismo carril: linea recta. Cambio de carril: curva en S (bezier cubica) que
   * gira pegada a cada nodo y deja el tramo medio recto, como en GitKraken. Las
   * esquinas a 90 grados dejaban la rama colgando de un punto suelto.
   */
  const edgePath = (edge: GraphEdge) => {
    const x1 = laneX(edge.fromLane);
    const y1 = edge.fromRow * ROW_HEIGHT + ROW_HEIGHT / 2;
    const x2 = laneX(edge.toLane);
    const y2 = edge.toRow * ROW_HEIGHT + ROW_HEIGHT / 2;
    if (x1 === x2) return `M ${x1} ${y1} V ${y2}`;
    // Estilo ortogonal (git --graph): baja vertical por el carril origen
    // hasta la fila del padre y luego cruza horizontalmente al carril destino.
    return `M ${x1} ${y1} V ${y2} H ${x2}`;
  };

  // --- Redimensionado de columnas -----------------------------------------

  const startResize = (key: ColumnKey) => (event: ReactPointerEvent<HTMLSpanElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const width = colWidth(key);
    dragRef.current = { key, startX: event.clientX, startWidth: width, width };
    setDrag({ key, width });
  };

  const moveResize = (event: ReactPointerEvent<HTMLSpanElement>) => {
    const active = dragRef.current;
    if (!active) return;
    const target = active.startWidth + (event.clientX - active.startX);
    const width = clampColumnWidth(active.key, clampToRoom(active.key, target));
    active.width = width;
    setDrag({ key: active.key, width });
  };

  const endResize = (event: ReactPointerEvent<HTMLSpanElement>) => {
    const active = dragRef.current;
    if (!active) return;
    dragRef.current = null;
    setDrag(null);
    const handle = event.currentTarget;
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    // Un clic sin arrastrar no cambia nada: el ancho se guarda al soltar.
    if (event.clientX === active.startX) return;
    setColumnWidth(active.key, clampColumnWidth(active.key, toStored(active.key, active.width)));
  };

  const resizeHandle = (key: ColumnKey) => (
    <span
      className="col-resize"
      aria-hidden
      onPointerDown={startResize(key)}
      onPointerMove={moveResize}
      onPointerUp={endResize}
      onPointerCancel={endResize}
    />
  );

  /** Bloquea la seleccion de texto mientras se arrastra un borde. */
  useEffect(() => {
    if (!drag) return;
    document.body.classList.add('is-resizing-column');
    return () => document.body.classList.remove('is-resizing-column');
  }, [drag]);

  const totalHeight = nodes.length * ROW_HEIGHT;
  const separatorPath = nodes
    .map((node) => `M 0 ${node.row * ROW_HEIGHT + ROW_HEIGHT - 0.5} H ${graphWidth}`)
    .join(' ');
  const selectedNode = selectedOid ? nodes.find((n) => n.oid === selectedOid) : undefined;

  return (
    <div className="graph-view" ref={scrollRef}>
      {nodes.length === 0 ? (
        <p className="empty">Sin commits que mostrar.</p>
      ) : (
        <>
          {/*
            Cabecera pegajosa con el mismo reparto de columnas que las filas:
            el separador del grafo absorbe el primer `gap` para que `Refs`
            empiece exactamente donde empieza cada fila.
          */}
          <div className="graph-head" ref={headRef}>
            <span className="head-graph" style={{ width: graphWidth }} aria-hidden />
            <span className="graph-labels head-col" style={{ width: colWidth('labels') }}>
              {COLUMN_TITLES.labels}
              {resizeHandle('labels')}
            </span>
            <span className="graph-subject head-col">Mensaje</span>
            <span className="graph-shortsha head-col" style={{ width: colWidth('sha') }}>
              {COLUMN_TITLES.sha}
              {resizeHandle('sha')}
            </span>
            <span className="graph-author head-col" style={{ width: colWidth('author') }}>
              {COLUMN_TITLES.author}
              {resizeHandle('author')}
            </span>
            <span className="graph-time head-col" style={{ width: colWidth('time') }}>
              {COLUMN_TITLES.time}
              {resizeHandle('time')}
            </span>
          </div>

          <div className="graph-body">
            <svg
              className="graph-svg"
              width={graphWidth}
              height={totalHeight}
              role="img"
              aria-label="Grafo de commits"
            >
              {/* Bandas de fila: el hover y la seleccion cruzan grafo y tabla. */}
              {nodes.map((node) => (
                <rect
                  key={`band-${node.oid}`}
                  className={bandClass(node)}
                  x={0}
                  y={node.row * ROW_HEIGHT}
                  width={graphWidth}
                  height={ROW_HEIGHT}
                />
              ))}

              {/* Mismo trazo que el borde inferior de cada fila de la tabla. */}
              <path className="graph-sep" d={separatorPath} fill="none" />

              {/* Aristas: primero halo para separar del fondo, luego arista coloreada. */}
              {[false, true].map((isMerge) =>
                edges
                  .filter((e) => e.isMergeEdge === isMerge)
                  .map((edge, i) => (
                    <path
                      key={`${isMerge ? 'm' : 'e'}h${i}`}
                      d={edgePath(edge)}
                      fill="none"
                      stroke="var(--bg)"
                      strokeWidth={3.2}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      opacity={edgeOpacity(edge) * 0.8}
                      pointerEvents="none"
                    />
                  )),
              )}
              {[false, true].map((isMerge) =>
                edges
                  .filter((e) => e.isMergeEdge === isMerge)
                  .map((edge, i) => (
                    <path
                      key={`${isMerge ? 'm' : 'e'}${i}`}
                      d={edgePath(edge)}
                      fill="none"
                      stroke={laneColor(edge.toLane)}
                      strokeWidth={2.4}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      opacity={edgeOpacity(edge)}
                    />
                  )),
              )}

              {/* Nodos del mismo tamano; el merge sale hueco y el HEAD con halo. */}
              {nodes.map((node) => {
                const cx = laneX(node.lane);
                const cy = node.row * ROW_HEIGHT + ROW_HEIGHT / 2;
                const color = laneColor(node.lane);
                return (
                  <circle
                    key={node.oid}
                    cx={cx}
                    cy={cy}
                    r={node.isHead ? 5.2 : 4.6}
                    fill={node.isMerge ? 'var(--bg)' : color}
                    stroke={node.isMerge ? color : 'var(--bg)'}
                    strokeWidth={node.isHead ? 2 : node.isMerge ? 2.4 : 1.4}
                    opacity={activeLane === null || node.lane === activeLane ? 1 : 0.25}
                  />
                );
              })}

              {/* Borde vertical entre el grafo y la tabla. */}
              <line
                className="graph-split"
                x1={graphWidth - 0.5}
                y1={0}
                x2={graphWidth - 0.5}
                y2={totalHeight}
              />

              {/* Marca de seleccion, pegada al borde izquierdo del visor. */}
              {selectedNode && (
                <rect
                  className="graph-mark"
                  x={0}
                  y={selectedNode.row * ROW_HEIGHT}
                  width={3}
                  height={ROW_HEIGHT}
                />
              )}
            </svg>

            {/* Lista de commits alineada con el grafo */}
            <div className="graph-rows" style={{ height: totalHeight }}>
              {nodes.map((node) => (
                <div
                  key={node.oid}
                  className={rowClass(node)}
                  style={{ height: ROW_HEIGHT }}
                  onClick={() => void selectCommit(node.oid === selectedOid ? null : node.oid)}
                  onMouseEnter={() => setHover(node.oid)}
                  onMouseLeave={() => setHover(null)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      void selectCommit(node.oid === selectedOid ? null : node.oid);
                    }
                  }}
                >
                  <span className="graph-labels" style={{ width: colWidth('labels') }}>
                    {node.labels.map((label) => (
                      <span
                        key={label.fullName}
                        className={`ref-chip ref-${label.kind}${label.isHead ? ' ref-head' : ''}`}
                        title={label.fullName}
                      >
                        {label.name}
                      </span>
                    ))}
                  </span>

                  <span className="graph-subject" title={node.subject}>
                    {truncateMiddle(node.subject, Math.max(colWidth('labels') * 4, 200))}
                  </span>

                  <span className="graph-shortsha" title={node.oid} style={{ width: colWidth('sha') }}>
                    {node.shortOid}
                  </span>

                  <span className="graph-author" style={{ width: colWidth('author') }}>
                    {node.authorName}
                  </span>
                  <span className="graph-time" style={{ width: colWidth('time') }}>
                    {relativeTime(node.authorTime)}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {truncated && (
            <p className="graph-truncated">
              Mostrando {nodes.length} de {totalReachable} commits alcanzables.
            </p>
          )}
        </>
      )}
    </div>
  );
}
