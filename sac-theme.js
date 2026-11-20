// New-object defaults drawn from the SAC poster. Imported documents keep their
// own paints and typography; validation/rendering defaults are independent.
export const SAC_PALETTE = Object.freeze({
  ink: '#232425',
  blue: '#0082CA',
  navy: '#00609C',
  divider: '#D7E2EA',
  peach: '#EE916F',
  coral: '#DC486E',
  magenta: '#A63387',
  purple: '#69438C',
  paper: '#ffffff',
});

export const SAC_TEXT_STYLE = Object.freeze({
  fontFamily: 'Arial', fontWeight: 400, fontStyle: 'normal',
  color: SAC_PALETTE.ink, align: 'left',
});

export function sacShapeStyle({ line = false } = {}) {
  return {
    fill: line ? 'none' : SAC_PALETTE.paper,
    stroke: SAC_PALETTE.ink, strokeWidth: 2,
    fillOpacity: 1, strokeOpacity: 1, strokeDash: 'solid',
  };
}
