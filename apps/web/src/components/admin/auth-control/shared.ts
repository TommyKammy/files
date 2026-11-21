import type { InputHTMLAttributes } from 'react';

export const NATIVE_SWITCH_ATTRS = {
  switch: '',
} as unknown as InputHTMLAttributes<HTMLInputElement>;

/** Checks whether two string lists contain the same elements regardless of order. */
export function sameStringList(
  left: readonly string[],
  right: readonly string[]
): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}
