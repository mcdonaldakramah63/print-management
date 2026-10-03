// ---------------------------------------------------------------
// State
// ---------------------------------------------------------------
let currentUser = null;
let currentSettings = null;
let catalog = [];          // active products, for the checkout
let cart = [];             // [{ key, product_id, name, unit_price, qty, session_id? }]
let cartSessions = new Map(); // print session id -> label, billed by this sale
let cartCopies = new Map();   // photocopy run id -> label, billed by this sale
let cartMotion = null;        // { key, kind: 'new' | 'bump' } for the next cart render
let cartKey = 0;
let payMethod = 'cash';
let catalogCategory = 'All';
let currentView = null;
let currentRoute = null;  // view plus its parameter, e.g. "printer/3/HP M479"
let routeParam = '';
let historyPage = 1;

const ADMIN_VIEWS = ['products', 'print-monitor', 'reconcile', 'users', 'settings', 'customers'];
const VIEWS = ['dashboard', 'sale', 'history', 'reports', 'customers', 'printers', 'printer', 'print-monitor', 'reconcile', 'products', 'users', 'settings', 'account'];
const PAY_LABELS = { cash: 'Cash', momo: 'Mobile money', card: 'Card' };

const $ = (id) => document.getElementById(id);
const isAdmin = () => currentUser && currentUser.role === 'admin';
const cur = (n) => money(n, currentSettings.currency);
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// ---------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------
(async function init() {
  let me;
  try {
    me = await api('GET', '/api/auth/me');
  } catch (_) {
    me = { user: null };
  }
  if (!me.user) {
    window.location.href = 'login.html';
    return;
  }
  currentUser = me.user;
  $('nav-user-name').textContent = currentUser.full_name;
  $('nav-user-role').textContent = currentUser.role;
  $('nav-avatar').textContent = initials(currentUser.full_name || currentUser.username);

  if (!isAdmin()) document.querySelectorAll('.admin-only').forEach((el) => el.remove());

  await loadSettings();
  await loadCatalog();

  setupNav();
  setupSale();
  setupCustomerLookup();
  setupHistory();
  setupReports();
  setupPrinters();
  setupPrinterDetail();
  if (isAdmin()) {
    setupPrintMonitor();
    setupReconcile();
    setupCustomers();
    setupTraffic();
    setupSupplies();
    setupProducts();
    setupUsers();
    setupSettings();
    refreshUnreviewedCount();
  }
  setupAccount();

  navigateTo(decodeURIComponent(location.hash.replace('#', '')) || 'dashboard');
  window.addEventListener('hashchange', () => {
    const route = decodeURIComponent(location.hash.replace('#', ''));
    if (route && route !== currentRoute) navigateTo(route);
  });
})();

function initials(name) {
  return String(name).split(/\s+/).filter(Boolean).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
}

async function loadSettings() {
  const { settings } = await api('GET', '/api/settings');
  currentSettings = settings;
  $('brand-business').textContent = settings.business_name;
}

async function loadCatalog() {
  const { products } = await api('GET', '/api/products');
  catalog = products;
}

$('logout-btn').addEventListener('click', async () => {
  try { await api('POST', '/api/auth/logout'); } catch (_) { /* leaving anyway */ }
  window.location.href = 'login.html';
});

// ---------------------------------------------------------------
// Small UI helpers: toasts, modals, errors
// ---------------------------------------------------------------
const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------------------------------------------------------------
// Ambient effects: spotlight on glass, ripples, counting numbers,
// the ink splash on a completed sale. All skip under reduced motion.
// ---------------------------------------------------------------
(function setupEffects() {
  // A soft light follows the pointer over glass panels (fine pointers only).
  if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
    let target = null;
    let frame = 0;
    let pos = null;
    document.addEventListener('pointermove', (e) => {
      const el = e.target.closest && e.target.closest('.tile, .card');
      if (target && target !== el) { target.style.removeProperty('--mx'); target.style.removeProperty('--my'); }
      target = el;
      pos = { x: e.clientX, y: e.clientY };
      if (!el || frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (!target) return;
        const r = target.getBoundingClientRect();
        target.style.setProperty('--mx', `${pos.x - r.left}px`);
        target.style.setProperty('--my', `${pos.y - r.top}px`);
      });
    }, { passive: true });
    document.addEventListener('pointerleave', () => { if (target) { target.style.removeProperty('--mx'); target.style.removeProperty('--my'); target = null; } });
  }

  // Press ripple from the point of contact.
  document.addEventListener('pointerdown', (e) => {
    const b = e.target.closest && e.target.closest('.btn, .chip, .segmented button');
    if (!b || b.disabled || reduceMotion()) return;
    const r = b.getBoundingClientRect();
    const size = Math.max(r.width, r.height) * 2.2;
    const dot = document.createElement('span');
    dot.className = 'ripple';
    dot.style.cssText = `width:${size}px;height:${size}px;left:${e.clientX - r.left - size / 2}px;top:${e.clientY - r.top - size / 2}px`;
    if (getComputedStyle(b).position === 'static') b.style.position = 'relative';
    b.appendChild(dot);
    setTimeout(() => dot.remove(), 600);
  });

  // KPI numbers count from their last value (or zero) to the new one.
  const lastKpi = new Map();
  const countUp = (el) => {
    const card = el.closest('.kpi');
    const key = card ? card.querySelector('.kpi-label')?.textContent : null;
    const text = el.textContent;
    const m = /^(.*?)(-?\d[\d,]*(?:\.\d+)?)(.*)$/.exec(text);
    const prev = key ? lastKpi.get(key) : null;
    if (key) lastKpi.set(key, text);
    if (!m || reduceMotion() || prev === text || document.hidden) return;
    const decimals = (m[2].split('.')[1] || '').length;
    const to = Number(m[2].replace(/,/g, ''));
    const pm = prev && /(-?\d[\d,]*(?:\.\d+)?)/.exec(prev);
    const from = pm ? Number(pm[1].replace(/,/g, '')) : 0;
    if (!Number.isFinite(to) || from === to) return;
    const fmt = (v) => `${m[1]}${v.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}${m[3]}`;
    const start = performance.now();
    const dur = 700;
    el.classList.add('counting');
    const step = (now) => {
      const k = Math.min(1, (now - start) / dur);
      const v = from + (to - from) * (1 - (1 - k) ** 3);
      el.textContent = k < 1 ? fmt(v) : text;
      if (k < 1) requestAnimationFrame(step); else el.classList.remove('counting');
    };
    el.textContent = fmt(from);
    requestAnimationFrame(step);
  };
  new MutationObserver((records) => {
    for (const r of records) for (const n of r.addedNodes) {
      if (n.nodeType !== 1) continue;
      if (n.classList.contains('kpi-value')) countUp(n);
      n.querySelectorAll && n.querySelectorAll('.kpi-value').forEach(countUp);
    }
  }).observe(document.querySelector('.main') || document.body, { childList: true, subtree: true });

  // The ink field rests while the tab is hidden.
  const field = document.querySelector('.ink-field');
  if (field) document.addEventListener('visibilitychange', () => field.classList.toggle('paused', document.hidden));
}());

// A splash of process ink from a button: a completed sale is worth a moment.
function inkSplash(el) {
  if (!el || reduceMotion() || !el.animate) return;
  const r = el.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const inks = ['#00A0DC', '#D6167A', '#F5C518', '#1B1E24'];
  for (let i = 0; i < 18; i++) {
    const d = document.createElement('span');
    d.className = 'splash-dot';
    d.style.left = `${cx - 4}px`;
    d.style.top = `${cy - 4}px`;
    d.style.background = inks[i % 4];
    document.body.appendChild(d);
    const angle = (Math.PI * 2 * i) / 18 + (Math.random() - 0.5) * 0.5;
    const dist = 60 + Math.random() * 70;
    const dx = Math.cos(angle) * dist;
    const dy = Math.sin(angle) * dist * 0.75 - 30;
    d.animate([
      { transform: 'translate(0, 0) scale(.4)', opacity: 1 },
      { transform: `translate(${dx * 0.7}px, ${dy * 0.7}px) scale(1)`, opacity: 1, offset: 0.55 },
      { transform: `translate(${dx}px, ${dy + 40}px) scale(.6)`, opacity: 0 }
    ], { duration: 820 + Math.random() * 240, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' }).onfinish = () => d.remove();
  }
}

// Toasts rise in with a dwell bar; hovering pauses them. Errors are announced
// assertively, shake once and stay longer (feedback-indicators skill).
function toast(message, isError) {
  const el = document.createElement('div');
  const dwell = isError ? 7000 : 4500;
  el.className = `toast${isError ? ' error' : ''}`;
  el.setAttribute('role', isError ? 'alert' : 'status');
  el.style.setProperty('--dwell', `${dwell}ms`);
  el.innerHTML = `<svg class="toast-icon" viewBox="0 0 24 24" aria-hidden="true">${isError ? '<path d="M12 7v6M12 17h.01"/>' : '<path d="M5 12.5l4.5 4.5L19 7.5"/>'}</svg><span></span><span class="toast-dwell" aria-hidden="true"></span>`;
  el.children[1].textContent = message;
  let stack = document.querySelector('.toast-stack');
  if (!stack) {
    stack = document.createElement('div');
    stack.className = 'toast-stack';
    document.body.appendChild(stack);
  }
  stack.appendChild(el);
  let left = dwell;
  let started = Date.now();
  let timer = null;
  const leave = () => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), reduceMotion() ? 0 : 160);
  };
  const run = () => { started = Date.now(); timer = setTimeout(leave, left); };
  el.addEventListener('mouseenter', () => { clearTimeout(timer); left -= Date.now() - started; });
  el.addEventListener('mouseleave', run);
  run();
}

function showError(el, message) {
  el.textContent = message;
  el.hidden = false;
}

/**
 * Open a modal form. `body` is trusted HTML built with escapeHtml().
 * onSubmit(form) may throw to show an error; resolves → modal closes.
 */
function openModal({ title, body, submitLabel = 'Save', danger = false, wide = false, onSubmit, onOpen, onClose, hideSubmit = false }) {
  const root = $('modal-root');
  const previouslyFocused = document.activeElement;
  root.innerHTML = `
    <div class="modal-backdrop">
      <form class="modal${wide ? ' wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="modal-title" novalidate>
        <h2 id="modal-title">${escapeHtml(title)}</h2>
        <div class="stack">${body}</div>
        <div class="error-text" data-modal-error hidden></div>
        <div class="modal-foot">
          <button type="button" class="btn btn-outline" data-modal-cancel>${hideSubmit ? 'Close' : 'Cancel'}</button>
          ${hideSubmit ? '' : `<button type="submit" class="btn ${danger ? 'btn-danger' : 'btn-primary'}">${escapeHtml(submitLabel)}</button>`}
        </div>
      </form>
    </div>`;
  const backdrop = root.firstElementChild;
  const form = backdrop.querySelector('form');
  const errEl = form.querySelector('[data-modal-error]');

  let closed = false;
  const close = (submitted) => {
    if (closed) return;
    closed = true;
    // Exit runs at ~60% of the entrance; the dialog is gone for input at once.
    backdrop.classList.add('closing');
    backdrop.style.pointerEvents = 'none';
    setTimeout(() => { if (backdrop.parentNode === root) root.innerHTML = ''; }, reduceMotion() ? 0 : 180);
    if (onClose) onClose(!!submitted);
    if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus();
  };
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(false); });
  form.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(false); });
  form.querySelector('[data-modal-cancel]').addEventListener('click', () => close(false));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errEl.hidden = true;
    if (!form.reportValidity()) return;
    const btn = form.querySelector('button[type=submit]');
    if (btn) btn.disabled = true;
    try {
      if (onSubmit) await onSubmit(form);
      close(true);
    } catch (err) {
      showError(errEl, err.message);
    } finally {
      if (btn) btn.disabled = false;
    }
  });
  if (onOpen) onOpen(form);
  const first = form.querySelector('.stack input:not([type=hidden]), .stack select, .stack textarea') || form.querySelector('button');
  if (first) first.focus();
  return form;
}

function confirmModal({ title, message, confirmLabel, danger = true }) {
  return new Promise((resolve) => {
    openModal({
      title,
      body: `<p style="margin:0;">${escapeHtml(message)}</p>`,
      submitLabel: confirmLabel,
      danger,
      onClose: (submitted) => resolve(submitted)
    });
  });
}

function emptyState(text) {
  return `<div class="empty-state">${escapeHtml(text)}</div>`;
}

function statusBadge(ok, yes, no) {
  return ok ? `<span class="badge ok">${yes}</span>` : `<span class="badge danger">${no}</span>`;
}

function payBadge(method) {
  return `<span class="badge${method === 'cash' ? '' : ' info'}">${escapeHtml(PAY_LABELS[method] || method)}</span>`;
}

function dayLabel(dateStr, opts = { weekday: 'short', day: 'numeric', month: 'short' }) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, opts);
}

function daysAgoString(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return localDateString(d);
}

// Opens a tab synchronously (inside the click handler, so it isn't popup-
// blocked) that can be pointed at a URL once an async request finishes.
function openPendingTab() {
  const win = window.open('', '_blank');
  if (win) win.document.write('<p style="font-family:sans-serif;padding:24px;color:#555">Loading&hellip;</p>');
  return {
    go(url) { if (win) win.location.href = url; else window.location.href = url; },
    cancel() { if (win) win.close(); }
  };
}

// ---------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------
function setupNav() {
  document.querySelectorAll('.nav-link[data-view], [data-nav]').forEach((link) => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      navigateTo(link.dataset.view || link.dataset.nav);
    });
  });
}

function navigateTo(target) {
  const [first, ...rest] = String(target || '').split('/');
  let view = first;
  routeParam = rest.join('/');
  if (view === 'printer' && !routeParam) view = 'printers';
  if (!VIEWS.includes(view)) view = 'dashboard';
  if (ADMIN_VIEWS.includes(view) && !isAdmin()) view = 'dashboard';
  if (view !== 'printer') routeParam = '';
  const route = routeParam ? `${view}/${routeParam}` : view;
  const navView = view === 'printer' ? 'printers' : view;

  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
  document.querySelectorAll('.nav-link').forEach((l) => {
    const on = l.dataset.view === navView;
    l.classList.toggle('active', on);
    if (on) l.setAttribute('aria-current', 'page'); else l.removeAttribute('aria-current');
  });
  currentView = view;
  currentRoute = route;
  document.body.dataset.view = view;
  if (decodeURIComponent(location.hash.replace('#', '')) !== route) location.hash = route;
  window.scrollTo(0, 0);

  const loaders = {
    dashboard: loadDashboard,
    sale: enterSale,
    history: loadHistory,
    reports: () => Promise.all([loadReport(), loadClose(), loadClosings(), ...(isAdmin() ? [loadTraffic(), loadMix()] : [])]),
    customers: loadCustomers,
    printers: loadPrinters,
    printer: () => openPrinterDetail(routeParam),
    'print-monitor': () => Promise.all([loadPrintSummary(), loadSessions(), loadCopies(), loadAgents(), loadSupplies()]),
    reconcile: loadReconcile,
    products: loadProducts,
    users: loadUsers,
    settings: fillSettingsForm
  };
  const load = loaders[view];
  if (load) Promise.resolve().then(load).catch((err) => toast(err.message, true));
}

function wireGoLinks(container) {
  container.querySelectorAll('[data-go]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); navigateTo(a.dataset.go); }));
}

// ---------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------
async function loadDashboard() {
  $('dash-date').textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  const [data, forecast, stock, risk] = await Promise.all([
    api('GET', '/api/dashboard/summary'),
    api('GET', '/api/insights/forecast').catch(() => null),
    api('GET', '/api/insights/stock').catch(() => ({ products: [] })),
    isAdmin() ? api('GET', '/api/insights/risk').catch(() => ({ alerts: [] })) : Promise.resolve(null)
  ]);
  if (isAdmin()) {
    api('GET', '/api/insights/toner').then(({ printers }) => {
      $('toner-card').hidden = printers.length === 0;
      $('toner-dash').innerHTML = printers.map((p) => tonerPrinterHtml(p, true)).join('');
    }).catch(() => {});
  }
  $('dash-closed').hidden = !data.closedToday;

  const pace = forecast && forecast.today;
  const PACE_TEXT = { ahead: 'ahead of forecast', behind: 'behind forecast', on_track: 'on track' };
  const todaySub = pace && pace.projected != null
    ? `${plural(data.today.count, 'sale')} · heading for ${cur(pace.projected)} (${PACE_TEXT[pace.pace]})`
    : pace && pace.forecast ? `${plural(data.today.count, 'sale')} · forecast ${cur(pace.forecast)}` : plural(data.today.count, 'sale');

  const kpis = [
    { label: 'Today', value: cur(data.today.revenue), sub: todaySub },
    { label: 'Last 7 days', value: cur(data.last7Days.revenue), sub: plural(data.last7Days.count, 'sale') },
    { label: 'This month', value: cur(data.thisMonth.revenue), sub: plural(data.thisMonth.count, 'sale') }
  ];
  if (data.printing) {
    kpis.push({ label: 'Pages printed today', value: String(data.printing.pages), sub: `${data.printing.color_pages} colour · ${data.printing.mono_pages} B&W` });
  } else {
    const avg = data.today.count ? data.today.revenue / data.today.count : 0;
    kpis.push({ label: 'Average sale today', value: cur(avg), sub: 'Excludes voided sales' });
  }
  $('dash-kpis').innerHTML = kpis.map(kpiCard).join('');

  if (forecast && forecast.forecast.length) renderForecastChart(forecast);
  else {
    renderBarChart(data.dailySeries);
    $('forecast-note').textContent = 'A forecast appears after a week of sales';
  }

  const mixTotal = data.paymentMix.reduce((s, m) => s + m.revenue, 0);
  $('dash-mix').innerHTML = data.paymentMix.length === 0
    ? '<p class="muted" style="margin:0;">No sales yet today.</p>'
    : data.paymentMix.map((m) => meterRow(PAY_LABELS[m.method] || m.method, m.count, m.revenue, mixTotal)).join('');

  const callout = $('dash-print-callout');
  const p = data.printing;
  if (!p) {
    callout.innerHTML = '';
  } else if (!p.has_print_services) {
    callout.innerHTML = `<div class="callout info"><strong>Compare printing with sales</strong><span class="small">Mark your print products as colour or B&amp;W print services to see pages printed vs sold. <a href="#products" data-go="products">Open products</a></span></div>`;
  } else if (p.gap > 0) {
    callout.innerHTML = `<div class="callout"><strong>Print gap today: ${plural(p.gap, 'page')}</strong><span class="small">Agents saw ${p.color_pages + p.mono_pages} colour/B&amp;W pages; ${p.pages_sold} were sold (about ${escapeHtml(cur(p.estimated_value))} unbilled). <a href="#reconcile" data-go="reconcile">Review</a></span></div>`;
  } else {
    callout.innerHTML = `<div class="callout ok"><strong>Printing and sales match today</strong><span class="small">${plural(p.pages_sold, 'page')} sold for ${plural(p.color_pages + p.mono_pages, 'page')} printed.</span></div>`;
  }
  wireGoLinks(callout);

  $('dash-top').innerHTML = data.topItems.length === 0 ? emptyState('No sales in the last 30 days yet.') : `
    <table><thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Revenue</th></tr></thead><tbody>
    ${data.topItems.map((i) => `<tr><td>${escapeHtml(i.name)}</td><td class="num">${round2(i.qty)}</td><td class="num">${escapeHtml(cur(i.revenue))}</td></tr>`).join('')}
    </tbody></table>`;

  renderStockOutlook(stock.products);
  if (risk) renderRisk(risk.alerts);
}

const STOCK_STATUS = {
  out: ['Out of stock', 'danger'],
  order_now: ['Order now', 'danger'],
  order_soon: ['Order soon', 'warn'],
  below_alert: ['Below alert level', 'warn']
};

function renderStockOutlook(products) {
  const attention = products.filter((p) => p.status !== 'ok');
  if (products.length === 0) {
    $('dash-low').innerHTML = '<p class="muted" style="margin:0;">No products track stock yet.</p>';
    return;
  }
  if (attention.length === 0) {
    const next = products.filter((p) => p.days_left !== null).sort((a, b) => a.days_left - b.days_left)[0];
    $('dash-low').innerHTML = `<p class="muted" style="margin:0;">Nothing needs ordering.${next ? ` Next to run low: ${escapeHtml(next.name)}, in about ${plural(Math.round(next.days_left), 'day')}.` : ''}</p>`;
    return;
  }
  $('dash-low').innerHTML = attention.slice(0, 8).map((p) => {
    const [label, cls] = STOCK_STATUS[p.status];
    const when = p.status === 'out' ? 'none left'
      : p.days_left !== null ? `${p.stock_qty} left · runs out in ~${p.days_left < 1 ? 'under a day' : plural(Math.round(p.days_left), 'day')}`
      : `${p.stock_qty} left`;
    return `<div class="list-row">
      <div style="min-width:0;"><div>${escapeHtml(p.name)}</div><div class="muted small">${escapeHtml(when)}${p.daily_rate ? ` · sells ~${p.daily_rate}/day` : ''}</div></div>
      <div class="row" style="gap:6px; flex-wrap:nowrap;">${p.suggested_order ? `<span class="badge info">Order ${p.suggested_order}</span>` : ''}<span class="badge ${cls}">${label}</span></div>
    </div>`;
  }).join('');
}

function renderRisk(alerts) {
  const el = $('risk-list');
  if (!el) return;
  el.innerHTML = alerts.length === 0
    ? '<div class="callout ok"><strong>Nothing unusual</strong><span class="small">Voids, discounts, takings, print gaps and cash closings are all within their normal range.</span></div>'
    : alerts.map((a) => `<div class="risk-row"><span class="sev ${a.severity}">${a.severity}</span><div><strong>${escapeHtml(a.title)}</strong><div class="muted small">${escapeHtml(a.detail)}</div></div></div>`).join('');
}

function renderForecastChart(f) {
  const history = f.history.slice(-21);
  const fc = f.forecast;
  const today = localDateString();
  // Today appears as actual-so-far with its forecast range on top.
  const max = Math.max(1, ...history.map((d) => d.revenue), ...fc.map((p) => p.high), f.today.actual);
  const h = (v) => Math.max(1, Math.round((v / max) * 100));
  const cols = history.map((d) => {
    const label = `${dayLabel(d.day)}: ${cur(d.revenue)}`;
    return `<div class="bar-col" title="${escapeHtml(label)}"><div class="bar ${d.revenue ? '' : 'zero'}" style="height:${h(d.revenue)}%"></div></div>`;
  });
  cols.push('<div class="divider" aria-hidden="true"></div>');
  for (const p of fc) {
    const isToday = p.day === today;
    const label = `${dayLabel(p.day)}: forecast ${cur(p.value)} (likely ${cur(p.low)}–${cur(p.high)})${isToday ? `, so far ${cur(f.today.actual)}` : ''}`;
    cols.push(`<div class="bar-col" title="${escapeHtml(label)}">
      <div class="bar fc" style="height:${h(p.value)}%"></div>
      <div class="range" style="bottom:${h(p.low)}%; height:${Math.max(1, h(p.high) - h(p.low))}%"></div>
      ${isToday ? `<div class="bar today" style="position:absolute; left:25%; width:50%; bottom:0; height:${h(f.today.actual)}%"></div>` : ''}
    </div>`);
  }
  $('dash-chart').innerHTML = cols.join('');
  const first = history[0] || fc[0];
  $('dash-chart-axis').innerHTML = [first.day, today, fc[fc.length - 1].day].map((d, i) => `<span>${escapeHtml(i === 1 ? 'Today' : dayLabel(d, { day: 'numeric', month: 'short' }))}</span>`).join('');
  $('forecast-note').textContent = f.model.name === 'holt-winters'
    ? `Learns your weekly pattern · typical daily error ±${f.accuracy}%`
    : 'Weekday averages (forecast sharpens after 3 weeks of sales)';
}

function kpiCard(k) {
  return `<div class="card kpi"><span class="kpi-label">${escapeHtml(k.label)}</span><span class="kpi-value">${escapeHtml(String(k.value))}</span><span class="kpi-sub">${escapeHtml(k.sub)}</span></div>`;
}

function meterRow(label, count, revenue, total) {
  return `<div class="stack" style="gap:6px;">
    <div class="spread"><span>${escapeHtml(label)} <span class="muted small">(${count})</span></span><span class="mono">${escapeHtml(cur(revenue))}</span></div>
    <div class="meter"><div style="width:${total ? Math.round((revenue / total) * 100) : 0}%"></div></div>
  </div>`;
}

function renderBarChart(series) {
  const max = Math.max(1, ...series.map((d) => d.revenue));
  const today = localDateString();
  $('dash-chart').innerHTML = series.map((d) => {
    const h = Math.round((d.revenue / max) * 100);
    const cls = d.day === today ? 'today' : d.revenue ? '' : 'zero';
    const label = `${dayLabel(d.day)}: ${cur(d.revenue)}`;
    return `<div class="bar-col" title="${escapeHtml(label)}"><div class="bar ${cls}" style="height:${Math.max(h, 1)}%"></div></div>`;
  }).join('');
  const first = series[0], mid = series[Math.floor(series.length / 2)], last = series[series.length - 1];
  $('dash-chart-axis').innerHTML = [first, mid, last].map((d) => `<span>${escapeHtml(dayLabel(d.day, { day: 'numeric', month: 'short' }))}</span>`).join('');
}

// ---------------------------------------------------------------
// New sale (checkout)
// ---------------------------------------------------------------
function setupSale() {
  $('catalog-search').addEventListener('input', renderCatalog);
  $('catalog-search').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const q = e.target.value.trim().toLowerCase();
    if (!q) return;
    // Exact SKU match first (barcode scanners type the SKU then Enter), else the first result.
    const match = catalog.find((p) => p.sku && p.sku.toLowerCase() === q) || filteredCatalog()[0];
    if (match) { addToCart(match); e.target.value = ''; renderCatalog(); }
  });
  $('add-custom-btn').addEventListener('click', () => {
    cart.push({ key: ++cartKey, product_id: null, name: '', unit_price: 0, qty: 1 });
    renderCart();
    const inputs = $('cart-lines').querySelectorAll('.line-name');
    if (inputs.length) inputs[inputs.length - 1].focus();
  });
  $('clear-cart-btn').addEventListener('click', () => { cart = []; cartSessions.clear(); cartCopies.clear(); renderCart(); renderWaitingSessions(); });
  $('waiting-refresh').addEventListener('click', () => loadWaitingSessions());
  $('waiting-list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-add-session]');
    if (b) addSessionToCart(Number(b.dataset.addSession));
    const c = e.target.closest('[data-add-copy]');
    if (c) addCopyToCart(Number(c.dataset.addCopy));
  });
  $('cart-sessions').addEventListener('click', (e) => {
    const b = e.target.closest('[data-remove-session]');
    if (b) {
      const id = Number(b.dataset.removeSession);
      cart = cart.filter((l) => l.session_id !== id);
      cartSessions.delete(id);
    }
    const c = e.target.closest('[data-remove-copy]');
    if (c) {
      const id = Number(c.dataset.removeCopy);
      cart = cart.filter((l) => l.copy_id !== id);
      cartCopies.delete(id);
    }
    if (!b && !c) return;
    renderCart();
    renderWaitingSessions();
  });
  // Keep the waiting list fresh while the till is open.
  setInterval(() => { if (currentView === 'sale') loadWaitingSessions(); }, 30000);
  $('discount-value').addEventListener('input', renderTotals);
  $('discount-type').addEventListener('change', renderTotals);
  $('amount-tendered').addEventListener('input', renderTotals);
  $('pay-methods').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-pay]');
    if (!btn) return;
    payMethod = btn.dataset.pay;
    $('pay-methods').querySelectorAll('[data-pay]').forEach((b) => {
      b.classList.toggle('active', b === btn);
      b.setAttribute('aria-pressed', String(b === btn));
    });
    $('cash-fields').hidden = payMethod !== 'cash';
    renderTotals();
  });

  // Cart line edits (delegated, since lines are re-rendered)
  const lines = $('cart-lines');
  lines.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const line = cart.find((l) => l.key === Number(btn.dataset.key));
    if (!line) return;
    if (btn.dataset.act === 'inc') line.qty = round2(line.qty + 1);
    if (btn.dataset.act === 'dec') line.qty = round2(line.qty - 1);
    if (btn.dataset.act === 'remove' || line.qty <= 0) cart = cart.filter((l) => l !== line);
    renderCart();
  });
  lines.addEventListener('input', (e) => {
    const input = e.target;
    const line = cart.find((l) => l.key === Number(input.dataset.key));
    if (!line) return;
    if (input.dataset.field === 'name') line.name = input.value;
    if (input.dataset.field === 'qty') line.qty = parseFloat(input.value) || 0;
    if (input.dataset.field === 'price') line.unit_price = parseFloat(input.value) || 0;
    // Update only the numbers, not the inputs, so typing isn't interrupted.
    const totalEl = lines.querySelector(`[data-line-total="${line.key}"]`);
    if (totalEl) totalEl.textContent = money(round2(line.qty * line.unit_price), '');
    updateStockWarnings();
    renderTotals();
  });

  $('complete-sale-btn').addEventListener('click', completeSale);
  $('cart-suggestions').addEventListener('click', (e) => {
    const b = e.target.closest('[data-suggest]');
    if (b) addToCart(catalog.find((p) => p.id === Number(b.dataset.suggest)));
  });
}

async function enterSale() {
  $('calc-tax-label').textContent = `Tax (${currentSettings.tax_rate}%)`;
  renderCatalog();
  renderCart();
  loadWaitingSessions();
  $('catalog-search').focus();
  try {
    const { closing } = await api('GET', '/api/reports/close');
    $('sale-closed').hidden = !closing;
    $('complete-sale-btn').disabled = !!closing;
  } catch (_) { /* non-fatal: the server still refuses sales on a closed day */ }
}

function filteredCatalog() {
  const q = $('catalog-search').value.trim().toLowerCase();
  return catalog.filter((p) => (catalogCategory === 'All' || (p.category || 'Other') === catalogCategory) &&
    (!q || p.name.toLowerCase().includes(q) || (p.sku || '').toLowerCase().includes(q) || (p.category || '').toLowerCase().includes(q)));
}

function renderCatalog() {
  const cats = ['All', ...Array.from(new Set(catalog.map((p) => p.category || 'Other'))).sort()];
  if (!cats.includes(catalogCategory)) catalogCategory = 'All';
  const catsEl = $('catalog-cats');
  catsEl.innerHTML = cats.length > 2 ? cats.map((c) => `<button type="button" class="chip${c === catalogCategory ? ' active' : ''}" aria-pressed="${c === catalogCategory}" data-cat="${escapeHtml(c)}">${escapeHtml(c)}</button>`).join('') : '';
  catsEl.querySelectorAll('[data-cat]').forEach((b) => b.addEventListener('click', () => { catalogCategory = b.dataset.cat; renderCatalog(); }));

  const list = filteredCatalog();
  const tiles = $('catalog-tiles');
  if (catalog.length === 0) {
    tiles.innerHTML = emptyState(isAdmin() ? 'No products yet. Add them under Products, or use "+ Custom item".' : 'No products yet. Use "+ Custom item".');
    return;
  }
  tiles.innerHTML = list.length === 0 ? emptyState('No products match.') : list.map((p) => {
    const low = p.track_stock && p.stock_qty <= p.reorder_level;
    const stock = p.track_stock ? `${p.stock_qty} in stock` : (p.print_color_mode ? printServiceLabel(p) : 'Service');
    return `<button type="button" class="tile" data-id="${p.id}">
      <span class="t-name">${escapeHtml(p.name)}</span>
      <span class="t-meta"><span class="t-price">${escapeHtml(cur(p.price))}</span><span class="t-stock${low ? ' low' : ''}">${escapeHtml(stock)}</span></span>
    </button>`;
  }).join('');
  tiles.querySelectorAll('.tile').forEach((t) => t.addEventListener('click', (e) => {
    const r = t.getBoundingClientRect();
    t.style.setProperty('--ink-x', `${(e.clientX || r.left + r.width / 2) - r.left}px`);
    t.style.setProperty('--ink-y', `${(e.clientY || r.top + r.height / 2) - r.top}px`);
    t.classList.remove('inked');
    void t.offsetWidth; // restart the ink drop on every tap
    t.classList.add('inked');
    addToCart(catalog.find((p) => p.id === Number(t.dataset.id)));
  }));
}

function addToCart(product) {
  if (!product) return;
  const line = cart.find((l) => l.product_id === product.id && l.unit_price === product.price && !l.session_id && !l.copy_id);
  if (line) {
    line.qty = round2(line.qty + 1);
    cartMotion = { key: line.key, kind: 'bump' };
  } else {
    cart.push({ key: ++cartKey, product_id: product.id, name: product.name, unit_price: product.price, qty: 1 });
    cartMotion = { key: cartKey, kind: 'new' };
  }
  renderCart();
}

// ---------------------------------------------------------------
// Print sessions waiting at the till
// ---------------------------------------------------------------
let waitingSessions = [];
let waitingCopies = [];

// "B&W print", "Colour photocopy · both sides" ...
function printServiceLabel(p) {
  const what = `${p.print_color_mode === 'color' ? 'Colour' : 'B&W'} ${p.print_kind === 'copy' ? 'photocopy' : 'print'}`;
  return p.print_sides === 2 ? `${what} · both sides, per sheet` : what;
}

async function loadWaitingSessions() {
  const [sessions, copies] = await Promise.all([
    api('GET', '/api/print-sessions/open').then((r) => r.sessions).catch(() => []),
    api('GET', '/api/copies/open').then((r) => r.copies).catch(() => [])
  ]);
  waitingSessions = sessions;
  waitingCopies = copies;
  renderWaitingSessions();
}

const COPY_CONFIDENCE = { high: 'Sure', medium: 'Likely', low: 'Unsure' };

function copyWaitingRow(c) {
  const canAdd = c.suggestion.lines.length > 0;
  const colour = c.color_pages && !c.mono_pages && !c.unknown_pages ? 'colour' : c.unknown_pages ? 'colour not known' : c.color_pages ? `${c.color_pages} colour` : 'B&W';
  return `<div class="waiting-row copy-row">
    <div style="min-width:0;">
      <div><span class="badge info">Photocopies</span> <strong>${escapeHtml(c.printer_name)}</strong> <span class="muted small">· ${escapeHtml(timeOf(c.started_at))}–${escapeHtml(timeOf(c.ended_at))}</span></div>
      <div class="muted small">${plural(c.pages, c.unit === 'sheets' ? 'sheet' : 'page')} · ${escapeHtml(colour)} · ${escapeHtml(COPY_CONFIDENCE[c.confidence])}: no print job behind it</div>
      ${canAdd ? '' : '<div class="small" style="color:var(--warn-ink);">No photocopy or print product matches. Set "Print service" on a product.</div>'}
    </div>
    <button type="button" class="btn btn-outline btn-sm" data-add-copy="${c.id}" ${canAdd ? '' : 'disabled'}>Add to sale</button>
  </div>`;
}

function addCopyToCart(copyId) {
  const c = waitingCopies.find((x) => x.id === copyId);
  if (!c || cartCopies.has(copyId)) return;
  for (const line of c.suggestion.lines) {
    cart.push({ key: ++cartKey, product_id: line.product_id, name: line.name, unit_price: line.unit_price, qty: line.qty, copy_id: copyId });
  }
  cartCopies.set(copyId, `${c.printer_name} · ${plural(c.pages, 'page')}`);
  if (c.unknown_pages) toast('The printer can\'t tell colour from B&W copies. Added as B&W: change the line if they were colour.');
  renderCart();
  renderWaitingSessions();
}

function renderWaitingSessions() {
  const list = waitingSessions.filter((s) => !cartSessions.has(s.id));
  const copies = waitingCopies.filter((c) => !cartCopies.has(c.id));
  $('waiting-sessions').hidden = list.length === 0 && copies.length === 0;
  $('waiting-list').innerHTML = copies.map(copyWaitingRow).join('') + list.map((s) => {
    const pages = s.color_pages + s.mono_pages + s.unknown_pages;
    const alerts = s.flags.filter((f) => ['burst', 'concurrent', 'partial', 'reprint'].includes(f.type));
    const canAdd = s.suggestion.lines.length > 0;
    return `<div class="waiting-row">
      <div style="min-width:0;">
        <div><strong>${escapeHtml(s.owner || 'Unknown user')}</strong>${s.machine ? ` <span class="muted">on ${escapeHtml(s.machine)}</span>` : ''} <span class="muted small">· ${escapeHtml(timeOf(s.ended_at))}</span></div>
        <div class="muted small">${plural(s.job_count, 'job')} · ${plural(pages, 'page')} (${s.color_pages} colour, ${s.mono_pages} B&amp;W${s.unknown_pages ? `, ${s.unknown_pages} unknown` : ''})${s.jobs.some((j) => j.duplex === 'duplex') ? ' · printed on both sides' : ''}</div>
        ${alerts.length ? `<div class="alert-chips" style="margin-top:6px;">${sessionAlerts(alerts)}</div>` : ''}
        ${canAdd ? '' : '<div class="small" style="color:var(--warn-ink);">No print-service products match. Set "Print service" on your print products.</div>'}
      </div>
      <button type="button" class="btn btn-outline btn-sm" data-add-session="${s.id}" ${canAdd ? '' : 'disabled'}>Add to sale</button>
    </div>`;
  }).join('');
}

function addSessionToCart(sessionId) {
  const s = waitingSessions.find((x) => x.id === sessionId);
  if (!s || cartSessions.has(sessionId)) return;
  for (const line of s.suggestion.lines) {
    cart.push({ key: ++cartKey, product_id: line.product_id, name: line.name, unit_price: line.unit_price, qty: line.qty, session_id: sessionId });
  }
  const pages = s.color_pages + s.mono_pages + s.unknown_pages;
  cartSessions.set(sessionId, `${s.owner || 'Print job'} · ${pages} pages`);
  if (!$('customer-name').value.trim() && s.owner) $('customer-name').value = s.owner;
  const unmatched = s.suggestion.unmatched.reduce((n, u) => n + u.pages, 0);
  if (unmatched) toast(`${plural(unmatched, 'page')} had an unknown colour mode or no matching product. Add them manually.`, true);
  renderCart();
  renderWaitingSessions();
}

function renderCartSessions() {
  $('cart-sessions').innerHTML = [...cartSessions.entries()].map(([id, label]) => `
    <span class="alert-chip info">Billing print session: ${escapeHtml(label)}
      <button type="button" class="chip-remove" data-remove-session="${id}" aria-label="Remove print session ${escapeHtml(label)} from this sale">&times;</button></span>`).join('') +
    [...cartCopies.entries()].map(([id, label]) => `
    <span class="alert-chip info">Billing photocopies: ${escapeHtml(label)}
      <button type="button" class="chip-remove" data-remove-copy="${id}" aria-label="Remove photocopies ${escapeHtml(label)} from this sale">&times;</button></span>`).join('');
}

function renderCart() {
  // A print session whose lines were all removed is no longer billed by this sale.
  for (const id of [...cartSessions.keys()]) {
    if (!cart.some((l) => l.session_id === id)) cartSessions.delete(id);
  }
  for (const id of [...cartCopies.keys()]) {
    if (!cart.some((l) => l.copy_id === id)) cartCopies.delete(id);
  }
  renderCartSessions();
  const wrap = $('cart-lines');
  if (cart.length === 0) {
    wrap.innerHTML = '<p class="muted" style="text-align:center; margin:0; padding:24px 0;">Tap a product to add it.</p>';
  } else {
    const motion = cartMotion;
    cartMotion = null;
    wrap.innerHTML = cart.map((l) => `
      <div class="cart-line${motion && motion.key === l.key ? (motion.kind === 'new' ? ' is-new' : ' is-bumped') : ''}">
        <div style="min-width:0;">
          ${l.product_id
            ? `<div style="font-weight:500;">${escapeHtml(l.name)}</div>`
            : `<label class="sr-only" for="ln-${l.key}">Item name</label><input class="line-name" id="ln-${l.key}" data-key="${l.key}" data-field="name" value="${escapeHtml(l.name)}" placeholder="Item name">`}
          <div class="line-unit"><label class="sr-only" for="lp-${l.key}">Unit price</label><input id="lp-${l.key}" type="number" min="0" step="0.01" data-key="${l.key}" data-field="price" value="${l.unit_price}"> each</div>
          <div class="stock-warn" data-stock-warn="${l.key}" hidden></div>
        </div>
        <div class="qty">
          <button type="button" data-act="dec" data-key="${l.key}" aria-label="Decrease quantity">&minus;</button>
          <label class="sr-only" for="lq-${l.key}">Quantity</label>
          <input id="lq-${l.key}" type="number" min="0.01" step="any" data-key="${l.key}" data-field="qty" value="${l.qty}">
          <button type="button" data-act="inc" data-key="${l.key}" aria-label="Increase quantity">+</button>
        </div>
        <span class="line-total" data-line-total="${l.key}">${money(round2(l.qty * l.unit_price), '')}</span>
        <button type="button" class="line-remove" data-act="remove" data-key="${l.key}" aria-label="Remove ${escapeHtml(l.name || 'item')}">&times;</button>
      </div>`).join('');
  }
  updateStockWarnings();
  renderTotals();
  scheduleSuggestions();
}

// "Often bought together": refreshed shortly after the cart's products change.
let suggestTimer = null;
let lastSuggestKey = '';
function scheduleSuggestions() {
  clearTimeout(suggestTimer);
  suggestTimer = setTimeout(loadSuggestions, 250);
}

async function loadSuggestions() {
  const ids = [...new Set(cart.filter((l) => l.product_id).map((l) => l.product_id))].sort((a, b) => a - b);
  const key = ids.join(',');
  const box = $('cart-suggestions');
  if (ids.length === 0) { box.hidden = true; lastSuggestKey = ''; return; }
  if (key === lastSuggestKey) return;
  lastSuggestKey = key;
  let suggestions = [];
  try { ({ suggestions } = await api('GET', `/api/insights/suggestions?product_ids=${key}`)); } catch (_) { /* optional */ }
  if (key !== lastSuggestKey) return; // cart changed meanwhile
  box.hidden = suggestions.length === 0;
  box.innerHTML = suggestions.length === 0 ? '' : `<span class="label">Often bought together</span>${suggestions.map((sg) => `
    <div class="suggest-chip">
      <span><strong>${escapeHtml(sg.name)}</strong> · ${escapeHtml(cur(sg.price))}<br>in ${Math.round(sg.confidence * 100)}% of sales with ${escapeHtml(sg.because)}</span>
      <button type="button" class="btn btn-outline btn-sm" data-suggest="${sg.id}">Add</button>
    </div>`).join('')}`;
}

function updateStockWarnings() {
  for (const l of cart) {
    const el = document.querySelector(`[data-stock-warn="${l.key}"]`);
    if (!el) continue;
    const p = l.product_id && catalog.find((x) => x.id === l.product_id);
    const qtyInCart = cart.filter((x) => x.product_id === l.product_id).reduce((s, x) => s + x.qty, 0);
    const short = p && p.track_stock && qtyInCart > p.stock_qty;
    el.hidden = !short;
    if (short) el.textContent = `Only ${p.stock_qty} in stock`;
  }
}

function computeTotals() {
  const subtotal = round2(cart.reduce((s, l) => s + round2(l.qty * l.unit_price), 0));
  const dType = $('discount-type').value;
  const dValue = Math.max(0, parseFloat($('discount-value').value) || 0);
  let discount = dType === 'percent' ? (subtotal * dValue) / 100 : dValue;
  discount = round2(Math.max(0, Math.min(discount, subtotal)));
  const tax = round2(((subtotal - discount) * currentSettings.tax_rate) / 100);
  const total = round2(subtotal - discount + tax);
  return { subtotal, discount, tax, total };
}

// Money that changes counts to its new value instead of jumping; a new
// change cancels the old tween, and the final text is always exact.
const tweens = new WeakMap();
function tweenMoney(el, value) {
  const from = Number(el.dataset.value);
  el.dataset.value = String(value);
  const prev = tweens.get(el);
  if (prev) cancelAnimationFrame(prev);
  if (!Number.isFinite(from) || from === value || reduceMotion() || document.hidden) { el.textContent = cur(value); return; }
  const start = performance.now();
  const step = (now) => {
    const k = Math.min(1, (now - start) / 240);
    const eased = 1 - (1 - k) ** 3;
    el.textContent = cur(round2(from + (value - from) * eased));
    if (k < 1) tweens.set(el, requestAnimationFrame(step)); else { el.textContent = cur(value); tweens.delete(el); }
  };
  tweens.set(el, requestAnimationFrame(step));
}

function renderTotals() {
  const t = computeTotals();
  const totalEl = $('calc-total');
  if (Number(totalEl.dataset.value) !== t.total && totalEl.dataset.value !== undefined && !reduceMotion()) {
    totalEl.classList.remove('flash-glow');
    void totalEl.offsetWidth;
    totalEl.classList.add('flash-glow');
  }
  $('calc-subtotal').textContent = cur(t.subtotal);
  $('calc-discount').textContent = `− ${cur(t.discount)}`;
  $('calc-tax').textContent = cur(t.tax);
  tweenMoney($('calc-total'), t.total);

  const tenderedRaw = $('amount-tendered').value;
  const box = $('change-box');
  if (tenderedRaw === '') {
    box.classList.remove('short');
    box.firstElementChild.textContent = 'Change due';
    $('change-due').textContent = cur(0);
  } else {
    const diff = round2((parseFloat(tenderedRaw) || 0) - t.total);
    box.classList.toggle('short', diff < 0);
    box.firstElementChild.textContent = diff < 0 ? 'Short by' : 'Change due';
    $('change-due').textContent = cur(Math.abs(diff));
  }
}

function resetSale() {
  cart = [];
  cartSessions.clear();
  cartCopies.clear();
  $('customer-name').value = '';
  $('customer-phone').value = '';
  $('discount-value').value = 0;
  $('discount-type').value = 'amount';
  $('amount-tendered').value = '';
  $('sale-error').hidden = true;
  renderCart();
}

async function completeSale() {
  const errEl = $('sale-error');
  errEl.hidden = true;

  if (cart.length === 0) return showError(errEl, 'Add at least one item.');
  const bad = cart.find((l) => !l.name.trim() || !(l.qty > 0) || !(l.unit_price >= 0));
  if (bad) return showError(errEl, 'Every item needs a name, a quantity above 0 and a price.');

  const totals = computeTotals();
  const tenderedRaw = $('amount-tendered').value;
  if (payMethod === 'cash' && tenderedRaw !== '' && (parseFloat(tenderedRaw) || 0) < totals.total) {
    return showError(errEl, 'Amount tendered is less than the total.');
  }

  const payload = {
    customer_name: $('customer-name').value.trim(),
    customer_phone: $('customer-phone').value.trim(),
    items: cart.map((l) => ({ name: l.name.trim(), qty: l.qty, unit_price: l.unit_price, product_id: l.product_id })),
    discount_type: $('discount-type').value,
    discount_value: parseFloat($('discount-value').value) || 0,
    payment_method: payMethod,
    amount_tendered: payMethod === 'cash' && tenderedRaw !== '' ? parseFloat(tenderedRaw) : null,
    print_session_ids: [...cartSessions.keys()],
    copy_event_ids: [...cartCopies.keys()]
  };

  const btn = $('complete-sale-btn');
  btn.disabled = true;
  const tab = openPendingTab();
  try {
    const result = await api('POST', '/api/sales', payload);
    tab.go(`receipt.html?id=${result.id}`);
    const label = btn.innerHTML;
    btn.classList.add('btn-done');
    inkSplash(btn);
    btn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>Sale recorded';
    setTimeout(() => { btn.classList.remove('btn-done'); btn.innerHTML = label; }, reduceMotion() ? 600 : 1100);
    resetSale();
    toast(result.change_due != null
      ? `Sale ${result.receipt_no} recorded. Change due: ${cur(result.change_due)}`
      : `Sale ${result.receipt_no} recorded.`);
    await loadCatalog();
    renderCatalog();
    loadWaitingSessions();
  } catch (err) {
    tab.cancel();
    showError(errEl, err.message);
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------
// Sales history
// ---------------------------------------------------------------
function historyParams() {
  const params = new URLSearchParams();
  const map = { from: 'filter-from', to: 'filter-to', payment_method: 'filter-pay', status: 'filter-status', q: 'filter-q' };
  for (const [key, id] of Object.entries(map)) {
    const v = $(id).value.trim();
    if (v) params.set(key, v);
  }
  return params;
}

function setupHistory() {
  $('history-filters').addEventListener('submit', (e) => { e.preventDefault(); historyPage = 1; loadHistory().catch((err) => toast(err.message, true)); });
  $('history-pages').addEventListener('click', (e) => {
    const b = e.target.closest('[data-page]');
    if (b) { historyPage = Number(b.dataset.page); loadHistory().catch((err) => toast(err.message, true)); }
  });
  $('history-table-wrap').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-void]');
    if (!btn) return;
    const ok = await confirmModal({
      title: `Void ${btn.dataset.receipt}?`,
      message: 'It stays in history marked as voided, is excluded from totals, and any tracked stock goes back on the shelf.',
      confirmLabel: 'Void sale'
    });
    if (!ok) return;
    try {
      await api('PATCH', `/api/sales/${btn.dataset.void}/void`);
      toast(`${btn.dataset.receipt} voided.`);
      await loadCatalog();
      await loadHistory();
    } catch (err) {
      toast(err.message, true);
    }
  });
}

async function loadHistory() {
  const params = historyParams();
  $('history-export').href = `/api/sales/export.csv?${params.toString()}`;
  params.set('page', historyPage);
  params.set('limit', 25);
  const data = await api('GET', `/api/sales?${params.toString()}`);

  $('history-summary').textContent = `${plural(data.total, 'sale')} · ${cur(data.summary.revenue)} excluding voided${data.summary.voided ? ` · ${data.summary.voided} voided` : ''}`;
  const wrap = $('history-table-wrap');
  if (data.sales.length === 0) {
    wrap.innerHTML = emptyState('No sales found for this filter.');
    $('history-pages').innerHTML = '';
    return;
  }
  wrap.innerHTML = `
    <table>
      <thead><tr><th>Receipt</th><th>Date</th><th>Customer</th><th>Cashier</th><th>Payment</th><th class="num">Total</th><th>Status</th><th></th></tr></thead>
      <tbody>${data.sales.map((s) => `
        <tr class="${s.voided ? 'voided' : ''}">
          <td class="mono">${escapeHtml(s.receipt_no)}</td>
          <td>${escapeHtml(formatDbDate(s.created_at))}</td>
          <td>${s.customer_name ? escapeHtml(s.customer_name) : '<span class="muted">Walk-in</span>'}${s.customer_phone ? `<div class="muted small">${escapeHtml(s.customer_phone)}</div>` : ''}</td>
          <td>${escapeHtml(s.cashier_name)}</td>
          <td>${payBadge(s.payment_method)}</td>
          <td class="num">${escapeHtml(cur(s.total))}</td>
          <td>${s.voided ? '<span class="badge danger">Voided</span>' : '<span class="badge ok">Completed</span>'}</td>
          <td><div class="actions">
            <a class="btn btn-outline btn-sm" href="receipt.html?id=${s.id}" target="_blank" rel="noopener">Receipt</a>
            ${isAdmin() && !s.voided ? `<button type="button" class="btn btn-danger btn-sm" data-void="${s.id}" data-receipt="${escapeHtml(s.receipt_no)}">Void</button>` : ''}
          </div></td>
        </tr>`).join('')}
      </tbody>
    </table>`;

  $('history-pages').innerHTML = data.pages <= 1 ? '' : `
    <span class="info">Page ${data.page} of ${data.pages}</span>
    <button type="button" class="btn btn-outline btn-sm" data-page="${data.page - 1}" ${data.page <= 1 ? 'disabled' : ''}>Previous</button>
    <button type="button" class="btn btn-outline btn-sm" data-page="${data.page + 1}" ${data.page >= data.pages ? 'disabled' : ''}>Next</button>`;
}

// ---------------------------------------------------------------
// Reports & end-of-day close
// ---------------------------------------------------------------
function setupReports() {
  const today = localDateString();
  $('report-from').value = `${today.slice(0, 8)}01`;
  $('report-to').value = today;
  $('close-date').value = today;
  $('close-date').max = today;

  $('report-filters').addEventListener('submit', (e) => { e.preventDefault(); loadReport().catch((err) => toast(err.message, true)); });
  $('close-date').addEventListener('change', () => loadClose().catch((err) => toast(err.message, true)));
  $('cash-counted').addEventListener('input', renderVariance);
  $('close-day-btn').addEventListener('click', closeDay);
  $('closings-wrap').addEventListener('click', (e) => {
    const b = e.target.closest('[data-close-date]');
    if (!b) return;
    $('close-date').value = b.dataset.closeDate;
    loadClose().catch((err) => toast(err.message, true));
    $('close-card').scrollIntoView({ behavior: 'smooth' });
  });
}

async function loadReport() {
  const from = $('report-from').value;
  const to = $('report-to').value;
  const q = new URLSearchParams({ from, to }).toString();
  $('report-export').href = `/api/reports/export.csv?${q}`;
  const data = await api('GET', `/api/reports/summary?${q}`);
  const t = data.totals;

  $('report-kpis').innerHTML = [
    { label: 'Revenue', value: cur(t.revenue), sub: `${dayLabel(data.from, { day: 'numeric', month: 'short' })} – ${dayLabel(data.to, { day: 'numeric', month: 'short', year: 'numeric' })}` },
    { label: 'Sales', value: t.count, sub: t.voided_count ? `${t.voided_count} voided (${cur(t.voided_value)})` : 'None voided' },
    { label: 'Average sale', value: cur(t.average), sub: 'Excludes voided sales' },
    { label: 'Discounts given', value: cur(t.discounts), sub: `Tax collected ${cur(t.tax)}` }
  ].map(kpiCard).join('');

  $('report-items').innerHTML = data.byItem.length === 0 ? emptyState('No sales in this range.') : `
    <table><thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Revenue</th></tr></thead><tbody>
    ${data.byItem.map((i) => `<tr><td>${escapeHtml(i.name)}</td><td class="num">${round2(i.qty)}</td><td class="num">${escapeHtml(cur(i.revenue))}</td></tr>`).join('')}
    </tbody></table>`;

  $('report-cashiers').innerHTML = data.byCashier.length === 0 ? '<p class="muted" style="margin:0;">No sales in this range.</p>'
    : data.byCashier.map((c) => `<div class="list-row"><span>${escapeHtml(c.name)} <span class="muted small">${plural(c.count, 'sale')}</span></span><span class="mono">${escapeHtml(cur(c.revenue))}</span></div>`).join('');

  const payTotal = data.byPayment.reduce((s, p) => s + p.revenue, 0);
  $('report-payments').innerHTML = data.byPayment.length === 0 ? '<p class="muted" style="margin:0;">No sales in this range.</p>'
    : `<div class="stack">${data.byPayment.map((p) => meterRow(PAY_LABELS[p.method] || p.method, p.count, p.revenue, payTotal)).join('')}</div>`;
}

let closeState = null;

async function loadClose() {
  const date = $('close-date').value || localDateString();
  const data = await api('GET', `/api/reports/close?date=${encodeURIComponent(date)}`);
  closeState = data;
  $('h-close').textContent = dayLabel(data.date, { weekday: 'long', day: 'numeric', month: 'long' });

  const f = data.closing || data.figures;
  $('close-lines').innerHTML = `
    <div class="t-row"><span>Sales (${f.sales_count})</span><span>${escapeHtml(cur(f.gross_total))}</span></div>
    <div class="t-row"><span>Mobile money</span><span>${escapeHtml(cur(f.momo_total))}</span></div>
    <div class="t-row"><span>Card</span><span>${escapeHtml(cur(f.card_total))}</span></div>
    ${f.voided_count ? `<div class="t-row"><span>Voided sales</span><span>${f.voided_count}</span></div>` : ''}
    <div class="t-row t-total"><span>Cash expected</span><span>${escapeHtml(cur(f.cash_total))}</span></div>`;

  const closed = !!data.closing;
  $('close-form-wrap').hidden = closed;
  $('closed-info').hidden = !closed;
  $('close-error').hidden = true;
  if (closed) {
    const c = data.closing;
    $('closed-info').innerHTML = `
      <div class="z-lines"><div class="t-row"><span>Cash counted</span><span>${escapeHtml(cur(c.cash_counted))}</span></div></div>
      ${varianceHtml(c.variance)}
      <p class="small" style="margin:0; color:var(--side-text);">Closed by ${escapeHtml(c.closed_by_name)} · ${escapeHtml(formatDbDate(c.closed_at))}${c.note ? `<br>Note: ${escapeHtml(c.note)}` : ''}</p>
      <a class="btn btn-light btn-block" href="zreport.html?date=${encodeURIComponent(c.business_date)}" target="_blank" rel="noopener">Print Z-report</a>
      ${isAdmin() ? '<button type="button" class="btn btn-block" id="reopen-day-btn" style="background:transparent; color:#fff; border-color:var(--side-line);">Reopen this day</button>' : ''}`;
    const reopen = $('reopen-day-btn');
    if (reopen) reopen.addEventListener('click', reopenDay);
  } else {
    $('cash-counted').value = '';
    $('close-note').value = '';
    renderVariance();
  }
}

function varianceHtml(v) {
  const cls = v < 0 ? 'short' : v > 0 ? 'over' : 'even';
  const label = v < 0 ? 'Short by' : v > 0 ? 'Over by' : 'Drawer balances';
  return `<div class="variance ${cls}"><span>${label}</span><span>${v ? escapeHtml(cur(Math.abs(v))) : ''}</span></div>`;
}

function renderVariance() {
  const raw = $('cash-counted').value;
  if (raw === '' || !closeState) { $('close-variance').innerHTML = ''; return; }
  $('close-variance').innerHTML = varianceHtml(round2((parseFloat(raw) || 0) - closeState.figures.cash_total));
}

async function closeDay() {
  const errEl = $('close-error');
  errEl.hidden = true;
  const raw = $('cash-counted').value;
  if (raw === '') return showError(errEl, 'Enter the cash counted in the drawer.');
  const date = $('close-date').value || localDateString();
  const tab = openPendingTab();
  try {
    await api('POST', '/api/reports/close', { date, cash_counted: parseFloat(raw), note: $('close-note').value.trim() });
    tab.go(`zreport.html?date=${encodeURIComponent(date)}`);
    toast(`${dayLabel(date)} closed.`);
    await Promise.all([loadClose(), loadClosings()]);
  } catch (err) {
    tab.cancel();
    showError(errEl, err.message);
  }
}

async function reopenDay() {
  const date = closeState.date;
  const ok = await confirmModal({
    title: `Reopen ${dayLabel(date)}?`,
    message: 'The Z-report for this day is discarded so late sales or voids can be recorded. Close the day again afterwards.',
    confirmLabel: 'Reopen day'
  });
  if (!ok) return;
  try {
    await api('DELETE', `/api/reports/close/${encodeURIComponent(date)}`);
    toast(`${dayLabel(date)} reopened.`);
    await Promise.all([loadClose(), loadClosings()]);
  } catch (err) {
    toast(err.message, true);
  }
}

async function loadClosings() {
  const { closings } = await api('GET', '/api/reports/closings');
  $('closings-wrap').innerHTML = closings.length === 0 ? '<p class="muted" style="margin:0;">No days closed yet.</p>' : `
    <table><thead><tr><th>Day</th><th class="num">Sales</th><th class="num">Gross</th><th class="num">Cash expected</th><th class="num">Counted</th><th class="num">Variance</th><th>Closed by</th><th></th></tr></thead><tbody>
    ${closings.map((c) => `<tr>
      <td>${escapeHtml(dayLabel(c.business_date))}</td>
      <td class="num">${c.sales_count}</td>
      <td class="num">${escapeHtml(cur(c.gross_total))}</td>
      <td class="num">${escapeHtml(cur(c.cash_total))}</td>
      <td class="num">${escapeHtml(cur(c.cash_counted))}</td>
      <td class="num"><span class="badge ${c.variance < 0 ? 'warn' : c.variance > 0 ? 'info' : 'ok'}">${c.variance > 0 ? '+' : ''}${money(c.variance, '')}</span></td>
      <td>${escapeHtml(c.closed_by_name)}</td>
      <td><div class="actions"><button type="button" class="btn btn-ghost btn-sm" data-close-date="${escapeHtml(c.business_date)}">View</button><a class="btn btn-outline btn-sm" href="zreport.html?date=${encodeURIComponent(c.business_date)}" target="_blank" rel="noopener">Z-report</a></div></td>
    </tr>`).join('')}
    </tbody></table>`;
}

// ---------------------------------------------------------------
// Printers: each printer's panel and controls, for everyone
// ---------------------------------------------------------------
const HEALTH = {
  ready: ['Ready', 'ok'], busy: ['Printing', 'info'], warning: ['Needs attention', 'warn'],
  error: ['Not printing', 'danger'], offline: ['Not reporting', '']
};
const SEVERITY_ICON = { critical: '!', warning: '!', info: 'i' };
const JOB_ACT_LABEL = { pause_job: 'Hold', resume_job: 'Release', restart_job: 'Restart', cancel_job: 'Cancel' };
const DUPLEX_LABEL = { OneSided: 'One side', TwoSidedLongEdge: 'Both sides (long edge)', TwoSidedShortEdge: 'Both sides (short edge)' };
const PENDING_LABEL = {
  cancel_job: 'Cancelling', pause_job: 'Holding', resume_job: 'Releasing', restart_job: 'Restarting', pause_printer: 'Pausing the printer',
  resume_printer: 'Resuming the printer', set_online: 'Bringing it online', test_page: 'Printing a test page', clear_queue: 'Clearing the queue',
  set_defaults: 'Changing default settings'
};
let printerList = [];
const printerCardSig = new Map();
const watchedCommands = new Map(); // command id -> printer name

function setupPrinters() {
  $('printers-refresh').addEventListener('click', () => loadPrinters().catch((err) => toast(err.message, true)));
  $('printers-wrap').addEventListener('click', onPrinterAction);
  // While the page is open, refresh often; elsewhere, just keep the nav badge current.
  setInterval(() => {
    if (document.hidden) return;
    if (currentView === 'printers') loadPrinters().catch(() => {});
  }, 4000);
  const glance = () => api('GET', '/api/printers?glance=1').then(({ printers }) => updatePrinterBadge(printers)).catch(() => {});
  glance();
  setInterval(() => { if (!document.hidden && currentView !== 'printers') glance(); }, 60000);
}

function updatePrinterBadge(printers) {
  const bad = printers.filter((p) => p.health === 'error' || p.health === 'offline').length;
  const el = $('printer-alert-count');
  if (el.textContent !== String(bad) && bad > 0) { el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump'); }
  el.hidden = bad === 0;
  el.textContent = String(bad);
  el.title = `${plural(bad, 'printer')} need attention`;
}

async function loadPrinters() {
  const { printers } = await api('GET', '/api/printers');
  printerList = printers;
  updatePrinterBadge(printers);
  refreshFixGuide();
  $('printers-updated').textContent = `Updated ${new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
  const wrap = $('printers-wrap');
  if (printers.length === 0) {
    printerCardSig.clear();
    wrap.innerHTML = `<div class="card">${emptyState(isAdmin()
      ? 'No printers reported yet. Install the print agent on the PC each printer is connected to (Print monitor > Register agent).'
      : 'No printers reported yet. Ask an admin to install the print agent on the printer\'s PC.')}</div>`;
    return;
  }
  // Re-render only the cards that changed, and never the one being used.
  const keys = new Set(printers.map((p) => p.key));
  wrap.querySelectorAll('[data-printer-key]').forEach((el) => { if (!keys.has(el.dataset.printerKey)) { el.remove(); printerCardSig.delete(el.dataset.printerKey); } });
  wrap.querySelectorAll(':scope > :not([data-printer-key])').forEach((el) => el.remove());
  let prev = null;
  for (const p of printers) {
    trackIssues(p);
    const { updated_at: _u, _newIssues: _n, ...rest } = p;
    const sig = JSON.stringify(rest);
    let el = wrap.querySelector(`[data-printer-key="${CSS.escape(p.key)}"]`);
    const busy = el && (el.contains(document.activeElement) && document.activeElement !== document.body);
    if (!el || (printerCardSig.get(p.key) !== sig && !busy)) {
      const fresh = document.createElement('div');
      fresh.innerHTML = printerCard(p);
      const card = fresh.firstElementChild;
      if (!el) card.classList.add('enter');
      if (el) el.replaceWith(card); else if (prev) prev.after(card); else wrap.prepend(card);
      el = card;
      printerCardSig.set(p.key, sig);
    }
    prev = el;
  }
}

function printerByKey(key) { return printerList.find((p) => p.key === key); }

function trayHtml(t) {
  const pct = t.percent !== null ? t.percent : t.level === -3 ? null : null;
  const label = t.empty ? 'Empty' : t.percent !== null ? `${t.percent}%` : t.level === -3 ? 'Has paper' : 'Unknown';
  return `<div class="tray-row${t.empty ? ' is-empty' : ''}">
    <span class="tray-name">${escapeHtml(t.name)}${t.media ? ` <span class="muted">· ${escapeHtml(t.media)}</span>` : ''}</span>
    <span class="tray-bar" aria-hidden="true"><span style="width:${pct !== null ? pct : t.level === -3 ? 50 : 0}%"${pct === null && t.level === -3 ? ' class="partial"' : ''}></span></span>
    <span class="tray-level">${label}</span>
  </div>`;
}

// Issues seen per printer, so new ones animate in and fixed ones say so on the way out.
const seenIssues = new Map();   // printer key -> Map(issue key -> title)
const resolvedGhosts = new Map(); // printer key -> [{ key, title, until }]

function trackIssues(p) {
  const prev = seenIssues.get(p.key);
  const now = new Map(p.issues.map((i) => [i.key, i.title]));
  const ghosts = (resolvedGhosts.get(p.key) || []).filter((g) => g.until > Date.now() && !now.has(g.key));
  if (prev) {
    for (const [key, title] of prev) if (!now.has(key) && !p.stale) ghosts.push({ key, title, until: Date.now() + 7000 });
    p._newIssues = new Set(p.issues.filter((i) => !prev.has(i.key)).map((i) => i.key));
  } else {
    p._newIssues = new Set();
  }
  seenIssues.set(p.key, now);
  resolvedGhosts.set(p.key, ghosts);
  p._resolved = ghosts.map((g) => ({ key: g.key, title: g.title }));
}

function printerHref(p) { return `#printer/${p.agent_id}/${encodeURIComponent(p.name)}`; }

function issueListHtml(p) {
  const can = (a) => p.actions.includes(a);
  const pendingJob = new Set(p.pending.filter((c) => c.params && c.params.job_id).map((c) => c.params.job_id));
  const pendingPrinter = new Set(p.pending.filter((c) => !(c.params && c.params.job_id)).map((c) => c.action));
  const ghosts = (p._resolved || []).map((g) => `
      <li class="issue sev-fixed is-resolved" aria-live="polite">
        <span class="issue-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path class="draw-check" d="M6 12.5l4 4 8-9" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
        <div class="issue-body"><div class="issue-title">Fixed: ${escapeHtml(g.title)}</div></div>
      </li>`).join('');
  if (!p.issues.length && !ghosts) return '';
  return `<ul class="issue-list">${ghosts}${p.issues.map((i) => {
    const fixes = i.fixes.filter((f) => can(f.action));
    return `
      <li class="issue sev-${i.severity}${p._newIssues && p._newIssues.has(i.key) ? ' is-new' : ''}">
        <span class="issue-icon" aria-hidden="true">${SEVERITY_ICON[i.severity]}</span>
        <div class="issue-body">
          <div class="issue-title">${escapeHtml(i.title)}${i.confirmed ? ' <span class="badge" title="Reported by the printer and by Windows">Confirmed</span>' : ''}</div>
          ${i.detail ? `<div class="muted small">${escapeHtml(i.detail)}</div>` : ''}
          <div class="row" style="gap:6px; margin-top:8px; flex-wrap:wrap;">
            ${guideFor(i) ? `<button type="button" class="btn btn-outline btn-sm guide-btn" data-guide="${escapeHtml(i.key)}" data-key="${escapeHtml(p.key)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>Show me how</button>` : ''}
            ${fixes.map((f) => `<button type="button" class="btn btn-primary btn-sm" data-printer-act="${f.action}" data-key="${escapeHtml(p.key)}"${f.params ? ` data-job="${f.params.job_id}" data-doc="${escapeHtml(f.params.document)}"` : ''}${(f.params && pendingJob.has(f.params.job_id)) || pendingPrinter.has(f.action) ? ' disabled' : ''}>${escapeHtml(f.label)}</button>`).join('')}
          </div>
        </div>
      </li>`;
  }).join('')}</ul>`;
}

function devicePanelHtml(p) {
  const device = p.device;
  if (!device) {
    return `<div class="lcd lcd-off"><div>${escapeHtml(p.host ? 'Printer screen not available' : 'USB / local printer')}</div></div>
       <p class="muted small" style="margin:0;">${p.host ? 'The printer did not share its panel (SNMP may be off).' : 'Only network printers share their screen, trays and covers. Queue controls still work.'}</p>`;
  }
  const screen = p.screen.length ? p.screen : [device.reachable === false ? 'No reply from the printer' : device.status === 'printing' ? 'Printing...' : device.status === 'warmup' ? 'Warming up...' : 'Ready'];
  return `
      <div class="lcd${device.reachable === false ? ' lcd-dead' : ''}" role="group" aria-label="Printer screen">
        ${screen.map((l, i) => `<div>${escapeHtml(l)}${i === screen.length - 1 ? '<span class="lcd-cursor" aria-hidden="true"></span>' : ''}</div>`).join('')}
      </div>
      ${device.trays.length ? `<div class="stack" style="gap:6px;"><div class="mini-label">Paper</div>${device.trays.map(trayHtml).join('')}</div>` : ''}
      ${device.covers.length ? `<div class="row" style="gap:6px; flex-wrap:wrap;">${device.covers.map((c) => `<span class="badge ${c.status === 'open' ? 'warn' : ''}">${escapeHtml(c.name)}: ${c.status === 'open' ? 'open' : 'closed'}</span>`).join('')}</div>` : ''}
      ${device.alerts.length ? `<div class="stack" style="gap:4px;"><div class="mini-label">Printer messages</div>${device.alerts.slice(0, 4).map((a) => `<div class="small">${a.severity === 'critical' ? '<span class="badge warn">Critical</span> ' : ''}${escapeHtml(a.description)}</div>`).join('')}</div>` : ''}`;
}

function queueTableHtml(p) {
  const can = (a) => p.actions.includes(a);
  const pendingJob = new Set(p.pending.filter((c) => c.params && c.params.job_id).map((c) => c.params.job_id));
  const jobBtn = (j, action) => can(action) ? `<button type="button" class="btn btn-ghost btn-sm" data-printer-act="${action}" data-key="${escapeHtml(p.key)}" data-job="${j.id}" data-doc="${escapeHtml(j.document)}"${pendingJob.has(j.id) ? ' disabled' : ''}>${JOB_ACT_LABEL[action]}</button>` : '';
  if (p.queue.length === 0) return '<p class="muted" style="margin:0;">Nothing waiting.</p>';
  return `
    <div class="table-wrap"><table class="queue-table">
      <thead><tr><th>Document</th><th>Progress</th><th>Status</th><th class="num">Wait</th><th><span class="sr-only">Actions</span></th></tr></thead>
      <tbody>${p.queue.map((j) => {
        const held = /Paused/.test(j.status);
        const live = /Printing/.test(j.status) && !/Error/.test(j.status) && p.health !== 'error';
        return `<tr${j.id === p.stalled_job_id ? ' class="is-stalled"' : ''}>
          <td><div style="font-weight:600;">${escapeHtml(j.document || '(untitled)')}</div><div class="muted small">${escapeHtml(j.owner || '')}</div></td>
          <td data-label="Progress" style="min-width:140px;">${j.total_pages ? `<div class="small">${j.pages_printed} of ${j.total_pages} pages</div><div class="tray-bar${live ? ' live' : ''}"><span style="width:${Math.max(3, Math.round((j.progress || 0) * 100))}%"></span></div>` : '<span class="muted small">Pages unknown</span>'}</td>
          <td class="small" data-label="Status">${escapeHtml(j.status || 'Waiting')}</td>
          <td class="num small" data-label="Wait">${j.eta_min ? `~${j.eta_min} min` : '<span class="muted">&mdash;</span>'}</td>
          <td><div class="actions">${pendingJob.has(j.id) ? '<span class="badge info"><span class="spinner" aria-hidden="true"></span>Working</span>' : `${jobBtn(j, held ? 'resume_job' : 'pause_job')}${jobBtn(j, 'restart_job')}${jobBtn(j, 'cancel_job')}`}</div></td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>`;
}

function pendingHtml(p) {
  const pending = p.pending.filter((c) => c.action !== 'printer_info');
  const chips = pending.length ? `<div class="row" style="gap:6px; flex-wrap:wrap;" aria-live="polite">${pending.map((c) => `<span class="badge info pending-chip"><span class="spinner" aria-hidden="true"></span>${escapeHtml(PENDING_LABEL[c.action] || c.verb)}${c.params && c.params.document ? ` "${escapeHtml(c.params.document)}"` : ''}...</span>`).join('')}</div>` : '';
  const failed = p.recent.filter((c) => (c.status === 'failed' || c.status === 'expired') && c.action !== 'printer_info').slice(0, 2);
  return chips + failed.map((c) => `<div class="small" style="color:var(--warn-ink);">${escapeHtml(c.verb)}${c.params && c.params.document ? ` "${escapeHtml(c.params.document)}"` : ''}: ${escapeHtml(c.error || c.status)}</div>`).join('');
}

function controlsHtml(p) {
  const can = (a) => p.actions.includes(a);
  const pendingPrinter = new Set(p.pending.filter((c) => !(c.params && c.params.job_id)).map((c) => c.action));
  const paused = p.issues.some((i) => i.key === 'paused');
  const btn = (action, label, cls = 'btn-outline') => `<button type="button" class="btn ${cls} btn-sm" data-printer-act="${action}" data-key="${escapeHtml(p.key)}"${pendingPrinter.has(action) ? ' disabled' : ''}>${escapeHtml(label)}</button>`;
  return `<div class="row printer-controls">
      ${paused ? btn('resume_printer', 'Resume printing', 'btn-primary') : can('pause_printer') ? btn('pause_printer', 'Pause printing') : ''}
      ${can('test_page') ? btn('test_page', 'Print test page') : ''}
      ${can('clear_queue') && p.queue.length ? btn('clear_queue', 'Clear queue', 'btn-ghost') : ''}
      ${p.host ? `<a class="btn btn-ghost btn-sm" href="http://${escapeHtml(p.host)}/" target="_blank" rel="noopener">Printer's own page</a>` : ''}
    </div>`;
}

function printerCard(p, { detail = false } = {}) {
  const [healthLabel, healthKind] = HEALTH[p.health] || HEALTH.offline;
  const cfg = p.config;
  const id = `pn-${p.key.replace(/[^\w-]/g, '_')}`;
  return `<article class="card printer-card health-${p.health}" data-printer-key="${escapeHtml(p.key)}" aria-labelledby="${escapeHtml(id)}">
    <div class="printer-head">
      <div style="min-width:0;">
        <h2 id="${escapeHtml(id)}" class="printer-name">${detail ? escapeHtml(p.name) : `<a class="printer-link" href="${printerHref(p)}">${escapeHtml(p.name)}</a>`}${p.is_default ? ' <span class="badge">Default</span>' : ''}</h2>
        <div class="muted small">On ${escapeHtml(p.agent_label)}${p.host ? ` · ${escapeHtml(p.host)}` : ''}${p.speed && p.speed.source === 'learned' ? ` · about ${p.speed.ppm} pages/min` : ''}${p.stale ? ` · last report ${escapeHtml(timeOf(p.updated_at))}` : ''}</div>
      </div>
      <span class="badge ${healthKind} health-pill">${p.health === 'busy' ? '<span class="pulse-dot" aria-hidden="true"></span>' : ''}${healthLabel}</span>
    </div>
    <div class="printer-headline">${escapeHtml(p.headline)}</div>
    ${pendingHtml(p)}
    <div class="printer-grid">
      <div class="stack" style="gap:10px;">${devicePanelHtml(p)}</div>
      <div class="stack" style="gap:14px; min-width:0;">
        ${issueListHtml(p)}
        ${detail ? '' : `<div class="stack" style="gap:8px;"><div class="mini-label">Queue${p.queue.length ? ` · ${p.queue.length}` : ''}</div>${queueTableHtml(p)}</div>`}
        ${controlsHtml(p)}
        ${!detail && cfg ? `<div class="row" style="gap:10px; flex-wrap:wrap; align-items:center;"><span class="muted small">Defaults: ${escapeHtml(DUPLEX_LABEL[cfg.duplex] || cfg.duplex || '?')} · ${cfg.color ? 'colour' : 'black &amp; white'} · ${escapeHtml(cfg.paper_size || '?')}</span><a class="small" href="${printerHref(p)}">All features and settings</a></div>` : ''}
      </div>
    </div>
  </article>`;
}

// ---------------------------------------------------------------
// Guided fixes: an animated, step-by-step "how to fix it" for each issue.
// Every step that the printer can confirm ticks itself off from the live
// state (door opened, jam cleared, tray filled...), later steps confirming
// imply the earlier ones, and the guide ends when the issue is gone.
// ---------------------------------------------------------------
const hasIssue = (q, key) => q.issues.some((i) => i.key === key || i.key.startsWith(`${key}:`));
const anyCoverOpen = (q) => !!(q.device && q.device.covers.some((c) => c.status === 'open'));
const coverNames = (q) => (q.device ? q.device.covers.map((c) => c.name) : []);
const emptyTrayNames = (q) => (q.device ? q.device.trays.filter((t) => t.empty).map((t) => t.name) : []);
const headJob = (q) => q.queue[0] || null;
const words = (list) => (list.length <= 1 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`);

function guideSteps(issue, p) {
  const base = issue.key.split(':')[0];
  const gone = (q) => !q.issues.some((i) => i.key === issue.key);
  const fix = (action) => issue.fixes.find((f) => f.action === action);
  const doors = coverNames(p);
  const job = headJob(p);
  const media = p.device && p.device.trays.find((t) => t.empty && t.media);
  const toner = base === 'no_toner' || base === 'low_toner';
  switch (base) {
    case 'jammed': return [
      { art: 'open-door', title: `Open ${doors.length ? words(doors) : 'the front door'}`, hint: 'Ticks itself off when the printer reports the door open.', check: (q) => anyCoverOpen(q) },
      { art: 'remove-jam', title: 'Pull the stuck paper out', hint: 'Hold it with both hands and pull slowly in the direction the paper travels. Check no torn pieces are left behind.', check: (q) => !hasIssue(q, 'jammed') },
      { art: 'close-door', title: 'Close every door until it clicks', hint: 'The printer warms up again on its own.', check: (q) => !hasIssue(q, 'jammed') && !anyCoverOpen(q) && !hasIssue(q, 'door_open') },
      ...(job ? [{ art: 'restart', title: `Restart "${job.document}" if pages came out incomplete`, hint: 'It prints again from the first page. Skip this if everything came out.', action: { action: 'restart_job', label: `Restart "${job.document}"`, params: { job_id: job.id, document: job.document } }, optional: true }] : [])
    ];
    case 'door_open': return [
      { art: 'close-door', title: `Close ${doors.filter((d, i) => p.device.covers[i].status === 'open').join(', ') || 'the open door'}`, hint: 'Push it firmly until it clicks into place.', check: gone }
    ];
    case 'no_paper': case 'tray_empty': case 'low_paper': return [
      { art: 'load-paper', title: `Load ${media ? media.media : ''} paper in ${words(emptyTrayNames(p)) || 'the tray'}`.replace(/\s+/g, ' '), hint: 'Pull the tray out, fan the stack, put it in print side down without going over the max line, and push the tray all the way in.', check: gone }
    ];
    case 'no_toner': case 'low_toner': return [
      { art: 'open-door', title: 'Open the toner door', hint: 'Usually the front door; some printers open at the top.', check: (q) => anyCoverOpen(q) || !hasIssue(q, base) },
      { art: 'replace-toner', title: 'Swap the cartridge', hint: 'Lift out the old one. Shake the new one gently side to side, pull off the tape, and slide it in until it clicks.', check: (q) => !hasIssue(q, base) },
      { art: 'close-door', title: 'Close the door', hint: 'The new level shows here within a minute.', check: (q) => !hasIssue(q, base) && !anyCoverOpen(q) }
    ].slice(toner && !p.device ? 1 : 0);
    case 'output_full': case 'output_near_full': return [
      { art: 'empty-output', title: 'Take the printed pages out of the output tray', hint: 'Check whose they are before you put them aside.', check: gone }
    ];
    case 'windows_offline': return [
      { art: 'online', title: 'Bring the printer back online', hint: 'Windows was set to "Use printer offline", so jobs were waiting. This switches it back.', action: fix('set_online') && { action: 'set_online', label: 'Bring online' }, check: gone }
    ];
    case 'paused': return [
      { art: 'restart', title: 'Resume printing', hint: 'The queue starts moving again straight away.', action: fix('resume_printer') && { action: 'resume_printer', label: 'Resume printing' }, check: gone }
    ];
    case 'unreachable': return [
      { art: 'power', title: 'Check the printer is switched on and awake', hint: 'Press any button to wake it from sleep.', check: gone },
      { art: 'network', title: 'Check its network cable or Wi-Fi', hint: 'The cable should click in at both ends; on Wi-Fi the wireless light should be steady.', check: gone },
      { art: 'power', title: 'Still nothing? Turn it off, wait 10 seconds, turn it on', hint: 'Give it a minute to rejoin the network.', check: gone }
    ];
    case 'offline': return [
      { art: 'press-button', title: 'Press the Online / Ready button on the printer', hint: 'On printers with a touch screen, tap the message on screen.', check: gone },
      { art: 'power', title: 'Still offline? Turn it off and on again', hint: 'Wait for it to finish warming up.', check: gone }
    ];
    case 'queue_stuck': case 'job_error': return [
      ...(fix('restart_job') ? [{ art: 'restart', title: `Restart "${fix('restart_job').params.document}"`, hint: 'It prints again from the start, which clears most stuck jobs.', action: fix('restart_job'), check: gone }] : []),
      ...(fix('cancel_job') ? [{ art: 'cancel', title: `Still stuck? Cancel "${fix('cancel_job').params.document}"`, hint: 'The jobs behind it start printing; print the cancelled one again.', action: fix('cancel_job'), optional: true, check: gone }] : [])
    ];
    case 'job_paused': return [
      { art: 'restart', title: issue.title.replace(' is on hold', ''), hint: 'Release it and it joins the queue again.', action: fix('resume_job'), check: gone }
    ];
    case 'agent_offline': return [
      { art: 'pc', title: 'Check the PC this printer is connected to is on', hint: 'And that it is connected to the network.', check: (q) => !q.stale },
      { art: 'pc', title: 'Start the print agent on it', hint: 'Run PrintMonitorAgent (or wait for it to start at log-on).', check: (q) => !q.stale }
    ];
    default:
      return (issue.steps.length ? issue.steps : ['Look at the message on the printer screen']).map((text, i) => ({
        art: i === 0 ? 'screen' : 'press-button', title: text, hint: issue.detail || '', check: gone
      }));
  }
}

function guideFor(issue) { return !issue.key.startsWith('low_') || issue.key === 'low_paper' || issue.key === 'low_toner'; }

// ---------------------------------------------------------------
// Illustrations (inline SVG, animated with CSS; still frames when the
// viewer prefers reduced motion)
// ---------------------------------------------------------------
function fixArt(kind) {
  const body = `
    <ellipse cx="120" cy="156" rx="94" ry="6" class="a-shadow"/>
    <rect x="34" y="38" width="172" height="104" rx="12" class="a-body"/>
    <rect x="66" y="38" width="108" height="9" rx="3" class="a-slot"/>
    <rect x="152" y="54" width="42" height="22" rx="4" class="a-panel"/>
    <rect x="156" y="58" width="34" height="14" rx="2" class="a-screen"/>`;
  const cavity = '<rect x="46" y="82" width="98" height="42" rx="5" class="a-cavity"/>';
  const door = '<g class="a-door"><rect x="46" y="82" width="98" height="42" rx="5"/><rect x="82" y="88" width="26" height="4" rx="2" class="a-handle"/></g>';
  const tray = '<g class="a-tray"><rect x="54" y="126" width="132" height="12" rx="3"/><rect x="108" y="130" width="24" height="3" rx="1.5" class="a-handle"/></g>';
  const svg = (cls, inner) => `<svg class="fix-art art-${cls}" viewBox="0 0 240 170" aria-hidden="true">${inner}</svg>`;
  const arrowDown = (x, y) => `<path class="a-arrow" d="M${x} ${y}v18m-7-7l7 7 7-7"/>`;
  switch (kind) {
    case 'open-door': return svg(kind, `${body}${cavity}${door}${tray}${arrowDown(95, 128)}`);
    case 'remove-jam': return svg(kind, `${body}${cavity}<g class="a-jam"><path d="M58 92h70l-4 18H62z" class="a-sheet"/><path d="M66 98h50M66 104h42" class="a-lines"/></g>${door}${tray}`);
    case 'close-door': return svg(kind, `${body}${cavity}${door}${tray}<circle cx="95" cy="104" r="10" class="a-ring"/>`);
    case 'load-paper': return svg(kind, `${body}${cavity.replace('a-cavity', 'a-cavity a-hidden')}<rect x="46" y="82" width="98" height="42" rx="5" class="a-door-static"/>${tray.replace('</g>', '<g class="a-stack"><rect x="70" y="112" width="100" height="5" rx="1" class="a-sheet"/><rect x="70" y="117" width="100" height="5" rx="1" class="a-sheet"/><rect x="70" y="122" width="100" height="5" rx="1" class="a-sheet"/></g></g>')}`);
    case 'replace-toner': return svg(kind, `${body}${cavity}<g class="a-door a-door-open"><rect x="46" y="82" width="98" height="42" rx="5"/></g><rect x="60" y="88" width="70" height="16" rx="4" class="a-cart-old"/><rect x="60" y="88" width="70" height="16" rx="4" class="a-cart-new"/>${tray}`);
    case 'empty-output': return svg(kind, `${body}${cavity.replace('a-cavity', 'a-cavity a-hidden')}<rect x="46" y="82" width="98" height="42" rx="5" class="a-door-static"/>${tray}<g class="a-out"><rect x="74" y="26" width="92" height="14" rx="2" class="a-sheet"/><rect x="74" y="20" width="92" height="6" rx="2" class="a-sheet"/></g>`);
    case 'press-button': return svg(kind, `${body}<rect x="46" y="82" width="98" height="42" rx="5" class="a-door-static"/>${tray}<circle cx="173" cy="88" r="5" class="a-button"/><circle cx="173" cy="88" r="5" class="a-ripple"/><circle cx="173" cy="88" r="5" class="a-ripple r2"/>`);
    case 'power': return svg(kind, `${body}<rect x="46" y="82" width="98" height="42" rx="5" class="a-door-static"/>${tray}<g class="a-power"><circle cx="173" cy="90" r="7"/><path d="M173 85v5m-3.5-2.5a5 5 0 1 0 7 0" class="a-power-icon"/></g>`);
    case 'network': return svg(kind, `${body}<rect x="46" y="82" width="98" height="42" rx="5" class="a-door-static"/>${tray}<rect x="196" y="98" width="8" height="12" rx="1" class="a-port"/><g class="a-plug"><rect x="208" y="99" width="14" height="10" rx="2"/><path d="M222 104h16"/></g><g class="a-wifi"><path class="w1" d="M114 22a8 8 0 0 1 12 0"/><path class="w2" d="M108 16a17 17 0 0 1 24 0"/><path class="w3" d="M102 10a26 26 0 0 1 36 0"/></g>`);
    case 'restart': return svg(kind, `${body}<rect x="46" y="82" width="98" height="42" rx="5" class="a-door-static"/>${tray}<g class="a-feed"><rect x="80" y="8" width="80" height="34" rx="2" class="a-sheet"/><path d="M90 18h50M90 25h38M90 32h44" class="a-lines"/></g><rect x="60" y="38" width="120" height="8" rx="3" class="a-slot-front"/>`);
    case 'cancel': return svg(kind, `<g class="a-docs"><rect x="70" y="40" width="90" height="110" rx="6" class="a-sheet back"/><g class="a-doc-top"><rect x="80" y="30" width="90" height="110" rx="6" class="a-sheet"/><path d="M95 60h58M95 74h44M95 88h52" class="a-lines"/><path d="M110 104l30 30m0-30l-30 30" class="a-x"/></g></g>`);
    case 'online': return svg(kind, `<rect x="40" y="24" width="160" height="100" rx="8" class="a-monitor"/><rect x="50" y="34" width="140" height="80" rx="4" class="a-screen-big"/><path d="M100 124h40l6 18h-52z" class="a-stand"/><text x="64" y="64" class="a-text">Use printer offline</text><g class="a-toggle"><rect x="134" y="80" width="44" height="22" rx="11" class="a-track"/><circle cx="145" cy="91" r="8" class="a-knob"/></g>`);
    case 'pc': return svg(kind, `<rect x="40" y="24" width="160" height="100" rx="8" class="a-monitor"/><rect x="50" y="34" width="140" height="80" rx="4" class="a-screen-big"/><path d="M100 124h40l6 18h-52z" class="a-stand"/><circle cx="120" cy="74" r="18" class="a-spin"/>`);
    default: return svg('screen', `${body}<rect x="46" y="82" width="98" height="42" rx="5" class="a-door-static"/>${tray}<g class="a-zoom"><circle cx="173" cy="65" r="26" class="a-lens"/><path d="M191 84l14 14" class="a-lens-handle"/><path d="M160 60h26M160 68h18" class="a-lcd-lines"/></g>`);
  }
}

const SUCCESS_ART = `<svg class="fix-art art-success" viewBox="0 0 240 170" aria-hidden="true">
  <circle cx="120" cy="82" r="46" class="a-ok-ring"/>
  <path d="M98 84l15 15 30-32" class="a-ok-check"/>
  ${[0, 45, 90, 135, 180, 225, 270, 315].map((a) => `<circle cx="${120 + 64 * Math.cos((a * Math.PI) / 180)}" cy="${82 + 64 * Math.sin((a * Math.PI) / 180)}" r="4" class="a-spark" style="--a:${a}deg"/>`).join('')}
</svg>`;

// ---------------------------------------------------------------
// The guide dialog
// ---------------------------------------------------------------
let fixGuide = null; // { printerKey, issueKey, title, steps, done:Set, cmd:{}, sig, timer, finished }

function findPrinter(key) {
  if (detailState.data && detailState.data.printer.key === key) return detailState.data.printer;
  return printerByKey(key);
}

function openFixGuide(printerKey, issueKey) {
  const p = findPrinter(printerKey);
  const issue = p && p.issues.find((i) => i.key === issueKey);
  if (!issue) return;
  if (fixGuide) clearInterval(fixGuide.timer);
  fixGuide = { printerKey, issueKey, title: issue.title, steps: guideSteps(issue, p), done: new Set(), cmd: {}, sig: '', finished: false };
  openModal({
    title: `How to fix: ${issue.title}`,
    wide: true,
    hideSubmit: true,
    body: '<div id="fix-guide" class="guide"></div>',
    onOpen: (form) => {
      form.addEventListener('click', onGuideClick);
      renderFixGuide(true);
    },
    onClose: () => { if (fixGuide) clearInterval(fixGuide.timer); fixGuide = null; }
  });
  // Watch the printer closely while the guide is open.
  fixGuide.timer = setInterval(() => {
    const reload = currentView === 'printer' ? loadPrinterDetail() : loadPrinters();
    reload.catch(() => {});
  }, 2000);
}

function guideProgress(p) {
  const g = fixGuide;
  const issueGone = !p.issues.some((i) => i.key === g.issueKey) && !p.stale;
  // A later step confirming means the earlier ones happened.
  let last = -1;
  g.steps.forEach((st, i) => {
    const cmd = g.cmd[i];
    const viaCmd = cmd && p.recent.some((c) => c.id === cmd && c.status === 'done');
    if (g.done.has(i) || viaCmd || (st.check && st.check(p))) last = Math.max(last, i);
  });
  for (let i = 0; i <= last; i++) g.done.add(i);
  const active = g.steps.findIndex((st, i) => !g.done.has(i) && !(st.optional && issueGone));
  return { issueGone, active };
}

function renderFixGuide(force) {
  const g = fixGuide;
  const root = document.getElementById('fix-guide');
  if (!g || !root) return;
  const p = findPrinter(g.printerKey);
  if (!p) return;
  const { issueGone, active } = guideProgress(p);
  const finished = issueGone && (active === -1 || g.steps[active].optional);
  const failedCmd = Object.values(g.cmd).map((id) => p.recent.find((c) => c.id === id && (c.status === 'failed' || c.status === 'expired'))).find(Boolean);
  const sig = JSON.stringify([finished, active, [...g.done], failedCmd && failedCmd.id, p.stale, Object.keys(g.cmd)]);
  if (!force && sig === g.sig) return;
  const stepChanged = g.lastActive !== active || g.finished !== finished;
  g.sig = sig;
  g.lastActive = active;
  g.finished = finished;

  if (finished) {
    const next = p.issues.find((i) => i.severity !== 'info' && guideFor(i));
    root.innerHTML = `
      <div class="guide-done" role="status">
        <div class="guide-art">${SUCCESS_ART}</div>
        <h3>Fixed: ${escapeHtml(g.title)}</h3>
        <p class="muted">${next ? `One more thing on ${escapeHtml(p.name)}: ${escapeHtml(next.title)}.` : `${escapeHtml(p.name)} reports it is ${p.health === 'busy' ? 'printing again' : 'ready'}.`}</p>
        <div class="row" style="gap:8px; justify-content:center;">
          ${next ? `<button type="button" class="btn btn-primary" data-guide-next="${escapeHtml(next.key)}">Fix the next one</button>` : ''}
        </div>
      </div>`;
    return;
  }
  const idx = active === -1 ? g.steps.length - 1 : active;
  const step = g.steps[idx];
  const allDoneStillThere = active === -1 && !issueGone;
  const stepList = g.steps.map((st, i) => `
    <li class="${g.done.has(i) ? 'done' : i === idx ? 'active' : ''}">
      <span class="step-dot" aria-hidden="true">${g.done.has(i) ? '<svg viewBox="0 0 24 24"><path d="M6 12.5l4 4 8-9" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>' : i + 1}</span>
      <span>${escapeHtml(st.title)}${st.optional ? ' <span class="muted small">(if needed)</span>' : ''}</span>
    </li>`).join('');
  const watching = step.check && !p.stale;
  root.innerHTML = `
    <ol class="guide-steps" aria-label="Steps">${stepList}</ol>
    <div class="guide-stage">
      <div class="guide-art${stepChanged ? ' swap' : ''}">${fixArt(step.art)}</div>
      <div class="guide-text">
        <div class="mini-label">Step ${idx + 1} of ${g.steps.length}</div>
        <h3>${escapeHtml(step.title)}</h3>
        ${step.hint ? `<p class="muted" style="margin:0;">${escapeHtml(step.hint)}</p>` : ''}
        ${allDoneStillThere ? `<div class="callout" style="margin-top:4px;">All steps done, but ${escapeHtml(p.name)} still reports this problem. Give it a minute, or look at the printer screen${p.screen.length ? `: "${escapeHtml(p.screen.join(' · '))}"` : ''}.</div>` : ''}
        ${p.stale ? '<div class="callout">The PC with this printer isn\'t reporting, so steps can\'t be checked automatically. Tick them off yourself.</div>' : ''}
        ${failedCmd ? `<div class="callout" style="color:var(--warn-ink);">${escapeHtml(failedCmd.verb)} didn't work: ${escapeHtml(failedCmd.error || failedCmd.status)}</div>` : ''}
        ${watching && !allDoneStillThere ? '<div class="guide-live" aria-live="polite"><span class="live-dot" aria-hidden="true"></span>Watching the printer: this ticks itself off when it\'s done</div>' : ''}
        <div class="row" style="gap:8px; flex-wrap:wrap; margin-top:6px;">
          ${idx > 0 ? '<button type="button" class="btn btn-ghost" data-guide-back>Back</button>' : ''}
          ${step.action && p.actions.includes(step.action.action) ? `<button type="button" class="btn btn-primary" data-guide-act="${idx}"${g.cmd[idx] && !failedCmd ? ' disabled' : ''}>${g.cmd[idx] && !failedCmd ? '<span class="spinner" aria-hidden="true"></span>Working' : escapeHtml(step.action.label)}</button>` : ''}
          ${active !== -1 ? `<button type="button" class="btn ${step.action ? 'btn-outline' : 'btn-primary'}" data-guide-skip="${idx}">${step.optional ? 'Not needed' : step.check ? "I've done this" : 'Next'}</button>` : ''}
        </div>
      </div>
    </div>`;
}

async function onGuideClick(e) {
  const g = fixGuide;
  if (!g) return;
  if (e.target.closest('[data-guide-close]')) { document.querySelector('[data-modal-cancel]').click(); return; }
  const next = e.target.closest('[data-guide-next]');
  if (next) { const key = g.printerKey; document.querySelector('[data-modal-cancel]').click(); openFixGuide(key, next.dataset.guideNext); return; }
  if (e.target.closest('[data-guide-back]')) {
    const last = Math.max(...[...g.done]);
    g.done.delete(last);
    renderFixGuide(true);
    return;
  }
  const skip = e.target.closest('[data-guide-skip]');
  if (skip) { g.done.add(Number(skip.dataset.guideSkip)); renderFixGuide(true); return; }
  const act = e.target.closest('[data-guide-act]');
  if (act) {
    const i = Number(act.dataset.guideAct);
    const st = g.steps[i];
    const p = findPrinter(g.printerKey);
    act.disabled = true;
    try {
      const { command } = await api('POST', '/api/printers/commands', { agent_id: p.agent_id, printer: p.name, action: st.action.action, params: st.action.params || {} });
      g.cmd[i] = command.id;
      watchCommand(command.id, p.name);
      renderFixGuide(true);
    } catch (err) {
      toast(err.message, true);
      act.disabled = false;
    }
  }
}

function refreshFixGuide() { if (fixGuide) renderFixGuide(false); }

// ---------------------------------------------------------------
// One printer: overview, features, settings, queue, activity
// ---------------------------------------------------------------
const detailState = { agentId: null, name: '', tab: 'overview', data: null, sig: '' };

function setupPrinterDetail() {
  wireGoLinks($('view-printer'));
  const tabs = [...$('printer-tabs').querySelectorAll('[role="tab"]')];
  const ink = document.createElement('span');
  ink.className = 'tab-ink';
  ink.setAttribute('aria-hidden', 'true');
  $('printer-tabs').appendChild(ink);
  $('printer-tabs').classList.add('has-ink');
  const placeInk = () => {
    const on = tabs.find((t) => t.getAttribute('aria-selected') === 'true');
    if (on && on.offsetWidth) ink.style.transform = `translateX(${on.offsetLeft}px) scaleX(${on.offsetWidth})`;
  };
  window.addEventListener('resize', placeInk);
  new MutationObserver(placeInk).observe($('view-printer'), { attributes: true, attributeFilter: ['class'] });
  const select = (tab, focus) => {
    detailState.tab = tab.dataset.tab;
    tabs.forEach((t) => { const on = t === tab; t.setAttribute('aria-selected', on); t.tabIndex = on ? 0 : -1; });
    placeInk();
    $('printer-panel').setAttribute('aria-labelledby', tab.id);
    if (focus) tab.focus();
    renderPrinterDetail(true);
  };
  $('printer-tabs').addEventListener('click', (e) => { const t = e.target.closest('[role="tab"]'); if (t) select(t); });
  $('printer-tabs').addEventListener('keydown', (e) => {
    const i = tabs.findIndex((t) => t.getAttribute('aria-selected') === 'true');
    const to = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    select(tabs[(to + tabs.length) % tabs.length], true);
  });
  $('printer-pick').addEventListener('change', (e) => navigateTo(`printer/${e.target.value}`));
  $('printer-panel').addEventListener('click', (e) => {
    if (e.target.closest('[data-refresh-features]')) {
      e.target.closest('[data-refresh-features]').disabled = true;
      loadPrinterDetail(true).catch((err) => toast(err.message, true));
      return;
    }
    onPrinterAction(e);
  });
  setInterval(() => { if (!document.hidden && currentView === 'printer' && !fixGuide) loadPrinterDetail().catch(() => {}); }, 4000);
}

async function openPrinterDetail(param) {
  const [agentId, ...rest] = String(param || '').split('/');
  detailState.agentId = Number(agentId);
  detailState.name = rest.join('/');
  detailState.data = null;
  detailState.sig = '';
  $('printer-panel').innerHTML = '<div class="card"><div class="skeleton" style="height:180px;"></div></div>';
  if (!printerList.length) {
    try { printerList = (await api('GET', '/api/printers?glance=1')).printers; } catch (_) { /* picker stays short */ }
  }
  await loadPrinterDetail();
}

async function loadPrinterDetail(refresh) {
  if (!detailState.agentId) return;
  const q = new URLSearchParams({ agent_id: detailState.agentId, printer: detailState.name });
  if (refresh) q.set('refresh', '1');
  let data;
  try {
    data = await api('GET', `/api/printers/detail?${q.toString()}`);
  } catch (err) {
    $('h-printer').textContent = 'Printer not found';
    $('printer-sub').textContent = 'It may have been removed from its PC.';
    $('printer-panel').innerHTML = `<div class="card">${emptyState('This printer is no longer reported. Go back to all printers.')}</div>`;
    return;
  }
  const p = data.printer;
  trackIssues(p);
  const i = printerList.findIndex((x) => x.key === p.key);
  if (i >= 0) printerList[i] = p; else printerList.push(p);
  detailState.data = data;
  const [label, kind] = HEALTH[p.health] || HEALTH.offline;
  $('h-printer').innerHTML = `${escapeHtml(p.name)} <span class="badge ${kind} health-pill">${p.health === 'busy' ? '<span class="pulse-dot" aria-hidden="true"></span>' : ''}${label}</span>`;
  $('printer-sub').textContent = [data.identity.model, `on ${p.agent_label}`, p.host].filter(Boolean).join(' · ');
  $('printer-pick').innerHTML = printerList.map((x) => `<option value="${x.agent_id}/${escapeHtml(x.name)}"${x.key === p.key ? ' selected' : ''}>${escapeHtml(x.name)} (${escapeHtml(x.agent_label)})</option>`).join('');
  renderPrinterDetail(false);
  refreshFixGuide();
}

function featureTile(f, i) {
  const icon = { yes: '<path d="M6 12.5l4 4 8-9"/>', no: '<path d="M7 7l10 10M17 7L7 17"/>', unknown: '<path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5v.7M12 17h.01"/>' }[f.status];
  return `<div class="feature-tile is-${f.status}" style="--i:${i}">
    <span class="feature-icon" aria-hidden="true"><svg viewBox="0 0 24 24">${icon}</svg></span>
    <div style="min-width:0;">
      <div class="feature-label">${escapeHtml(f.label)} <span class="sr-only">${f.status === 'yes' ? 'supported' : f.status === 'no' ? 'not supported' : 'not reported'}</span></div>
      <div class="small">${f.value ? escapeHtml(f.value) : `<span class="muted">${f.status === 'unknown' ? 'Not reported' : f.status === 'yes' ? 'Yes' : 'No'}</span>`}</div>
      ${f.detail ? `<div class="small" style="color:var(--warn-ink);">${escapeHtml(f.detail)}</div>` : ''}
      ${f.sources.length ? `<div class="feature-src">${f.sources.map((s) => `<span>${escapeHtml(s)}</span>`).join('')}</div>` : ''}
    </div>
  </div>`;
}

function renderPrinterDetail(force) {
  const data = detailState.data;
  if (!data) return;
  const p = data.printer;
  const panel = $('printer-panel');
  const { _newIssues: _n, updated_at: _u, ...stable } = p;
  const sig = JSON.stringify([detailState.tab, stable, detailState.tab === 'overview' ? null : { ...data, printer: null }]);
  const busy = panel.contains(document.activeElement) && document.activeElement !== panel;
  if (!force && (sig === detailState.sig || busy)) return;
  detailState.sig = sig;
  const tab = detailState.tab;
  let html = '';
  if (tab === 'overview') {
    html = printerCard(p, { detail: true });
  } else if (tab === 'features') {
    const id = data.identity;
    const info = [
      ['Model', id.model], ['Serial number', id.serial], ['Network address', id.host], ['Network name', id.network_name],
      ['Location', id.location], ['Driver', id.driver && [id.driver.name, id.driver.manufacturer, id.driver.version && `v${id.driver.version}`].filter(Boolean).join(' · ')],
      ['Port', id.port], ['Shared', id.shared ? `Yes${id.share_name ? ` as ${id.share_name}` : ''}` : ''],
      ['Pages printed (lifetime)', id.page_count != null ? id.page_count.toLocaleString() : ''], ['On for', id.uptime_hours != null ? `${id.uptime_hours} h` : ''], ['Comment', id.comment]
    ].filter(([, v]) => v);
    html = `
      <div class="card stack">
        <div class="spread" style="gap:12px; flex-wrap:wrap;">
          <div><h2 style="margin:0;">What ${escapeHtml(p.name)} can do</h2>
            <p class="muted small" style="margin:4px 0 0;">From the driver, Windows and the printer itself. ${data.info_updated_at ? `Read ${escapeHtml(formatDbDate(data.info_updated_at))}.` : ''}</p></div>
          <button type="button" class="btn btn-outline btn-sm" data-refresh-features${data.info_pending ? ' disabled' : ''}>${data.info_pending ? '<span class="spinner" aria-hidden="true"></span>Reading from the printer' : 'Read again'}</button>
        </div>
        ${data.info_pending && !data.info_updated_at ? '<div class="feature-grid">' + Array.from({ length: 6 }, (_, i) => `<div class="feature-tile skeleton" style="--i:${i}; height:64px;"></div>`).join('') + '</div>' : `<div class="feature-grid">${data.features.map(featureTile).join('')}</div>`}
        ${p.stale && !data.info_updated_at ? '<p class="muted small" style="margin:0;">The PC with this printer isn\'t reporting, so its features can\'t be read right now.</p>' : ''}
      </div>
      <div class="grid grid-2">
        <div class="card stack"><h2 style="margin:0;">Details</h2>${info.length ? `<dl class="info-list">${info.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(String(v))}</dd>`).join('')}</dl>` : '<p class="muted" style="margin:0;">Not read yet.</p>'}</div>
        <div class="card stack"><h2 style="margin:0;">Toner and ink</h2>${data.supplies.length ? data.supplies.map((s) => `
          <div class="tray-row"><span class="tray-name">${escapeHtml(s.description)}</span>
          <span class="tray-bar" aria-hidden="true"><span style="width:${s.percent != null ? s.percent : 50}%; background:${COLORANT[s.colorant] || 'var(--accent)'}"${s.percent == null ? ' class="partial"' : ''}></span></span>
          <span class="tray-level">${s.percent != null ? `${s.percent}%` : 'OK'}</span></div>`).join('') : '<p class="muted" style="margin:0;">This printer doesn\'t report toner levels.</p>'}</div>
      </div>`;
  } else if (tab === 'settings') {
    const cfg = p.config;
    const s = data.settings;
    const canSet = p.actions.includes('set_defaults');
    const opt = (v, l, cur) => `<option value="${v}"${String(cur) === String(v) ? ' selected' : ''}>${l}</option>`;
    html = `
      <div class="card stack">
        <div><h2 style="margin:0;">Default settings</h2><p class="muted small" style="margin:4px 0 0;">What new jobs on ${escapeHtml(p.name)} use unless the customer changes them. Only options this printer supports are offered.</p></div>
        ${!cfg ? '<p class="muted" style="margin:0;">Windows didn\'t report this printer\'s settings.</p>' : canSet ? `
        <form class="defaults-form" data-key="${escapeHtml(p.key)}">
          <div class="field"><label for="ds-duplex">Sides</label><select id="ds-duplex" name="duplex">${s.duplex.map((v) => opt(v, DUPLEX_LABEL[v], cfg.duplex)).join('')}</select></div>
          <div class="field"><label for="ds-color">Colour</label><select id="ds-color" name="color">${s.color.map((v) => opt(v, v ? 'Colour' : 'Black &amp; white', cfg.color)).join('')}</select></div>
          <div class="field"><label for="ds-paper">Paper</label><select id="ds-paper" name="paper_size">${s.paper_size.map((v) => opt(v, v, cfg.paper_size)).join('')}${s.paper_size.includes(cfg.paper_size) ? '' : `<option value="" selected>${escapeHtml(cfg.paper_size || 'Other')}</option>`}</select></div>
          <button type="button" class="btn btn-primary btn-sm" data-printer-act="set_defaults" data-key="${escapeHtml(p.key)}"${p.pending.some((c) => c.action === 'set_defaults') ? ' disabled' : ''}>Apply</button>
        </form>` : `<p style="margin:0;">${escapeHtml(DUPLEX_LABEL[cfg.duplex] || cfg.duplex)} · ${cfg.color ? 'colour' : 'black &amp; white'} · ${escapeHtml(cfg.paper_size)}</p><p class="muted small" style="margin:0;">Only an admin can change these.</p>`}
        ${pendingHtml(p)}
      </div>
      ${data.properties.length ? `<details class="card"><summary><strong>Driver options</strong> <span class="muted small">(${data.properties.length}, read only)</span></summary>
        <dl class="info-list" style="margin-top:12px;">${data.properties.map((x) => `<dt class="mono small">${escapeHtml(x.name)}</dt><dd>${escapeHtml(x.value)}</dd>`).join('')}</dl></details>` : ''}`;
  } else if (tab === 'queue') {
    html = `<div class="card stack">${pendingHtml(p)}${queueTableHtml(p)}${controlsHtml(p)}</div>`;
  } else {
    const t = data.today;
    html = `
      <div class="grid grid-4">${[
        { label: 'Jobs today', value: t.jobs, sub: `${plural(t.two_sided_jobs, 'job')} two-sided` },
        { label: 'Pages today', value: t.pages, sub: `${t.colour_pages} colour · ${t.sheets} sheets` },
        { label: 'Photocopies today', value: t.copied_pages, sub: 'From its page counter' },
        { label: 'Print speed', value: p.speed.source === 'learned' ? `${p.speed.ppm}/min` : '—', sub: p.speed.source === 'learned' ? 'Measured from jobs here' : 'Not measured yet' }
      ].map(kpiCard).join('')}</div>
      <div class="card stack"><h2 style="margin:0;">Actions from this app</h2>${data.log.length ? `
        <div class="table-wrap"><table><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Result</th></tr></thead><tbody>${data.log.map((c) => `
          <tr><td class="small">${escapeHtml(formatDbDate(c.created_at))}</td><td>${escapeHtml(c.requested_by_name || 'Automatic')}</td>
          <td>${escapeHtml(c.verb)}${c.params && c.params.document ? ` "${escapeHtml(c.params.document)}"` : ''}</td>
          <td>${c.status === 'done' ? '<span class="badge ok">Done</span>' : c.status === 'queued' || c.status === 'sent' ? '<span class="badge info">Waiting</span>' : `<span class="badge warn">${escapeHtml(c.status)}</span> <span class="small">${escapeHtml(c.error || '')}</span>`}</td></tr>`).join('')}
        </tbody></table></div>` : '<p class="muted" style="margin:0;">No actions yet.</p>'}</div>`;
  }
  panel.innerHTML = `<div class="stack tab-in">${html}</div>`;
}

async function onPrinterAction(e) {
  const g = e.target.closest('[data-guide]');
  if (g) { openFixGuide(g.dataset.key, g.dataset.guide); return; }
  const b = e.target.closest('[data-printer-act]');
  if (!b || b.disabled) return;
  const p = findPrinter(b.dataset.key);
  if (!p) return;
  const action = b.dataset.printerAct;
  const params = {};
  if (b.dataset.job) Object.assign(params, { job_id: Number(b.dataset.job), document: b.dataset.doc });
  if (action === 'set_defaults') {
    const form = b.closest('form');
    params.duplex = form.elements.duplex.value;
    params.color = form.elements.color.value === 'true';
    if (form.elements.paper_size.value) params.paper_size = form.elements.paper_size.value;
  }
  const send = async () => {
    const { command } = await api('POST', '/api/printers/commands', { agent_id: p.agent_id, printer: p.name, action, params });
    watchCommand(command.id, p.name);
    await (currentView === 'printer' ? loadPrinterDetail() : loadPrinters());
  };
  const confirmText = {
    cancel_job: [`Cancel "${params.document}"?`, 'It is removed from the queue. Pages already printed stay printed.', 'Cancel job'],
    restart_job: [`Restart "${params.document}"?`, 'It prints again from the first page.', 'Restart'],
    clear_queue: [`Clear every job on ${p.name}?`, `${plural(p.queue.length, 'job')} will be removed.`, 'Clear queue']
  }[action];
  if (confirmText) {
    openModal({ title: confirmText[0], body: `<p style="margin:0;">${escapeHtml(confirmText[1])}</p>`, submitLabel: confirmText[2], danger: action !== 'restart_job', onSubmit: send });
    return;
  }
  b.disabled = true;
  try { await send(); } catch (err) { toast(err.message, true); b.disabled = false; }
}

// Follow a command until the printer's PC reports back, then say how it went.
function watchCommand(id, printerName) {
  if (watchedCommands.has(id)) return;
  watchedCommands.set(id, printerName);
  const started = Date.now();
  const tick = async () => {
    try {
      const { command } = await api('GET', `/api/printers/commands/${id}`);
      if (command.status === 'done') {
        watchedCommands.delete(id);
        const removed = command.result && command.result.removed;
        toast(`${printerName}: ${command.verb}${command.params.document ? ` "${command.params.document}"` : ''} done${removed != null ? ` (${plural(removed, 'job')} removed)` : ''}.`);
        if (currentView === 'printers') loadPrinters().catch(() => {});
        if (currentView === 'printer') loadPrinterDetail().catch(() => {});
        return;
      }
      if (command.status === 'failed' || command.status === 'expired') {
        watchedCommands.delete(id);
        toast(`${printerName}: ${command.verb} didn't work. ${command.error || ''}`, true);
        if (currentView === 'printers') loadPrinters().catch(() => {});
        if (currentView === 'printer') loadPrinterDetail().catch(() => {});
        return;
      }
    } catch (_) { /* keep trying */ }
    if (Date.now() - started < 6 * 60 * 1000) setTimeout(tick, 1500); else watchedCommands.delete(id);
  };
  setTimeout(tick, 1000);
}

// ---------------------------------------------------------------
// Print monitor (admin): client sessions
// ---------------------------------------------------------------
let sessionList = [];

function setupPrintMonitor() {
  $('summary-date').value = localDateString();
  const reload = () => Promise.all([loadPrintSummary(), loadSessions(), loadCopies()]).catch((err) => toast(err.message, true));
  $('summary-date').addEventListener('change', reload);
  $('session-filter').addEventListener('change', () => loadSessions().catch((err) => toast(err.message, true)));

  $('sessions-wrap').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-session-act]');
    if (!b) return;
    const id = Number(b.dataset.id);
    if (b.dataset.sessionAct === 'review') {
      try {
        await api('PATCH', `/api/print-sessions/${id}/review`);
        await Promise.all([loadSessions(), refreshUnreviewedCount()]);
      } catch (err) { toast(err.message, true); }
    }
    if (b.dataset.sessionAct === 'flag') {
      openModal({
        title: 'Flag this session',
        body: `<div class="field"><label for="flag-note">Note (optional)</label><textarea id="flag-note" maxlength="500" placeholder="e.g. printed 40 pages, paid for 10"></textarea></div>`,
        submitLabel: 'Flag',
        danger: true,
        onSubmit: async (form) => {
          await api('PATCH', `/api/print-sessions/${id}/flag`, { note: form.querySelector('#flag-note').value.trim() });
          await Promise.all([loadSessions(), refreshUnreviewedCount()]);
        }
      });
    }
  });

  $('copies-wrap').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-copy-act]');
    if (!b) return;
    const id = Number(b.dataset.id);
    if (b.dataset.copyAct === 'restore') {
      try { await api('PATCH', `/api/copies/${id}/restore`); await loadCopies(); } catch (err) { toast(err.message, true); }
      return;
    }
    openModal({
      title: 'Not a sale',
      body: `<p class="muted" style="margin:0;">The run stays on record but no longer counts as printed-but-not-sold.</p>
        <div class="field"><label for="copy-note">Reason</label>
          <select id="copy-note"><option>Shop's own copies</option><option>Printer report / test page</option><option>Fax received</option><option>Reprint after a jam</option><option>Other</option></select></div>`,
      submitLabel: 'Dismiss',
      onSubmit: async (form) => {
        await api('PATCH', `/api/copies/${id}/dismiss`, { note: form.querySelector('#copy-note').value });
        await loadCopies();
      }
    });
  });

  $('agent-register-btn').addEventListener('click', () => {
    openModal({
      title: 'Register a print agent',
      body: `<div class="field"><label for="agent-label">Name for this PC</label><input id="agent-label" required maxlength="100" placeholder="e.g. Front desk PC"></div>`,
      submitLabel: 'Register',
      onSubmit: async (form) => {
        const result = await api('POST', '/api/agents', { label: form.querySelector('#agent-label').value.trim() });
        const reveal = $('agent-key-reveal');
        reveal.hidden = false;
        reveal.innerHTML = `
          <div class="callout info">
            <strong>Agent "${escapeHtml(result.label)}" registered</strong>
            <span class="small">Copy this key into the agent's <code>config.json</code> now. It will not be shown again.</span>
            <code class="key-box">${escapeHtml(result.api_key)}</code>
          </div>`;
        await loadAgents();
      }
    });
  });
  $('agents-wrap').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-agent]');
    if (!b) return;
    try {
      await api('PATCH', `/api/agents/${b.dataset.agent}/active`, { active: b.dataset.active !== '1' });
      await loadAgents();
    } catch (err) { toast(err.message, true); }
  });
}

async function refreshUnreviewedCount() {
  try {
    const { jobs } = await api('GET', '/api/print-jobs?status=draft');
    const el = $('unreviewed-count');
    el.hidden = jobs.length === 0;
    el.textContent = jobs.length >= 500 ? '500+' : String(jobs.length);
    el.title = `${jobs.length} unreviewed print jobs`;
  } catch (_) { /* badge is optional */ }
}

async function loadPrintSummary() {
  const date = $('summary-date').value || localDateString();
  const { totals, byPrinter } = await api('GET', `/api/print-jobs/summary?date=${encodeURIComponent(date)}`);
  $('summary-kpis').innerHTML = [
    { label: 'Pages printed', value: totals.total_pages, sub: `${totals.color_pages} colour · ${totals.mono_pages} B&W · ${totals.total_sheets} sheets` },
    { label: 'Print jobs', value: totals.job_count, sub: `${plural(totals.multi_copy_jobs, 'job')} with copies${totals.unknown_color_jobs ? ` · ${totals.unknown_color_jobs} colour unknown` : ''}` },
    { label: 'Client sessions', value: totals.sessions, sub: 'Jobs grouped per client visit' },
    { label: 'Partial prints', value: totals.partial_jobs, sub: 'Fewer pages than the document has' }
  ].map(kpiCard).join('');

  $('summary-by-printer').innerHTML = byPrinter.length === 0 ? '<p class="muted" style="margin:0;">Nothing printed this day.</p>' : `
    <table><thead><tr><th>Printer</th><th class="num">Jobs</th><th class="num">Pages</th></tr></thead><tbody>
    ${byPrinter.map((p) => `<tr><td>${escapeHtml(p.printer_name)}</td><td class="num">${p.job_count}</td><td class="num">${p.total_pages}</td></tr>`).join('')}
    </tbody></table>`;
}

const ICONS = {
  burst: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>',
  concurrent: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
  partial: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H6v18h12V7z"/><path d="M14 3v4h4M9 13h6"/></svg>',
  reprint: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5"/></svg>'
};

function sessionAlerts(flags) {
  const text = {
    off_hours: (f) => [`${plural(f.jobs, 'job')} printed after hours`, '', ICONS.burst],
    burst: (f) => [`${f.jobs} jobs within ${f.seconds} s`, '', ICONS.burst],
    concurrent: (f) => [`${f.jobs} printing at once`, '', ICONS.concurrent],
    partial: (f) => [`${plural(f.jobs, 'partial print')}`, '', ICONS.partial],
    split: () => ['Document printed in parts', 'info', ICONS.partial],
    reprint: (f) => [`${plural(f.jobs, 'reprint')}`, '', ICONS.reprint],
    copies: (f) => [`${plural(f.jobs, 'job')} with copies`, 'info', ''],
    mode_unknown: (f) => [`Colour unknown on ${plural(f.jobs, 'job')}`, 'neutral', '']
  };
  return flags.filter((f) => text[f.type]).map((f) => {
    const [label, cls, icon] = text[f.type](f);
    return `<span class="alert-chip ${cls}">${icon}${escapeHtml(label)}</span>`;
  }).join('');
}

function timeOf(value) {
  const d = parseDbDate(value);
  return d && !Number.isNaN(d.getTime()) ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '';
}

function coverageCell(j) {
  if (j.pages == null) return '<span class="muted">Pages unknown</span>';
  const est = j.est_document_pages;
  const knows = j.est_source === 'measured' || j.est_source === 'history';
  const how = j.est_source === 'measured' ? 'Length measured from the file' : 'Length from this client\'s print history';
  if (!knows || !est) {
    return `<div class="coverage"><span>${plural(j.pages, 'page')}</span><span class="muted small" title="Turn on document page counting in the agent to know the full length">Document length unknown</span></div>`;
  }
  const pct = Math.min(100, Math.round((j.pages / est) * 100));
  const label = j.coverage === 'full' ? 'All pages' : j.coverage === 'split' ? 'Part of a split print' : 'Partial';
  return `<div class="coverage" title="${escapeHtml(how)}">
    <span><b class="mono">${j.pages}</b> of ${est} · <span class="${j.coverage === 'partial' ? 'badge warn' : j.coverage === 'full' ? 'badge ok' : 'badge info'}">${label}</span></span>
    <div class="bar ${j.coverage === 'partial' ? 'partial' : ''}"><div style="width:${pct}%"></div></div>
  </div>`;
}

function sessionCard(s) {
  const pages = s.color_pages + s.mono_pages + s.unknown_pages;
  const start = timeOf(s.started_at);
  const end = timeOf(s.ended_at);
  const client = s.owner || 'Unknown user';
  return `
    <article class="card session" aria-label="Print session for ${escapeHtml(client)}">
      <div class="session-head">
        <div>
          <div class="session-client">${escapeHtml(client)}${s.machine ? ` <span class="muted" style="font-weight:500; font-size:14px;">on ${escapeHtml(s.machine)}</span>` : ''}</div>
          <div class="session-meta">
            <span>${escapeHtml(start)}${end && end !== start ? `–${escapeHtml(end)}` : ''}</span>
            <span><b>${s.job_count}</b> ${s.job_count === 1 ? 'job' : 'jobs'}</span>
            <span><b>${pages}</b> ${pages === 1 ? 'page' : 'pages'} (${s.color_pages} colour, ${s.mono_pages} B&amp;W${s.unknown_pages ? `, ${s.unknown_pages} unknown` : ''})</span>
            <span><b>${s.sheets}</b> sheets</span>
            <span>${escapeHtml(s.agent_label)}</span>
          </div>
        </div>
        <div class="row" style="gap:6px;">
          ${s.sale_id ? `<a class="badge ok" href="receipt.html?id=${s.sale_id}" target="_blank" rel="noopener">Billed ${escapeHtml(s.receipt_no || '')}</a>` : '<span class="badge warn">Not billed</span>'}
          ${s.unreviewed ? `<button type="button" class="btn btn-outline btn-sm" data-session-act="review" data-id="${s.id}">Mark reviewed</button>` : '<span class="badge">Reviewed</span>'}
          <button type="button" class="btn btn-ghost btn-sm" data-session-act="flag" data-id="${s.id}">Flag</button>
        </div>
      </div>
      ${s.flags.length ? `<div class="alert-chips">${sessionAlerts(s.flags)}</div>` : ''}
      <div class="table-wrap">
        <table>
          <thead><tr><th>Document</th><th>Pages printed</th><th class="num">Copies</th><th class="num">Total</th><th>Type</th><th>Time</th><th>Status</th></tr></thead>
          <tbody>${s.jobs.map((j) => `
            <tr>
              <td>${j.document_name ? escapeHtml(j.document_name) : '<span class="muted">(untitled)</span>'}
                <div class="muted small">${escapeHtml(j.printer_name)}${j.flags.includes('reprint') ? ' · <strong style="color:var(--warn-ink)">reprint</strong>' : ''}${j.flags.includes('concurrent') ? ' · overlapped another job' : ''}</div></td>
              <td>${coverageCell(j)}</td>
              <td class="num">${j.copies > 1 ? `<span class="badge info">×${j.copies}</span>` : (j.copies === 1 ? '1' : '<span class="muted">1?</span>')}</td>
              <td class="num">${j.impressions ?? j.pages ?? '?'}${j.duplex === 'duplex' ? `<div class="muted small">${j.sheets} sheets</div>` : ''}</td>
              <td><div class="row" style="gap:4px;">${colorBadge(j.color_mode)}${duplexBadge(j.duplex)}${j.paper_size ? `<span class="badge">${escapeHtml(j.paper_size)}</span>` : ''}</div></td>
              <td>${escapeHtml(timeOf(j.submitted_at))}</td>
              <td>${jobStatus(j)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </article>`;
}

async function loadSessions() {
  const date = $('summary-date').value || localDateString();
  const filter = $('session-filter').value;
  const params = new URLSearchParams({ date });
  if (filter === 'billed' || filter === 'unbilled') params.set('billing', filter);
  if (filter === 'flagged') params.set('flagged', '1');
  const { sessions } = await api('GET', `/api/print-sessions?${params.toString()}`);
  sessionList = sessions;
  $('sessions-wrap').innerHTML = sessions.length === 0
    ? `<div class="card">${emptyState('No print sessions for this day and filter.')}</div>`
    : sessions.map(sessionCard).join('');
}

// ---------------------------------------------------------------
// Photocopies found on the printers' page counters
// ---------------------------------------------------------------
const COPY_EVIDENCE = {
  copy_counter: "printer's own copy counter",
  printing_without_job: 'printer busy with no print job',
  sustained: 'went on for several minutes',
  spooled_pages_missing_nearby: 'a print job went missing nearby: may be a late print',
  single_page: 'single page: may be a report page',
  other_pc_jobs: 'part of it was printing from another PC'
};
const COPY_BADGE = { high: '<span class="badge ok">Sure</span>', medium: '<span class="badge">Likely</span>', low: '<span class="badge warn">Unsure</span>' };

async function loadCopies() {
  const date = $('summary-date').value || localDateString();
  const { copies } = await api('GET', `/api/copies?date=${encodeURIComponent(date)}`);
  const counted = copies.filter((c) => c.status === 'open' || c.status === 'billed');
  const pages = counted.reduce((n, c) => n + c.pages, 0);
  const open = counted.filter((c) => c.status === 'open' && c.pages > 0);
  $('copies-total').textContent = copies.length ? `${plural(pages, 'page')} · ${open.length} not billed` : '';
  $('copies-wrap').innerHTML = copies.length === 0
    ? '<p class="muted" style="margin:0;">No photocopies detected this day.</p>'
    : copies.map((c) => {
      const colour = c.color_pages && !c.mono_pages && !c.unknown_pages ? 'colour' : c.unknown_pages ? 'colour unknown' : c.color_pages ? `${c.color_pages} colour` : 'B&W';
      const evidence = c.evidence.map((x) => COPY_EVIDENCE[x]).filter(Boolean).join(' · ');
      let state = '';
      if (c.status === 'open') state = `<button type="button" class="btn btn-ghost btn-sm" data-copy-act="dismiss" data-id="${c.id}">Not a sale</button>`;
      if (c.status === 'billed') state = `<span class="badge ok">Billed${c.receipt_no ? ` · ${escapeHtml(c.receipt_no)}` : ''}</span>`;
      if (c.status === 'dismissed') state = `<span class="badge">${escapeHtml(c.note || 'Dismissed')}</span> <button type="button" class="btn btn-ghost btn-sm" data-copy-act="restore" data-id="${c.id}">Restore</button>`;
      if (c.status === 'duplicate') state = '<span class="badge">Same run as another agent</span>';
      return `<div class="copy-item${c.status === 'dismissed' || c.status === 'duplicate' ? ' is-muted' : ''}">
        <div class="spread" style="gap:8px;">
          <div><strong>${plural(c.pages, c.unit === 'sheets' ? 'sheet' : 'page')}</strong> <span class="muted">· ${escapeHtml(colour)}</span></div>
          ${COPY_BADGE[c.confidence] || ''}
        </div>
        <div class="muted small">${escapeHtml(c.printer_name)} · ${escapeHtml(timeOf(c.started_at))}–${escapeHtml(timeOf(c.ended_at))}${c.detected_pages !== c.pages ? ` · ${c.detected_pages} on the counter` : ''}</div>
        ${evidence ? `<div class="muted small">${escapeHtml(evidence)}</div>` : ''}
        <div class="row" style="gap:6px; margin-top:6px;">${state}</div>
      </div>`;
    }).join('');
}

function colorBadge(mode) {
  if (mode === 'color') return '<span class="badge info">Colour</span>';
  if (mode === 'mono') return '<span class="badge">B&amp;W</span>';
  return '<span class="badge warn">Colour unknown</span>';
}

function duplexBadge(duplex) {
  if (duplex === 'duplex') return '<span class="badge">Duplex</span>';
  if (duplex === 'simplex') return '<span class="badge">1-sided</span>';
  return '';
}

function jobStatus(j) {
  if (j.status === 'approved') return '<span class="badge ok">Reviewed</span>';
  if (j.status === 'rejected') return `<span class="badge danger">Flagged</span>${j.note ? `<div class="muted small">${escapeHtml(j.note)}</div>` : ''}`;
  return '<span class="badge warn">Unreviewed</span>';
}

async function loadAgents() {
  const { agents } = await api('GET', '/api/agents');
  $('agents-wrap').innerHTML = agents.length === 0 ? '<p class="muted" style="margin:0;">No agents registered yet.</p>'
    : agents.map((a) => `
      <div class="list-row">
        <div style="min-width:0;"><div style="font-weight:600;">${escapeHtml(a.label)}</div>
          <div class="muted small">${a.last_seen_at ? `Last seen ${escapeHtml(formatDbDate(a.last_seen_at))}` : 'Never connected'}</div></div>
        <div class="row" style="gap:6px; flex-wrap:nowrap;">
          ${!a.active ? '<span class="badge danger">Disabled</span>' : a.online ? '<span class="badge ok">Online</span>' : '<span class="badge">Offline</span>'}
          <button type="button" class="btn btn-ghost btn-sm" data-agent="${a.id}" data-active="${a.active}">${a.active ? 'Disable' : 'Enable'}</button>
        </div>
      </div>`).join('');
}

// ---------------------------------------------------------------
// Printed vs sold (admin)
// ---------------------------------------------------------------
function setupReconcile() {
  $('audit-likely').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-link-session]');
    if (!b) return;
    try {
      await api('PATCH', `/api/print-sessions/${b.dataset.linkSession}/link`, { sale_id: Number(b.dataset.sale) });
      toast('Session linked to the sale.');
      await loadReconcile();
    } catch (err) { toast(err.message, true); }
  });
  $('rec-from').value = daysAgoString(13);
  $('rec-to').value = localDateString();
  $('rec-filters').addEventListener('submit', (e) => { e.preventDefault(); loadReconcile().catch((err) => toast(err.message, true)); });
}

async function loadReconcile() {
  const q = new URLSearchParams({ from: $('rec-from').value, to: $('rec-to').value });
  const data = await api('GET', `/api/reconciliation?${q.toString()}`);
  const t = data.totals;

  $('rec-setup').innerHTML = data.printServices.length > 0 ? '' : `
    <div class="callout"><strong>No print services set up yet</strong>
    <span class="small">Edit your print products (for example "B&amp;W print A4") and set <em>Print service</em> to Colour or B&amp;W, so their quantity sold counts as pages here. <a href="#products" data-go="products">Open products</a></span></div>`;
  wireGoLinks($('rec-setup'));

  $('rec-kpis').innerHTML = [
    { label: 'Pages printed', value: t.color_printed + t.mono_printed, sub: `${t.color_printed} colour · ${t.mono_printed} B&W${t.unknown_printed ? ` · ${t.unknown_printed} unknown` : ''}${t.copy_pages ? ` · ${t.copy_pages} photocopied` : ''}` },
    { label: 'Pages sold', value: round2(t.color_sold + t.mono_sold), sub: `${round2(t.color_sold)} colour · ${round2(t.mono_sold)} B&W${t.copy_sold ? ` · ${round2(t.copy_sold)} as photocopies` : ''}${t.two_sided_sold ? ` · ${round2(t.two_sided_sold)} two-sided` : ''}` },
    { label: 'Gap', value: plural(round2(t.gap), 'page'), sub: `${t.gap > 0 ? 'Printed but not sold' : 'Nothing unaccounted for'} · ${data.sessions.billed} of ${plural(data.sessions.total, 'client session')} billed` },
    { label: 'Est. unbilled value', value: cur(t.estimated_value), sub: `At ${cur(data.prices.color)} colour / ${cur(data.prices.mono)} B&W per page` }
  ].map(kpiCard).join('');

  renderAudit(data.audit);
  if (t.no_data_days) {
    $('rec-setup').insertAdjacentHTML('beforeend', `<div class="callout info"><strong>${plural(t.no_data_days, 'day')} without print data left out of the totals</strong><span class="small">Print services were sold on those days but no agent reported any printing, usually because the agent wasn't running yet.</span></div>`);
  }

  $('rec-table').innerHTML = data.rows.length === 0 ? emptyState('No printing or print-service sales in this range.') : `
    <table>
      <thead><tr><th>Day</th><th class="num">Colour printed</th><th class="num">Colour sold</th><th class="num">B&amp;W printed</th><th class="num">B&amp;W sold</th><th class="num">Unknown</th><th class="num">Photocopied</th><th class="num">Gap</th><th class="num">Est. value</th></tr></thead>
      <tbody>${data.rows.map((r) => `
        <tr>
          <td>${escapeHtml(dayLabel(r.day))}</td>
          <td class="num">${r.color_printed}</td><td class="num">${round2(r.color_sold)}</td>
          <td class="num">${r.mono_printed}</td><td class="num">${round2(r.mono_sold)}</td>
          <td class="num">${r.unknown_printed || '<span class="muted">0</span>'}</td>
          <td class="num">${r.copy_pages ? `${r.copy_pages}<div class="muted small">${round2(r.copy_sold)} sold as copies</div>` : '<span class="muted">0</span>'}</td>
          <td class="num">${r.no_data ? '<span class="badge" title="Print services were sold but no agent reported any printing this day">No print data</span>' : `<span class="badge ${r.gap > 0 ? 'warn' : r.gap < 0 ? '' : 'ok'}">${r.gap === 0 ? 'Balanced' : `${r.gap > 0 ? '+' : ''}${round2(r.gap)} pages`}</span>`}</td>
          <td class="num">${!r.no_data && r.estimated_value ? escapeHtml(cur(r.estimated_value)) : '<span class="muted">&mdash;</span>'}</td>
        </tr>`).join('')}
      </tbody>
    </table>`;
}

function auditRow(s, extra) {
  const pages = s.color_pages + s.mono_pages + s.unknown_pages;
  return `<div class="list-row">
    <div style="min-width:0;">
      <div><strong>${escapeHtml(s.owner || 'Unknown user')}</strong>${s.machine ? ` <span class="muted">on ${escapeHtml(s.machine)}</span>` : ''}</div>
      <div class="muted small">${escapeHtml(formatDbDate(s.ended_at))} · ${plural(s.job_count, 'job')} · ${plural(pages, 'page')} (${s.color_pages} colour, ${s.mono_pages} B&amp;W)</div>
      ${extra || ''}
    </div>
    <span class="mono" style="white-space:nowrap;">${escapeHtml(cur(s.value))}</span>
  </div>`;
}

function renderAudit(audit) {
  $('audit-missing').innerHTML = audit.missing.length === 0
    ? '<p class="muted" style="margin:0;">Every print session in this range is linked to or matched with a sale.</p>'
    : `<div class="callout" style="margin-bottom:6px;"><strong>${plural(audit.missing_count, 'session')} · about ${escapeHtml(cur(audit.missing_value))} unbilled</strong></div>${audit.missing.map((s) => auditRow(s)).join('')}`;
  $('audit-copies').innerHTML = audit.copies.length === 0 ? '' : `
    <div class="callout" style="margin:10px 0 6px;"><strong>${plural(audit.copies_count, 'photocopy run')} · about ${escapeHtml(cur(audit.copies_value))} unbilled</strong></div>
    ${audit.copies.map((c) => `<div class="list-row">
      <div style="min-width:0;">
        <div><span class="badge info">Photocopies</span> <strong>${escapeHtml(c.printer_name)}</strong></div>
        <div class="muted small">${escapeHtml(formatDbDate(c.started_at))} · ${plural(c.pages, 'page')}${c.unknown_pages ? ' (colour unknown, valued as B&amp;W)' : ''} · ${c.confidence === 'high' ? 'sure' : 'likely'}</div>
      </div>
      <span class="mono" style="white-space:nowrap;">${escapeHtml(cur(c.value))}</span>
    </div>`).join('')}`;
  $('audit-likely').innerHTML = audit.likely.length === 0
    ? '<p class="muted" style="margin:0;">No hand-rung sales to pair with.</p>'
    : audit.likely.map((s) => auditRow(s, `<div class="row" style="gap:6px; margin-top:6px;">
        <a class="badge info" href="receipt.html?id=${s.match.sale.id}" target="_blank" rel="noopener">${escapeHtml(s.match.sale.receipt_no)}</a>
        <span class="muted small">${Math.round(s.match.confidence * 100)}% match${s.match.sale.customer_name ? ` · till name "${escapeHtml(s.match.sale.customer_name)}"` : ''}</span>
        <button type="button" class="btn btn-outline btn-sm" data-link-session="${s.id}" data-sale="${s.match.sale.id}">Confirm</button>
      </div>`)).join('');
}

// ---------------------------------------------------------------
// Customers (admin) and checkout lookup
// ---------------------------------------------------------------
const SEGMENTS = {
  champion: ['Champions', 'Recent, frequent, high spend', 'ok'],
  loyal: ['Loyal', 'Come back regularly', 'ok'],
  promising: ['Promising', 'Recent, starting to return', 'info'],
  new: ['New', 'First visit in the last two weeks', 'info'],
  at_risk: ['At risk', 'Good customers who have gone quiet', 'warn'],
  needs_attention: ['Needs attention', 'Middling and slipping', 'warn'],
  lost: ['Lost', 'Not seen for over two months', 'danger'],
  one_off: ['One-off', 'Came once, a while ago', '']
};
let customerSegment = '';

function setupCustomers() {
  let timer = null;
  $('customer-search').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => loadCustomers().catch((err) => toast(err.message, true)), 250); });
  $('segment-chips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-segment]');
    if (!b) return;
    customerSegment = customerSegment === b.dataset.segment ? '' : b.dataset.segment;
    loadCustomers().catch((err) => toast(err.message, true));
  });
}

async function loadCustomers() {
  const params = new URLSearchParams();
  if (customerSegment) params.set('segment', customerSegment);
  const q = $('customer-search').value.trim();
  if (q) params.set('q', q);
  const data = await api('GET', `/api/insights/customers?${params.toString()}`);
  $('segment-chips').innerHTML = Object.entries(SEGMENTS).filter(([k]) => data.segments[k]).map(([k, [label, hint]]) =>
    `<button type="button" class="chip seg-chip${customerSegment === k ? ' active' : ''}" data-segment="${k}" aria-pressed="${customerSegment === k}" title="${escapeHtml(hint)}">${escapeHtml(label)}<span class="count">${data.segments[k]}</span></button>`).join('');
  $('customers-table-wrap').innerHTML = data.customers.length === 0
    ? emptyState('No customers yet. Customers appear once names or phone numbers are entered at checkout.')
    : `<table>
      <thead><tr><th>Customer</th><th>Phone</th><th class="num">Visits</th><th class="num">Spend</th><th class="num">Average</th><th>Last visit</th><th>Usually every</th><th>Group</th></tr></thead>
      <tbody>${data.customers.map((c) => {
        const [label, , cls] = SEGMENTS[c.segment] || [c.segment, '', ''];
        return `<tr>
          <td><strong>${escapeHtml(c.name)}</strong>${c.aliases.length ? `<div class="muted small">also: ${c.aliases.map(escapeHtml).join(', ')}</div>` : ''}</td>
          <td>${c.phones.length ? escapeHtml(c.phones[0]) : '<span class="muted">&mdash;</span>'}</td>
          <td class="num">${c.visits}</td>
          <td class="num">${escapeHtml(cur(c.spend))}</td>
          <td class="num">${escapeHtml(cur(c.average))}</td>
          <td>${c.days_since === 0 ? 'Today' : `${plural(c.days_since, 'day')} ago`}</td>
          <td>${c.usual_gap_days ? plural(Math.round(c.usual_gap_days), 'day') : '<span class="muted">&mdash;</span>'}</td>
          <td><span class="badge ${cls}">${escapeHtml(label)}</span>${c.overdue ? ' <span class="badge warn" title="Well past their usual gap between visits">Overdue</span>' : ''}</td>
        </tr>`;
      }).join('')}</tbody></table>`;
}

function setupCustomerLookup() {
  const input = $('customer-name');
  const list = $('customer-matches');
  let timer = null;
  let token = 0;
  const hide = () => { list.hidden = true; };
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { hide(); return; }
    timer = setTimeout(async () => {
      const mine = ++token;
      let customers = [];
      try { ({ customers } = await api('GET', `/api/insights/customers/lookup?q=${encodeURIComponent(q)}`)); } catch (_) { /* optional */ }
      if (mine !== token) return;
      list.hidden = customers.length === 0;
      list.innerHTML = customers.map((c, i) => `<button type="button" role="option" data-i="${i}">${escapeHtml(c.name)} <small>${c.phone ? `${escapeHtml(c.phone)} · ` : ''}${plural(c.visits, 'visit')}</small></button>`).join('');
      list._customers = customers;
    }, 200);
  });
  list.addEventListener('mousedown', (e) => {
    const b = e.target.closest('[data-i]');
    if (!b) return;
    e.preventDefault();
    const c = list._customers[Number(b.dataset.i)];
    input.value = c.name;
    if (c.phone && !$('customer-phone').value) $('customer-phone').value = c.phone;
    hide();
  });
  input.addEventListener('blur', () => setTimeout(hide, 150));
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
}

// ---------------------------------------------------------------
// Busy hours (admin, on Reports)
// ---------------------------------------------------------------
let trafficData = null;
let heatMode = 'rate';

function setupTraffic() {
  document.querySelectorAll('[data-heat]').forEach((b) => b.addEventListener('click', () => {
    heatMode = b.dataset.heat;
    document.querySelectorAll('[data-heat]').forEach((x) => { x.classList.toggle('active', x === b); x.setAttribute('aria-pressed', String(x === b)); });
    renderHeatmap();
  }));
}

async function loadTraffic() {
  trafficData = await api('GET', '/api/insights/traffic');
  $('traffic-note').textContent = `About ${trafficData.service_minutes} min per customer (measured). Cashier counts aim to serve ${Math.round(trafficData.target.service_level * 100)}% of customers within ${trafficData.target.wait_minutes} min (Erlang C queueing model).`;
  renderHeatmap();
}

function renderHeatmap() {
  const t = trafficData;
  if (!t) return;
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const order = [1, 2, 3, 4, 5, 6, 0];
  const values = heatMode === 'rate' ? t.rate : t.staff;
  const max = Math.max(1, ...order.flatMap((wd) => t.hours.map((h) => values[wd][h])));
  const cell = (v) => {
    if (!v) return '<td style="background:var(--surface-2); color:var(--input-line);">·</td>';
    const k = v / max;
    const bg = `rgba(35, 70, 216, ${0.12 + 0.78 * k})`;
    return `<td style="background:${bg}; color:${k > 0.55 ? '#fff' : 'var(--accent-ink)'};">${heatMode === 'rate' ? (v < 10 ? v.toFixed(1) : Math.round(v)) : v}</td>`;
  };
  $('heatmap-wrap').innerHTML = `<table class="heatmap" aria-label="${heatMode === 'rate' ? 'Average customers per hour' : 'Recommended cashiers'} by weekday and hour">
    <thead><tr><th></th>${t.hours.map((h) => `<th scope="col">${String(h).padStart(2, '0')}</th>`).join('')}</tr></thead>
    <tbody>${order.map((wd, i) => `<tr><th scope="row" class="day">${days[i]}${t.opening[wd] ? `<div class="muted" style="font-weight:400; font-size:10.5px;">${minutesLabel(t.opening[wd].open)}–${minutesLabel(t.opening[wd].close)}</div>` : ''}</th>${t.hours.map((h) => cell(values[wd][h])).join('')}</tr>`).join('')}</tbody>
  </table>
  ${t.peak.length ? `<p class="muted small" style="margin:8px 0 0;">Busiest: ${t.peak.slice(0, 3).map((p) => `${days[order.indexOf(p.wd)]} ${String(p.hr).padStart(2, '0')}:00 (${p.per_hour}/h, ${plural(p.cashiers, 'cashier')})`).join(' · ')}. Row labels show the opening hours learned from your sales.</p>` : ''}`;
}

function minutesLabel(m) {
  const h = Math.floor(m / 60);
  return `${String(h).padStart(2, '0')}:${String(Math.round(m % 60)).padStart(2, '0')}`;
}

// ---------------------------------------------------------------
// Product mix (admin, on Reports)
// ---------------------------------------------------------------
async function loadMix() {
  const { products } = await api('GET', '/api/insights/product-mix');
  const clsBadge = (c) => `<span class="badge ${c[0] === 'A' ? 'ok' : c[0] === 'B' ? 'info' : ''}">${escapeHtml(c)}</span>`;
  $('mix-wrap').innerHTML = products.length === 0 ? emptyState('No catalogue sales in the last 90 days.') : `
    <table><thead><tr><th>Product</th><th>Class</th><th class="num">Revenue</th><th class="num">Share</th><th class="num">Margin</th><th>What it means</th></tr></thead>
    <tbody>${products.map((p) => `<tr>
      <td>${escapeHtml(p.name)}</td>
      <td>${clsBadge(p.class)}</td>
      <td class="num">${escapeHtml(cur(p.revenue))}</td>
      <td class="num">${p.share}%</td>
      <td class="num">${p.margin === null ? '<span class="muted" title="Add a cost price to this product">&mdash;</span>' : `${escapeHtml(cur(p.margin))}<div class="muted small">${p.margin_pct}%</div>`}</td>
      <td class="small">${escapeHtml(p.advice)}</td>
    </tr>`).join('')}</tbody></table>`;
}

// ---------------------------------------------------------------
// Printer supplies (admin, on Print monitor)
// ---------------------------------------------------------------
let suppliesData = [];

function setupSupplies() {
  $('supplies-wrap').addEventListener('click', (e) => {
    const b = e.target.closest('[data-refill]');
    if (!b) return;
    const printer = b.dataset.printer;
    const kind = b.dataset.refill;
    const current = suppliesData.find((p) => p.printer === printer)?.supplies.find((x) => x.kind === kind);
    openModal({
      title: `${kind === 'paper' ? 'Paper loaded' : 'Toner replaced'}: ${printer}`,
      submitLabel: 'Save',
      body: `<div class="field"><label for="refill-cap">${kind === 'paper' ? 'Sheets now in the printer' : 'Rated yield of the new toner (pages)'}</label>
        <input id="refill-cap" type="number" min="1" step="1" required value="${current && current.capacity ? current.capacity : kind === 'paper' ? 500 : 2000}"></div>
        <p class="muted small" style="margin:0;">Counting restarts from now.</p>`,
      onSubmit: async (form) => {
        const res = await api('POST', '/api/insights/supplies/refill', { printer, kind, capacity: parseInt(form.querySelector('#refill-cap').value, 10) });
        suppliesData = res.printers;
        renderSupplies();
      }
    });
  });
}

let measuredToner = [];

async function loadSupplies() {
  ({ printers: suppliesData, measured: measuredToner } = await api('GET', '/api/insights/supplies'));
  renderSupplies();
}

const COLORANT = { black: '#16181D', cyan: '#00A3D9', magenta: '#D6007E', yellow: '#F2C200' };
const TONER_STATUS = { replace_now: ['Replace now', 'danger'], low: ['Low', 'warn'], unknown: ['Not reported', ''] };

function ago(iso) {
  const min = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

function tonerPrinterHtml(p, compact) {
  const supplies = compact ? p.supplies.filter((s) => !s.receptacle && /toner|ink/.test(s.kind)) : p.supplies;
  const rows = supplies.map((s) => {
    const colour = COLORANT[s.colorant] || (s.receptacle ? '#9EA29A' : '#C9CCC4');
    const [label, cls] = TONER_STATUS[s.status] || [];
    const forecast = s.receptacle ? (s.status === 'ok' ? '' : 'Nearly full: replace soon')
      : [s.pages_left !== null ? `~${s.pages_left.toLocaleString()} pages` : '', s.days_left !== null ? `~${s.days_left < 1 ? 'under a day' : plural(Math.round(s.days_left), 'day')}` : '']
        .filter(Boolean).join(' · ');
    const how = s.method === 'pages' ? `Learned: ~${s.pages_per_percent} pages per 1%${s.previous_yield ? `; last cartridge gave ~${s.previous_yield.toLocaleString()} pages` : ''}`
      : s.method === 'time' ? 'Forecast from how fast the level has dropped (few pages since the change)'
      : s.method === 'learning' ? 'Still learning this cartridge' : '';
    const barColour = s.status === 'replace_now' ? 'var(--danger)' : s.status === 'low' ? '#C2620A' : colour;
    return `<div class="toner-row">
      <span class="toner-dot" style="background:${colour}" aria-hidden="true"></span>
      <div style="min-width:0;">
        <div class="spread small"><span>${escapeHtml(s.description || s.colorant || s.kind)}</span><span class="mono">${s.percent === null ? (s.some_remaining ? 'some left' : '?') : s.receptacle ? `${Math.round(100 - s.percent)}% full` : `${Math.round(s.percent)}%`}</span></div>
        <div class="toner-bar ${s.percent === null ? 'unknown' : ''}" role="img" aria-label="${escapeHtml(s.description)} ${s.percent === null ? 'level not reported' : s.receptacle ? Math.round(100 - s.percent) + '% full' : Math.round(s.percent) + '%'}"><div style="width:${s.percent === null ? 0 : s.receptacle ? 100 - s.percent : s.percent}%; background:${barColour};"></div></div>
        ${!compact && (forecast || how) ? `<div class="muted small" title="${escapeHtml(how)}">${escapeHtml(forecast)}${forecast && how ? ' · ' : ''}${escapeHtml(how)}</div>` : compact && forecast ? `<div class="muted small">${escapeHtml(forecast)}</div>` : ''}
        ${!compact && s.replaced_at ? `<div class="muted small">New cartridge detected ${escapeHtml(formatDbDate(s.replaced_at))}</div>` : ''}
        ${!compact ? s.notes.map((n) => `<div class="small" style="color:var(--warn-ink);">${escapeHtml(n)}</div>`).join('') : ''}
      </div>
      ${label ? `<span class="badge ${cls}">${label}</span>` : '<span></span>'}
    </div>`;
  }).join('');
  const gap = p.device_gap && p.device_gap.significant
    ? `<div class="callout" style="padding:8px 12px;"><strong class="small">${p.device_gap.gap} pages not seen by the agent (24 h)</strong><span class="small">Printer counter +${p.device_gap.device_pages}, print jobs ${p.device_gap.reported_pages}. Usually photocopies or printing that bypassed this PC.</span></div>` : '';
  return `<div class="toner-printer">
    <div><strong>${escapeHtml(p.printer)}</strong>${p.model ? ` <span class="muted small">${escapeHtml(p.model)}</span>` : ''}
      <div class="muted small">${p.read_at ? `Read ${ago(p.read_at)}` : ''}${p.stale ? ' · <span style="color:var(--warn-ink)">not updated recently</span>' : ''}${!compact && p.life_count !== null ? ` · counter ${p.life_count.toLocaleString()} pages` : ''}</div></div>
    ${rows || '<p class="muted small" style="margin:0;">No toner reported.</p>'}
    ${gap}
  </div>`;
}

function renderSupplies() {
  const measured = new Map((measuredToner || []).map((m) => [m.printer, m]));
  $('supplies-wrap').innerHTML = suppliesData.length === 0 && measured.size === 0 ? '<p class="muted" style="margin:0;">Printers appear here once an agent reports jobs.</p>'
    : [...measured.values()].filter((m) => !suppliesData.some((p) => p.printer === m.printer)).map((m) => `<div class="supply">${tonerPrinterHtml(m, false)}</div>`).join('') +
    suppliesData.map((p) => `<div class="supply">${measured.has(p.printer) ? tonerPrinterHtml(measured.get(p.printer), false) : `<strong>${escapeHtml(p.printer)}</strong>`}${p.supplies.filter((s) => !(s.kind === 'toner' && measured.has(p.printer))).map((s) => {
      const label = s.kind === 'paper' ? 'Paper' : 'Toner (estimated from pages)';
      if (!s.tracked) {
        return `<div class="spread small"><span>${label}: not tracked${s.daily_use ? ` · uses ~${s.daily_use}/day` : ''}</span><button type="button" class="btn btn-ghost btn-sm" data-refill="${s.kind}" data-printer="${escapeHtml(p.printer)}">Start tracking</button></div>`;
      }
      const cls = s.status === 'empty' ? 'empty' : s.status === 'low' || s.status === 'soon' ? 'low' : '';
      const when = s.status === 'empty' ? 'probably empty' : s.days_left === null ? 'no recent use' : `lasts ~${s.days_left < 1 ? 'under a day' : plural(Math.round(s.days_left), 'day')}`;
      return `<div class="stack" style="gap:4px;">
        <div class="spread small"><span>${label}: ${s.remaining} of ${s.capacity} ${s.kind === 'paper' ? 'sheets' : 'pages'} · ${escapeHtml(when)}</span><button type="button" class="btn btn-ghost btn-sm" data-refill="${s.kind}" data-printer="${escapeHtml(p.printer)}">${s.kind === 'paper' ? 'Refilled' : 'Replaced'}</button></div>
        <div class="meter ${cls}"><div style="width:${s.percent}%"></div></div>
      </div>`;
    }).join('')}</div>`).join('');
}

// ---------------------------------------------------------------
// Products (admin)
// ---------------------------------------------------------------
let productList = [];

function setupProducts() {
  $('product-add-btn').addEventListener('click', () => openProductModal(null));
  $('product-search').addEventListener('input', renderProducts);
  $('products-table-wrap').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const p = productList.find((x) => x.id === Number(b.dataset.id));
    if (!p) return;
    try {
      if (b.dataset.act === 'edit') openProductModal(p);
      if (b.dataset.act === 'adjust') openAdjustModal(p);
      if (b.dataset.act === 'history') await openStockHistory(p);
      if (b.dataset.act === 'toggle') {
        await api('PATCH', `/api/products/${p.id}/active`, { active: !p.active });
        await loadCatalog();
        await loadProducts();
      }
    } catch (err) { toast(err.message, true); }
  });
}

let productOutlook = new Map();

async function loadProducts() {
  const [{ products }, outlook] = await Promise.all([
    api('GET', '/api/products?all=1'),
    api('GET', '/api/insights/stock').catch(() => ({ products: [] }))
  ]);
  productList = products;
  productOutlook = new Map(outlook.products.map((o) => [o.id, o]));
  renderProducts();
}

function outlookCell(p) {
  const o = productOutlook.get(p.id);
  if (!p.track_stock || !o) return '<span class="muted">&mdash;</span>';
  const status = STOCK_STATUS[o.status];
  const days = o.days_left === null ? 'no recent sales' : o.status === 'out' ? 'out now' : `~${plural(Math.round(o.days_left), 'day')} left`;
  return `<div>${status ? `<span class="badge ${status[1]}">${status[0]}</span> ` : ''}<span class="small">${escapeHtml(days)}</span></div>
    ${o.suggested_order ? `<div class="muted small">Order ${o.suggested_order} (reorder at ${o.reorder_point})</div>` : o.daily_rate ? `<div class="muted small">~${o.daily_rate}/day</div>` : ''}`;
}

function renderProducts() {
  const q = $('product-search').value.trim().toLowerCase();
  const list = productList.filter((p) => !q || p.name.toLowerCase().includes(q) || (p.sku || '').toLowerCase().includes(q) || (p.category || '').toLowerCase().includes(q));
  const wrap = $('products-table-wrap');
  if (productList.length === 0) { wrap.innerHTML = emptyState('No products yet. Add your first one.'); return; }
  if (list.length === 0) { wrap.innerHTML = emptyState('No products match.'); return; }
  wrap.innerHTML = `
    <table>
      <thead><tr><th>Product</th><th>Category</th><th class="num">Price</th><th>Print service</th><th class="num">Stock</th><th>Outlook</th><th>Status</th><th></th></tr></thead>
      <tbody>${list.map((p) => {
        const low = p.track_stock && p.stock_qty <= p.reorder_level;
        return `<tr>
          <td><div style="font-weight:600;">${escapeHtml(p.name)}</div>${p.sku ? `<div class="muted small mono">${escapeHtml(p.sku)}</div>` : ''}</td>
          <td>${p.category ? escapeHtml(p.category) : '<span class="muted">&mdash;</span>'}</td>
          <td class="num">${escapeHtml(cur(p.price))}</td>
          <td>${p.print_color_mode ? `<div class="row" style="gap:4px;">${p.print_color_mode === 'color' ? '<span class="badge info">Colour</span>' : '<span class="badge">B&amp;W</span>'}${p.print_kind === 'copy' ? '<span class="badge">Photocopy</span>' : ''}${p.print_sides === 2 ? '<span class="badge">Both sides</span>' : ''}</div>` : '<span class="muted">&mdash;</span>'}</td>
          <td class="num">${p.track_stock ? `<span class="${low ? 'badge warn' : ''}">${p.stock_qty}</span>` : '<span class="muted">Not tracked</span>'}</td>
          <td>${outlookCell(p)}</td>
          <td>${statusBadge(p.active, 'Active', 'Inactive')}</td>
          <td><div class="actions">
            <button type="button" class="btn btn-outline btn-sm" data-act="edit" data-id="${p.id}">Edit</button>
            ${p.track_stock ? `<button type="button" class="btn btn-outline btn-sm" data-act="adjust" data-id="${p.id}">Stock</button>
            <button type="button" class="btn btn-ghost btn-sm" data-act="history" data-id="${p.id}">History</button>` : ''}
            <button type="button" class="btn btn-ghost btn-sm" data-act="toggle" data-id="${p.id}">${p.active ? 'Deactivate' : 'Activate'}</button>
          </div></td>
        </tr>`;
      }).join('')}
      </tbody>
    </table>`;
}

function openProductModal(p) {
  const editing = !!p;
  const v = p || { name: '', sku: '', category: '', price: '', track_stock: 1, stock_qty: 0, reorder_level: 5, print_color_mode: null, print_kind: 'print', print_sides: 1 };
  const service = v.print_color_mode ? `${v.print_color_mode}|${v.print_kind || 'print'}` : '';
  const opt = (value, label) => `<option value="${value}"${service === value ? ' selected' : ''}>${label}</option>`;
  const cats = Array.from(new Set(productList.map((x) => x.category).filter(Boolean))).sort();
  openModal({
    title: editing ? `Edit ${p.name}` : 'Add product',
    submitLabel: editing ? 'Save changes' : 'Add product',
    body: `
      <div class="form-grid">
        <div class="field full"><label for="pm-name">Name</label><input id="pm-name" required maxlength="200" value="${escapeHtml(v.name)}"></div>
        <div class="field"><label for="pm-price">Price (${escapeHtml(currentSettings.currency)})</label><input id="pm-price" type="number" min="0" step="0.01" required value="${escapeHtml(String(v.price))}"></div>
        <div class="field"><label for="pm-cost">Cost price (optional, for margins)</label><input id="pm-cost" type="number" min="0" step="0.01" value="${v.cost_price != null ? escapeHtml(String(v.cost_price)) : ''}"></div>
        <div class="field"><label for="pm-sku">SKU / barcode (optional)</label><input id="pm-sku" maxlength="100" value="${escapeHtml(v.sku || '')}"></div>
        <div class="field"><label for="pm-category">Category (optional)</label><input id="pm-category" list="pm-cats" maxlength="100" value="${escapeHtml(v.category || '')}"><datalist id="pm-cats">${cats.map((c) => `<option value="${escapeHtml(c)}">`).join('')}</datalist></div>
        <div class="field"><label for="pm-print">Print service</label>
          <select id="pm-print">
            <option value="">Not a print service</option>
            ${opt('mono|print', 'B&amp;W print')}
            ${opt('color|print', 'Colour print')}
            ${opt('mono|copy', 'B&amp;W photocopy')}
            ${opt('color|copy', 'Colour photocopy')}
          </select></div>
        <div class="field" data-print><label for="pm-sides">Sides</label>
          <select id="pm-sides">
            <option value="1"${v.print_sides === 2 ? '' : ' selected'}>One side, per page</option>
            <option value="2"${v.print_sides === 2 ? ' selected' : ''}>Both sides, per sheet</option>
          </select>
          <span class="muted small">Both sides: 1 qty = 1 sheet, counted as 2 pages.</span></div>
        <label class="check full"><input type="checkbox" id="pm-track"${v.track_stock ? ' checked' : ''}> Track stock for this product</label>
        <div class="field" data-stock><label for="pm-stock">Stock on hand</label><input id="pm-stock" type="number" step="any" value="${v.stock_qty}"></div>
        <div class="field" data-stock><label for="pm-reorder">Low-stock alert level</label><input id="pm-reorder" type="number" step="any" min="0" value="${v.reorder_level}"></div>
      </div>
      ${editing ? '<p class="muted small" style="margin:0;">Changing stock on hand here is logged in the product\'s stock history.</p>' : ''}`,
    onOpen: (form) => {
      const track = form.querySelector('#pm-track');
      const print = form.querySelector('#pm-print');
      const sync = () => {
        form.querySelectorAll('[data-stock]').forEach((el) => { el.hidden = !track.checked; });
        form.querySelectorAll('[data-print]').forEach((el) => { el.hidden = !print.value; });
      };
      track.addEventListener('change', sync);
      print.addEventListener('change', () => {
        // Print services are sold by the page, not from stock.
        if (print.value && !editing) track.checked = false;
        sync();
      });
      sync();
    },
    onSubmit: async (form) => {
      const val = (id) => form.querySelector(id).value;
      const payload = {
        name: val('#pm-name').trim(),
        price: parseFloat(val('#pm-price')),
        cost_price: val('#pm-cost') === '' ? null : parseFloat(val('#pm-cost')),
        sku: val('#pm-sku').trim(),
        category: val('#pm-category').trim(),
        print_color_mode: val('#pm-print') ? val('#pm-print').split('|')[0] : null,
        print_kind: val('#pm-print') ? val('#pm-print').split('|')[1] : 'print',
        print_sides: val('#pm-print') ? Number(val('#pm-sides')) : 1,
        track_stock: form.querySelector('#pm-track').checked,
        stock_qty: parseFloat(val('#pm-stock')) || 0,
        reorder_level: val('#pm-reorder') === '' ? 5 : parseFloat(val('#pm-reorder'))
      };
      if (editing) await api('PUT', `/api/products/${p.id}`, payload);
      else await api('POST', '/api/products', payload);
      toast(editing ? 'Product updated.' : 'Product added.');
      await loadCatalog();
      await loadProducts();
    }
  });
}

function openAdjustModal(p) {
  openModal({
    title: `Adjust stock: ${p.name}`,
    submitLabel: 'Save adjustment',
    body: `
      <p class="muted" style="margin:0;">Currently ${p.stock_qty} in stock.</p>
      <div class="form-grid">
        <div class="field"><label for="adj-delta">Change</label><input id="adj-delta" type="number" step="any" required placeholder="20 to add, -5 to remove"></div>
        <div class="field"><label for="adj-note">Reason</label><input id="adj-note" maxlength="300" placeholder="e.g. delivery received"></div>
      </div>`,
    onSubmit: async (form) => {
      const delta = parseFloat(form.querySelector('#adj-delta').value);
      if (!Number.isFinite(delta) || delta === 0) throw new Error('Enter a number other than 0.');
      await api('POST', `/api/products/${p.id}/adjust-stock`, { delta, note: form.querySelector('#adj-note').value.trim() });
      toast('Stock updated.');
      await loadCatalog();
      await loadProducts();
    }
  });
}

const MOVE_LABELS = { initial: 'Opening stock', sale: 'Sale', void: 'Sale voided', adjust: 'Adjustment', edit: 'Edited' };

async function openStockHistory(p) {
  const { movements } = await api('GET', `/api/products/${p.id}/movements`);
  openModal({
    title: `Stock history: ${p.name}`,
    wide: true,
    hideSubmit: true,
    body: movements.length === 0 ? '<p class="muted" style="margin:0;">No stock movements recorded yet.</p>' : `
      <div class="table-wrap"><table>
        <thead><tr><th>When</th><th>What</th><th class="num">Change</th><th>Detail</th><th>By</th></tr></thead>
        <tbody>${movements.map((m) => `<tr>
          <td>${escapeHtml(formatDbDate(m.created_at))}</td>
          <td>${escapeHtml(MOVE_LABELS[m.reason] || m.reason)}</td>
          <td class="num"><span class="badge ${m.delta < 0 ? 'warn' : 'ok'}">${m.delta > 0 ? '+' : ''}${m.delta}</span></td>
          <td>${m.receipt_no ? `<a href="receipt.html?id=${m.sale_id}" target="_blank" rel="noopener" class="mono">${escapeHtml(m.receipt_no)}</a>` : escapeHtml(m.note || '')}</td>
          <td>${escapeHtml(m.user_name || '')}</td>
        </tr>`).join('')}</tbody>
      </table></div>`
  });
}

// ---------------------------------------------------------------
// Users (admin)
// ---------------------------------------------------------------
let userList = [];

function setupUsers() {
  $('user-add-btn').addEventListener('click', () => {
    openModal({
      title: 'Add user',
      submitLabel: 'Add user',
      body: `
        <div class="form-grid">
          <div class="field full"><label for="nu-name">Full name</label><input id="nu-name" required maxlength="100"></div>
          <div class="field"><label for="nu-username">Username</label><input id="nu-username" required maxlength="60" autocomplete="off"></div>
          <div class="field"><label for="nu-role">Role</label><select id="nu-role"><option value="cashier">Cashier</option><option value="admin">Admin</option></select></div>
          <div class="field full"><label for="nu-password">Password (min 6 characters)</label><input id="nu-password" type="password" required minlength="6" autocomplete="new-password"></div>
        </div>`,
      onSubmit: async (form) => {
        await api('POST', '/api/users', {
          full_name: form.querySelector('#nu-name').value.trim(),
          username: form.querySelector('#nu-username').value.trim(),
          role: form.querySelector('#nu-role').value,
          password: form.querySelector('#nu-password').value
        });
        toast('User added.');
        await loadUsers();
      }
    });
  });

  $('users-table-wrap').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const u = userList.find((x) => x.id === Number(b.dataset.id));
    if (!u) return;
    if (b.dataset.act === 'edit') {
      openModal({
        title: `Edit ${u.username}`,
        body: `
          <div class="field"><label for="eu-name">Full name</label><input id="eu-name" required maxlength="100" value="${escapeHtml(u.full_name)}"></div>
          <div class="field"><label for="eu-role">Role</label><select id="eu-role"><option value="cashier"${u.role === 'cashier' ? ' selected' : ''}>Cashier</option><option value="admin"${u.role === 'admin' ? ' selected' : ''}>Admin</option></select></div>`,
        onSubmit: async (form) => {
          const fullName = form.querySelector('#eu-name').value.trim();
          await api('PATCH', `/api/users/${u.id}`, { full_name: fullName, role: form.querySelector('#eu-role').value });
          toast('User updated.');
          if (u.id === currentUser.id) {
            currentUser.full_name = fullName;
            $('nav-user-name').textContent = fullName;
            $('nav-avatar').textContent = initials(fullName);
          }
          await loadUsers();
        }
      });
    }
    if (b.dataset.act === 'password') {
      openModal({
        title: `Reset password for ${u.username}`,
        submitLabel: 'Reset password',
        body: `<div class="field"><label for="rp-pass">New password (min 6 characters)</label><input id="rp-pass" type="password" required minlength="6" autocomplete="new-password"></div>`,
        onSubmit: async (form) => {
          await api('POST', `/api/users/${u.id}/reset-password`, { newPassword: form.querySelector('#rp-pass').value });
          toast('Password updated.');
        }
      });
    }
    if (b.dataset.act === 'toggle') {
      try {
        await api('PATCH', `/api/users/${u.id}/active`, { active: !u.active });
        await loadUsers();
      } catch (err) { toast(err.message, true); }
    }
  });
}

async function loadUsers() {
  const { users } = await api('GET', '/api/users');
  userList = users;
  $('users-table-wrap').innerHTML = `
    <table>
      <thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Status</th><th>Added</th><th></th></tr></thead>
      <tbody>${users.map((u) => `<tr>
        <td><div class="row" style="gap:10px; flex-wrap:nowrap;"><span class="avatar" style="background:var(--line-soft); color:var(--ink);" aria-hidden="true">${escapeHtml(initials(u.full_name || u.username))}</span><span style="font-weight:600;">${escapeHtml(u.full_name)}${u.id === currentUser.id ? ' <span class="muted small">(you)</span>' : ''}</span></div></td>
        <td class="mono">${escapeHtml(u.username)}</td>
        <td><span class="badge${u.role === 'admin' ? ' info' : ''}" style="text-transform:capitalize;">${escapeHtml(u.role)}</span></td>
        <td>${statusBadge(u.active, 'Active', 'Disabled')}</td>
        <td>${escapeHtml((parseDbDate(u.created_at) || new Date()).toLocaleDateString())}</td>
        <td><div class="actions">
          <button type="button" class="btn btn-outline btn-sm" data-act="edit" data-id="${u.id}">Edit</button>
          <button type="button" class="btn btn-ghost btn-sm" data-act="password" data-id="${u.id}">Reset password</button>
          ${u.id === currentUser.id ? '' : `<button type="button" class="btn btn-ghost btn-sm" data-act="toggle" data-id="${u.id}">${u.active ? 'Disable' : 'Enable'}</button>`}
        </div></td>
      </tr>`).join('')}
      </tbody>
    </table>`;
}

// ---------------------------------------------------------------
// Settings (admin)
// ---------------------------------------------------------------
let pendingLogo; // undefined = unchanged, '' = remove, data URL = new logo

function fillSettingsForm() {
  const s = currentSettings;
  $('s-business-name').value = s.business_name;
  $('s-address').value = s.address;
  $('s-phone').value = s.phone;
  $('s-email').value = s.email;
  $('s-tax-rate').value = s.tax_rate;
  $('s-currency').value = s.currency;
  $('s-receipt-prefix').value = s.receipt_prefix;
  $('s-footer').value = s.footer_note;
  $('s-lead').value = s.reorder_lead_days;
  $('s-cover').value = s.reorder_cover_days;
  pendingLogo = undefined;
  $('s-logo').value = '';
  showLogoPreview(s.logo_data_url);
  $('settings-error').hidden = true;
  $('settings-success').hidden = true;
}

function showLogoPreview(src) {
  const img = $('s-logo-preview');
  img.hidden = !src;
  if (src) img.src = src; else img.removeAttribute('src');
  $('s-logo-remove').hidden = !src;
}

function setupSettings() {
  $('s-logo').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 1.5 * 1024 * 1024) {
      toast('Please choose a logo image smaller than 1.5 MB.', true);
      e.target.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => { pendingLogo = reader.result; showLogoPreview(pendingLogo); };
    reader.readAsDataURL(file);
  });
  $('s-logo-remove').addEventListener('click', () => { pendingLogo = ''; $('s-logo').value = ''; showLogoPreview(''); });

  $('settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('settings-error').hidden = true;
    $('settings-success').hidden = true;
    try {
      await api('PUT', '/api/settings', {
        business_name: $('s-business-name').value.trim(),
        address: $('s-address').value.trim(),
        phone: $('s-phone').value.trim(),
        email: $('s-email').value.trim(),
        tax_rate: parseFloat($('s-tax-rate').value) || 0,
        currency: $('s-currency').value.trim(),
        receipt_prefix: $('s-receipt-prefix').value.trim(),
        footer_note: $('s-footer').value.trim(),
        reorder_lead_days: parseInt($('s-lead').value, 10),
        reorder_cover_days: parseInt($('s-cover').value, 10),
        logo_data_url: pendingLogo === undefined ? currentSettings.logo_data_url : pendingLogo
      });
      await loadSettings();
      pendingLogo = undefined;
      $('settings-success').hidden = false;
    } catch (err) {
      showError($('settings-error'), err.message);
    }
  });
}

// ---------------------------------------------------------------
// Account
// ---------------------------------------------------------------
function setupAccount() {
  $('password-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('password-error').hidden = true;
    $('password-success').hidden = true;
    if ($('new-password').value !== $('confirm-password').value) {
      return showError($('password-error'), 'The new passwords do not match.');
    }
    try {
      await api('POST', '/api/auth/change-password', {
        currentPassword: $('cur-password').value,
        newPassword: $('new-password').value
      });
      $('password-form').reset();
      $('password-success').hidden = false;
    } catch (err) {
      showError($('password-error'), err.message);
    }
  });
}
