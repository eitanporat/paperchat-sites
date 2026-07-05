// Chapter-site runtime. Wires the primitives defined in pc.css:
//   - click any .pc-figure--zoom image to open a lightbox
//   - "Hide skipped" button in .pc-nav toggles all .pc-skip blocks
//   - hash-routed pagination across .pc-page elements when more than one
//   - KaTeX render pass on load via the shared pc-math util
//
// The module is intentionally framework-free so a generated single-file
// chapter bundle stays standalone.

import { renderMathIn } from './pc-math.js';

// --- Zoom lightbox --------------------------------------------------
function openZoom(src, alt) {
  const overlay = document.createElement('div');
  overlay.className = 'pc-zoom-overlay';
  const img = document.createElement('img');
  img.src = src;
  img.alt = alt || '';
  overlay.appendChild(img);
  const close = () => overlay.remove();
  overlay.addEventListener('click', close);
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
  });
  document.body.appendChild(overlay);
}

function wireZoom() {
  // Delegated click handler so it works for figures injected AFTER
  // boot (section fragments load via fetch + replaceWith in the
  // chapter site's inline loader). Any <img> inside a <figure> within
  // .pc-page / .pc-prose is zoomable — that covers writer-emitted
  // <figure class="l-page …"> and writer-emitted <figure class="pc-figure …">
  // without needing a marker class.
  document.addEventListener('click', (e) => {
    const img = e.target && e.target.tagName === 'IMG' ? e.target : null;
    if (!img) return;
    const fig = img.closest('figure');
    if (!fig) return;
    if (!fig.closest('.pc-page, .pc-prose')) return;
    // Skip if the image is inside a control surface (annotated hotspots
    // or anki cards already wire their own click semantics).
    if (img.closest('.pc-anno-pin, pc-anki, pc-annotated')) return;
    if (e.defaultPrevented) return;
    e.preventDefault();
    openZoom(img.currentSrc || img.src, img.alt);
  });
  // Hint to users that figures are clickable.
  if (!document.getElementById('pc-zoom-cursor-style')) {
    const s = document.createElement('style');
    s.id = 'pc-zoom-cursor-style';
    s.textContent = '.pc-page figure img, .pc-prose figure img { cursor: zoom-in; }';
    document.head.appendChild(s);
  }
}

// --- Skip toggle ----------------------------------------------------
function wireSkipToggle() {
  const btn = document.querySelector('.pc-skip-toggle');
  if (!btn) return;
  const sync = () => {
    const hidden = document.body.classList.contains('pc-skip-hide');
    btn.setAttribute('aria-pressed', hidden ? 'true' : 'false');
    btn.textContent = hidden ? 'Show skipped' : 'Hide skipped';
  };
  btn.addEventListener('click', () => {
    document.body.classList.toggle('pc-skip-hide');
    sync();
  });
  sync();
}

// --- Infinite-scroll section tracking (autogo-style) ---------------
// All <section class="pc-page"> sections are laid out as one long
// document. As the user scrolls, IntersectionObserver detects which
// section is currently "active" (most visible in viewport) and updates
// the .pc-nav links + URL hash. Arrow keys advance to prev/next.
function wireSectionTracking() {
  const pages = [...document.querySelectorAll('section.pc-page')];
  if (!pages.length) return;
  const navLinks = [...document.querySelectorAll('.pc-nav a[href^="#"]')];
  let activeId = pages[0].id;

  function setActive(id) {
    if (id === activeId) return;
    activeId = id;
    for (const a of navLinks) {
      if (a.getAttribute('href') === '#' + id) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
    // Quietly update the URL hash without triggering a scroll.
    if (history.replaceState) history.replaceState(null, '', '#' + id);
  }

  // Track which sections are visible. Pick the most-visible one as active.
  const visible = new Map(); // id -> intersectionRatio
  const observer = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) visible.set(e.target.id, e.intersectionRatio);
      else visible.delete(e.target.id);
    }
    if (visible.size === 0) return;
    let bestId = null, bestRatio = -1;
    for (const p of pages) {
      const r = visible.get(p.id);
      if (r === undefined) continue;
      if (r > bestRatio) { bestRatio = r; bestId = p.id; }
    }
    if (bestId) setActive(bestId);
  }, {
    // Slim middle band — section is "active" when its top is roughly in
    // the upper-third of the viewport (autogo's pattern).
    rootMargin: '-30% 0px -55% 0px',
    threshold: [0, 0.25, 0.5, 0.75, 1.0],
  });
  for (const p of pages) observer.observe(p);

  // Nav-link click → smooth scroll to the target section.
  for (const a of navLinks) {
    a.addEventListener('click', (e) => {
      const id = a.getAttribute('href').slice(1);
      const target = document.getElementById(id);
      if (!target) return;
      e.preventDefault();
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setActive(id);
    });
  }

  // Arrow-key navigation: ← / → move to prev/next page section.
  document.addEventListener('keydown', (e) => {
    // Ignore when the user is typing in an input or contentEditable.
    if (e.target.matches?.('input, textarea, [contenteditable="true"]')) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const idx = pages.findIndex(p => p.id === activeId);
    if (idx < 0) return;
    let next = null;
    if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === 'j') {
      if (idx < pages.length - 1) next = pages[idx + 1];
    } else if (e.key === 'ArrowLeft' || e.key === 'PageUp' || e.key === 'k') {
      if (idx > 0) next = pages[idx - 1];
    }
    if (next) {
      e.preventDefault();
      next.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setActive(next.id);
    }
  });

  // If the page loads with a hash, scroll to it after a tick.
  if (location.hash) {
    const target = document.getElementById(location.hash.slice(1));
    if (target) setTimeout(() => target.scrollIntoView({ behavior: 'instant', block: 'start' }), 0);
  }
}

// --- Reveal-on-scroll animations -----------------------------------
// Elements with .pc-fade-in / .pc-rise / .pc-draw start invisible; when
// they enter the viewport we add .pc-revealed which triggers the CSS
// animation. Re-armed on each page change.
let _revealObserver = null;
function getRevealObserver() {
  if (_revealObserver) return _revealObserver;
  _revealObserver = new IntersectionObserver((entries, obs) => {
    for (const e of entries) {
      if (e.isIntersecting) {
        e.target.classList.add('pc-revealed');
        obs.unobserve(e.target);
      }
    }
  }, { rootMargin: '0px 0px -10% 0px', threshold: 0.01 });
  return _revealObserver;
}

function primeReveals(root = document) {
  // Number stagger children so the CSS calc() picks up an index.
  for (const group of root.querySelectorAll('.pc-stagger')) {
    let i = 0;
    for (const child of group.children) {
      if (child.classList.contains('pc-fade-in') || child.classList.contains('pc-rise')) {
        child.style.setProperty('--pc-i', String(i++));
      }
    }
  }
  // For .pc-draw, measure the SVG path length so CSS can dash it.
  for (const path of root.querySelectorAll('.pc-draw')) {
    try {
      const len = path.getTotalLength?.();
      if (Number.isFinite(len) && len > 0) {
        path.style.setProperty('--pc-len', String(Math.ceil(len)));
      }
    } catch {}
  }
  // Reset reveal state — used on page re-entry so animations replay.
  for (const el of root.querySelectorAll('.pc-fade-in, .pc-rise, .pc-draw')) {
    el.classList.remove('pc-revealed');
  }
}

function observeReveals(root = document) {
  const obs = getRevealObserver();
  for (const el of root.querySelectorAll('.pc-fade-in, .pc-rise, .pc-draw')) {
    if (!el.classList.contains('pc-revealed')) obs.observe(el);
  }
}

// --- Public timeline helper for figure animations ------------------
// Sequences a set of steps over time. Each step is { at, run } where
// `at` is ms from start and `run` is a callback. Cancellable via the
// returned function. Honors prefers-reduced-motion (snaps to last step).
function timeline(steps) {
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (reduced && steps.length) { steps[steps.length - 1].run?.(); return () => {}; }
  const timers = [];
  for (const s of steps) {
    timers.push(setTimeout(() => { try { s.run?.(); } catch (e) { console.warn(e); } }, s.at || 0));
  }
  return () => { for (const t of timers) clearTimeout(t); };
}

// Animate an SVG path's stroke drawing in. Pass the <path> element + a
// duration in ms. Useful for the agent's interactive figures.
function drawPath(pathEl, durationMs = 1200) {
  try {
    const len = pathEl.getTotalLength?.() || 1000;
    pathEl.style.strokeDasharray = String(len);
    pathEl.style.strokeDashoffset = String(len);
    pathEl.getBoundingClientRect();  // force layout
    pathEl.style.transition = `stroke-dashoffset ${durationMs}ms cubic-bezier(0.2, 0.7, 0.2, 1)`;
    pathEl.style.strokeDashoffset = '0';
  } catch {}
}

// --- Heading anchors -----------------------------------------------
function wireAnchors() {
  for (const h of document.querySelectorAll('.pc-prose :is(h2, h3)[id]')) {
    if (h.querySelector('.pc-anchor')) continue;
    const a = document.createElement('a');
    a.className = 'pc-anchor';
    a.href = '#' + h.id;
    a.textContent = '#';
    a.title = 'Copy link';
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const url = new URL(location.href);
      url.hash = h.id;
      navigator.clipboard?.writeText(url.toString());
    });
    h.prepend(a);
  }
}

// --- Source-page citations: click → jump in parent PDF viewer ------
// Every section has a `<div class="pc-source" data-page="40">pp. 40–42</div>`.
// When the chapter site is loaded inside paperchat (in an iframe),
// clicking the citation postMessage's the parent so it can close the
// chapter overlay and scroll the PDF viewer to that page. When the
// site is opened standalone (new tab), the click is a no-op (the
// parent isn't paperchat).
function wireSourceCitations() {
  document.body.addEventListener('click', (e) => {
    const el = e.target.closest('.pc-source');
    if (!el) return;
    e.preventDefault();
    const explicit = parseInt(el.dataset.page || '0', 10);
    // Fallback: parse the first number out of the visible text
    // (e.g. "pp. 40–42" → 40) so older sections without data-page
    // still work.
    const fromText = explicit || (() => {
      const m = (el.textContent || '').match(/\d+/);
      return m ? parseInt(m[0], 10) : 0;
    })();
    if (!fromText) return;
    try { window.parent?.postMessage({ type: 'paperchat:goto-page', page: fromText }, '*'); }
    catch {}
  });
}

// --- Boot ----------------------------------------------------------
// Auto-arm reveals on any dynamically-inserted content. Without this,
// custom components that re-render via `this.innerHTML = ...` produce
// fresh `.pc-rise` / `.pc-fade-in` elements that nobody is observing,
// so they stay at opacity:0 forever (everything in the component
// "disappears" after a click). The MutationObserver picks them up.
function startRevealAutoArm() {
  let pending = new Set();
  let scheduled = false;
  const flush = () => {
    scheduled = false;
    const roots = pending; pending = new Set();
    for (const r of roots) {
      if (!r.isConnected) continue;
      try { primeReveals(r); observeReveals(r); } catch {}
    }
  };
  const schedule = (node) => {
    pending.add(node);
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(flush);
  };
  const mo = new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.classList?.contains?.('pc-fade-in') || n.classList?.contains?.('pc-rise') || n.classList?.contains?.('pc-draw')) {
          schedule(n);
        } else if (n.querySelector?.('.pc-fade-in, .pc-rise, .pc-draw')) {
          schedule(n);
        }
      }
    }
  });
  mo.observe(document.body, { childList: true, subtree: true });
  return mo;
}

// Walk the DOM and prepend "Figure N." to every figure caption in
// document (top-to-bottom) order. Idempotent — re-runs after fragment
// loads update the numbering without doubling. Skips pc-bibliography
// list items, pc-anki, the pc-header hero. Honors `data-no-figure-number`
// on a figcaption when the writer wants to opt out (rare).
function numberFigures(root = document) {
  const captions = root.querySelectorAll('figcaption, .pc-cap');
  let n = 0;
  // Strip leading "Figure N." / "Fig. N" the writer or a prior pass added.
  const STRIP = /^(?:<strong[^>]*>\s*)?(?:figure|fig\.?)\s+(?:[0-9]+[a-z]?|[ivx]+)\.?\s*(?:<\/strong>)?\s*/i;
  for (const cap of captions) {
    if (cap.dataset.noFigureNumber === 'true') continue;
    if (cap.closest('.pc-bib-list, .pc-anki-deck, pc-header, .pc-hero')) continue;
    n++;
    let html = cap.innerHTML.trimStart().replace(STRIP, '');
    cap.innerHTML = `<strong>Figure ${n}.</strong> ${html}`;
    cap.dataset.figNumbered = String(n);
  }
}

// Hide a "References" / "Bibliography" header inside .pc-appendix when
// nothing follows it (writer emitted the header but no pc-bibliography
// or the bibliography has zero entries). Safe to call repeatedly.
function hideOrphanReferences(root = document) {
  const headers = root.querySelectorAll('.pc-appendix h2, .pc-appendix h3, .pc-appendix h4');
  for (const h of headers) {
    if (!/^\s*(references|bibliography)\s*$/i.test(h.textContent || '')) continue;
    // Look for a pc-bibliography sibling AFTER this header.
    let next = h.nextElementSibling;
    let foundBib = null;
    while (next) {
      if (next.tagName === 'PC-BIBLIOGRAPHY') { foundBib = next; break; }
      // If we hit another header at the same level, stop searching.
      if (/^H[2-4]$/.test(next.tagName)) break;
      next = next.nextElementSibling;
    }
    const orphan = !foundBib ||
      (foundBib.style.display === 'none') ||
      (foundBib.querySelectorAll('ol.pc-bib-list li').length === 0);
    if (orphan) {
      h.style.display = 'none';
      if (foundBib) foundBib.style.display = 'none';
    }
  }
}

function wireExternalLinks() {
  // Delegated click handler — works regardless of when the <a> was
  // injected (section-loader fetches fragments AFTER DOMContentLoaded,
  // so an eager querySelectorAll on boot would miss them).
  //
  // For any cross-page link, force a new tab via window.open. Inside
  // an iframe (paperchat chapter viewer) the natural target="_blank"
  // sometimes ends up trying to navigate the iframe itself; explicit
  // window.open with _blank reliably escapes the frame.
  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    if (e.defaultPrevented) return;
    if (e.button !== 0) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const href = a.getAttribute('href') || '';
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;
    let u;
    try { u = new URL(href, location.href); } catch { return; }
    if (u.origin === location.origin && u.pathname === location.pathname && !u.search) return;
    e.preventDefault();
    window.open(u.toString(), '_blank', 'noopener,noreferrer');
  }, true);
}

// --- Reading time + paperchat attribution ---------------------------
// Both are auto-injected by boot() so every chapter/paper site gets
// them without writer involvement. Read-time re-runs whenever sections
// load in (debounced via MutationObserver).
const PAPERCHAT_HOME_URL = 'https://github.com/eporat/paperchat';

function _wordCountIn(root) {
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => {
      const p = n.parentElement;
      if (!p) return NodeFilter.FILTER_REJECT;
      // Exclude code blocks, math source, bibliographies, attribution,
      // scripts/styles, and read-time display itself.
      if (p.closest('script, style, code, pre, pc-bibliography, .pc-bib-list, #pc-read-time, #pc-attribution, .pc-skip')) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let words = 0;
  let n;
  while ((n = w.nextNode())) {
    const s = n.nodeValue.trim();
    if (s) words += s.split(/\s+/).length;
  }
  return words;
}

function injectReadTime(root = document) {
  const body = root.body || root;
  const minutes = Math.max(1, Math.round(_wordCountIn(body) / 220));
  const label = `${minutes} min read`;
  let el = document.getElementById('pc-read-time');
  if (!el) {
    el = document.createElement('div');
    el.id = 'pc-read-time';
    el.className = 'pc-read-time';
    el.setAttribute('aria-label', 'Estimated reading time');
    const header = body.querySelector('pc-header');
    if (header) header.insertAdjacentElement('afterend', el);
    else body.insertAdjacentElement('afterbegin', el);
  }
  el.textContent = label;
}

function injectPaperchatFooter(root = document) {
  const body = root.body || root;
  if (document.getElementById('pc-attribution')) return;
  const f = document.createElement('footer');
  f.id = 'pc-attribution';
  f.className = 'pc-attribution';
  f.innerHTML = `Made with <a href="${PAPERCHAT_HOME_URL}" target="_blank" rel="noopener noreferrer">paperchat</a>`;
  body.appendChild(f);
}

function _watchForSectionLoads() {
  // Section loaders use fetch + replaceWith, so the initial boot's
  // word count is mostly placeholders. Re-run read-time whenever
  // .pc-page contents mutate, debounced to a single update per stable
  // ~250ms window so we're not recounting on every keystroke of a
  // streaming render.
  let pending = null;
  const obs = new MutationObserver(() => {
    if (pending) clearTimeout(pending);
    pending = setTimeout(() => {
      pending = null;
      injectReadTime(document);
      // Footer should stay at the very bottom even if sections grew.
      const f = document.getElementById('pc-attribution');
      if (f && f !== document.body.lastElementChild) document.body.appendChild(f);
    }, 250);
  });
  obs.observe(document.body, { childList: true, subtree: true, characterData: true });
}

function boot() {
  wireZoom();
  wireSkipToggle();
  wireSectionTracking();
  wireAnchors();
  wireSourceCitations();
  wireExternalLinks();
  renderMathIn(document.body);
  primeReveals(document);
  observeReveals(document);
  startRevealAutoArm();
  hideOrphanReferences(document);
  numberFigures(document);
  injectReadTime(document);
  injectPaperchatFooter(document);
  _watchForSectionLoads();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

// Expose for agent-generated interactive figures that mount after boot.
window.pcSite = {
  wireZoom, openZoom,
  timeline, drawPath,
  primeReveals, observeReveals,
  hideOrphanReferences,
  numberFigures,
  wireExternalLinks,
  injectReadTime,
  injectPaperchatFooter,
};

// ====================================================================
// pc-* web components — reusable interactive figures
// --------------------------------------------------------------------
// The agent writes one tag like <pc-chain data='[…]'></pc-chain> and
// the component handles SVG geometry, animations, design tokens, and
// click wiring. That collapses ~30 lines of bug-prone SVG into ~4
// lines of JSON the agent fills in.
//
// All tokens come from pc.css via `style="fill: var(--accent)"` —
// inline SVG attrs like `fill="var(--accent)"` do NOT work (SVG
// doesn't parse CSS variables in presentation attributes).
//
// Pattern: every component reads its `data` attribute as JSON, falls
// back to an empty payload on parse failure, and renders into its own
// subtree. Boot wires `pcSite.primeReveals/observeReveals` so any
// .pc-fade-in/.pc-rise inside still animates on scroll.
// ====================================================================

// Common authoring mistake: LaTeX commands like `\lambda`, `\frac`,
// `\sin` get written into JSON with a SINGLE backslash. JSON requires
// `\\` to encode a literal backslash, so JSON.parse throws and the
// component renders empty. We retry with an automatic repair pass:
// every `\X` where X is not a valid JSON escape becomes `\\X`.
function _pcJsonRepair(raw) {
  const validNext = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't', 'u']);
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '\\' && i + 1 < raw.length && !validNext.has(raw[i + 1])) {
      out += '\\\\';
    } else {
      out += c;
    }
  }
  return out;
}

function _pcData(el, fallback = null) {
  // Prefer a child <script type="application/json"> payload over the
  // `data` attribute when present. Script content bypasses HTML
  // attribute quoting entirely, so JSON strings can contain
  // apostrophes and double-quotes without escaping — this is the
  // recommended form for any payload with prose. Falls back to the
  // `data` attribute for the short / quote-free case.
  const script = el.querySelector(':scope > script[type="application/json"]');
  const raw = script ? script.textContent : el.getAttribute('data');
  if (!raw || !raw.trim()) return fallback;
  try { return JSON.parse(raw); }
  catch (e) {
    // Retry once with the LaTeX-backslash repair before giving up.
    try {
      const repaired = JSON.parse(_pcJsonRepair(raw));
      console.warn(el.tagName + ' JSON had unescaped LaTeX backslashes — auto-repaired');
      return repaired;
    } catch (e2) {
      console.warn(el.tagName + ' bad JSON:', e.message);
      return fallback;
    }
  }
}
const _pcEsc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Unified caption block — placed BELOW the figure body, serif body
// text, left-aligned, muted. "Figure N." style lead-in is bolded by
// the .pc-figure figcaption CSS (which also applies inside
// .pc-fig-interactive). Components call this with optional `title`
// (short, bold lead-in) and `caption` (longer description). Either
// or both may be present; if both, they're combined as
// "<strong>title.</strong> caption".
function _pcCaption(title, caption) {
  if (!title && !caption) return '';
  const titlePart = title ? `<strong>${_pcEsc(title)}.</strong>` : '';
  const capPart   = caption ? (title ? ' ' : '') + _pcEsc(caption) : '';
  return `<figcaption class="pc-cap">${titlePart}${capPart}</figcaption>`;
}
// Render KaTeX inside `root`. Generally unnecessary — the autoMath
// MutationObserver below catches new content automatically. Exposed
// for the rare case where a caller needs a synchronous render.
function _pcMath(root) { if (window.pcMath) window.pcMath.renderMathIn(root); }

// Auto-render math anywhere `$...$`, `\\(...\\)`, or `\\[...\\]`
// appears in the DOM, no matter which component (or section, or
// custom web component) inserted it. One MutationObserver replaces
// what would otherwise be `renderMathIn` sprinkled into every
// component's innerHTML / re-render path — easy to miss, easy to
// drift. The observer is the source of truth.
//
// Loop avoidance: KaTeX itself mutates the DOM during rendering.
// We disconnect the observer before rendering, drain pending records
// after, and reconnect — so KaTeX's own mutations never re-trigger us.
let _autoMathObserver = null;
const _autoMathQueue = new Set();
let _autoMathScheduled = false;
function _enqueueAutoMath(node) {
  if (!node || node.nodeType !== 1) return;
  if (node.classList?.contains('katex')) return;  // skip already-rendered math
  _autoMathQueue.add(node);
  if (_autoMathScheduled) return;
  _autoMathScheduled = true;
  requestAnimationFrame(_flushAutoMath);
}
function _flushAutoMath() {
  _autoMathScheduled = false;
  if (!window.pcMath) { _autoMathQueue.clear(); return; }
  const nodes = [..._autoMathQueue].filter(n => n.isConnected);
  _autoMathQueue.clear();
  if (!nodes.length) return;
  if (_autoMathObserver) _autoMathObserver.disconnect();
  try { for (const n of nodes) window.pcMath.renderMathIn(n); }
  catch (e) { console.warn('autoMath:', e); }
  if (_autoMathObserver && document.body) {
    _autoMathObserver.takeRecords();  // discard mutations from KaTeX itself
    _autoMathObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
  }
}
function _startAutoMath() {
  if (_autoMathObserver || typeof MutationObserver === 'undefined' || !document.body) return;
  _autoMathObserver = new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        const el = n.nodeType === 1 ? n : n.parentElement;
        if (el) _enqueueAutoMath(el);
      }
      if (m.type === 'characterData' && m.target?.parentElement) {
        _enqueueAutoMath(m.target.parentElement);
      }
    }
  });
  _enqueueAutoMath(document.body);  // initial render of existing content
  _autoMathObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _startAutoMath);
} else {
  _startAutoMath();
}

// --- pc-chain ---------------------------------------------------------
// data = [{label, sub?, detail?}, …]   3–5 nodes; click reveals detail.
class PcChain extends HTMLElement {
  connectedCallback() {
    const data = _pcData(this, []);
    if (!data.length) { this.innerHTML = '<em>pc-chain: empty data</em>'; return; }
    const W = 600, H = 120, gap = 24, n = data.length;
    const nw = (W - gap * (n - 1)) / n;
    const nodes = data.map((d, i) => {
      const x = i * (nw + gap);
      const cx = x + nw / 2;
      return `
        <g class="pc-chain-node" data-i="${i}" style="cursor:pointer">
          <rect x="${x}" y="35" width="${nw}" height="50" rx="6"
                style="fill: var(--paper); stroke: var(--accent); stroke-width: 1.5"/>
          <text x="${cx}" y="58" text-anchor="middle"
                style="font-family: var(--mono); font-size: 12px; fill: var(--ink); font-weight: 600">${_pcEsc(d.label)}</text>
          <text x="${cx}" y="74" text-anchor="middle"
                style="font-size: 10px; fill: var(--ink-soft)">${_pcEsc(d.sub || '')}</text>
        </g>
        ${i < n - 1 ? `<line x1="${x + nw}" y1="60" x2="${x + nw + gap}" y2="60"
          style="stroke: var(--ink-soft); stroke-width: 1.5" marker-end="url(#pc-arrow)"/>` : ''}`;
    }).join('');
    this.innerHTML = `
      <figure class="pc-fig-interactive pc-rise">
        <svg viewBox="0 0 ${W} ${H}" style="width:100%; max-width:${W}px; display:block; margin: 0;">
          <defs><marker id="pc-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M0,0 L8,4 L0,8 z" style="fill: var(--ink-soft)"/>
          </marker></defs>
          ${nodes}
        </svg>
        <div class="pc-chain-detail" style="margin-top:.6rem; min-height:2.4rem; padding:.5rem .8rem;
             background: var(--accent-soft); border-radius: 4px; font-size: 13px; color: var(--ink);">
          Click a node to see what it means.
        </div>
      </figure>`;
    const det = this.querySelector('.pc-chain-detail');
    const ns = this.querySelectorAll('.pc-chain-node');
    ns.forEach((el, i) => el.addEventListener('click', () => {
      det.innerHTML = data[i].detail || data[i].label;
      ns.forEach(o => o.querySelector('rect').style.fill = 'var(--paper)');
      el.querySelector('rect').style.fill = 'var(--accent-soft)';
    }));
  }
}

// --- pc-stepped -------------------------------------------------------
// data = [{title?, body, svg?}, …]   one step shown at a time; prev/next.
class PcStepped extends HTMLElement {
  connectedCallback() {
    const data = _pcData(this, []);
    if (!data.length) { this.innerHTML = '<em>pc-stepped: empty data</em>'; return; }
    this.innerHTML = `
      <figure class="pc-fig-interactive pc-rise">
        <div class="pc-stepped-stage" style="min-height: 160px; padding: 1rem 1.2rem;
             border: 1px solid var(--border); border-radius: 6px; background: var(--paper);"></div>
        <div class="pc-stepped-bar" style="display:flex; align-items:center; justify-content:space-between;
             margin-top:.5rem; font-family: var(--mono); font-size: 12px; color: var(--ink-soft);">
          <button class="pc-stepped-prev" style="font: inherit; border: 0; background: transparent;
                  cursor: pointer; color: var(--accent); padding: 4px 8px;">← prev</button>
          <span class="pc-stepped-count"></span>
          <button class="pc-stepped-next" style="font: inherit; border: 0; background: transparent;
                  cursor: pointer; color: var(--accent); padding: 4px 8px;">next →</button>
        </div>
      </figure>`;
    let i = 0;
    const stage = this.querySelector('.pc-stepped-stage');
    const count = this.querySelector('.pc-stepped-count');
    const render = () => {
      const s = data[i] || {};
      // Per-step visual: `svg` (raw inline SVG markup) OR `image`
      // (URL — local figures/ path or remote https://) OR neither.
      // image renders constrained to the stage width with the same
      // muted figcaption convention as the rest of the site.
      let visualHtml = '';
      if (s.svg) {
        visualHtml = `<div style="margin: .4rem 0;">${s.svg}</div>`;
      } else if (s.image) {
        const alt = s.imageAlt || s.title || '';
        visualHtml = `<div style="margin: .4rem 0;"><img src="${_pcEsc(s.image)}" alt="${_pcEsc(alt)}" style="max-width: 100%; height: auto; border-radius: 3px; display: block;"></div>`;
      }
      stage.innerHTML = (s.title ? `<h4 style="margin:0 0 .4rem; font-size: 14px; font-family: var(--mono); color: var(--accent);">${_pcEsc(s.title)}</h4>` : '') +
        visualHtml +
        `<div style="font-size: 14px; line-height: 1.5;">${s.body || ''}</div>`;
      count.textContent = `${i + 1} / ${data.length}`;
    };
    this.querySelector('.pc-stepped-prev').addEventListener('click', () => { i = (i - 1 + data.length) % data.length; render(); });
    this.querySelector('.pc-stepped-next').addEventListener('click', () => { i = (i + 1) % data.length; render(); });
    render();
  }
}

// --- pc-timeline ------------------------------------------------------
// data = [{when, label, detail?}, …]   horizontal axis, click for detail.
class PcTimeline extends HTMLElement {
  connectedCallback() {
    const data = _pcData(this, []);
    if (!data.length) { this.innerHTML = '<em>pc-timeline: empty data</em>'; return; }
    const W = 640, H = 160, padX = 30, axisY = 80, n = data.length;
    const dx = n > 1 ? (W - padX * 2) / (n - 1) : 0;
    const dots = data.map((d, i) => {
      const x = padX + i * dx;
      return `
        <g class="pc-timeline-pt" data-i="${i}" style="cursor:pointer">
          <line x1="${x}" y1="${axisY}" x2="${x}" y2="${axisY - 18}" style="stroke: var(--ink-soft); stroke-width: 1"/>
          <circle cx="${x}" cy="${axisY}" r="6" style="fill: var(--accent); stroke: var(--paper); stroke-width: 2"/>
          <text x="${x}" y="${axisY - 24}" text-anchor="middle"
                style="font-family: var(--mono); font-size: 10px; fill: var(--ink); letter-spacing: 0.04em;">${_pcEsc(d.when)}</text>
          <text x="${x}" y="${axisY + 22}" text-anchor="middle"
                style="font-size: 12px; fill: var(--ink);">${_pcEsc(d.label)}</text>
        </g>`;
    }).join('');
    this.innerHTML = `
      <figure class="pc-fig-interactive pc-rise">
        <svg viewBox="0 0 ${W} ${H}" style="width:100%; max-width:${W}px; display:block; margin: 0;">
          <line x1="${padX}" y1="${axisY}" x2="${W - padX}" y2="${axisY}" style="stroke: var(--ink-soft); stroke-width: 1.5"/>
          ${dots}
        </svg>
        <div class="pc-timeline-detail" style="margin-top:.4rem; min-height: 2.4rem; padding:.5rem .8rem;
             background: var(--accent-soft); border-radius: 4px; font-size: 13px; color: var(--ink);">
          Click a point for context.
        </div>
      </figure>`;
    const det = this.querySelector('.pc-timeline-detail');
    this.querySelectorAll('.pc-timeline-pt').forEach((el, i) => el.addEventListener('click', () => {
      det.innerHTML = data[i].detail || data[i].label;
    }));
  }
}

// --- pc-grid ---------------------------------------------------------
// data = [{title, body, eyebrow?}, …]   responsive grid of comparison cards.
class PcGrid extends HTMLElement {
  connectedCallback() {
    const data = _pcData(this, []);
    if (!data.length) { this.innerHTML = '<em>pc-grid: empty data</em>'; return; }
    // Each card may carry a visual ABOVE the title via `svg` (raw
    // inline SVG markup) OR `image` (URL — local figures/ path or
    // remote https://). The visual gets a fixed aspect-ratio holder
    // so cards stay aligned even when bodies are different lengths.
    const cards = data.map(d => {
      let visual = '';
      if (d.svg) {
        visual = `<div style="margin-bottom:.5rem; aspect-ratio: 16/9; display:flex; align-items:center; justify-content:center; overflow:hidden; border-radius: 3px; background: var(--bg-soft);">${d.svg}</div>`;
      } else if (d.image) {
        visual = `<div style="margin-bottom:.5rem; aspect-ratio: 16/9; overflow:hidden; border-radius: 3px; background: var(--bg-soft);"><img src="${_pcEsc(d.image)}" alt="${_pcEsc(d.imageAlt || d.title || '')}" style="width:100%; height:100%; object-fit: cover; display:block;"></div>`;
      }
      return `
      <div class="pc-grid-card" style="padding: .8rem 1rem; border: 1px solid var(--border);
           border-radius: 6px; background: var(--paper); display:flex; flex-direction:column;">
        ${visual}
        ${d.eyebrow ? `<div style="font-family: var(--mono); font-size: 10px; text-transform: uppercase;
             letter-spacing: 0.08em; color: var(--accent); margin-bottom:.3rem;">${_pcEsc(d.eyebrow)}</div>` : ''}
        <div style="font-weight: 600; font-size: 14px; margin-bottom:.3rem; color: var(--ink);">${_pcEsc(d.title)}</div>
        <div style="font-size: 13px; color: var(--ink-soft); line-height: 1.5;">${d.body || ''}</div>
      </div>`;
    }).join('');
    this.innerHTML = `
      <figure class="pc-fig-interactive pc-rise">
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: .8rem;">
          ${cards}
        </div>
      </figure>`;
  }
}

// --- pc-toggle --------------------------------------------------------
// data = {a: {label, body}, b: {label, body}}   2-state A/B switch.
class PcToggle extends HTMLElement {
  connectedCallback() {
    const d = _pcData(this, {});
    if (!d.a || !d.b) { this.innerHTML = '<em>pc-toggle: need a and b</em>'; return; }
    this.innerHTML = `
      <figure class="pc-fig-interactive pc-rise">
        <div style="display:flex; gap:0; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; width: max-content; margin: 0 auto;">
          <button class="pc-toggle-a" style="font: inherit; font-family: var(--mono); font-size: 12px;
                  padding: 6px 16px; border: 0; background: var(--accent); color: var(--paper); cursor: pointer;">${_pcEsc(d.a.label)}</button>
          <button class="pc-toggle-b" style="font: inherit; font-family: var(--mono); font-size: 12px;
                  padding: 6px 16px; border: 0; background: var(--paper); color: var(--ink); cursor: pointer;">${_pcEsc(d.b.label)}</button>
        </div>
        <div class="pc-toggle-body" style="margin-top:.8rem; padding: 1rem; border: 1px solid var(--border);
             border-radius: 6px; background: var(--paper); min-height: 100px;"></div>
      </figure>`;
    const body = this.querySelector('.pc-toggle-body');
    const aBtn = this.querySelector('.pc-toggle-a');
    const bBtn = this.querySelector('.pc-toggle-b');
    const setAB = (which) => {
      body.innerHTML = (which === 'a' ? d.a.body : d.b.body) || '';
      aBtn.style.background = which === 'a' ? 'var(--accent)' : 'var(--paper)';
      aBtn.style.color = which === 'a' ? 'var(--paper)' : 'var(--ink)';
      bBtn.style.background = which === 'b' ? 'var(--accent)' : 'var(--paper)';
      bBtn.style.color = which === 'b' ? 'var(--paper)' : 'var(--ink)';
    };
    aBtn.addEventListener('click', () => setAB('a'));
    bBtn.addEventListener('click', () => setAB('b'));
    setAB('a');
  }
}

// --- pc-slider --------------------------------------------------------
// data = {min, max, step?, value?, label, formula?, unit?}
// formula is a JS expression in `x` returning a number (or HTML string).
class PcSlider extends HTMLElement {
  connectedCallback() {
    const d = _pcData(this, {});
    if (d.min == null || d.max == null) { this.innerHTML = '<em>pc-slider: need min and max</em>'; return; }
    const { min, max, step = (max - min) / 100, value = min, label = 'x', formula, unit = '' } = d;
    this.innerHTML = `
      <figure class="pc-fig-interactive pc-rise">
        <div style="display:flex; align-items:center; gap: 1rem; font-family: var(--mono); font-size: 12px;">
          <label style="color: var(--ink-soft);">${_pcEsc(label)}</label>
          <input type="range" min="${min}" max="${max}" step="${step}" value="${value}" style="flex:1; accent-color: var(--accent);"/>
          <span class="pc-slider-x" style="min-width: 4rem; text-align: right; color: var(--ink); font-weight: 600;"></span>
        </div>
        ${formula ? `<div class="pc-slider-out" style="margin-top:.8rem; padding:.8rem 1rem; background: var(--accent-soft);
             border-radius: 4px; font-family: var(--mono); font-size: 14px; color: var(--ink); text-align: center;"></div>` : ''}
      </figure>`;
    const range = this.querySelector('input[type=range]');
    const xEl = this.querySelector('.pc-slider-x');
    const out = this.querySelector('.pc-slider-out');
    const fmt = (v) => Number.isInteger(v) ? v : Number(v).toPrecision(4);
    const fn = formula ? new Function('x', `return (${formula});`) : null;
    const render = () => {
      const x = Number(range.value);
      xEl.textContent = fmt(x) + (unit ? ' ' + unit : '');
      if (fn && out) {
        try { out.innerHTML = String(fn(x)); }
        catch (e) { out.textContent = e.message; }
      }
    };
    range.addEventListener('input', render);
    render();
  }
}

// --- pc-plot ----------------------------------------------------------
// data = {kind: 'line'|'bar'|'scatter', series: [{name, points: [[x,y],…]}],
//         xLabel?, yLabel?, title?}
class PcPlot extends HTMLElement {
  connectedCallback() {
    const d = _pcData(this, {});
    const series = d.series || [];
    if (!series.length) { this.innerHTML = '<em>pc-plot: need series</em>'; return; }
    // For categorical bar data with a `labels` array, switch to a
    // wider bottom margin so labels have room.
    const hasCategoryLabels = d.kind === 'bar' && Array.isArray(d.labels) && d.labels.length;
    const W = 540, H = 320, m = { l: 50, r: 20, t: 28, b: hasCategoryLabels ? 70 : 40 };
    const innerW = W - m.l - m.r, innerH = H - m.t - m.b;
    const all = series.flatMap(s => s.points);
    const xs = all.map(p => p[0]), ys = all.map(p => p[1]);
    const xmin = Math.min(...xs), xmax = Math.max(...xs);
    const ymin = Math.min(0, ...ys), ymax = Math.max(...ys);
    const sx = (x) => m.l + ((x - xmin) / (xmax - xmin || 1)) * innerW;
    const sy = (y) => m.t + innerH - ((y - ymin) / (ymax - ymin || 1)) * innerH;
    const palette = ['var(--accent)', 'var(--accent-alt)', 'var(--ink-soft)'];
    const renderSeries = (s, i) => {
      const color = palette[i % palette.length];
      if (d.kind === 'bar') {
        const bw = innerW / s.points.length * 0.7;
        return s.points.map(([x, y]) => `<rect x="${sx(x) - bw / 2}" y="${sy(y)}" width="${bw}" height="${sy(0) - sy(y)}"
          style="fill: ${color}; opacity: 0.85"/>`).join('');
      }
      if (d.kind === 'scatter') {
        return s.points.map(([x, y]) => `<circle cx="${sx(x)}" cy="${sy(y)}" r="4" style="fill: ${color}"/>`).join('');
      }
      // line
      const path = s.points.map(([x, y], j) => `${j ? 'L' : 'M'}${sx(x).toFixed(1)},${sy(y).toFixed(1)}`).join(' ');
      return `<path d="${path}" style="fill: none; stroke: ${color}; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round"/>` +
        s.points.map(([x, y]) => `<circle cx="${sx(x)}" cy="${sy(y)}" r="3" style="fill: ${color}"/>`).join('');
    };
    this.innerHTML = `
      <figure class="pc-fig-interactive pc-rise">
        <svg viewBox="0 0 ${W} ${H}" style="width:100%; max-width:${W}px; display:block; margin: 0;">
          <line x1="${m.l}" y1="${m.t}" x2="${m.l}" y2="${m.t + innerH}" style="stroke: var(--ink-soft); stroke-width: 1"/>
          <line x1="${m.l}" y1="${m.t + innerH}" x2="${m.l + innerW}" y2="${m.t + innerH}" style="stroke: var(--ink-soft); stroke-width: 1"/>
          ${series.map(renderSeries).join('')}
          ${d.xLabel ? `<text x="${m.l + innerW / 2}" y="${H - 8}" text-anchor="middle" style="font-family: var(--mono); font-size: 11px; fill: var(--ink-soft);">${_pcEsc(d.xLabel)}</text>` : ''}
          ${d.yLabel ? `<text transform="rotate(-90 ${14} ${m.t + innerH / 2})" x="${14}" y="${m.t + innerH / 2}" text-anchor="middle" style="font-family: var(--mono); font-size: 11px; fill: var(--ink-soft);">${_pcEsc(d.yLabel)}</text>` : ''}
          <text x="${m.l - 6}" y="${m.t + 4}" text-anchor="end" style="font-family: var(--mono); font-size: 10px; fill: var(--ink-soft);">${fmtNum(ymax)}</text>
          <text x="${m.l - 6}" y="${m.t + innerH + 4}" text-anchor="end" style="font-family: var(--mono); font-size: 10px; fill: var(--ink-soft);">${fmtNum(ymin)}</text>
          ${hasCategoryLabels
            ? d.labels.map((lbl, i) => {
                // distribute labels at integer x-positions
                const x = sx(i);
                return `<text x="${x.toFixed(1)}" y="${(m.t + innerH + 18).toFixed(1)}" text-anchor="middle"
                  style="font-family: var(--mono); font-size: 10px; fill: var(--ink);">${_pcEsc(lbl)}</text>`;
              }).join('')
            : `<text x="${m.l}" y="${m.t + innerH + 16}" text-anchor="middle" style="font-family: var(--mono); font-size: 10px; fill: var(--ink-soft);">${fmtNum(xmin)}</text>
               <text x="${m.l + innerW}" y="${m.t + innerH + 16}" text-anchor="middle" style="font-family: var(--mono); font-size: 10px; fill: var(--ink-soft);">${fmtNum(xmax)}</text>`}
        </svg>
        ${series.length > 1 ? `<div style="display:flex; gap:1rem; justify-content:flex-start; margin-top:.4rem; font-size: 11px; font-family: var(--mono); color: var(--ink-soft);">
          ${series.map((s, i) => `<span><span style="display:inline-block; width:10px; height:10px; background:${palette[i % palette.length]}; margin-right:4px; vertical-align:middle;"></span>${_pcEsc(s.name || '')}</span>`).join('')}
        </div>` : ''}
        ${_pcCaption(d.title, d.caption)}
      </figure>`;
    function fmtNum(v) { return Number.isInteger(v) ? v : Number(v).toPrecision(3); }
  }
}

// --- pc-annotated -----------------------------------------------------
// data = {src, hotspots: [{x, y, label, body?}]}  x,y in % (0-100).
class PcAnnotated extends HTMLElement {
  connectedCallback() {
    const d = _pcData(this, {});
    if (!d.src) { this.innerHTML = '<em>pc-annotated: need src</em>'; return; }
    const spots = (d.hotspots || []).map((h, i) => `
      <button class="pc-anno-pin" data-i="${i}" style="position: absolute; left: ${h.x}%; top: ${h.y}%;
              transform: translate(-50%, -50%); width: 22px; height: 22px; border-radius: 50%; border: 2px solid var(--paper);
              background: var(--accent); color: var(--paper); font-family: var(--mono); font-size: 11px; font-weight: 700;
              cursor: pointer; box-shadow: 0 2px 6px rgba(0,0,0,.3); padding: 0;">${i + 1}</button>`).join('');
    this.innerHTML = `
      <figure class="pc-fig-interactive pc-rise">
        <div style="position: relative; display: inline-block; max-width: 100%;">
          <img src="${_pcEsc(d.src)}" alt="${_pcEsc(d.alt || '')}" style="display: block; max-width: 100%; height: auto;"/>
          ${spots}
        </div>
        <div class="pc-anno-detail" style="margin-top:.6rem; padding:.6rem .9rem; background: var(--accent-soft);
             border-radius: 4px; font-size: 13px; color: var(--ink); min-height: 2rem;">
          Click a numbered pin to read its label.
        </div>
      </figure>`;
    const det = this.querySelector('.pc-anno-detail');
    this.querySelectorAll('.pc-anno-pin').forEach((el, i) => el.addEventListener('click', () => {
      const h = d.hotspots[i];
      det.innerHTML = `<strong>${i + 1}. ${_pcEsc(h.label)}</strong>${h.body ? ' — ' + h.body : ''}`;
    }));
  }
}

// --- pc-equation ------------------------------------------------------
// data = {tex, terms: {symbol: definition}}   click any term in legend.
// `terms` keys are LaTeX (e.g. "\\chi_A"); the legend renders each as
// inline math via KaTeX, and the detail panel does the same on click.
class PcEquation extends HTMLElement {
  connectedCallback() {
    const d = _pcData(this, {});
    // Accept common alternate field names so writers don't get the bare
    // "need tex" error for a tiny vocabulary mismatch. Canonical is `tex`.
    if (!d.tex) {
      d.tex = d.latex || d.formula || d.equation || d.math || '';
    }
    if (!d.tex) {
      const keys = Object.keys(d).join(', ') || '(none)';
      this.innerHTML = `<em style="color: var(--ink-soft);">pc-equation: need a \`tex\` field with the LaTeX string. Got keys: ${_pcEsc(keys)}.</em>`;
      return;
    }
    const terms = d.terms || {};
    // Opt-in widening: only if the writer explicitly asks via
    // `wide: true` or sets class="l-page" on the tag. Auto-promoting on
    // long LaTeX strings was breaking the layout for normal equations
    // — better to keep figures inside the prose column by default and
    // let the writer escape when they really need it.
    if (d.wide === true && !this.classList.contains('l-page') && !this.classList.contains('l-screen')) {
      this.classList.add('l-page');
    }
    // data-k stores the raw LaTeX key (used to look up the definition);
    // the button content wraps it in $...$ so KaTeX renders the symbol.
    const legend = Object.entries(terms).map(([k]) => `
      <button class="pc-eq-term" data-k="${_pcEsc(k)}" style="font: inherit; font-size: 13px;
              border: 1px solid var(--border); background: var(--paper); color: var(--ink); padding: 3px 10px;
              border-radius: 3px; cursor: pointer; min-width: 36px;">$${k}$</button>`).join('');
    this.innerHTML = `
      <figure class="pc-fig-interactive pc-rise">
        <div class="pc-eq-display" style="text-align: center; font-size: 18px; padding: 1rem 0; overflow-x: auto; overflow-y: hidden;">$$${d.tex}$$</div>
        ${Object.keys(terms).length ? `<div style="display:flex; flex-wrap:wrap; gap: .4rem; justify-content: center; margin: .4rem 0;">${legend}</div>
        <div class="pc-eq-detail" style="margin-top:.4rem; padding:.6rem .9rem; background: var(--accent-soft);
             border-radius: 4px; font-size: 14px; color: var(--ink); min-height: 2rem; text-align: center; line-height: 1.5;">
          Click any symbol above to see what it means.
        </div>` : ''}
      </figure>`;
    if (window.pcMath) window.pcMath.renderMathIn(this);
    const det = this.querySelector('.pc-eq-detail');
    this.querySelectorAll('.pc-eq-term').forEach(el => el.addEventListener('click', () => {
      const k = el.dataset.k;
      if (!det) return;
      // Highlight active term.
      this.querySelectorAll('.pc-eq-term').forEach(o => o.style.background = 'var(--paper)');
      el.style.background = 'var(--accent-soft)';
      // Render definition with the symbol re-rendered via KaTeX.
      det.innerHTML = `$${k}$ — ${terms[k]}`;
      if (window.pcMath) window.pcMath.renderMathIn(det);
    }));
  }
}

// --- pc-tree ----------------------------------------------------------
// data = {root: {label, body?, children: [{label, body?, children?}, …]}}
// Hierarchical content as a horizontal mind-map (Markmap aesthetic):
// root on the left, branches fan out to the right, every node sits on
// a short underline, smooth Bezier curves connect parent's underline-end
// to child's underline-start. Labels stay horizontal so text always
// reads left-to-right. Nodes with `body` are clickable — the body
// shows in a detail panel under the SVG.
// `layout="cards"` opt-out renders nested collapsible cards instead;
// use it when labels are long-paragraph length and would overflow.
class PcTree extends HTMLElement {
  connectedCallback() {
    const d = _pcData(this, {});
    if (!d.root) { this.innerHTML = '<em>pc-tree: need root</em>'; return; }
    const layout = (this.getAttribute('layout') || 'tree').toLowerCase();
    if (layout === 'cards') { this._renderCards(d.root); return; }
    this._renderTree(d.root);
  }

  _renderCards(root) {
    const renderNode = (n, depth) => {
      const hasKids = Array.isArray(n.children) && n.children.length > 0;
      const label = `<span style="font-weight: 600; color: var(--ink);">${_pcEsc(n.label)}</span>`;
      const body = n.body
        ? `<div style="margin-top:.3rem; font-size: 13px; color: var(--ink-soft); line-height: 1.5;">${n.body}</div>`
        : '';
      const childrenHtml = hasKids
        ? `<div style="margin-top:.5rem; display: flex; flex-direction: column; gap:.4rem;">
             ${n.children.map(c => renderNode(c, depth + 1)).join('')}
           </div>`
        : '';
      const borderColor = depth === 0 ? 'var(--accent)' : 'var(--border)';
      if (hasKids) {
        return `
          <details ${depth < 2 ? 'open' : ''} style="border-left: 3px solid ${borderColor};
                  padding: .5rem .8rem; background: var(--paper); border-radius: 0 4px 4px 0;">
            <summary style="cursor: pointer; list-style: revert; user-select: none;">${label}</summary>
            ${body}
            ${childrenHtml}
          </details>`;
      }
      return `
        <div style="border-left: 3px solid ${borderColor}; padding: .5rem .8rem;
             background: var(--paper); border-radius: 0 4px 4px 0;">
          ${label}
          ${body}
        </div>`;
    };
    this.innerHTML = `
      <figure class="pc-fig-interactive pc-rise" style="max-width: 640px; margin: 0;">
        ${renderNode(root, 0)}
      </figure>`;
  }

  _renderTree(root) {
    // 1) Flatten into a node array with parent links.
    const nodes = [];
    const flatten = (n, depth, parent) => {
      const node = { data: n, depth, parent, children: [], x: 0, y: 0, w: 0 };
      nodes.push(node);
      if (Array.isArray(n.children)) {
        for (const c of n.children) node.children.push(flatten(c, depth + 1, node));
      }
      return node;
    };
    const treeRoot = flatten(root, 0, null);

    // 2) Measure each label width using a canvas 2D context — same trick
    //    Markmap uses. The font here must match the rendered SVG <text>.
    const ROOT_PX = 16, NODE_PX = 14;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const fontFamily = '"Fraunces", Georgia, "Iowan Old Style", serif';
    nodes.forEach(n => {
      const px = n.depth === 0 ? ROOT_PX : NODE_PX;
      ctx.font = `${n.depth === 0 ? '600' : '500'} ${px}px ${fontFamily}`;
      n.w = Math.max(40, ctx.measureText(n.data.label).width);
    });

    // 3) Column x by max label width at each depth, with a gap between.
    const COL_GAP = 36;
    const colMaxW = [];
    nodes.forEach(n => { colMaxW[n.depth] = Math.max(colMaxW[n.depth] || 0, n.w); });
    const colX = [0];
    for (let i = 1; i < colMaxW.length; i++) {
      colX[i] = colX[i - 1] + colMaxW[i - 1] + COL_GAP;
    }
    nodes.forEach(n => { n.x = colX[n.depth]; });

    // 4) Tidy y-layout: leaves get sequential rows in DFS order, internal
    //    nodes sit at the midpoint of their children's y. This is the
    //    classic Reingold-Tilford "simple" variant — fine for ≤30 nodes.
    const ROW_H = 32;
    let leafIdx = 0;
    const assignY = (n) => {
      if (n.children.length === 0) {
        n.y = leafIdx * ROW_H;
        leafIdx++;
      } else {
        n.children.forEach(assignY);
        n.y = (n.children[0].y + n.children[n.children.length - 1].y) / 2;
      }
    };
    assignY(treeRoot);
    const totalRows = Math.max(1, leafIdx);

    // 5) Edges — Bezier from parent's underline-end to child's underline-
    //    start with horizontal tangents at both endpoints (the Markmap
    //    signature). Stroke tapers with depth.
    const edges = nodes.filter(n => n.parent).map(n => {
      const px = n.parent.x + n.parent.w;
      const py = n.parent.y;
      const cx = n.x;
      const cy = n.y;
      const mid = (px + cx) / 2;
      const sw = Math.max(0.9, 1.6 - n.depth * 0.2).toFixed(2);
      return `<path d="M${px.toFixed(1)},${py.toFixed(1)} C${mid.toFixed(1)},${py.toFixed(1)} ${mid.toFixed(1)},${cy.toFixed(1)} ${cx.toFixed(1)},${cy.toFixed(1)}"
              fill="none" stroke="var(--accent)" stroke-opacity="0.55" stroke-width="${sw}" stroke-linecap="round"/>`;
    }).join('');

    // 6) Each node: label sitting above a short underline. The underline
    //    is part of the visual branch — it merges with the incoming and
    //    outgoing Beziers into one continuous curve.
    const nodeMarkup = nodes.map((n, i) => {
      const hasBody = !!n.data.body;
      const cursor = hasBody ? 'pointer' : 'default';
      const isRoot = n.depth === 0;
      const fontSize = isRoot ? ROOT_PX : NODE_PX;
      const weight = isRoot ? 600 : 500;
      const labelY = n.y - 6;
      const sw = Math.max(0.9, 1.6 - n.depth * 0.2).toFixed(2);
      return `<g class="pc-tree-node" data-i="${i}" style="cursor: ${cursor}">
        <line x1="${n.x.toFixed(1)}" y1="${n.y.toFixed(1)}" x2="${(n.x + n.w).toFixed(1)}" y2="${n.y.toFixed(1)}"
              stroke="var(--accent)" stroke-opacity="0.55" stroke-width="${sw}" stroke-linecap="round"/>
        <text x="${n.x.toFixed(1)}" y="${labelY.toFixed(1)}"
              font-family="var(--serif)" font-size="${fontSize}" font-weight="${weight}" fill="var(--ink)">${_pcEsc(n.data.label)}</text>
        <rect class="pc-tree-hit" x="${n.x.toFixed(1)}" y="${(n.y - fontSize - 6).toFixed(1)}"
              width="${n.w.toFixed(1)}" height="${(fontSize + 12).toFixed(1)}"
              fill="transparent"/>
      </g>`;
    }).join('');

    // 7) ViewBox = full extent + small padding.
    const PAD = 12;
    const W = colX[colX.length - 1] + colMaxW[colMaxW.length - 1] + PAD * 2;
    const H = (totalRows - 1) * ROW_H + ROOT_PX + PAD * 2;
    const vb = `${-PAD} ${-(ROOT_PX + PAD)} ${W} ${H}`;
    const hasAnyBody = nodes.some(n => n.data.body);

    this.innerHTML = `
      <figure class="pc-fig-interactive pc-rise" style="overflow-x: auto;">
        <svg viewBox="${vb}" style="width:100%; max-width: ${W}px; height: auto; display:block; margin: 0;" role="img">
          <g>${edges}</g>
          <g>${nodeMarkup}</g>
        </svg>
        ${hasAnyBody ? `<div class="pc-tree-detail" style="margin-top:.5rem; min-height: 2.2rem; padding:.5rem .8rem;
             background: var(--accent-soft); border-radius: 4px; font-size: 13px; color: var(--ink); line-height: 1.5;">
          Click a node for details.
        </div>` : ''}
      </figure>`;

    if (hasAnyBody) {
      const det = this.querySelector('.pc-tree-detail');
      const groups = this.querySelectorAll('.pc-tree-node');
      groups.forEach((el, i) => el.addEventListener('click', () => {
        const n = nodes[i];
        if (!n.data.body) return;
        det.innerHTML = `<strong style="color: var(--accent);">${_pcEsc(n.data.label)}</strong> — ${n.data.body}`;
        groups.forEach(o => {
          const txt = o.querySelector('text');
          if (txt) txt.setAttribute('fill', 'var(--ink)');
        });
        const txt = el.querySelector('text');
        if (txt) txt.setAttribute('fill', 'var(--accent)');
      }));
    }
  }
}

// --- pc-term ----------------------------------------------------------
// Inline term with a hover/focus tooltip showing its definition. Use
// for technical terms on first (or important) appearance:
//
//   The smallest repeating unit is the <pc-term def="The minimum
//   3D building block whose translation tiles the whole crystal.">
//   unit cell</pc-term>.
//
// The definition may contain inline HTML (including KaTeX delimiters);
// it's rendered via pcMath after the tooltip mounts.
// Mobile: tap toggles. Keyboard: focusable, Enter / Space toggle.
class PcTerm extends HTMLElement {
  connectedCallback() {
    if (this._wired) return;
    this._wired = true;
    const def = this.getAttribute('def') || '';
    const text = this.textContent;
    this.textContent = '';
    this.classList.add('pc-term');
    this.setAttribute('tabindex', '0');
    this.setAttribute('role', 'button');
    this.setAttribute('aria-label', `${text} — definition`);
    const trigger = document.createElement('span');
    trigger.className = 'pc-term-trigger';
    trigger.textContent = text;
    // Tooltip is a popover so it renders in the top-layer, escaping any
    // ancestor stacking context created by transformed pc-rise/pc-fade-in
    // figures. Position is computed at show time relative to the trigger.
    const tip = document.createElement('div');
    tip.className = 'pc-term-tip';
    tip.setAttribute('role', 'tooltip');
    tip.setAttribute('popover', 'manual');
    tip.innerHTML = def;
    this.appendChild(trigger);
    document.body.appendChild(tip);
    if (window.pcMath) window.pcMath.renderMathIn(tip);
    const position = () => {
      const r = trigger.getBoundingClientRect();
      tip.style.left = '0px';
      tip.style.top = '0px';
      const tw = tip.offsetWidth, th = tip.offsetHeight;
      const margin = 8;
      let left = r.left;
      if (left + tw > window.innerWidth - margin) left = window.innerWidth - tw - margin;
      if (left < margin) left = margin;
      let top = r.bottom + 6;
      if (top + th > window.innerHeight - margin) top = r.top - th - 6;
      tip.style.left = left + 'px';
      tip.style.top = top + 'px';
    };
    let open = false;
    const setOpen = (v) => {
      open = v;
      this.classList.toggle('pc-term-open', v);
      if (v) {
        try { tip.showPopover(); } catch (e) {}
        position();
      } else {
        try { tip.hidePopover(); } catch (e) {}
      }
    };
    let closeTimer = 0;
    const scheduleClose = () => {
      clearTimeout(closeTimer);
      closeTimer = setTimeout(() => {
        if (!tipHover && !this.matches(':hover, :focus-within')) setOpen(false);
      }, 80);
    };
    let tipHover = false;
    tip.addEventListener('mouseenter', () => { tipHover = true; clearTimeout(closeTimer); });
    tip.addEventListener('mouseleave', () => { tipHover = false; scheduleClose(); });
    this.addEventListener('mouseenter', () => { clearTimeout(closeTimer); setOpen(true); });
    this.addEventListener('mouseleave', scheduleClose);
    this.addEventListener('focus', () => setOpen(true));
    window.addEventListener('scroll', () => { if (open) position(); }, { passive: true });
    window.addEventListener('resize', () => { if (open) position(); });
    this.addEventListener('click', (e) => {
      if (e.target.closest('a')) return;
      e.preventDefault();
      setOpen(!open);
    });
    this.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(!open); }
      if (e.key === 'Escape') setOpen(false);
    });
    // Dismiss when focus leaves.
    this.addEventListener('blur', () => setOpen(false));
  }
}

// --- pc-anki ----------------------------------------------------------
// Anki-style review card deck. Use at the END of every section so the
// reader can self-test the concepts before moving on. Each card has
// a question and an answer; question is visible by default, answer is
// hidden behind a click. Numbered, with an "Expand all" / "Collapse
// all" toggle. KaTeX in q/a is fine.
//
// Style cribbed from flashcards.dwarkesh.com: accent left-border on
// expanded answer, soft hover, monospace numbering, no "flip"
// animation — just expand/collapse, which is more compact and
// keyboard-friendly than 3D card flips.
class PcAnki extends HTMLElement {
  connectedCallback() {
    const cards = _pcData(this, []);
    if (!Array.isArray(cards) || !cards.length) { this.innerHTML = '<em>pc-anki: empty data</em>'; return; }
    const items = cards.map((c, i) => `
      <li class="pc-anki-card" data-i="${i}">
        <button type="button" class="pc-anki-q" aria-expanded="false">
          <span class="pc-anki-num">${String(i + 1).padStart(2, '0')}</span>
          <span class="pc-anki-q-text">${c.q || ''}</span>
          <span class="pc-anki-chev" aria-hidden="true">▸</span>
        </button>
        <div class="pc-anki-a" hidden>
          <div class="pc-anki-a-inner">${c.a || ''}</div>
        </div>
      </li>`).join('');
    // pc-anki is a review-card DECK, not a figure — it's a pedagogical
    // self-test, not a data display. Rendered as a <section> so it
    // doesn't get figcaption/zoom semantics, and styled as its own
    // "pc-anki-deck" container (existing pc-anki child classes still
    // apply via .pc-anki-list / .pc-anki-card / etc).
    this.innerHTML = `
      <section class="pc-anki-deck pc-rise">
        <div class="pc-anki-head">
          <div class="pc-eyebrow">Review · ${cards.length} card${cards.length === 1 ? '' : 's'}</div>
          <button type="button" class="pc-anki-toggle">Expand all</button>
        </div>
        <ul class="pc-anki-list">${items}</ul>
      </section>`;
    if (window.pcMath) window.pcMath.renderMathIn(this);
    const list = this.querySelector('.pc-anki-list');
    const expandBtn = this.querySelector('.pc-anki-toggle');
    const allCards = list.querySelectorAll('.pc-anki-card');
    function setOpen(card, open) {
      const a = card.querySelector('.pc-anki-a');
      const q = card.querySelector('.pc-anki-q');
      a.hidden = !open;
      q.setAttribute('aria-expanded', open ? 'true' : 'false');
      card.classList.toggle('pc-anki-open', open);
    }
    list.addEventListener('click', (e) => {
      const btn = e.target.closest('.pc-anki-q');
      if (!btn) return;
      const card = btn.parentElement;
      const open = card.classList.contains('pc-anki-open');
      setOpen(card, !open);
      refreshToggle();
    });
    expandBtn.addEventListener('click', () => {
      const anyClosed = [...allCards].some(c => !c.classList.contains('pc-anki-open'));
      for (const c of allCards) setOpen(c, anyClosed);
      refreshToggle();
    });
    function refreshToggle() {
      const anyClosed = [...allCards].some(c => !c.classList.contains('pc-anki-open'));
      expandBtn.textContent = anyClosed ? 'Expand all' : 'Collapse all';
    }
  }
}

// --- pc-bibliography + pc-cite ---------------------------------------
// Inline citations in the distill.pub vein. Write the bibliography
// once anywhere in the document (typically inside <div class="pc-appendix">):
//
//   <pc-bibliography>
//     <script type="application/json">
//       [
//         {"key":"lecun2024", "authors":"LeCun, Y.", "year":2024,
//          "title":"A path towards autonomous machine intelligence",
//          "venue":"Position paper", "url":"https://…"},
//         {"key":"jing2021", "authors":"Jing, L. et al.", "year":2021,
//          "title":"Understanding dimensional collapse", "venue":"NeurIPS 2021"}
//       ]
//     </script>
//   </pc-bibliography>
//
// Then cite anywhere in prose:
//
//   …vision JEPAs <pc-cite key="lecun2024"></pc-cite> and the
//   collapse work of <pc-cite key="jing2021"></pc-cite> …
//
// pc-cite renders as a small bracketed superscript [N] (N = order
// the key first appeared on the page). Hover shows a popover with
// the full entry. The bibliography itself also renders below into a
// numbered list <ol class="pc-bib-list"> sorted by first appearance.

// Document-scoped state — accumulates as pc-cite elements connect.
const _pcBib = {
  entries: new Map(),       // key -> {authors, year, title, venue, url, key}
  order:   new Map(),       // key -> index (1-based, first-appearance)
  citers:  new Map(),       // key -> [PcCite, …] (for re-numbering)
  lists:   new Set(),       // <ol class="pc-bib-list"> to keep in sync
};
function _pcBibRegisterEntry(entry) {
  if (!entry || !entry.key) return;
  _pcBib.entries.set(entry.key, entry);
  for (const el of _pcBib.citers.get(entry.key) || []) el._render();
  _pcBibRenderLists();
}
function _pcBibAssignNumber(key) {
  if (!_pcBib.order.has(key)) _pcBib.order.set(key, _pcBib.order.size + 1);
  return _pcBib.order.get(key);
}
function _pcBibFormatEntry(e) {
  if (!e) return '';
  const parts = [];
  if (e.authors) parts.push(`<span style="font-weight: 500;">${_pcEsc(e.authors)}</span>`);
  if (e.year)    parts.push(`(${_pcEsc(e.year)})`);
  if (e.title)   parts.push(`<em>${_pcEsc(e.title)}</em>`);
  if (e.venue)   parts.push(_pcEsc(e.venue));
  let html = parts.join('. ');
  if (e.url) html += ` <a href="${_pcEsc(e.url)}" target="_blank" rel="noopener" style="color:inherit; border-bottom:1px solid var(--border);">${_pcEsc(e.url.replace(/^https?:\/\//, '').slice(0, 60))}</a>`;
  return html;
}
function _pcBibRenderLists() {
  if (!_pcBib.lists.size) return;
  const ordered = [..._pcBib.order.entries()].sort((a, b) => a[1] - b[1]);
  const itemsHtml = ordered.map(([key, n]) => {
    const e = _pcBib.entries.get(key);
    if (!e) return `<li value="${n}" id="ref-${_pcEsc(key)}" style="color: var(--ink-soft);">[${n}] unknown citation key: ${_pcEsc(key)}</li>`;
    return `<li value="${n}" id="ref-${_pcEsc(key)}">${_pcBibFormatEntry(e)}</li>`;
  }).join('');
  for (const ol of _pcBib.lists) {
    ol.innerHTML = itemsHtml;
  }
}
class PcBibliography extends HTMLElement {
  connectedCallback() {
    const list = _pcData(this, []);
    if (Array.isArray(list)) for (const e of list) _pcBibRegisterEntry(e);
    // Render OWN header so the writer never has to (and can't orphan).
    const header = document.createElement('h3');
    header.className = 'pc-bib-header';
    header.textContent = 'References';
    const ol = document.createElement('ol');
    ol.className = 'pc-bib-list';
    ol.style.cssText = 'list-style-position: outside; padding-left: 2em; font-size: 0.88rem; line-height: 1.6em; color: var(--ink); margin: 0;';
    this.innerHTML = '';
    this.appendChild(header);
    this.appendChild(ol);
    _pcBib.lists.add(ol);
    _pcBib.bibs = _pcBib.bibs || new Set();
    _pcBib.bibs.add(this);
    _pcBibRenderLists();
    _pcBibUpdateVisibility();
    // Defensive: hide a sibling <h3>References</h3> the writer may have
    // emitted before us (legacy convention). Done after a tick so any
    // pc-cite elements in later-loaded fragments have a chance to
    // register first.
    setTimeout(() => {
      const prev = this.previousElementSibling;
      if (prev && /^H[2-4]$/.test(prev.tagName) &&
          /^\s*(references|bibliography)\s*$/i.test(prev.textContent || '')) {
        prev.style.display = 'none';
      }
      _pcBibUpdateVisibility();
    }, 0);
  }
  disconnectedCallback() {
    const ol = this.querySelector('ol.pc-bib-list');
    if (ol) _pcBib.lists.delete(ol);
    if (_pcBib.bibs) _pcBib.bibs.delete(this);
  }
}
function _pcBibUpdateVisibility() {
  if (!_pcBib.bibs) return;
  const hasAny = _pcBib.entries.size > 0 || _pcBib.order.size > 0;
  for (const el of _pcBib.bibs) {
    el.style.display = hasAny ? '' : 'none';
  }
}
class PcCite extends HTMLElement {
  connectedCallback() {
    const key = this.getAttribute('key') || '';
    if (!key) { this.innerHTML = '<span style="color: var(--ink-soft);">[?]</span>'; return; }
    this._key = key;
    if (!_pcBib.citers.has(key)) _pcBib.citers.set(key, []);
    _pcBib.citers.get(key).push(this);
    this._render();
  }
  _render() {
    const key = this._key;
    const n = _pcBibAssignNumber(key);
    const entry = _pcBib.entries.get(key);
    const tip = entry ? _pcBibFormatEntry(entry) : `unknown citation key: ${_pcEsc(key)}`;
    // Clicking a citation should open the source, full stop.
    // Resolve to a real URL in this order:
    //  1. entry.url from the bibliography (best — direct paper link)
    //  2. Google Scholar search on title/authors (when bibliography has
    //     no url but does have title/authors)
    //  3. Google Scholar search on the bare key (when the bibliography
    //     hasn't loaded yet, or has no entry for this key) — better
    //     than dropping the reader at a broken in-page anchor.
    let target;
    if (entry && entry.url) {
      target = entry.url;
    } else if (entry && (entry.title || entry.authors)) {
      const q = [entry.title, entry.authors, entry.year].filter(Boolean).join(' ');
      target = `https://scholar.google.com/scholar?q=${encodeURIComponent(q)}`;
    } else {
      target = `https://scholar.google.com/scholar?q=${encodeURIComponent(key)}`;
    }
    const href = _pcEsc(target);
    const targetAttr = ' target="_blank" rel="noopener noreferrer"';
    this.innerHTML = `<a href="${href}"${targetAttr} class="pc-cite"
      style="color: var(--accent); text-decoration: none; font-size: 0.78em; vertical-align: super; line-height: 0; padding: 0 .1em;"
      data-key="${_pcEsc(key)}">[${n}]</a>`;
    const anchor = this.querySelector('a');
    if (!anchor) return;
    const tipEl = document.createElement('div');
    tipEl.className = 'pc-cite-tip';
    tipEl.setAttribute('role', 'tooltip');
    tipEl.style.cssText = 'position: absolute; z-index: 9999; max-width: 360px; padding: .6em .8em; background: var(--paper); border: 1px solid var(--border); border-radius: 4px; font-family: var(--serif); font-size: 0.85rem; line-height: 1.5em; color: var(--ink); box-shadow: 0 4px 16px rgba(0,0,0,0.08); pointer-events: none; opacity: 0; transition: opacity 0.12s ease; vertical-align: baseline;';
    tipEl.innerHTML = tip;
    document.body.appendChild(tipEl);
    const showTip = () => {
      const r = anchor.getBoundingClientRect();
      tipEl.style.left = '0px'; tipEl.style.top = '0px';
      const tw = tipEl.offsetWidth, th = tipEl.offsetHeight;
      let left = r.left + window.scrollX;
      if (left + tw > window.innerWidth - 8) left = window.innerWidth - tw - 8;
      let top = r.bottom + window.scrollY + 6;
      if (top + th > window.scrollY + window.innerHeight - 8) top = r.top + window.scrollY - th - 6;
      tipEl.style.left = `${left}px`;
      tipEl.style.top = `${top}px`;
      tipEl.style.opacity = '1';
    };
    const hideTip = () => { tipEl.style.opacity = '0'; };
    anchor.addEventListener('mouseenter', showTip);
    anchor.addEventListener('mouseleave', hideTip);
    anchor.addEventListener('focus', showTip);
    anchor.addEventListener('blur', hideTip);
  }
}

// --- pc-header --------------------------------------------------------
// Paper-mode hero block — mocks the distill.pub article header.
// Replaces the Abstract section. Use ONCE per paper site, at the top
// of index.html, before any <section class="pc-page">.
//
// Five structural pieces (in vertical order):
//  1. Title — large serif, weight 400, ~50px, tight letter-spacing.
//  2. Dek — one oversized sentence (~150% body), weight 300, full ink.
//     This is the distill "hook". Make it a CLAIM, not a description.
//  3. Hairline rule (above byline).
//  4. 4-column byline grid: AUTHORS / AFFILIATIONS / PUBLISHED / DOI.
//     Tiny uppercase mono column headers, subdued links.
//  5. Hairline rule (below byline) + optional hero figure.
//
// Schema:
//   {
//     title:    "LLM-JEPA: Joint Embedding Predictive Architectures for LLMs",
//     dek:      "Adding a single embedding-space term to next-token loss
//                lifts language-model accuracy by ~20 points on regex
//                generation — using only (text, code) pairs that real
//                datasets already contain.",
//     authors:  ["Hai Huang", "Yann LeCun", "Randall Balestriero"],
//     affiliations?: ["Atlassian", "Meta-FAIR / NYU", "Brown University"],
//     published?: "October 2025",
//     doi?:     "arXiv:2510.12345",
//     doi_url?: "https://arxiv.org/abs/2510.12345",
//     hero?:    "<svg viewBox='...'>...</svg>"   // raw HTML for an inline figure
//   }
// The DEK should be a single sentence that lands the central CLAIM —
// don't recap the abstract. Distill.pub style: one strong sentence,
// then move on.
class PcHeader extends HTMLElement {
  connectedCallback() {
    const d = _pcData(this, {});
    // Fallback: accept individual data-* attributes
    // (data-title, data-dek, data-authors="A · B · C", data-affiliation,
    // data-affiliations, data-published, data-doi, data-doi-url) — some
    // writers reach for the HTML5 form rather than the JSON-in-<script>
    // form. Splitting `data-authors` on " · " (used to render mid-dots
    // between names) keeps the array contract.
    const split = (s) => String(s || '').split(/\s*·\s*|\s*,\s*|\s*;\s*/).map(x => x.trim()).filter(Boolean);
    if (!d.title && this.dataset.title) d.title = this.dataset.title;
    if (!d.dek && this.dataset.dek) d.dek = this.dataset.dek;
    if (!d.authors && this.dataset.authors) d.authors = split(this.dataset.authors);
    if (!d.affiliations && (this.dataset.affiliations || this.dataset.affiliation)) {
      d.affiliations = split(this.dataset.affiliations || this.dataset.affiliation);
    }
    if (!d.published && this.dataset.published) d.published = this.dataset.published;
    if (!d.doi && this.dataset.doi) d.doi = this.dataset.doi;
    if (!d.doi_url && (this.dataset.doiUrl || this.dataset['doi-url'])) d.doi_url = this.dataset.doiUrl || this.dataset['doi-url'];
    if (!d.title) { this.innerHTML = '<em>pc-header: need title</em>'; return; }
    const authors = Array.isArray(d.authors) ? d.authors : [];
    const affs = Array.isArray(d.affiliations) ? d.affiliations : [];
    const hasByline = authors.length || d.published || d.doi;
    const authorsCol = authors.length
      ? authors.map(a => `<p class="pc-hero-author">${_pcEsc(a)}</p>`).join('')
      : '';
    const affsCol = (affs.length && authors.length)
      ? authors.map((_, i) => `<p class="pc-hero-aff">${_pcEsc(affs[i] || '')}</p>`).join('')
      : '';
    const doiLink = d.doi
      ? (d.doi_url
          ? `<a href="${_pcEsc(d.doi_url)}" target="_blank" rel="noopener">${_pcEsc(d.doi)}</a>`
          : _pcEsc(d.doi))
      : '';
    this.innerHTML = `
      <header class="pc-hero pc-rise">
        <h1 class="pc-hero-title">${_pcEsc(d.title)}</h1>
        ${d.dek ? `<p class="pc-hero-dek">${_pcEsc(d.dek)}</p>` : ''}
        ${hasByline ? `
          <div class="pc-hero-byline">
            ${authorsCol ? `<div class="pc-hero-col"><h3>Authors</h3>${authorsCol}</div>` : ''}
            ${affsCol ? `<div class="pc-hero-col"><h3>Affiliations</h3>${affsCol}</div>` : ''}
            ${d.published ? `<div class="pc-hero-col"><h3>Published</h3><p>${_pcEsc(d.published)}</p></div>` : ''}
            ${d.doi ? `<div class="pc-hero-col"><h3>DOI</h3><p>${doiLink}</p></div>` : ''}
          </div>` : ''}
        ${d.hero ? `<figure class="pc-hero-fig">${d.hero}</figure>` : ''}
      </header>`;
  }
}

// --- pc-table ---------------------------------------------------------
// Tabular data — benchmark accuracy, ablation results, comparison rows.
// PREFER over pc-grid when every row shares the same columns; reserve
// pc-grid for taxonomic cards (different bodies per card). Numeric
// columns get right-aligned monospace; the best value per numeric
// column can be bolded via `highlightBest`.
//
// Schema:
//   {
//     title?: "Llama-3.2-1B fine-tune accuracy (mean ± std, 5 seeds)",
//     columns: [
//       {label: "Method",       align: "left"},
//       {label: "NL-RX-SYNTH",  align: "right", unit: "%"},
//       {label: "Spider",       align: "right", unit: "%"}
//     ],
//     rows: [
//       {cells: ["Baseline (NTP)", 51.6, 11.5]},
//       {cells: ["LLM-JEPA",       66.6, 20.2], highlight: true}
//     ],
//     highlightBest?: true,   // bold the max numeric value per column
//     caption?: "Source: Table 1."
//   }
// A cell may be `{value, std}` instead of a number → prints
// "51.6 ± 5.3" with std rendered smaller.
class PcTable extends HTMLElement {
  connectedCallback() {
    const d = _pcData(this, {});
    const cols = d.columns || d.headers || [];
    const rows = d.rows || d.data || [];
    if (!cols.length || !rows.length) { this.innerHTML = '<em>pc-table: need columns + rows</em>'; return; }
    const isNum = (v) => typeof v === 'number' && isFinite(v);
    const fmtN = (n) => (Math.abs(n) < 100 && !Number.isInteger(n)) ? n.toFixed(1) : String(n);
    const cellValue = (cell) => (typeof cell === 'object' && cell != null && 'value' in cell) ? cell.value : cell;
    const fmtCell = (cell, col) => {
      if (cell == null) return '';
      const unit = col.unit ? `<span style="color: var(--ink-soft); font-size: 0.85em; margin-left: 0.1em;">${col.unit}</span>` : '';
      if (typeof cell === 'object' && cell != null && 'value' in cell) {
        const stdPart = isNum(cell.std) ? ` <span style="color: var(--ink-soft); font-size: 0.85em;">± ${fmtN(cell.std)}</span>` : '';
        return `${isNum(cell.value) ? fmtN(cell.value) : _pcEsc(cell.value)}${unit}${stdPart}`;
      }
      if (isNum(cell)) return `${fmtN(cell)}${unit}`;
      return _pcEsc(cell);
    };
    const bestByCol = cols.map((_col, ci) => {
      if (!d.highlightBest || ci === 0) return null;
      let best = -Infinity, ok = false;
      for (const r of rows) {
        const v = cellValue(r.cells?.[ci]);
        if (isNum(v)) { ok = true; if (v > best) best = v; }
      }
      return ok ? best : null;
    });
    const headerHtml = cols.map(c => `
      <th style="text-align: ${c.align || 'left'}; padding: .5rem .8rem; border-bottom: 1.5px solid var(--ink-soft);
                 font-family: var(--mono); font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase;
                 color: var(--ink-soft); font-weight: 500;">${_pcEsc(c.label)}</th>`).join('');
    const rowsHtml = rows.map(r => {
      const rowStyle = r.highlight ? 'background: var(--accent-soft);' : '';
      const cellsHtml = (r.cells || []).map((cell, ci) => {
        const col = cols[ci] || {};
        const val = cellValue(cell);
        const isBest = bestByCol[ci] != null && val === bestByCol[ci];
        const weight = (r.highlight || isBest) ? 600 : 400;
        const color = r.highlight ? 'var(--accent)' : 'var(--ink)';
        const family = (ci === 0 && (col.align || 'left') === 'left') ? 'inherit' : 'var(--mono)';
        return `<td style="text-align: ${col.align || 'left'}; padding: .45rem .8rem;
                          border-bottom: 1px solid var(--border);
                          font-family: ${family}; font-weight: ${weight}; color: ${color};">${fmtCell(cell, col)}</td>`;
      }).join('');
      return `<tr style="${rowStyle}">${cellsHtml}</tr>`;
    }).join('');
    this.innerHTML = `
      <figure class="pc-fig-interactive pc-rise" style="padding: 0; background: transparent; border: none;">
        ${d.title ? `<figcaption style="text-align:left; font-family: var(--mono); font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-soft); margin-bottom:.5rem;">${_pcEsc(d.title)}</figcaption>` : ''}
        <div style="overflow-x: auto;">
          <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
            <thead><tr>${headerHtml}</tr></thead>
            <tbody>${rowsHtml}</tbody>
          </table>
        </div>
        ${d.caption ? `<div style="margin-top:.5rem; font-size: 12px; color: var(--ink-soft); line-height: 1.5;">${d.caption}</div>` : ''}
      </figure>`;
  }
}

// --- pc-compare -------------------------------------------------------
// Grouped bar chart — compare N methods across M benchmarks. The
// canonical paper figure shape: "Baseline vs Method-X across SYNTH /
// Spider / GSM8K / …". Bars within a category sit side-by-side, color-
// coded by series; category labels render under each group.
//
// Schema:
//   {
//     title?: "Baseline vs LLM-JEPA",
//     categories: ["NL-RX-SYNTH", "NL-RX-TURK", "Spider", "GSM8K"],
//     series: [
//       {name: "Baseline", values: [51.6, 27.2, 11.5, 19.4]},
//       {name: "LLM-JEPA", values: [66.6, 31.6, 20.2, 51.5]}
//     ],
//     yLabel?: "Accuracy (%)",
//     yMax?: 100         // optional manual ceiling
//   }
class PcCompare extends HTMLElement {
  connectedCallback() {
    const d = _pcData(this, {});
    const cats = d.categories || [];
    const series = d.series || [];
    if (!cats.length || !series.length) { this.innerHTML = '<em>pc-compare: need categories + series</em>'; return; }
    const W = 620, H = 340, m = { l: 52, r: 18, t: 28, b: 70 };
    const innerW = W - m.l - m.r, innerH = H - m.t - m.b;
    const allVals = series.flatMap(s => s.values || []).filter(v => typeof v === 'number');
    const ymin = Math.min(0, ...allVals);
    const yMaxAuto = Math.max(...allVals, 0) * 1.1;
    const ymax = d.yMax != null ? d.yMax : (yMaxAuto || 1);
    const sy = (v) => m.t + innerH - ((v - ymin) / (ymax - ymin || 1)) * innerH;
    const groupW = innerW / cats.length;
    const groupPad = groupW * 0.18;
    const barW = (groupW - groupPad * 2) / series.length;
    const palette = ['var(--ink-soft)', 'var(--accent)', 'var(--accent-alt)'];
    const fmtN = (v) => (Math.abs(v) < 100 && !Number.isInteger(v)) ? v.toFixed(1) : String(v);
    let html = '';
    cats.forEach((cat, ci) => {
      const groupX = m.l + ci * groupW + groupPad;
      series.forEach((s, si) => {
        const v = s.values?.[ci];
        if (typeof v !== 'number') return;
        const x = groupX + si * barW;
        const y = sy(v);
        const color = palette[si % palette.length];
        html += `<g class="pc-compare-bar">
          <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${(sy(0) - y).toFixed(1)}"
                style="fill: ${color}; opacity: 0.88"/>
          <text x="${(x + barW / 2).toFixed(1)}" y="${(y - 4).toFixed(1)}" text-anchor="middle"
                style="font-family: var(--mono); font-size: 10px; fill: var(--ink);">${fmtN(v)}</text>
        </g>`;
      });
      // category label below the group (wraps long labels into two lines)
      const labelX = m.l + ci * groupW + groupW / 2;
      const lbl = String(cat);
      const split = lbl.length > 12 && /\s|-/.test(lbl) ? lbl.split(/[\s-]/) : [lbl];
      const labelLines = split.length > 1 ? [split.slice(0, Math.ceil(split.length/2)).join(' '), split.slice(Math.ceil(split.length/2)).join(' ')] : split;
      labelLines.forEach((ln, li) => {
        html += `<text x="${labelX.toFixed(1)}" y="${(m.t + innerH + 18 + li * 13).toFixed(1)}" text-anchor="middle"
                  style="font-family: var(--mono); font-size: 11px; fill: var(--ink);">${_pcEsc(ln)}</text>`;
      });
    });
    // y-axis tick labels (0 and ymax)
    const yAxisLabels = `
      <text x="${(m.l - 6).toFixed(1)}" y="${(m.t + 4).toFixed(1)}" text-anchor="end" style="font-family: var(--mono); font-size: 10px; fill: var(--ink-soft);">${fmtN(ymax)}</text>
      <text x="${(m.l - 6).toFixed(1)}" y="${(m.t + innerH + 4).toFixed(1)}" text-anchor="end" style="font-family: var(--mono); font-size: 10px; fill: var(--ink-soft);">${fmtN(ymin)}</text>`;
    const legendHtml = series.length > 1
      ? `<div style="display:flex; gap:1.2rem; justify-content:center; margin-top:.6rem; font-size: 12px; font-family: var(--mono); color: var(--ink);">
        ${series.map((s, i) => `<span><span style="display:inline-block; width:11px; height:11px; background:${palette[i % palette.length]}; margin-right:5px; vertical-align:middle;"></span>${_pcEsc(s.name || `series ${i+1}`)}</span>`).join('')}
       </div>`
      : '';
    this.innerHTML = `
      <figure class="pc-fig-interactive pc-rise">
        ${d.title ? `<figcaption style="text-align:center; font-family: var(--mono); font-size: 12px; color: var(--ink-soft); margin-bottom:.4rem;">${_pcEsc(d.title)}</figcaption>` : ''}
        <svg viewBox="0 0 ${W} ${H}" style="width:100%; max-width:${W}px; display:block; margin: 0;">
          <line x1="${m.l}" y1="${m.t}" x2="${m.l}" y2="${m.t + innerH}" style="stroke: var(--ink-soft); stroke-width: 1"/>
          <line x1="${m.l}" y1="${m.t + innerH}" x2="${m.l + innerW}" y2="${m.t + innerH}" style="stroke: var(--ink-soft); stroke-width: 1"/>
          ${yAxisLabels}
          ${d.yLabel ? `<text transform="rotate(-90 14 ${(m.t + innerH / 2).toFixed(1)})" x="14" y="${(m.t + innerH / 2).toFixed(1)}" text-anchor="middle" style="font-family: var(--mono); font-size: 11px; fill: var(--ink-soft);">${_pcEsc(d.yLabel)}</text>` : ''}
          ${html}
        </svg>
        ${legendHtml}
      </figure>`;
  }
}

// --- pc-pseudocode ----------------------------------------------------
// Algorithm / pseudocode block — monospace body, indentation preserved
// EXACTLY from leading whitespace, inline math (`$…$`) rendered via
// pc-math.js. Use this instead of inline <pre><code> for paper
// Algorithm 1-style boxes AND for real code listings.
//
// Two input forms:
//
//   (a) `code` — a raw multi-line string. WHITESPACE PRESERVED VERBATIM
//       (every space and newline). Use this for actual Python / JS /
//       SQL / shell — paste the code in as-is, including the 4-space
//       function-body indent. NO automatic line numbers (set
//       `numbered: true` to add them).
//
//       {
//         "title": "Block-causal additive attention mask",
//         "language": "python",
//         "code": "def additive_mask(k):\n    \"\"\"Causal within a block.\"\"\"\n    m = torch.zeros((k, k))\n    m[torch.triu(torch.ones(k, k), diagonal=1) == 1] = -torch.inf\n    return m"
//       }
//
//   (b) `lines` — an array of strings. Each line gets a numbered
//       gutter (1..N). Leading whitespace IS preserved as indent.
//       Use this for ALGORITHM pseudocode where step numbers matter.
//
//       {
//         "title": "Algorithm 1: LLM-JEPA training step",
//         "lines": [
//           "Input: paired (Text x, Code y), weight λ, predictor depth k",
//           "[e_text, e_code] ← LLM(concat(x, y), block_causal_mask)",
//           "Pred ← LLM(concat(x, [PRED] × k)).last_hidden",
//           "L_jepa ← 1 − cosine(Pred, e_code)",
//           "L ← L_LLM(x) + λ · L_jepa",
//           "θ ← θ − η · ∇L"
//         ]
//       }
// Lazy-load Prism (core + a requested language) once per page. Returns
// a promise resolving with the global `Prism` object, or null if the
// network load failed. Used by pc-pseudocode for syntax highlighting
// when the writer sets `language: "python"` (or any Prism-supported
// language).
const _prismLoaded = new Map(); // language -> Promise<Prism|null>
let _prismLineNumbersLoaded = null; // Promise<void> for the line-numbers plugin
function _loadPrism(language) {
  if (typeof window === 'undefined') return Promise.resolve(null);
  if (!language) return Promise.resolve(window.Prism || null);
  const key = String(language).toLowerCase();
  if (_prismLoaded.has(key)) return _prismLoaded.get(key);
  const p = (async () => {
    try {
      const loadScript = (src) => new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = src; s.async = false;
        s.onload = () => res();
        s.onerror = () => rej(new Error('failed: ' + src));
        document.head.appendChild(s);
      });
      if (!window.Prism) {
        await loadScript('https://cdn.jsdelivr.net/npm/prismjs@1.29.0/prism.min.js');
        // Suppress Prism's automatic on-load highlight pass; we drive it.
        if (window.Prism) window.Prism.manual = true;
      }
      const lang = window.Prism && window.Prism.languages && window.Prism.languages[key];
      if (!lang) {
        await loadScript(`https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-${key}.min.js`);
      }
      return window.Prism || null;
    } catch { return null; }
  })();
  _prismLoaded.set(key, p);
  return p;
}
// Line-numbers plugin — separate from per-language loading because it
// only needs to load once per page. Uses Prism's official plugin
// (renders a gutter via absolute-positioned <span> CSS counters; works
// fine with multi-line tokens like Python triple-quoted strings).
function _loadPrismLineNumbers() {
  if (typeof window === 'undefined') return Promise.resolve();
  if (_prismLineNumbersLoaded) return _prismLineNumbersLoaded;
  _prismLineNumbersLoaded = (async () => {
    try {
      const loadScript = (src) => new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = src; s.async = false;
        s.onload = () => res();
        s.onerror = () => rej(new Error('failed: ' + src));
        document.head.appendChild(s);
      });
      await loadScript('https://cdn.jsdelivr.net/npm/prismjs@1.29.0/plugins/line-numbers/prism-line-numbers.min.js');
    } catch {}
  })();
  return _prismLineNumbersLoaded;
}

class PcPseudocode extends HTMLElement {
  connectedCallback() {
    const d = _pcData(this, {});
    const code = typeof d.code === 'string' ? d.code : '';
    const lines = Array.isArray(d.lines) ? d.lines : [];
    if (!code && !lines.length) { this.innerHTML = '<em>pc-pseudocode: need `code` or `lines`</em>'; return; }
    const lang = d.language ? String(d.language).toLowerCase() : '';
    const langCls = lang ? ` language-${_pcEsc(lang)}` : '';
    // Auto-detect "this looks like real source code": python keywords or
    // typical operators / call syntax. Lets a `lines` block with no
    // explicit `language` still get reasonable highlighting.
    const autoLang = (s) =>
      /\b(def|return|import|from|class|if|else|elif|for|while|lambda|yield|with|as|in|not|and|or|is|None|True|False)\b/.test(s)
      || /[\(\[\{\}\)\]]/.test(s) && /[=:]/.test(s)
        ? 'python' : '';
    let bodyHtml;
    if (code) {
      // Always render the raw-code form with line numbers (via Prism's
      // line-numbers plugin — handles multi-line tokens like Python
      // triple-quoted strings, which a manual line-split would break).
      bodyHtml = `<pre class="pc-code-block line-numbers"><code class="pc-code${langCls}">${_pcEsc(code.replace(/\n+$/, ''))}</code></pre>`;
    } else {
      // Numbered-lines form: each entry becomes a numbered row with the
      // body wrapped in <code class="pc-code language-X"> so Prism can
      // highlight it the same way it does for the `code` form.
      const inferred = !lang && lines.some(l => autoLang(typeof l === 'string' ? l : (l?.text || '')))
        ? 'python' : '';
      const effLang = lang || inferred;
      const effLangCls = effLang ? ` language-${_pcEsc(effLang)}` : '';
      bodyHtml = lines.map((raw, i) => {
        const text = typeof raw === 'string' ? raw : (raw?.text || '');
        const indentMatch = text.match(/^(\s*)/);
        const indent = indentMatch ? indentMatch[1].length : 0;
        const body = text.slice(indent);
        return `<div class="pc-pc-line">
          <span class="pc-pc-num">${i + 1}</span>
          <code class="pc-code${effLangCls}" style="padding-left: ${indent * 0.6}em;">${_pcEsc(body) || '​'}</code>
        </div>`;
      }).join('');
      // Make the lines branch use the same lang for the highlight loop
      // below.
      d._effLang = effLang;
    }
    const shownLang = d.language || d._effLang;
    this.innerHTML = `
      <figure class="pc-fig-interactive pc-rise pc-pseudocode-fig">
        ${d.title ? `<figcaption class="pc-pc-title">${_pcEsc(d.title)}</figcaption>` : ''}
        ${shownLang ? `<div class="pc-pc-lang">${_pcEsc(shownLang)}</div>` : ''}
        <div class="pc-pc-body">${bodyHtml}</div>
      </figure>`;
    if (window.pcMath) window.pcMath.renderMathIn(this);
    const highlightLang = lang || d._effLang;
    if (highlightLang) {
      // For the `code` form (single <pre class="line-numbers">), load
      // the line-numbers plugin alongside the language grammar so the
      // gutter renders. The `lines` form has its own gutter and
      // doesn't need the plugin.
      const wantsLineNumbers = !!code;
      const ready = wantsLineNumbers
        ? Promise.all([_loadPrism(highlightLang), _loadPrismLineNumbers()]).then(([P]) => P)
        : _loadPrism(highlightLang);
      ready.then(Prism => {
        if (!Prism) return;
        for (const el of this.querySelectorAll('code.pc-code')) {
          try { Prism.highlightElement(el); } catch { /* keep raw on fail */ }
        }
      });
    }
  }
}

customElements.define('pc-chain',      PcChain);
customElements.define('pc-stepped',    PcStepped);
customElements.define('pc-timeline',   PcTimeline);
customElements.define('pc-grid',       PcGrid);
customElements.define('pc-toggle',     PcToggle);
customElements.define('pc-slider',     PcSlider);
customElements.define('pc-plot',       PcPlot);
customElements.define('pc-annotated',  PcAnnotated);
customElements.define('pc-equation',   PcEquation);
customElements.define('pc-tree',       PcTree);
customElements.define('pc-term',       PcTerm);
customElements.define('pc-header',       PcHeader);
customElements.define('pc-table',        PcTable);
customElements.define('pc-compare',      PcCompare);
customElements.define('pc-pseudocode',   PcPseudocode);
customElements.define('pc-bibliography', PcBibliography);
customElements.define('pc-cite',         PcCite);
// --- pc-3d ------------------------------------------------------------
// Generic interactive 3D scene. Load Three.js from a CDN the first
// time a pc-3d appears on the page; render the declarative `data`
// JSON as a small scene the reader can orbit/zoom/pick.
//
// Scene schema:
//   data = {
//     objects: [
//       {type: 'sphere', pos: [x,y,z], r: 0.5, color: '#c25b2a', label?: 'C'},
//       {type: 'box',    pos: [x,y,z], size: [1,1,1], wireframe?: true, color?},
//       {type: 'cylinder', from: [x,y,z], to: [x,y,z], r: 0.05, color?},
//       {type: 'line',   from: [x,y,z], to: [x,y,z], color?, dashed?: bool},
//       {type: 'arrow',  from: [x,y,z], to: [x,y,z], color?},
//       {type: 'label',  pos: [x,y,z], text: 'a'},
//     ],
//     camera?: [x,y,z],         // default [3,3,3]
//     bg?: '#fbf6ea',           // default --paper
//     axes?: bool,              // show x/y/z axes
//     grid?: bool,              // show ground grid
//     autoRotate?: bool,        // rotate slowly until user interacts
//     caption?: string,         // text rendered under the canvas
//   }
//
// Common use cases:
//   - Crystal unit cells (atoms + bonds + bounding box)
//   - Molecules (atoms + bonds, colored by element)
//   - Vector fields (lots of arrows)
//   - Geometry / polyhedra
//   - Force diagrams in 3-space
let _threePromise = null;
function _loadThree() {
  if (_threePromise) return _threePromise;
  _threePromise = (async () => {
    const imap = document.createElement('script');
    imap.type = 'importmap';
    imap.textContent = JSON.stringify({
      imports: {
        three: 'https://cdn.jsdelivr.net/npm/three@0.169/build/three.module.js',
        'three/addons/': 'https://cdn.jsdelivr.net/npm/three@0.169/examples/jsm/',
      },
    });
    if (!document.querySelector('script[type="importmap"]')) {
      document.head.appendChild(imap);
    }
    const [THREE, { OrbitControls }] = await Promise.all([
      import('three'),
      import('three/addons/controls/OrbitControls.js'),
    ]);
    return { THREE, OrbitControls };
  })();
  return _threePromise;
}
class Pc3D extends HTMLElement {
  async connectedCallback() {
    const d = _pcData(this, {});
    const objects = Array.isArray(d.objects) ? d.objects : [];
    this.innerHTML = `
      <figure class="pc-fig-interactive pc-rise" style="margin: 1rem auto;">
        <div class="pc-3d-host" style="aspect-ratio: 1.4; width: 100%; max-width: 560px; margin: 0 auto;
             background: ${_pcEsc(d.bg || 'var(--paper)')}; border-radius: 6px; overflow: hidden;
             border: 1px solid var(--border); position: relative;">
          <div class="pc-3d-hint" style="position: absolute; top: 8px; left: 12px;
               font-family: var(--mono); font-size: 10px; color: var(--ink-soft); opacity: 0.7;
               pointer-events: none; letter-spacing: 0.06em;">drag to rotate · scroll to zoom</div>
        </div>
        ${d.caption ? `<figcaption style="text-align: center; font-size: 13px; color: var(--ink-soft); margin-top: .4rem;">${_pcEsc(d.caption)}</figcaption>` : ''}
      </figure>`;
    const host = this.querySelector('.pc-3d-host');
    let lib;
    try { lib = await _loadThree(); }
    catch (e) { host.textContent = 'pc-3d: failed to load Three.js — ' + e.message; return; }
    const { THREE, OrbitControls } = lib;
    const w = host.clientWidth || 560;
    const h = host.clientHeight || 400;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 1000);
    const cam = d.camera || [3, 3, 3];
    camera.position.set(cam[0], cam[1], cam[2]);
    camera.lookAt(0, 0, 0);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(w, h);
    renderer.setPixelRatio(window.devicePixelRatio);
    host.appendChild(renderer.domElement);
    scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const key = new THREE.DirectionalLight(0xffffff, 0.7);
    key.position.set(5, 8, 5);
    scene.add(key);
    if (d.axes) {
      const ax = new THREE.AxesHelper(1.5);
      scene.add(ax);
    }
    if (d.grid) {
      const grid = new THREE.GridHelper(4, 8, 0xc25b2a, 0xd9cdb0);
      scene.add(grid);
    }
    // --- Build objects ---
    const labels = [];  // {text, pos: THREE.Vector3}
    const v = (a) => new THREE.Vector3(a[0] || 0, a[1] || 0, a[2] || 0);
    for (const o of objects) {
      const color = o.color || '#c25b2a';
      if (o.type === 'sphere') {
        const m = new THREE.Mesh(
          new THREE.SphereGeometry(o.r ?? 0.3, 32, 24),
          new THREE.MeshStandardMaterial({ color, roughness: 0.4, metalness: 0.1 }),
        );
        m.position.copy(v(o.pos || [0, 0, 0]));
        scene.add(m);
        if (o.label) labels.push({ text: o.label, pos: m.position.clone() });
      } else if (o.type === 'box') {
        const size = o.size || [1, 1, 1];
        const geo = new THREE.BoxGeometry(size[0], size[1], size[2]);
        let mesh;
        if (o.wireframe) {
          mesh = new THREE.LineSegments(new THREE.EdgesGeometry(geo),
            new THREE.LineBasicMaterial({ color }));
        } else {
          mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, roughness: 0.5 }));
        }
        mesh.position.copy(v(o.pos || [0, 0, 0]));
        scene.add(mesh);
      } else if (o.type === 'cylinder' || o.type === 'line' || o.type === 'arrow') {
        const a = v(o.from || [0, 0, 0]);
        const b = v(o.to || [1, 0, 0]);
        if (o.type === 'line') {
          const geo = new THREE.BufferGeometry().setFromPoints([a, b]);
          const mat = o.dashed
            ? new THREE.LineDashedMaterial({ color, dashSize: 0.1, gapSize: 0.05 })
            : new THREE.LineBasicMaterial({ color });
          const line = new THREE.Line(geo, mat);
          if (o.dashed) line.computeLineDistances();
          scene.add(line);
        } else if (o.type === 'arrow') {
          const dir = b.clone().sub(a);
          const len = dir.length();
          dir.normalize();
          const helper = new THREE.ArrowHelper(dir, a, len, new THREE.Color(color), 0.18, 0.1);
          scene.add(helper);
        } else {
          // cylinder = stick (for bonds)
          const len = a.distanceTo(b);
          const r = o.r ?? 0.05;
          const geo = new THREE.CylinderGeometry(r, r, len, 16);
          const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, roughness: 0.5 }));
          mesh.position.copy(a.clone().add(b).multiplyScalar(0.5));
          mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
          scene.add(mesh);
        }
      } else if (o.type === 'label') {
        labels.push({ text: o.text || '', pos: v(o.pos || [0, 0, 0]) });
      }
    }
    // 2D HTML labels overlaid on the canvas (projected each frame).
    const labelLayer = document.createElement('div');
    Object.assign(labelLayer.style, { position: 'absolute', inset: '0', pointerEvents: 'none' });
    host.appendChild(labelLayer);
    const labelEls = labels.map(({ text }) => {
      const el = document.createElement('div');
      el.textContent = text;
      Object.assign(el.style, {
        position: 'absolute', font: '12px var(--mono)', color: 'var(--ink)',
        background: 'rgba(251,246,234,0.85)', padding: '1px 5px', borderRadius: '3px',
        border: '1px solid var(--border)', transform: 'translate(-50%, -50%)',
        whiteSpace: 'nowrap',
      });
      labelLayer.appendChild(el);
      return el;
    });
    // Controls
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.1;
    controls.autoRotate = !!d.autoRotate;
    controls.autoRotateSpeed = 0.6;
    controls.addEventListener('start', () => { controls.autoRotate = false; });
    // Render loop
    const tmp = new THREE.Vector3();
    let stopped = false;
    const tick = () => {
      if (stopped || !this.isConnected) return;
      controls.update();
      // Project labels
      for (let i = 0; i < labels.length; i++) {
        tmp.copy(labels[i].pos).project(camera);
        const x = (tmp.x * 0.5 + 0.5) * w;
        const y = (-tmp.y * 0.5 + 0.5) * h;
        const visible = tmp.z < 1;
        const el = labelEls[i];
        el.style.left = `${x}px`;
        el.style.top = `${y}px`;
        el.style.opacity = visible ? '1' : '0';
      }
      renderer.render(scene, camera);
      requestAnimationFrame(tick);
    };
    tick();
    // Resize on element resize
    const ro = new ResizeObserver(() => {
      const nw = host.clientWidth || w, nh = host.clientHeight || h;
      camera.aspect = nw / nh;
      camera.updateProjectionMatrix();
      renderer.setSize(nw, nh);
    });
    ro.observe(host);
  }
}

customElements.define('pc-anki',      PcAnki);
customElements.define('pc-3d',        Pc3D);
