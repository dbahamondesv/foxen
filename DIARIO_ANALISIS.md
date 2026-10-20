# Análisis y Especificación de Diseño UI/UX: Rediseño del Grafo y la Interfaz de Foxen

> **Fecha:** 2026-10-20  
> **Objetivo:** Erradicar la sobrecarga cognitiva y el "shock visual" de la interfaz previa, implementando un diseño esbelto, geométrico y fluido inspirado en las mejores prácticas de **GitFiend** y clientes modernos de Git.

---

## 1. Diagnóstico de la Interfaz Previa: Factores de Fricción y "Shock"

Al evaluar la interfaz original desde la perspectiva de diseño de interacción y ergonomía visual, se identificaron varios problemas críticos:

| Elemento | Implementación Previa | Efecto en la Experiencia del Usuario (UX) |
| :--- | :--- | :--- |
| **Trazado de Aristas** | Ángulos rectos de 90° (`M x1 y1 V y2 H x2`). | **Efecto "escalera / placa de circuitos":** El ojo humano interpreta los cambios de carril como interrupciones bruscas o fallos de conexión en lugar de una ramificación continua. |
| **Grosor y Halos** | Trazo de `2.4px` con halo negro de `3.2px`. | **Pesadez gráfica:** En filas compactas de 30px, los trazos gruesos asfixiaban el espacio y competían con el texto. |
| **Estructura de Tabla** | Cabecera `.graph-head` fija con tiradores de columna (`REFS \| MENSAJE \| SHA \| AUTOR \| TIEMPO`). | **Sobrecarga de "hoja de cálculo":** El asunto del commit quedaba aprisionado entre 4 columnas fijas, obligando a truncar mensajes importantes mientras se desperdiciaba espacio horizontal. |
| **Cromatismo y Fondo** | Negro crudo (`#0d1117`) y bordes duros (`#30363d`) con tonos neón saturados. | **Fatiga visual:** Excesivo contraste estático que provocaba incomodidad en sesiones prolongadas. |
| **Identidad de Autores** | Texto plano desalineado (`authorName`). | **Falta de calidez y jerarquía:** Largas cadenas de texto que consumían espacio sin aportar una diferenciación rápida de quién hizo qué. |

---

## 2. Benchmark de Referencia: La Filosofía Visual de GitFiend

El análisis de la captura de GitFiend reveló los pilares del diseño que generan esa sensación de orden y calma:

1. **Topología de Diamante y Diagonales Suaves:**  
   Las bifurcaciones y uniones de ramas nunca forman ángulos rectos; utilizan transiciones diagonales a 45° limpias que forman rombos y diamantes visualmente naturales.
2. **Ausencia de Cabeceras Rígidas:**  
   No existen etiquetas redundantes como "Mensaje" o "Fecha". La jerarquía tipográfica y espacial basta para que el cerebro entienda el dato de un vistazo.
3. **Avatares Sintéticos:**  
   Un círculo compacto de 20px con la inicial del autor y un color armónico identifica instantáneamente la autoría ahorrando más de 120px de ancho.
4. **Pastillas (Pills) Diferenciadas:**  
   - Rama activa (`HEAD`): Destacada con checkmark (`✓`) y fondo traslúcido cian/teal.
   - Commits por delante/detrás: Badges numéricos compactos (`+1`).
   - Etiquetas (`tags`): Borde punteado icónico que las diferencia inmediatamente de las ramas vivas.
5. **Acciones Remotas Integradas:**  
   Botones principales siempre accesibles: **Pull ⬇️**, **Push ⬆️** y **Fetch 🔄**.

---

## 3. Especificación Técnica de la Nueva Arquitectura de Diseño

### 3.1. Algoritmo Geométrico de Conexión de Líneas (`edgePath`)

Se rediseñó el cálculo SVG de las aristas en [`src/components/CommitGraph.tsx`](file:///home/foxbuntu/Proyectos/foxen/src/components/CommitGraph.tsx) para eliminar el código escalonado y adoptar geometría diagonal armónica:

```typescript
const edgePath = (edge: GraphEdge) => {
  const x1 = laneX(edge.fromLane);
  const y1 = edge.fromRow * ROW_HEIGHT + ROW_HEIGHT / 2;
  const x2 = laneX(edge.toLane);
  const y2 = edge.toRow * ROW_HEIGHT + ROW_HEIGHT / 2;

  // 1. Mismo carril: Línea vertical continua perfecta
  if (x1 === x2) return `M ${x1} ${y1} V ${y2}`;

  // 2. Filas contiguas: Diagonal recta limpia (45° aproximado)
  if (edge.toRow === edge.fromRow + 1) {
    return `M ${x1} ${y1} L ${x2} ${y2}`;
  }

  // 3. Arista de Merge (desde el commit merge hacia la rama que se integra):
  //    Inicia diagonal hacia el carril de la rama y continúa vertical
  if (edge.isMergeEdge) {
    const diagY = y1 + ROW_HEIGHT;
    return `M ${x1} ${y1} L ${x2} ${diagY} V ${y2}`;
  }

  // 4. Bifurcación (Fork de rama):
  //    Baja vertical por su carril y converge diagonalmente hacia el padre al final
  const diagY = y2 - ROW_HEIGHT;
  return `M ${x1} ${y1} V ${diagY} L ${x2} ${y2}`;
};
```

#### Parámetros Gráficos de Renderizado:
- **Grosor del Trazo:** Reducido a `1.8px` (antes `2.4px`), con `strokeLinecap="round"` y `strokeLinejoin="round"`.
- **Halo de Desacoplamiento:** Reducido a `2.8px` con `opacity={0.35}`, permitiendo que los cruces de líneas se perciban limpios sin crear "cortes" negros artificiales.
- **Nodos:** Círculos sólidos de radio `3.8px` (`4.6px` en `HEAD` con anillo concéntrico de `r=7.2px`).

---

### 3.2. Sistema de Color y Tokens (Modo Grafito GitFiend)

Se sustituyeron los valores de contraste extremo por una paleta en grafito suave en [`src/styles.css`](file:///home/foxbuntu/Proyectos/foxen/src/styles.css):

```css
[data-theme='dark'] {
  --bg: #18181c;                    /* Fondo grafito mate cálido */
  --bg-elev: #202127;               /* Elevación 1 (TopBar, cards) */
  --bg-elev-2: #282932;             /* Elevación 2 (Hover, pills, inputs) */
  --border: rgba(255, 255, 255, 0.08);
  --border-soft: rgba(255, 255, 255, 0.04);
  --text: #f0f2f5;                  /* Blanco off-white no hiriente */
  --text-dim: #9aa0a6;              /* Gris legible */
  --text-faint: #636b74;            /* Metadatos y fechas */
  --accent: #eb6f65;                /* Coral Foxen (cálido, no agresivo) */

  /* Carriles armónicos de baja saturación visual */
  --lane-0: #eb6f65;  /* Coral principal */
  --lane-1: #b470d0;  /* Orquídea / Violeta */
  --lane-2: #38bdf8;  /* Cyan cielo */
  --lane-3: #fbbf24;  /* Ámbar */
  --lane-4: #34d399;  /* Menta */
  --lane-5: #f472b6;  /* Rosa */
  --lane-6: #a78bfa;  /* Lavanda */
  --lane-7: #fb923c;  /* Mandarina */
  --lane-8: #2dd4bf;  /* Teal */
  --lane-9: #60a5fa;  /* Azul cobalto */
}
```

---

### 3.3. Anatomía de la Fila de Commit Rediseñada

Cada fila en el historial ahora fluye de forma orgánica sin celdas cerradas:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ [Grafo SVG]  [✓ feat/k8s +1]  (F)  fix: point deployment image to v1   hace 3m  7b8c9d0│
└────────────────────────────────────────────────────────────────────────────────────────┘
```

1. **Pastillas de Referencia (`.ref-pill`):**
   - **HEAD:** Fondo teal translúcido (`rgba(45, 212, 191, 0.16)`), texto cian `#2dd4bf`, símbolo `✓` y contador `+1`.
   - **Ramas Locales/Remotas:** Píldora redondeada con borde suave.
   - **Tags:** Fondo ámbar tenue con borde punteado (`1px dashed`) y prefijo `🏷️`.
2. **Avatar Sintético del Autor (`.graph-avatar`):**
   - Diámetro de `20px` con bordes redondeados al 50%.
   - Inicial en mayúscula (`authorInitial(name)`).
   - Color determinista (`authorColor(name)`) derivado del hash del autor para mantener consistencia visual a lo largo de todo el repositorio.
3. **Asunto del Commit (`.graph-subject`):**
   - Aprovecha todo el ancho disponible (`flex: 1 1 auto`).
   - Peso `600` para el commit activo (HEAD).
4. **Tiempo Relativo (`.graph-time`):**
   - Texto secundario alineado a la derecha ("hace 3 meses", "hace 2h").
5. **Short SHA Clicable (`.graph-shortsha`):**
   - Badge tipográfico monoespaciado que copia el SHA completo al portapapeles al hacer clic con notificación toast.

---

### 3.4. Barra de Herramientas Superior (TopBar) y Acciones Remotas

En [`src/components/TopBar.tsx`](file:///home/foxbuntu/Proyectos/foxen/src/components/TopBar.tsx):
- **Acciones directas:** Botones unificados para **Pull ⬇️**, **Push ⬆️** y **Fetch 🔄**.
- **Contadores de sincronización:** Indicadores de commits pendientes de subida (`Push ↑1`) y descarga (`Pull ↓1`).
- **Selector de Paneles (`PanelTabs`):** Pestañas con iconos expresivos (`📝 Cambios`, `🌿 Ramas`, `📦 Stashes`, `🌐 Remotos`, `⚡ Flow`, `📜 Reflog`) y contadores en píldora.

---

## 4. Resultados de Verificación y Métricas

- **TypeScript:** `npm run typecheck` completado con `0` errores.
- **Pruebas Unitarias:** `npm run test` (Vitest) con `37` pruebas pasando (`b64`, `desktop`, `session`, `format`).
- **Linter:** `npm run lint` (ESLint) limpio con `0` advertencias.
- **Rust Backend:** `cargo check` sobre `src-tauri` finalizado con éxito.
- **Build de Producción:** `npm run build` genera el bundle optimizado sin fallos.

