const GRID_SIZE = 40;
const SAMPLE_SIZE = 8;

export function meshPath(width, height) {
  const centerX = width / 2;
  const radiusX = Math.min(width * 0.42, 600);
  const horizon = height * 0.16;
  const amplitude = Math.min(height * 0.28, 84);
  const bump = (distance, radius) => {
    if (Math.abs(distance) >= radius) return 0;
    return (1 + Math.cos(Math.PI * distance / radius)) / 2;
  };
  const point = (x, y) => {
    const depth = y / height;
    const perspective = 0.90 + 0.10 * depth;
    const ripple = 0.72 + 0.28 * Math.cos((x - centerX) / Math.max(46, width / 18) + depth * 6);
    const influence = bump(x - centerX, radiusX) * Math.sin(Math.PI * depth) ** 2 * ripple;
    const projectedX = centerX + (x - centerX) * perspective;
    const projectedY = horizon + (height - horizon) * depth - amplitude * influence;
    return `${projectedX.toFixed(2)},${projectedY.toFixed(2)}`;
  };
  const path = [];

  for (let y = GRID_SIZE; y < height; y += GRID_SIZE) {
    let line = `M${point(0, y)}`;
    for (let x = SAMPLE_SIZE; x < width; x += SAMPLE_SIZE) line += ` L${point(x, y)}`;
    path.push(`${line} L${point(width, y)}`);
  }
  for (let x = 0; x < width; x += GRID_SIZE) {
    let line = `M${point(x, 0)}`;
    for (let y = SAMPLE_SIZE; y < height; y += SAMPLE_SIZE) line += ` L${point(x, y)}`;
    path.push(`${line} L${point(x, height)}`);
  }
  return path.join(' ');
}

export function setupMesh(svg) {
  const line = svg.querySelector('.mesh-lines');
  let scheduled = false;
  const update = () => {
    scheduled = false;
    const { width, height } = svg.getBoundingClientRect();
    if (!width || !height) return;
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    line.setAttribute('d', meshPath(width, height));
  };
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(update);
  };
  window.addEventListener('resize', schedule);
  if ('ResizeObserver' in window) {
    const observer = new ResizeObserver(schedule);
    observer.observe(svg);
  }
  update();
}
