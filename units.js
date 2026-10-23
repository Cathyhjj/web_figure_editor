// Project geometry always stays in CSS pixels (96 px = 1 inch).
export const UNITS = Object.freeze({ px: 1, mm: 25.4 / 96, pt: 72 / 96 });
export function fromPixels(value, unit = 'px') {
  if (!Object.hasOwn(UNITS, unit) || !Number.isFinite(value)) throw new Error('Invalid measurement.');
  return value * UNITS[unit];
}
export function toPixels(value, unit = 'px') {
  if (!Object.hasOwn(UNITS, unit) || String(value).trim() === '' || !Number.isFinite(Number(value))) throw new Error('Enter a finite measurement.');
  return Number(value) / UNITS[unit];
}
export function formatMeasurement(px, unit = 'px') {
  return String(Number(fromPixels(px, unit).toFixed(6)));
}
// Preserve the exact canonical value when a rounded display is left unchanged.
export function showMeasurement(input, px, unit = 'px') {
  input.value = formatMeasurement(px, unit);
  input.dataset.measurementDisplay = input.value;
  input.dataset.measurementPixels = String(px);
  input.dataset.measurementUnit = unit;
}
export function readMeasurement(input, unit = 'px') {
  return input.value === input.dataset.measurementDisplay
    ? Number(input.dataset.measurementPixels) : toPixels(input.value, input.dataset.measurementUnit || unit);
}
