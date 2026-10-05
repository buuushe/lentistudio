type Signature = number[];

export type ShuffleMode = 'similar' | 'contrast';

export function meanSignature(signatures: Signature[]): Signature {
  if (!signatures.length) return [];
  const length = signatures[0].length;
  return Array.from(
    { length },
    (_, k) => signatures.reduce((sum, s) => sum + (s[k] ?? 0), 0) / signatures.length
  );
}

export function signatureDistance(a: Signature, b: Signature): number {
  let sum = 0;
  const length = Math.max(a.length, b.length);
  for (let k = 0; k < length; k++) {
    const d = (a[k] ?? 0) - (b[k] ?? 0);
    sum += d * d;
  }
  return Math.sqrt(sum);
}

function farthestFromCentroid(signatures: Signature[]): number {
  const centroid = meanSignature(signatures);
  let best = 0;
  let bestDistance = -1;
  signatures.forEach((s, k) => {
    const d = signatureDistance(s, centroid);
    if (d > bestDistance) {
      best = k;
      bestDistance = d;
    }
  });
  return best;
}

function chain(
  signatures: Signature[],
  pick: (candidates: number[], path: number[]) => number
): number[] {
  if (signatures.length < 2) return signatures.map((_, k) => k);
  const path = [farthestFromCentroid(signatures)];
  const remaining = new Set(signatures.map((_, k) => k));
  remaining.delete(path[0]);
  while (remaining.size) {
    const next = pick([...remaining], path);
    path.push(next);
    remaining.delete(next);
  }
  return path;
}

export function orderSimilar(signatures: Signature[]): number[] {
  return chain(signatures, (candidates, path) => {
    const last = signatures[path[path.length - 1]];
    return candidates.reduce((best, k) =>
      signatureDistance(signatures[k], last) < signatureDistance(signatures[best], last) ? k : best
    );
  });
}

export function orderContrast(signatures: Signature[]): number[] {
  return chain(signatures, (candidates, path) => {
    const last = signatures[path[path.length - 1]];
    const before = path.length > 1 ? signatures[path[path.length - 2]] : null;
    const score = (k: number) =>
      signatureDistance(signatures[k], last) +
      (before ? 0.5 * signatureDistance(signatures[k], before) : 0);
    return candidates.reduce((best, k) => (score(k) > score(best) ? k : best));
  });
}

export function orderBy(mode: ShuffleMode, signatures: Signature[]): number[] {
  return mode === 'similar' ? orderSimilar(signatures) : orderContrast(signatures);
}

export function groupSimilar(features: Signature[], groupSize: number): number[][] {
  const remaining = features.map((_, k) => k);
  const groups: number[][] = [];
  while (remaining.length >= groupSize) {
    const seed = remaining[0];
    const nearest = remaining
      .slice(1)
      .map((k) => ({ k, distance: signatureDistance(features[seed], features[k]) }))
      .sort((a, b) => a.distance - b.distance || a.k - b.k)
      .slice(0, groupSize - 1)
      .map((item) => item.k);
    const group = [seed, ...nearest].sort((a, b) => a - b);
    groups.push(group);
    group.forEach((k) => remaining.splice(remaining.indexOf(k), 1));
  }
  return groups;
}
