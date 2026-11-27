export function bufferAhead(ranges, time) {
  for (let i = 0; i < ranges.length; i++) {
    if (time >= ranges.start(i) - 0.05 && time <= ranges.end(i)) return Math.max(0, ranges.end(i) - time);
  }
  return 0;
}
export function bufferAction({ ahead, target, maxLag, playing, drift }) {
  if (ahead > maxLag) return { action: 'reset', rate: 1 };
  if (!playing) return { action: ahead >= target ? 'play' : 'wait', rate: 1 };
  if (ahead < 0.08) return { action: 'pause', rate: 1 };
  return { action: 'continue', rate: drift ? (ahead > target + 0.25 ? 1.02 : ahead < target - 0.25 ? 0.98 : 1) : 1 };
}
// Both CSS letterboxing and encoder padding use the source aspect ratio.
export function pointerPosition(rect, screen, x, y) {
  const scale = Math.min(rect.width / screen.width, rect.height / screen.height);
  const width = screen.width * scale, height = screen.height * scale;
  const left = rect.left + (rect.width - width) / 2, top = rect.top + (rect.height - height) / 2;
  if (x < left || x > left + width || y < top || y > top + height) return null;
  return { x: (x - left) / width, y: (y - top) / height };
}
