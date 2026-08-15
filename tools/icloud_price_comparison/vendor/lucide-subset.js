const SVG_NS = 'http://www.w3.org/2000/svg';
/* Lucide 1.30.0 icon subset - ISC license; see ../THIRD_PARTY_NOTICES.md. */

const ICONS = {
  "arrow-down": [["path",{"d":"M12 5v14"}],["path",{"d":"m19 12-7 7-7-7"}]],
  "arrow-up": [["path",{"d":"m5 12 7-7 7 7"}],["path",{"d":"M12 19V5"}]],
  "arrow-up-down": [["path",{"d":"m21 16-4 4-4-4"}],["path",{"d":"M17 20V4"}],["path",{"d":"m3 8 4-4 4 4"}],["path",{"d":"M7 4v16"}]],
  "badge-check": [["path",{"d":"M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"}],["path",{"d":"m9 12 2 2 4-4"}]],
  "calendar-clock": [["path",{"d":"M16 14v2.2l1.6 1"}],["path",{"d":"M16 2v3"}],["path",{"d":"M21 7.338V5a2 2 0 00-2-2H5a2 2 0 00-2 2v14a2 2 0 002 2h2.338"}],["path",{"d":"M3 9h5.859"}],["path",{"d":"M8 2v3"}],["circle",{"cx":"16","cy":"16","r":"6"}]],
  "calendar-days": [["path",{"d":"M8 2v3"}],["path",{"d":"M16 2v3"}],["rect",{"x":"3","y":"3","width":"18","height":"18","rx":"2"}],["path",{"d":"M3 9h18"}],["path",{"d":"M8 13h.01"}],["path",{"d":"M12 13h.01"}],["path",{"d":"M16 13h.01"}],["path",{"d":"M8 17h.01"}],["path",{"d":"M12 17h.01"}],["path",{"d":"M16 17h.01"}]],
  "clock-3": [["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"M12 6v6h4"}]],
  "cloud": [["path",{"d":"M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"}]],
  "coins": [["path",{"d":"M13.744 17.736a6 6 0 1 1-7.48-7.48"}],["path",{"d":"M15 6h1v4"}],["path",{"d":"m6.134 14.768.866-.5 2 3.464"}],["circle",{"cx":"16","cy":"8","r":"6"}]],
  "database": [["ellipse",{"cx":"12","cy":"5","rx":"9","ry":"3"}],["path",{"d":"M3 5V19A9 3 0 0 0 21 19V5"}],["path",{"d":"M3 12A9 3 0 0 0 21 12"}]],
  "globe-2": [["path",{"d":"M21.54 15H17a2 2 0 0 0-2 2v4.54"}],["path",{"d":"M7 3.34V5a3 3 0 0 0 3 3a2 2 0 0 1 2 2c0 1.1.9 2 2 2a2 2 0 0 0 2-2c0-1.1.9-2 2-2h3.17"}],["path",{"d":"M11 21.95V18a2 2 0 0 0-2-2a2 2 0 0 1-2-2v-1a2 2 0 0 0-2-2H2.05"}],["circle",{"cx":"12","cy":"12","r":"10"}]],
  "search": [["path",{"d":"m21 21-4.34-4.34"}],["circle",{"cx":"11","cy":"11","r":"8"}]],
  "x": [["path",{"d":"M18 6 6 18"}],["path",{"d":"m6 6 12 12"}]]
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
