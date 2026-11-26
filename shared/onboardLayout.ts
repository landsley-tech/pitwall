// tiles video windows over a screen area. shared so the server (real window
// bounds sent to multiviewer) and the web app (the layout preview) agree.
import type { OnboardLayout, Rect } from './types.ts';

const ASPECT = 16 / 9;

interface Fit {
  cols: number;
  rows: number;
  w: number;
  h: number;
}

// biggest 16:9 tile size for a cols x rows grid that holds `cells` cells
function bestFit(cells: number, W: number, H: number, minCols = 1, minRows = 1): Fit {
  let best: Fit = { cols: 1, rows: 1, w: 0, h: 0 };
  for (let cols = minCols; cols <= Math.max(minCols, cells); cols++) {
    const rows = Math.max(minRows, Math.ceil(cells / cols));
    const w = Math.min(W / cols, (H / rows) * ASPECT);
    // ties go to more columns, which suits landscape screens (20 cars -> 5x4, not 4x5)
    if (w > best.w - 0.01) best = { cols, rows, w, h: w / ASPECT };
  }
  return best;
}

/**
 * one rect per feed, in feed order. 'feature' gives the first feed a 2x2 block
 * (the main broadcast) with the onboards around it. e.g. 20 cars on a
 * 1920x1080 grid -> 5 cols x 4 rows of 384x216 tiles.
 */
export function tileLayout(count: number, area: Rect, layout: OnboardLayout = 'grid'): Rect[] {
  if (count <= 0 || area.width <= 0 || area.height <= 0) return [];
  const { x: X, y: Y, width: W, height: H } = area;
  // round the edges, not the sizes, so neighbours share an edge instead of overlapping by 1px
  const round = (r: Rect): Rect => {
    const x = Math.round(r.x);
    const y = Math.round(r.y);
    return { x, y, width: Math.max(1, Math.round(r.x + r.width) - x), height: Math.max(1, Math.round(r.y + r.height) - y) };
  };

  if (layout === 'feature' && count > 1) {
    // the big tile takes 4 cells, so count - 1 + 4 cells in total
    const f = bestFit(count + 3, W, H, 2, 2);
    const ox = X + (W - f.cols * f.w) / 2;
    const oy = Y + (H - f.rows * f.h) / 2;
    const out: Rect[] = [{ x: ox, y: oy, width: f.w * 2, height: f.h * 2 }];
    for (let i = 0; out.length < count && i < f.cols * f.rows; i++) {
      const c = i % f.cols;
      const r = Math.floor(i / f.cols);
      if (c < 2 && r < 2) continue; // under the big tile
      out.push({ x: ox + c * f.w, y: oy + r * f.h, width: f.w, height: f.h });
    }
    return out.map(round);
  }

  const f = bestFit(count, W, H);
  const oy = Y + (H - f.rows * f.h) / 2;
  const out: Rect[] = [];
  for (let i = 0; i < count; i++) {
    const r = Math.floor(i / f.cols);
    const inRow = r === f.rows - 1 ? count - r * f.cols : f.cols; // short last row gets centred
    const ox = X + (W - inRow * f.w) / 2;
    out.push({ x: ox + (i % f.cols) * f.w, y: oy + r * f.h, width: f.w, height: f.h });
  }
  return out.map(round);
}
