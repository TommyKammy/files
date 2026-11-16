

export function toggleKeySelection(
  selected: ReadonlySet<string>,
  key: string
): Set<string> {
  const next = new Set(selected);
  if (next.has(key)) {
    next.delete(key);
  } else {
    next.add(key);
  }
  return next;
}

export function selectKeyRange(
  orderedKeys: readonly string[],
  anchorKey: string | null,
  targetKey: string
): Set<string> {
  const targetIdx = orderedKeys.indexOf(targetKey);
  if (targetIdx < 0) return new Set();
  const anchorIdx = anchorKey ? orderedKeys.indexOf(anchorKey) : -1;
  if (anchorIdx < 0) {
    return new Set([targetKey]);
  }
  const start = Math.min(anchorIdx, targetIdx);
  const end = Math.max(anchorIdx, targetIdx);
  return new Set(orderedKeys.slice(start, end + 1));
}


