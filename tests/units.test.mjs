import test from 'node:test';
import assert from 'node:assert/strict';
import { fromPixels, toPixels, formatMeasurement, showMeasurement, readMeasurement } from '../units.js';
import { steppedDisplayFontSize } from '../font-tools.js';
test('physical units use 96 px per inch in both directions', () => {
  assert.equal(fromPixels(96, 'mm'), 25.4);
  assert.equal(fromPixels(96, 'pt'), 72);
  assert.equal(toPixels('25.4', 'mm'), 96);
  assert.equal(toPixels('72', 'pt'), 96);
  assert.equal(toPixels('-12', 'px'), -12);
});
test('unchanged rounded measurements retain exact canonical geometry over repeated switches', () => {
  const input = { value: '', dataset: {} }, original = 123.456789123456;
  let value = original;
  for (let i = 0; i < 20; i++) for (const unit of ['mm', 'pt', 'px']) {
    showMeasurement(input, value, unit); value = readMeasurement(input, unit);
  }
  assert.equal(value, original);
  showMeasurement(input, original, 'mm'); input.value = '25.4';
  assert.equal(readMeasurement(input, 'mm'), 96);
  // A late change event from a detached old-unit input cannot use the new unit.
  assert.equal(readMeasurement(input, 'pt'), 96);
});
test('invalid measurements reject instead of silently becoming zero', () => {
  for (const value of ['', ' ', 'NaN', 'Infinity', 'abc']) assert.throws(() => toPixels(value, 'mm'));
  assert.throws(() => toPixels(1, 'cm'));
  assert.throws(() => formatMeasurement(Infinity));
});
test('font increase/decrease stays monotone and reaches canonical limits in every unit', () => {
  for (const unit of ['px', 'mm', 'pt']) for (const size of [1, 1.1, 2, 4, 16, 1600, 1999, 2000]) {
    const down = steppedDisplayFontSize(size, -1, unit), up = steppedDisplayFontSize(size, 1, unit);
    assert.ok(down <= size && down >= 1); assert.ok(up >= size && up <= 2000);
    if (size > 1) assert.ok(down < size);
    if (size < 2000) assert.ok(up > size);
  }
  assert.equal(steppedDisplayFontSize(2, -1, 'mm'), 1);
  assert.equal(steppedDisplayFontSize(1.1, -1, 'pt'), 1);
});
