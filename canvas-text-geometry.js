// The last text is the original. A shadow can add an earlier, transformed copy.
function sourceText(group) {
  const texts = group.querySelectorAll('text');
  return texts[texts.length - 1];
}

let metricsContext;
function fontMetrics(text, item) {
  metricsContext ??= document.createElement('canvas').getContext('2d');
  const style = getComputedStyle(text);
  metricsContext.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  const metrics = metricsContext.measureText('Mg');
  return {
    ascent: metrics.fontBoundingBoxAscent ?? item.fontSize * 0.8,
    descent: metrics.fontBoundingBoxDescent ?? item.fontSize * 0.2,
  };
}

// The textarea uses the SVG font, alignment and 1.2em line-height with no
// padding, border or soft wrapping. All returned coordinates are item-local.
export function textEditorBounds(group, item) {
  const text = sourceText(group), box = text.getBBox();
  const lineHeight = item.fontSize * 1.2;
  const {ascent, descent} = fontMetrics(text, item);
  const y = item.fontSize - ascent - (lineHeight - ascent - descent) / 2;
  // Widen about the same alignment anchor, including a little room for the
  // caret on lines which extend outside the nominal PowerPoint text box.
  const width = Math.max(item.width, Math.ceil(box.width) + 2);
  const x = item.align === 'center' ? (item.width - width) / 2 : item.align === 'right' ? item.width - width : 0;
  const height = Math.max(item.height - y, text.children.length * lineHeight + 2, box.y + box.height - y + 2);
  return {x, y, width, height};
}

let segmenter;
function graphemeAt(line, index) {
  if (typeof Intl.Segmenter === 'function') {
    segmenter ??= new Intl.Segmenter(undefined, {granularity: 'grapheme'});
    const boundary = segmenter.segment(line).containing(index);
    return [boundary.index, boundary.index + boundary.segment.length];
  }
  const start = index > 0 && /[\uDC00-\uDFFF]/.test(line[index]) ? index - 1 : index;
  return [start, start + (line.codePointAt(start) > 0xffff ? 2 : 1)];
}

export function textPointerPosition(group, item, clientX, clientY) {
  const text = sourceText(group);
  const point = new DOMPoint(clientX, clientY).matrixTransform(text.getScreenCTM().inverse());
  const lines = item.text.split('\n'), lineHeight = item.fontSize * 1.2;
  const {ascent, descent} = fontMetrics(text, item);
  const firstCenter = item.fontSize - (ascent - descent) / 2;
  const row = Math.max(0, Math.min(lines.length - 1, Math.round((point.y - firstCenter) / lineHeight)));
  const span = text.children[row], line = lines[row];
  let lineStart = 0;
  for (let i = 0; i < row; i++) lineStart += lines[i].length + 1;
  if (!line) return {offset: lineStart, onText: false};

  const box = span.getBBox();
  const withinLine = point.y >= box.y && point.y <= box.y + box.height;
  // Project onto the baseline so clicks in the margin above/below the line
  // still put the caret at the requested column.
  const baseline = span.getStartPositionOfChar(0).y;
  const index = span.getCharNumAtPosition(new DOMPoint(point.x, baseline - item.fontSize * 0.1));
  if (index < 0) {
    const startX = span.getStartPositionOfChar(0).x;
    const endX = span.getEndPositionOfChar(span.getNumberOfChars() - 1).x;
    const end = Math.abs(point.x - endX) < Math.abs(point.x - startX);
    return {offset: lineStart + (end ? line.length : 0), onText: false};
  }
  const [start, end] = graphemeAt(line, index);
  const firstX = span.getStartPositionOfChar(start).x, lastX = span.getEndPositionOfChar(end - 1).x;
  const closerToEnd = Math.abs(point.x - lastX) < Math.abs(point.x - firstX);
  return {offset: lineStart + (closerToEnd ? end : start), onText: withinLine};
}
