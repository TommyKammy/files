import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeMarqueeSelection,
  normalizeMarqueeRect,
  rectsIntersect,
} from '@/lib/use-marquee-selection';

function fakeRow(index: number, top: number, height = 40, width = 200): HTMLElement {
  return {
    dataset: { rowIndex: String(index) },
    getBoundingClientRect: () => ({
      left: 0,
      top,
      right: width,
      bottom: top + height,
      width,
      height,
    }),
  } as unknown as HTMLElement;
}

test('normalizeMarqueeRect returns a positive rect in any drag direction', () => {
  assert.deepEqual(normalizeMarqueeRect(100, 200, 40, 120), {
    left: 40,
    top: 120,
    width: 60,
    height: 80,
  });
  assert.deepEqual(normalizeMarqueeRect(40, 120, 100, 200), {
    left: 40,
    top: 120,
    width: 60,
    height: 80,
  });
});

test('rectsIntersect includes edge-touching rows and rejects gaps', () => {
  const marquee = { left: 10, top: 10, right: 100, bottom: 100 };
  assert.equal(
    rectsIntersect(marquee, { left: 0, top: 0, right: 20, bottom: 20 }),
    true
  );
  assert.equal(
    rectsIntersect(marquee, { left: 100, top: 100, right: 120, bottom: 120 }),
    true
  );
  assert.equal(
    rectsIntersect(marquee, { left: 110, top: 110, right: 130, bottom: 130 }),
    false
  );
});

test('computeMarqueeSelection maps only rendered intersecting rows to workspace keys', () => {
  const keys = ['folder:a', 'file:b', 'file:c', 'file:d'];
  const rows = [fakeRow(0, 0), fakeRow(1, 50), fakeRow(2, 150), fakeRow(3, 250)];

  const hit = computeMarqueeSelection(
    { left: 0, top: 40, right: 200, bottom: 180 },
    rows,
    keys
  );
  assert.deepEqual([...hit].sort(), ['file:b', 'file:c', 'folder:a']);

  // Out-of-range data-row-index values are ignored rather than producing undefined keys.
  const invalid = computeMarqueeSelection(
    { left: 0, top: 0, right: 200, bottom: 500 },
    [fakeRow(0, 0), fakeRow(99, 60)],
    keys
  );
  assert.deepEqual([...invalid], ['folder:a']);

  // Zero-size rows (virtualized spacers) never count as hit targets.
  const zeroSize = {
    dataset: { rowIndex: '1' },
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
    }),
  } as unknown as HTMLElement;
  assert.equal(
    computeMarqueeSelection(
      { left: 0, top: 0, right: 10, bottom: 10 },
      [zeroSize],
      keys
    ).size,
    0
  );
});
