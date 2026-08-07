const SVG_NS = 'http://www.w3.org/2000/svg';
const ICONS = {
  'arrow-down': [['path', { d: 'M12 5v14' }], ['path', { d: 'm19 12-7 7-7-7' }]],
  'arrow-up': [['path', { d: 'm5 12 7-7 7 7' }], ['path', { d: 'M12 19V5' }]],
  'arrow-up-down': [['path', { d: 'm21 16-4 4-4-4' }], ['path', { d: 'M17 20V4' }], ['path', { d: 'm3 8 4-4 4 4' }], ['path', { d: 'M7 4v16' }]],
  'badge-check': [['path', { d: 'M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z' }], ['path', { d: 'm9 12 2 2 4-4' }]],
  'calendar-clock': [['path', { d: 'M21 7.5V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h3.5' }], ['path', { d: 'M16 2v4' }], ['path', { d: 'M8 2v4' }], ['path', { d: 'M3 10h5' }], ['path', { d: 'M17.5 17.5 16 16.3V14' }], ['circle', { cx: '16', cy: '16', r: '6' }]],
  'calendar-days': [['path', { d: 'M8 2v4' }], ['path', { d: 'M16 2v4' }], ['rect', { width: '18', height: '18', x: '3', y: '4', rx: '2' }], ['path', { d: 'M3 10h18' }], ['path', { d: 'M8 14h.01' }], ['path', { d: 'M12 14h.01' }], ['path', { d: 'M16 14h.01' }], ['path', { d: 'M8 18h.01' }], ['path', { d: 'M12 18h.01' }], ['path', { d: 'M16 18h.01' }]],
  'clock-3': [['circle', { cx: '12', cy: '12', r: '10' }], ['polyline', { points: '12 6 12 12 16.5 12' }]],
  cloud: [['path', { d: 'M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z' }]],
  coins: [['circle', { cx: '8', cy: '8', r: '6' }], ['path', { d: 'M18.09 10.37A6 6 0 1 1 10.34 18' }], ['path', { d: 'M7 6h1v4' }], ['path', { d: 'm16.71 13.88.7.71-2.82 2.82' }]],
  database: [['ellipse', { cx: '12', cy: '5', rx: '9', ry: '3' }], ['path', { d: 'M3 5V19A9 3 0 0 0 21 19V5' }], ['path', { d: 'M3 12A9 3 0 0 0 21 12' }]],
  'globe-2': [['path', { d: 'M21.54 15H17a2 2 0 0 0-2 2v4.54' }], ['path', { d: 'M7 3.34V5a3 3 0 0 0 3 3a2 2 0 0 1 2 2c0 1.1.9 2 2 2a2 2 0 0 0 2-2c0-1.1.9-2 2-2h3.17' }], ['path', { d: 'M11 21.95V18a2 2 0 0 0-2-2a2 2 0 0 1-2-2v-1a2 2 0 0 0-2-2H2.05' }], ['circle', { cx: '12', cy: '12', r: '10' }]],
  landmark: [['line', { x1: '3', x2: '21', y1: '22', y2: '22' }], ['line', { x1: '6', x2: '6', y1: '18', y2: '11' }], ['line', { x1: '10', x2: '10', y1: '18', y2: '11' }], ['line', { x1: '14', x2: '14', y1: '18', y2: '11' }], ['line', { x1: '18', x2: '18', y1: '18', y2: '11' }], ['polygon', { points: '12 2 20 7 4 7' }]],
  search: [['circle', { cx: '11', cy: '11', r: '8' }], ['path', { d: 'm21 21-4.3-4.3' }]],
  x: [['path', { d: 'M18 6 6 18' }], ['path', { d: 'm6 6 12 12' }]]
};

function setAttributes(element, attributes) {
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
}

export function createIcons({ attrs = {} } = {}) {
  for (const placeholder of document.querySelectorAll('i[data-lucide]')) {
    const iconName = placeholder.dataset.lucide;
    const icon = ICONS[iconName];
    if (!icon) continue;
    const svg = document.createElementNS(SVG_NS, 'svg');
    setAttributes(svg, {
      xmlns: SVG_NS,
      width: '24',
      height: '24',
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': '2',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      ...attrs
    });
    for (const attribute of placeholder.attributes) {
      if (attribute.name !== 'data-lucide' && attribute.name !== 'class') {
        svg.setAttribute(attribute.name, attribute.value);
      }
    }
    svg.setAttribute('class', ['lucide', `lucide-${iconName}`, placeholder.className].filter(Boolean).join(' '));
    svg.setAttribute('aria-hidden', placeholder.getAttribute('aria-hidden') ?? 'true');
    for (const [tagName, attributes] of icon) {
      const child = document.createElementNS(SVG_NS, tagName);
      setAttributes(child, attributes);
      svg.append(child);
    }
    placeholder.replaceWith(svg);
  }
}
