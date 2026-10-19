import test from 'node:test';
import assert from 'node:assert/strict';
import { clampWindowRect, fitDockWidths } from '../windows.js';

test('sidebar widths leave space for the canvas when restoring a wide layout', () => {
  const requested = Object.freeze({ slides: 400, assets: 500, properties: 600 });
  const fitted = fitDockWidths(requested, 1100);
  assert.ok(Object.values(fitted).reduce((sum, width) => sum + width, 0) <= 820.00001);
  assert.ok(fitted.slides >= 136 && fitted.assets >= 170 && fitted.properties >= 220);
  assert.deepEqual(requested, { slides: 400, assets: 500, properties: 600 });
});

test('fitting docks preserves ordinary sizes and excludes floating columns', () => {
  assert.deepEqual(fitDockWidths({ slides: 164, assets: 240, properties: 300 }, 1440), { slides: 164, assets: 240, properties: 300 });
  assert.deepEqual(fitDockWidths({ assets: 500 }, 900), { assets: 500 });
  assert.deepEqual(fitDockWidths({}, 700), {});
});

test('invalid or extreme sidebar preferences stay finite and usable', () => {
  assert.deepEqual(fitDockWidths({ slides: NaN, assets: -100, properties: Infinity }, 1200), { slides: 136, assets: 170, properties: 220 });
  assert.deepEqual(fitDockWidths({ assets: 10000 }, 1600), { assets: 600 });
});

const EPSILON = 1e-8;

function assertWithinViewport(rect, viewport, margin = 0) {
  const left = (viewport.left ?? 0) + margin;
  const top = (viewport.top ?? 0) + margin;
  const right = (viewport.left ?? 0) + viewport.width - margin;
  const bottom = (viewport.top ?? 0) + viewport.height - margin;
  for (const key of ['x', 'y', 'width', 'height']) {
    assert.ok(Number.isFinite(rect[key]), `${key} must be finite: ${rect[key]}`);
  }
  assert.ok(rect.width > 0, 'window width must stay positive');
  assert.ok(rect.height > 0, 'window height must stay positive');
  assert.ok(rect.x >= left - EPSILON, `left edge ${rect.x} is outside ${left}`);
  assert.ok(rect.y >= top - EPSILON, `top edge ${rect.y} is outside ${top}`);
  assert.ok(rect.x + rect.width <= right + EPSILON, 'right edge must remain visible');
  assert.ok(rect.y + rect.height <= bottom + EPSILON, 'bottom edge must remain visible');
}

test('leaves a usable window unchanged without mutating the inputs', () => {
  const rect = Object.freeze({ x: 72, y: 90, width: 280, height: 360 });
  const viewport = Object.freeze({ width: 1280, height: 800 });
  const options = Object.freeze({ minWidth: 180, minHeight: 150, margin: 8 });
  const actual = clampWindowRect(rect, viewport, options);
  assert.deepEqual(actual, rect);
});

test('recovers a window beyond each viewport edge while preserving its usable size', () => {
  const viewport = { width: 1000, height: 700 };
  for (const x of [-500, 200, 1500]) {
    for (const y of [-600, 100, 1200]) {
      const actual = clampWindowRect({ x, y, width: 300, height: 220 }, viewport);
      assertWithinViewport(actual, viewport, 8);
      assert.equal(actual.width, 300);
      assert.equal(actual.height, 220);
      if (x < 8) assert.equal(actual.x, 8);
      if (x > 692) assert.equal(actual.x, 692);
      if (y < 8) assert.equal(actual.y, 8);
      if (y > 472) assert.equal(actual.y, 472);
    }
  }
});

test('expands undersized windows to the minimum where the viewport has room', () => {
  const actual = clampWindowRect({ x: 900, y: 700, width: 12, height: -20 }, { width: 1000, height: 800 });
  assert.deepEqual(actual, { x: 812, y: 642, width: 180, height: 150 });
});

test('honors custom minimums and margin, including an explicit zero margin', () => {
  assert.deepEqual(
    clampWindowRect({ x: -10, y: -20, width: 20, height: 30 }, { width: 800, height: 600 }, { minWidth: 240, minHeight: 200, margin: 24 }),
    { x: 24, y: 24, width: 240, height: 200 },
  );
  assert.deepEqual(
    clampWindowRect({ x: -10, y: -20, width: 2000, height: 2000 }, { width: 800, height: 600 }, { margin: 0 }),
    { x: 0, y: 0, width: 800, height: 600 },
  );
});

test('shrinks oversized windows to the available area after viewport resize', () => {
  assert.deepEqual(
    clampWindowRect({ x: 900, y: 600, width: 1600, height: 1200 }, { width: 640, height: 480 }),
    { x: 8, y: 8, width: 624, height: 464 },
  );
});

test('allows less than the preferred minimum on a smaller viewport', () => {
  const viewport = { width: 140, height: 110 };
  const actual = clampWindowRect({ x: 900, y: -900, width: 400, height: 400 }, viewport);
  assertWithinViewport(actual, viewport, 8);
  assert.ok(actual.width < 180);
  assert.ok(actual.height < 150);
});

test('caps margins on tiny viewports so a positive window still fits', () => {
  for (const viewport of [{ width: 1, height: 1 }, { width: 10, height: 6 }, { width: 2, height: 700 }]) {
    const actual = clampWindowRect({ x: -1000, y: 2000, width: 800, height: 600 }, viewport);
    assertWithinViewport(actual, viewport);
  }
});

test('uses visual viewport offsets when restoring offscreen windows', () => {
  const viewport = { left: 250, top: 120, width: 600, height: 400 };
  assert.deepEqual(
    clampWindowRect({ x: -100, y: -100, width: 220, height: 180 }, viewport),
    { x: 258, y: 128, width: 220, height: 180 },
  );
  assert.deepEqual(
    clampWindowRect({ x: 10000, y: 10000, width: 220, height: 180 }, viewport),
    { x: 622, y: 332, width: 220, height: 180 },
  );
});

test('replaces invalid saved geometry with finite, visible, usable dimensions', () => {
  const viewport = { left: 20, top: 30, width: 1000, height: 800 };
  const normal = { x: 100, y: 100, width: 300, height: 220 };
  for (const key of Object.keys(normal)) {
    for (const value of [NaN, Infinity, -Infinity]) {
      const actual = clampWindowRect({ ...normal, [key]: value }, viewport);
      assertWithinViewport(actual, viewport, 8);
      assert.ok(actual.width >= 180, `${key}=${value} lost the minimum width`);
      assert.ok(actual.height >= 150, `${key}=${value} lost the minimum height`);
    }
  }
  assertWithinViewport(clampWindowRect({ x: NaN, y: Infinity, width: -Infinity, height: NaN }, viewport), viewport, 8);
  assertWithinViewport(clampWindowRect({ x: -Number.MAX_VALUE, y: Number.MAX_VALUE, width: Number.MAX_VALUE, height: Number.MAX_VALUE }, viewport), viewport, 8);
});

test('clamping is stable when saved geometry is restored repeatedly', () => {
  const viewport = { left: 40, top: 80, width: 720, height: 540 };
  const candidates = [
    { x: 120, y: 130, width: 280, height: 210 },
    { x: -10000, y: 10000, width: 5, height: 5 },
    { x: 0, y: 0, width: 10000, height: 10000 },
    { x: NaN, y: -Infinity, width: Infinity, height: NaN },
  ];
  for (const candidate of candidates) {
    const first = clampWindowRect(candidate, viewport);
    assert.deepEqual(clampWindowRect(first, viewport), first);
  }
});
