interface JustifyItem {
  ratio: number;
}

interface JustifiedCell<T> {
  item: T;
  width: number;
}

interface JustifiedRow<T> {
  height: number;
  cells: JustifiedCell<T>[];
}

const MIN_RATIO = 0.4;
const MAX_RATIO = 2.5;

function clampRatio(ratio: number): number {
  if (!Number.isFinite(ratio) || ratio <= 0) return 1;
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));
}

function fillRow<T extends JustifyItem>(
  items: T[],
  innerWidth: number,
  height: number
): JustifiedRow<T> {
  const widths = items.map((item) => Math.floor(clampRatio(item.ratio) * height));
  const spent = widths.reduce((sum, w) => sum + w, 0);
  if (widths.length && spent !== innerWidth && spent > 0) {
    widths[widths.length - 1] += innerWidth - spent;
  }
  return {
    height: Math.round(height),
    cells: items.map((item, k) => ({ item, width: widths[k] }))
  };
}

export function justifyRows<T extends JustifyItem>(
  items: T[],
  containerWidth: number,
  targetHeight: number,
  gap: number
): JustifiedRow<T>[] {
  if (containerWidth <= 0 || !items.length) return [];
  const rows: JustifiedRow<T>[] = [];
  let row: T[] = [];
  let ratioSum = 0;
  items.forEach((item) => {
    row.push(item);
    ratioSum += clampRatio(item.ratio);
    const innerWidth = containerWidth - gap * (row.length - 1);
    if (ratioSum * targetHeight >= innerWidth) {
      rows.push(fillRow(row, innerWidth, innerWidth / ratioSum));
      row = [];
      ratioSum = 0;
    }
  });
  if (row.length) {
    const innerWidth = containerWidth - gap * (row.length - 1);
    const natural = innerWidth / ratioSum;
    const height = Math.min(targetHeight, natural);
    const widths = row.map((item) => Math.floor(clampRatio(item.ratio) * height));
    rows.push({
      height: Math.round(height),
      cells: row.map((item, k) => ({ item, width: widths[k] }))
    });
  }
  return rows;
}

export function targetRowHeight(containerWidth: number): number {
  return Math.min(360, Math.max(200, Math.round(containerWidth / 5)));
}
