// Unofficial Figma MCP — Figma plugin main thread.
// Owns the `figma` global. Receives commands from ui.html (which holds the
// WebSocket, since the main thread has no network access) and posts results back.

// The UI iframe must exist (it owns the WebSocket) but does not need to be
// visible. Hidden by default so the plugin runs without a floating window;
// the `show_ui` bridge command brings it back for debugging.
figma.showUI(__html__, { width: 320, height: 260, themeColors: true, visible: false });

// ---------------------------------------------------------------- serializing

// Figma nodes are live proxies with cyclic parent/child references and getters
// that throw on some node types. Anything crossing postMessage must be flattened
// to plain JSON first.
function safeValue(v, depth) {
  if (v === null || v === undefined) return v;
  const t = typeof v;
  if (t === 'string' || t === 'number' || t === 'boolean') return v;
  if (t === 'function') return '[function]';
  if (t === 'symbol') return String(v);
  if (v === figma.mixed) return 'MIXED';
  if (depth > 8) return '[max depth]';

  if (Array.isArray(v)) return v.map((x) => safeValue(x, depth + 1));

  // A node proxy: identify it rather than walking the whole tree.
  if (v.id && v.type && typeof v.id === 'string') {
    const out = { id: v.id, name: v.name, type: v.type };
    if (typeof v.width === 'number') {
      out.x = Math.round(v.x);
      out.y = Math.round(v.y);
      out.width = Math.round(v.width);
      out.height = Math.round(v.height);
    }
    return out;
  }

  const out = {};
  for (const k in v) {
    try {
      out[k] = safeValue(v[k], depth + 1);
    } catch (e) {
      out[k] = '[unreadable: ' + e.message + ']';
    }
  }
  return out;
}

// -------------------------------------------------------------------- helpers

// Injected into every exec script so common tasks don't need boilerplate.
function buildHelpers() {
  return {
    // Hex string -> Figma RGB (0..1).
    color(hex) {
      const c = parseHex(hex);
      return { r: c.r, g: c.g, b: c.b };
    },
    // Load every font used by a text node before mutating it.
    async loadFontsFor(node) {
      const segs = node.getStyledTextSegments(['fontName']);
      const seen = {};
      for (const s of segs) {
        const key = s.fontName.family + '|' + s.fontName.style;
        if (!seen[key]) {
          seen[key] = true;
          await figma.loadFontAsync(s.fontName);
        }
      }
    },
    // Depth-limited structural dump — the metadata tool builds on this.
    outline(node, maxDepth) {
      const walk = (n, d) => {
        const o = { id: n.id, name: n.name, type: n.type };
        if (typeof n.width === 'number') {
          o.x = Math.round(n.x);
          o.y = Math.round(n.y);
          o.w = Math.round(n.width);
          o.h = Math.round(n.height);
        }
        if (n.type === 'TEXT') o.characters = n.characters;
        if (n.children && d < maxDepth) o.children = n.children.map((c) => walk(c, d + 1));
        else if (n.children) o.childCount = n.children.length;
        return o;
      };
      return walk(node, 0);
    },
  };
}

// ------------------------------------------------------------------ progress

// Figma only repaints the canvas when the plugin yields to the event loop, so a
// script that creates fifty nodes synchronously shows up all at once. Yielding
// between nodes lets the user watch the design being assembled.
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Progress events reset the bridge timeout and are forwarded to the MCP client,
// so long builds neither time out nor look frozen.
function reportProgress(id, done, total, message) {
  figma.ui.postMessage({ type: 'progress', id, done, total, message });
}

// ------------------------------------------------------------------ execution

async function exec(code, requestId) {
  const helpers = buildHelpers();
  let steps = 0;
  // `await step(node)` inside a script: repaint, optionally bring the node into
  // view, and report progress.
  const step = async (node, delay) => {
    steps++;
    reportProgress(requestId, steps, undefined, node && node.name ? node.name : undefined);
    if (node && typeof node.width === 'number' && node.parent && node.parent.type === 'PAGE') {
      figma.viewport.scrollAndZoomIntoView([node]);
    }
    await wait(delay === undefined ? 40 : delay);
  };
  // Same contract as Figma's own use_figma: plain JS body, top-level await and
  // return both work because the body is wrapped in an async function.
  const fn = new Function(
    'figma',
    'helpers',
    'color',
    'loadFontsFor',
    'outline',
    'step',
    '"use strict"; return (async () => {\n' + code + '\n})();'
  );
  const result = await fn(figma, helpers, helpers.color, helpers.loadFontsFor, helpers.outline, step);
  return safeValue(result, 0);
}

// Hidden children of instances are the bulk of most large files and are rarely
// what a caller wants from an outline. Skipping them makes traversal far faster.
function fastWalk(fn) {
  const prev = figma.skipInvisibleInstanceChildren;
  figma.skipInvisibleInstanceChildren = true;
  try {
    return fn();
  } finally {
    figma.skipInvisibleInstanceChildren = prev;
  }
}

async function resolveNode(nodeId) {
  const id = String(nodeId).replace('-', ':');
  const node = await figma.getNodeByIdAsync(id);
  if (!node) throw new Error('Node not found: ' + id);
  return node;
}

async function screenshot(nodeId, scale, maxSize) {
  const node = nodeId ? await resolveNode(nodeId) : figma.currentPage.selection[0];
  if (!node) throw new Error('No nodeId given and nothing selected');
  if (typeof node.exportAsync !== 'function') throw new Error(node.type + ' cannot be exported');

  // Cap the longest edge: oversized PNGs are slow to export, slow to transfer,
  // and get downscaled by the model anyway.
  const longest = Math.max(node.width || 1, node.height || 1);
  const effective = Math.min(scale || 1, (maxSize || 1600) / longest);

  const bytes = await node.exportAsync({
    format: 'PNG',
    constraint: { type: 'SCALE', value: effective },
  });
  return {
    base64: figma.base64Encode(bytes),
    meta: {
      id: node.id,
      name: node.name,
      width: Math.round(node.width),
      height: Math.round(node.height),
      scale: Math.round(effective * 1000) / 1000,
    },
  };
}

// ---------------------------------------------------------------------- build

// Declarative builder behind figma_build. The caller describes a tree of nodes
// as JSON; we load every font up front in parallel, then create nodes one at a
// time, yielding between them so the canvas repaints and the user watches the
// design appear. JSON is also much shorter for a model to write than Plugin API
// code, and the common pitfalls (font loading, sizing order, 0-1 colors) are
// handled here instead of in every script.

function parseHex(hex) {
  let h = String(hex).trim().replace('#', '');
  if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(h)) throw new Error('Bad color: ' + hex);
  const n = (i) => parseInt(h.slice(i, i + 2), 16) / 255;
  return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) : 1 };
}

function solid(hex) {
  const c = parseHex(hex);
  return { type: 'SOLID', color: { r: c.r, g: c.g, b: c.b }, opacity: c.a };
}

// CSS-style angle: 180 = top to bottom, 90 = left to right.
function linearGradient(stops, angle) {
  const a = ((angle === undefined ? 180 : angle) * Math.PI) / 180;
  const round = (v) => Math.round(v * 1e6) / 1e6;
  const dx = round(Math.sin(a));
  const dy = round(-Math.cos(a));
  return {
    type: 'GRADIENT_LINEAR',
    gradientTransform: [
      [dx, dy, 0.5 - 0.5 * dx - 0.5 * dy],
      [-dy, dx, 0.5 + 0.5 * dy - 0.5 * dx],
    ],
    gradientStops: stops.map((s, i) => {
      const hex = typeof s === 'string' ? s : s.color;
      const c = parseHex(hex);
      const position = typeof s === 'string' ? i / Math.max(1, stops.length - 1) : s.position;
      return { position, color: { r: c.r, g: c.g, b: c.b, a: c.a } };
    }),
  };
}

// '#hex' | { gradient: [...], angle } | raw Paint | an array of any of these.
function toPaints(v) {
  if (v === null || v === 'none' || v === false) return [];
  const one = (p) => {
    if (typeof p === 'string') return solid(p);
    if (p.gradient) return linearGradient(p.gradient, p.angle);
    if (p.type === 'SOLID' && typeof p.color === 'string') {
      const s = solid(p.color);
      if (p.opacity !== undefined) s.opacity = p.opacity;
      return s;
    }
    return p;
  };
  return Array.isArray(v) ? v.map(one) : [one(v)];
}

function toEffects(spec) {
  const effects = [];
  const shadows = spec.shadow ? (Array.isArray(spec.shadow) ? spec.shadow : [spec.shadow]) : [];
  for (const s of shadows) {
    const c = parseHex(s.color || '#00000026');
    effects.push({
      type: s.inner ? 'INNER_SHADOW' : 'DROP_SHADOW',
      color: { r: c.r, g: c.g, b: c.b, a: c.a },
      offset: { x: s.x || 0, y: s.y === undefined ? 4 : s.y },
      radius: s.blur === undefined ? 12 : s.blur,
      spread: s.spread || 0,
      visible: true,
      blendMode: 'NORMAL',
    });
  }
  if (spec.blur) effects.push({ type: 'LAYER_BLUR', radius: spec.blur, visible: true });
  if (spec.backgroundBlur) effects.push({ type: 'BACKGROUND_BLUR', radius: spec.backgroundBlur, visible: true });
  return effects;
}

// ---------------------------------------------------------------------- images

// The bridge server loads image files and URLs (the sandbox cannot) and sends
// PNG/JPEG/GIF bytes as base64.
const SCALE_MODES = { fill: 'FILL', fit: 'FIT', crop: 'CROP', tile: 'TILE' };

async function createImageFromBase64(base64) {
  const image = figma.createImage(figma.base64Decode(base64));
  const size = await image.getSizeAsync();
  return { image, size };
}

function imagePaint(image, scaleMode) {
  const key = String(scaleMode || 'fill').toLowerCase();
  if (!SCALE_MODES[key]) throw new Error('Bad scale mode: ' + scaleMode + ' (use fill, fit, crop or tile)');
  return { type: 'IMAGE', imageHash: image.hash, scaleMode: SCALE_MODES[key] };
}

// CROP with no transform stretches the image to the box. Start it centred and
// covering, like FILL, so the user gets an undistorted crop to adjust.
function coverCrop(paint, size, box) {
  if (paint.scaleMode !== 'CROP') return paint;
  const imageRatio = size.width / size.height;
  const boxRatio = box.width / box.height;
  const sx = imageRatio > boxRatio ? boxRatio / imageRatio : 1;
  const sy = imageRatio > boxRatio ? 1 : imageRatio / boxRatio;
  return Object.assign({}, paint, {
    imageTransform: [
      [sx, 0, (1 - sx) / 2],
      [0, sy, (1 - sy) / 2],
    ],
  });
}

// Scale vectors uniformly to fit a requested width and/or height; resize()
// alone would change the frame box and crop the artwork instead.
function rescaleToFit(node, width, height) {
  if (typeof width !== 'number' && typeof height !== 'number') return;
  const natural = { width: node.width, height: node.height };
  const target = fitSize(natural, width, height);
  node.rescale(Math.min(target.width / natural.width, target.height / natural.height));
}

// Natural size, or the missing edge derived from the aspect ratio.
function fitSize(size, width, height) {
  const w = typeof width === 'number' ? width : undefined;
  const h = typeof height === 'number' ? height : undefined;
  if (w !== undefined && h !== undefined) return { width: w, height: h };
  if (w !== undefined) return { width: w, height: Math.round((w * size.height) / size.width) };
  if (h !== undefined) return { width: Math.round((h * size.width) / size.height), height: h };
  return { width: size.width, height: size.height };
}

async function placeImage(p) {
  const focus = p.focus !== false;
  let node;
  let natural;
  let hash;

  if (p.svg) {
    if (p.nodeId) throw new Error('An SVG cannot be an image fill; omit nodeId to place it as vectors');
    node = figma.createNodeFromSvg(p.svg);
    natural = { width: node.width, height: node.height };
    rescaleToFit(node, p.width, p.height);
  } else {
    const { image, size } = await createImageFromBase64(p.base64);
    natural = size;
    hash = image.hash;
    const paint = imagePaint(image, p.scaleMode);
    if (p.nodeId) {
      node = await resolveNode(p.nodeId);
      if (!('fills' in node)) throw new Error(node.type + ' cannot take an image fill');
      if ((typeof p.width === 'number' || typeof p.height === 'number') && 'resize' in node) {
        const target = fitSize({ width: node.width, height: node.height }, p.width, p.height);
        node.resize(target.width, target.height);
      }
    } else {
      node = figma.createRectangle();
      const target = fitSize(size, p.width, p.height);
      node.resize(Math.max(0.01, target.width), Math.max(0.01, target.height));
    }
    node.fills = [coverCrop(paint, size, node)];
  }

  if (p.name) node.name = p.name;

  if (!p.nodeId) {
    const parent = p.parentId ? await resolveNode(p.parentId) : figma.currentPage;
    if (!('appendChild' in parent)) throw new Error(parent.type + ' cannot have children');
    const spot = parent.type === 'PAGE' && p.x === undefined && p.y === undefined ? nextFreeX(parent, 120) : null;
    parent.appendChild(node);
    if (spot) {
      node.x = spot.x;
      node.y = spot.y;
    } else {
      if (p.x !== undefined) node.x = p.x;
      if (p.y !== undefined) node.y = p.y;
    }
  }

  if (focus) {
    figma.viewport.scrollAndZoomIntoView([node]);
    try {
      figma.currentPage.selection = [node];
    } catch (e) {
      // node lives on another page; leave the selection alone
    }
  }

  const out = safeValue(node, 0);
  if (hash) out.imageHash = hash;
  out.naturalWidth = Math.round(natural.width);
  out.naturalHeight = Math.round(natural.height);
  return out;
}

const WEIGHT_STYLES = {
  100: 'Thin', 200: 'Extra Light', 300: 'Light', 400: 'Regular', 500: 'Medium',
  600: 'Semi Bold', 700: 'Bold', 800: 'Extra Bold', 900: 'Black',
};

function requestedFont(spec) {
  const family = spec.fontFamily || 'Inter';
  let style = spec.fontStyle;
  if (!style) style = WEIGHT_STYLES[spec.fontWeight] || 'Regular';
  if (spec.italic && !/italic/i.test(style)) style = style === 'Regular' ? 'Italic' : style + ' Italic';
  return { family, style };
}

// Foundries disagree on "Semi Bold" vs "SemiBold" vs "Semibold"; try the
// spellings before giving up and falling back to Inter.
async function loadFontWithFallback(font, warnings) {
  const compact = font.style.replace(/\s+/g, '');
  const variants = [font.style, compact, compact.replace(/Bold/, 'bold'), font.style.replace(/([a-z])([A-Z])/g, '$1 $2')];
  for (const style of [...new Set(variants)]) {
    try {
      await figma.loadFontAsync({ family: font.family, style });
      return { family: font.family, style };
    } catch (e) {
      // try the next spelling
    }
  }
  const fallback = { family: 'Inter', style: 'Regular' };
  await figma.loadFontAsync(fallback);
  warnings.push(`Font ${font.family} ${font.style} unavailable, used Inter Regular`);
  return fallback;
}

async function preloadFonts(specs, warnings) {
  const wanted = new Map();
  const walk = (s) => {
    if (!s) return;
    if ((s.type || 'FRAME').toUpperCase() === 'TEXT') {
      const f = requestedFont(s);
      wanted.set(f.family + '|' + f.style, f);
    }
    (s.children || []).forEach(walk);
  };
  specs.forEach(walk);
  const resolved = new Map();
  await Promise.all(
    [...wanted].map(async ([key, font]) => resolved.set(key, await loadFontWithFallback(font, warnings)))
  );
  return resolved;
}

function countNodes(specs) {
  let n = 0;
  const walk = (s) => {
    n++;
    (s.children || []).forEach(walk);
  };
  specs.forEach(walk);
  return n;
}

function applySize(node, spec, parentIsAutoLayout) {
  const w = spec.width;
  const h = spec.height;
  if (typeof w === 'number' || typeof h === 'number') {
    if (node.type === 'TEXT') {
      if (typeof w === 'number') {
        node.textAutoResize = typeof h === 'number' ? 'NONE' : 'HEIGHT';
        node.resize(w, typeof h === 'number' ? h : node.height);
      }
    } else if (node.type === 'LINE') {
      node.resize(typeof w === 'number' ? w : node.width, 0);
    } else {
      node.resize(typeof w === 'number' ? Math.max(0.01, w) : node.width, typeof h === 'number' ? Math.max(0.01, h) : node.height);
    }
  }
  const mode = (v) => (v === 'fill' ? 'FILL' : v === 'hug' ? 'HUG' : typeof v === 'number' ? 'FIXED' : null);
  const hMode = mode(w);
  const vMode = mode(h);
  const canHug = node.type === 'TEXT' || ('layoutMode' in node && node.layoutMode !== 'NONE');
  if (node.type === 'TEXT' && hMode === 'FILL') node.textAutoResize = 'HEIGHT';
  if ('layoutSizingHorizontal' in node) {
    if (hMode === 'FILL' && parentIsAutoLayout) node.layoutSizingHorizontal = 'FILL';
    else if (hMode === 'HUG' && canHug) node.layoutSizingHorizontal = 'HUG';
    else if (hMode === 'FIXED' && (parentIsAutoLayout || canHug)) node.layoutSizingHorizontal = 'FIXED';
    if (vMode === 'FILL' && parentIsAutoLayout) node.layoutSizingVertical = 'FILL';
    else if (vMode === 'HUG' && canHug) node.layoutSizingVertical = 'HUG';
    else if (vMode === 'FIXED' && (parentIsAutoLayout || canHug)) node.layoutSizingVertical = 'FIXED';
  }
}

const ALIGN = { start: 'MIN', center: 'CENTER', end: 'MAX', between: 'SPACE_BETWEEN', baseline: 'BASELINE' };
const align = (v) => ALIGN[v] || String(v).toUpperCase();

function applyLayout(node, spec) {
  if (!spec.layout || !('layoutMode' in node)) return;
  const mode = String(spec.layout).toUpperCase();
  node.layoutMode = mode === 'ROW' ? 'HORIZONTAL' : mode === 'COLUMN' ? 'VERTICAL' : mode;
  if (node.layoutMode === 'NONE') return;
  // Hug unless the axis has a numeric size; applySize handles FILL after append.
  const horizontal = node.layoutMode === 'HORIZONTAL';
  const primary = horizontal ? spec.width : spec.height;
  const counter = horizontal ? spec.height : spec.width;
  node.primaryAxisSizingMode = typeof primary === 'number' ? 'FIXED' : 'AUTO';
  node.counterAxisSizingMode = typeof counter === 'number' ? 'FIXED' : 'AUTO';
  if (spec.gap !== undefined) {
    if (spec.gap === 'auto') node.primaryAxisAlignItems = 'SPACE_BETWEEN';
    else node.itemSpacing = spec.gap;
  }
  if (spec.padding !== undefined) {
    const p = Array.isArray(spec.padding) ? spec.padding : [spec.padding];
    const [t, r = t, b = t, l = r] = p;
    node.paddingTop = t;
    node.paddingRight = r;
    node.paddingBottom = b;
    node.paddingLeft = l;
  }
  if (spec.align) node.primaryAxisAlignItems = align(spec.align);
  if (spec.crossAlign) node.counterAxisAlignItems = align(spec.crossAlign);
  if (spec.wrap) {
    node.layoutWrap = 'WRAP';
    if (spec.wrapGap !== undefined) node.counterAxisSpacing = spec.wrapGap;
  }
}

async function createNode(spec) {
  const type = (spec.type || 'FRAME').toUpperCase();
  switch (type) {
    case 'FRAME':
      return figma.createFrame();
    case 'COMPONENT':
      return figma.createComponent();
    case 'TEXT':
      return figma.createText();
    case 'RECTANGLE':
    case 'RECT':
    case 'IMAGE':
      return figma.createRectangle();
    case 'ELLIPSE':
      return figma.createEllipse();
    case 'LINE':
      return figma.createLine();
    case 'POLYGON':
      return figma.createPolygon();
    case 'STAR':
      return figma.createStar();
    case 'SVG':
      if (!spec.svg) throw new Error('SVG node needs an `svg` string');
      return figma.createNodeFromSvg(spec.svg);
    case 'INSTANCE': {
      let component;
      if (spec.componentKey) component = await figma.importComponentByKeyAsync(spec.componentKey);
      else if (spec.componentId) component = await resolveNode(spec.componentId);
      else throw new Error('INSTANCE needs componentId or componentKey');
      if (component.type === 'COMPONENT_SET') component = component.defaultVariant;
      if (component.type !== 'COMPONENT') throw new Error(spec.componentId + ' is not a component');
      return component.createInstance();
    }
    default:
      throw new Error('Unsupported node type: ' + type);
  }
}

function applyText(node, spec, fonts) {
  const f = requestedFont(spec);
  node.fontName = fonts.get(f.family + '|' + f.style);
  if (spec.fontSize) node.fontSize = spec.fontSize;
  node.characters = String(spec.text === undefined ? '' : spec.text);
  const unit = (v) =>
    typeof v === 'string' && v.endsWith('%')
      ? { value: parseFloat(v), unit: 'PERCENT' }
      : { value: Number(v), unit: 'PIXELS' };
  if (spec.lineHeight !== undefined) node.lineHeight = spec.lineHeight === 'auto' ? { unit: 'AUTO' } : unit(spec.lineHeight);
  if (spec.letterSpacing !== undefined) node.letterSpacing = unit(spec.letterSpacing);
  if (spec.textAlign) node.textAlignHorizontal = String(spec.textAlign).toUpperCase();
  if (spec.verticalAlign) node.textAlignVertical = String(spec.verticalAlign).toUpperCase();
  if (spec.textCase) node.textCase = String(spec.textCase).toUpperCase();
  if (spec.textDecoration) node.textDecoration = String(spec.textDecoration).toUpperCase();
  if (spec.color !== undefined) node.fills = toPaints(spec.color);
}

function applyStyle(node, spec, isRoot) {
  if (spec.name) node.name = spec.name;
  const isContainer = node.type === 'FRAME' || node.type === 'COMPONENT';
  if (spec.fill !== undefined) node.fills = toPaints(spec.fill);
  // New frames come with a white fill; nested containers read better transparent.
  else if (isContainer && !isRoot) node.fills = [];
  if (spec.stroke !== undefined) {
    node.strokes = toPaints(spec.stroke);
    if (spec.strokeWidth !== undefined) node.strokeWeight = spec.strokeWidth;
    if (spec.strokeAlign) node.strokeAlign = String(spec.strokeAlign).toUpperCase();
    if (spec.dash) node.dashPattern = spec.dash;
  }
  if (spec.radius !== undefined && 'cornerRadius' in node) {
    if (Array.isArray(spec.radius)) {
      const [tl, tr = tl, br = tl, bl = tr] = spec.radius;
      node.topLeftRadius = tl;
      node.topRightRadius = tr;
      node.bottomRightRadius = br;
      node.bottomLeftRadius = bl;
    } else node.cornerRadius = spec.radius;
  }
  if (spec.opacity !== undefined) node.opacity = spec.opacity;
  if (spec.visible === false) node.visible = false;
  if (spec.clip !== undefined && 'clipsContent' in node) node.clipsContent = !!spec.clip;
  if (spec.shadow || spec.blur || spec.backgroundBlur) node.effects = toEffects(spec);
  if (spec.rotation) node.rotation = spec.rotation;
}

// Placement for a new top-level node: right of everything already on the page,
// so builds never land on top of existing work.
function nextFreeX(page, gap) {
  let right = null;
  let top = 0;
  for (const n of page.children) {
    if (typeof n.x !== 'number') continue;
    const r = n.x + n.width;
    if (right === null || r > right) {
      right = r;
      top = n.y;
    }
  }
  return right === null ? { x: 0, y: 0 } : { x: Math.round(right + gap), y: Math.round(top) };
}

function inViewport(node) {
  const b = figma.viewport.bounds;
  const t = node.absoluteTransform;
  const x = t[0][2];
  const y = t[1][2];
  return x >= b.x && y >= b.y && x + node.width <= b.x + b.width && y + node.height <= b.y + b.height;
}

async function build(p, requestId) {
  const specs = p.nodes || (p.node ? [p.node] : []);
  if (!specs.length) throw new Error('Pass `node` (one tree) or `nodes` (several trees)');
  const delay = p.stepDelay === undefined ? 30 : Math.max(0, Math.min(1000, p.stepDelay));
  const focus = p.focus !== false;
  const warnings = [];
  const total = countNodes(specs);

  const parent = p.parentId ? await resolveNode(p.parentId) : figma.currentPage;
  if (!('appendChild' in parent)) throw new Error(parent.type + ' cannot have children');

  reportProgress(requestId, 0, total, 'loading fonts');
  const fonts = await preloadFonts(specs, warnings);

  const created = [];
  const roots = [];
  let done = 0;
  let focusRoot = null;

  const buildOne = async (spec, into, path, depth) => {
    const text = spec.text === undefined ? '' : String(spec.text);
    const fallback = text ? JSON.stringify(text.length > 24 ? text.slice(0, 24) + '…' : text) : (spec.type || 'frame').toLowerCase();
    const label = path + (spec.name || fallback);
    let node;
    try {
      // An image with a missing edge takes its size from the picture itself.
      let paint = null;
      let imageSize = null;
      if (spec.imageData) {
        const { image, size } = await createImageFromBase64(spec.imageData);
        paint = imagePaint(image, spec.imageScale);
        imageSize = size;
        if (spec.width === undefined || spec.height === undefined) {
          const fit = fitSize(size, spec.width, spec.height);
          spec = {
            ...spec,
            width: spec.width === undefined ? fit.width : spec.width,
            height: spec.height === undefined ? fit.height : spec.height,
          };
        }
      }
      node = await createNode(spec);
      const isRoot = depth === 0;
      const parentIsAutoLayout = 'layoutMode' in into && into.layoutMode !== 'NONE';
      if (node.type === 'TEXT') applyText(node, spec, fonts);
      applyStyle(node, spec, isRoot);
      // The image sits on top of an explicit `fill`, and replaces the default white.
      if (paint) node.fills = spec.fill !== undefined ? [...node.fills, paint] : [paint];
      applyLayout(node, spec);

      if (spec.svg) rescaleToFit(node, spec.width, spec.height);
      // Size before appending so a fixed-size frame never flashes at 100x100.
      if (node.type !== 'TEXT' && node.type !== 'LINE' && (typeof spec.width === 'number' || typeof spec.height === 'number')) {
        node.resize(
          typeof spec.width === 'number' ? Math.max(0.01, spec.width) : node.width,
          typeof spec.height === 'number' ? Math.max(0.01, spec.height) : node.height
        );
      }
      const autoPlace = isRoot && into.type === 'PAGE' && spec.x === undefined && spec.y === undefined;
      const spot = autoPlace ? nextFreeX(into, 120) : null;

      if (spec.index !== undefined) into.insertChild(spec.index, node);
      else into.appendChild(node);

      if (spec.position === 'absolute' && parentIsAutoLayout) node.layoutPositioning = 'ABSOLUTE';
      const flowChild = parentIsAutoLayout && node.layoutPositioning !== 'ABSOLUTE';
      applySize(node, spec, flowChild);
      // A crop is framed against the final box, which a "fill" size only settles here.
      if (paint && paint.scaleMode === 'CROP') {
        node.fills = [...node.fills.slice(0, -1), coverCrop(paint, imageSize, node)];
      }

      if (spot) {
        node.x = spot.x;
        node.y = spot.y;
      } else if (!flowChild) {
        if (spec.x !== undefined) node.x = spec.x;
        if (spec.y !== undefined) node.y = spec.y;
      }

      if (spec.properties && node.type === 'INSTANCE') node.setProperties(spec.properties);
      // Escape hatch for anything the schema does not cover.
      if (spec.props) for (const k of Object.keys(spec.props)) node[k] = spec.props[k];
    } catch (e) {
      const where = roots.length ? ` (partial build root: ${roots[0].id})` : '';
      throw new Error(`${label}: ${e && e.message ? e.message : e}${where}`);
    }

    created.push(node);
    if (depth === 0) roots.push(node);
    done++;
    reportProgress(requestId, done, total, label);

    if (focus && depth === 0) {
      focusRoot = node;
      // A hugging frame starts tiny; centre on it rather than zooming to 3200%.
      if (node.width >= 80 && node.height >= 80) figma.viewport.scrollAndZoomIntoView([node]);
      else figma.viewport.center = { x: node.absoluteTransform[0][2], y: node.absoluteTransform[1][2] };
    }
    await wait(delay);

    for (const child of spec.children || []) {
      await buildOne(child, node, label + ' > ', depth + 1);
      // Keep the growing design in view as whole sections land.
      if (focus && depth === 0 && focusRoot && !inViewport(focusRoot)) {
        figma.viewport.scrollAndZoomIntoView([focusRoot]);
      }
    }
    return node;
  };

  for (const spec of specs) await buildOne(spec, parent, '', 0);

  if (focus && roots.length) {
    figma.viewport.scrollAndZoomIntoView(roots);
    try {
      figma.currentPage.selection = roots;
    } catch (e) {
      // roots live on another page; leave the selection alone
    }
  }

  const summary = (n) => ({ id: n.id, name: n.name, type: n.type });
  const result = {
    rootIds: roots.map((r) => r.id),
    count: created.length,
    nodes: created.slice(0, 300).map(summary),
  };
  if (created.length > 300) result.truncated = created.length - 300;
  if (warnings.length) result.warnings = warnings;
  return result;
}

// --------------------------------------------------------------- command loop

const commands = {
  async ping() {
    return { ok: true, file: figma.root.name, page: figma.currentPage.name };
  },

  async exec(p, id) {
    return exec(p.code, id);
  },

  async build(p, id) {
    return build(p, id);
  },

  async get_pages() {
    return figma.root.children.map((p) => ({
      id: p.id,
      name: p.name,
      isCurrent: p.id === figma.currentPage.id,
    }));
  },

  async get_metadata(p) {
    const node = p.nodeId ? await resolveNode(p.nodeId) : figma.currentPage;
    return fastWalk(() => buildHelpers().outline(node, p.depth === undefined ? 3 : p.depth));
  },

  async get_selection() {
    const sel = figma.currentPage.selection;
    if (!sel.length) return { count: 0, nodes: [] };
    const o = buildHelpers().outline;
    return { count: sel.length, nodes: sel.map((n) => o(n, 1)) };
  },

  async place_image(p) {
    return placeImage(p);
  },

  async screenshot(p) {
    return screenshot(p.nodeId, p.scale, p.maxSize);
  },

  async set_page(p) {
    const page = await resolveNode(p.pageId);
    if (page.type !== 'PAGE') throw new Error('Not a page: ' + p.pageId);
    await figma.setCurrentPageAsync(page);
    return { currentPage: page.name, id: page.id };
  },

  async show_ui() {
    figma.ui.show();
    return { visible: true };
  },

  async hide_ui() {
    figma.ui.hide();
    return { visible: false };
  },
};

figma.ui.onmessage = async (msg) => {
  if (msg.type === 'status') return; // UI-only chatter
  if (msg.type === 'ui_ready') {
    // Tell the bridge which file this plugin instance belongs to, so several
    // files can stay connected at the same time.
    figma.ui.postMessage({ type: 'whoami', file: figma.root.name });
    return;
  }

  const { id, command, params } = msg;
  const handler = commands[command];

  if (!handler) {
    figma.ui.postMessage({ type: 'result', id, ok: false, error: 'Unknown command: ' + command });
    return;
  }

  try {
    const data = await handler(params || {}, id);
    figma.ui.postMessage({ type: 'result', id, ok: true, data });
  } catch (e) {
    figma.ui.postMessage({
      type: 'result',
      id,
      ok: false,
      error: e && e.message ? e.message : String(e),
      stack: e && e.stack ? String(e.stack).split('\n').slice(0, 4).join('\n') : undefined,
    });
  }
};
