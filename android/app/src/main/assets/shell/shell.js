'use strict';
/* Receipt Admin shell: shops, pairing, and each shop's summary from its
   encrypted snapshot. Talks to the app through window.Shell (MainActivity).
   Everything shown from a snapshot is escaped: it is data, not markup. */

const native = window.Shell;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const reduce = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

let shops = [];
const results = {}; // shop id -> last check result { online, pulse, ... }
const checking = new Set();
let screen = 'home';
let shopId = null;
let shopOpts = {};

// ---------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------
function money(n, cur) {
  return `${esc(cur || '')} ${Number(n || 0).toFixed(2)}`.trim();
}
function moneyHtml(n, cur) {
  return `<span class="cur">${esc(cur || '')}</span><span data-tween="${Number(n || 0)}" data-dec="2">${Number(n || 0).toFixed(2)}</span>`;
}
function ago(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 24 * 60) return `${Math.round(m / 60)} h ago`;
  return new Date(t).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
function clock(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const COLORANT = { black: '#1B1E24', cyan: '#00A0DC', magenta: '#D6167A', yellow: '#F5C518' };

// Numbers count from their last value (motion answers a change).
const lastValues = new Map();
function tweenIn(root) {
  root.querySelectorAll('[data-tween]').forEach((el) => {
    const key = el.closest('[data-key]') ? el.closest('[data-key]').dataset.key : null;
    const to = Number(el.dataset.tween);
    const from = key && lastValues.has(key) ? lastValues.get(key) : 0;
    if (key) lastValues.set(key, to);
    const decimals = Number(el.dataset.dec || 0);
    if (reduce() || from === to) { el.textContent = to.toFixed(decimals); return; }
    const start = performance.now();
    const dur = 420;
    const step = (now) => {
      const k = Math.min(1, (now - start) / dur);
      const e = 1 - Math.pow(1 - k, 4);
      el.textContent = (from + (to - from) * e).toFixed(decimals);
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

// ---------------------------------------------------------------
// Screens
// ---------------------------------------------------------------
function go(name, back) {
  screen = name;
  document.body.dataset.screen = name;
  document.querySelectorAll('.screen').forEach((s) => {
    const on = s.id === `screen-${name}`;
    s.classList.toggle('active', on);
    s.classList.toggle('back', !!back);
  });
  window.scrollTo(0, 0);
}

window.shellBack = function shellBack() {
  if (closeSheet()) return true;
  if ($('overlay-root').firstChild) { $('overlay-root').innerHTML = ''; return true; }
  if (screen !== 'home') {
    go('home', true);
    renderHome();
    return true;
  }
  return false;
};

function loadShops() {
  shops = JSON.parse(native.shops() || '[]');
  for (const s of shops) {
    if (results[s.id]) continue;
    const c = native.cached(s.id);
    if (c) {
      try { results[s.id] = Object.assign(JSON.parse(c), { from_phone: true }); } catch (_) { /* ignore */ }
    }
  }
}

function statusOf(id) {
  const r = results[id];
  if (checking.has(id) && (!r || r.from_phone)) return { cls: 'wait', text: 'Checking…' };
  if (!r) return { cls: 'wait', text: 'Checking…' };
  if (r.online) return { cls: 'on', text: 'Online' };
  if (r.unreachable) return { cls: 'off', text: 'No connection' };
  return { cls: 'off', text: 'Offline' };
}

const statusHtml = (id) => { const s = statusOf(id); return `<span class="status ${s.cls}"><i aria-hidden="true"></i>${s.text}</span>`; };

// ---------------------------------------------------------------
// Home
// ---------------------------------------------------------------
function renderHome() {
  loadShops();
  $('empty').hidden = shops.length > 0;
  $('add-btn').hidden = shops.length === 0;
  $('shop-list').innerHTML = shops.map((s, i) => cardHtml(s, i)).join('');
  tweenIn($('shop-list'));
}

function cardHtml(s, i) {
  const r = results[s.id];
  const p = r && r.pulse;
  let body;
  if (!s.paired) {
    body = '<p class="muted small">Opened by address. Pair with the QR code to see sales and alerts here.</p>';
  } else if (!p) {
    body = `<p class="muted small">${r && r.error ? esc(r.error) : 'Waiting for the first update…'}</p>`;
  } else {
    const alerts = (p.alerts || []).filter((a) => a.severity === 'high' || a.kind === 'printer').length;
    const printers = p.printers || [];
    const stopped = printers.filter((x) => !x.stale && (x.health === 'error' || x.health === 'offline')).length;
    const diff = p.yesterday && p.yesterday.revenue > 0 ? (p.today.revenue - p.yesterday.revenue) / p.yesterday.revenue : null;
    body = `
      <div data-key="home-today-${esc(s.id)}">
        <div class="big-money">${moneyHtml(p.today.revenue, p.currency)}</div>
        <div class="row small muted"><span>${plural(p.today.count, 'sale')} today</span>${diff === null ? '' : `<span class="trend ${diff >= 0 ? 'up' : 'down'}">${diff >= 0 ? '▲' : '▼'} ${Math.abs(Math.round(diff * 100))}% vs yesterday</span>`}</div>
      </div>
      <div class="chips">
        ${alerts ? `<span class="chip alert">${plural(alerts, 'alert')}</span>` : '<span class="chip ok">No alerts</span>'}
        ${printers.length ? `<span class="chip ${stopped ? 'bad' : ''}">${stopped ? `${stopped} printer${stopped === 1 ? '' : 's'} stopped` : `${plural(printers.length, 'printer')} OK`}</span>` : ''}
        ${p.closed_today ? '<span class="chip">Day closed</span>' : ''}
      </div>
      <div class="small muted">Updated ${esc(ago(p.generated_at))}${r.from_phone || (r && !r.online) ? ' · last saved update' : ''}</div>`;
  }
  // Not role="button": that would hide the totals and status from TalkBack.
  return `<article class="card shop-card" data-shop="${esc(s.id)}" style="animation-delay:${i * 45}ms" tabindex="0">
    <div class="spread"><div style="min-width:0;"><h2>${esc(s.name)}</h2><div class="shop-host">${esc(s.host)}</div></div>${statusHtml(s.id)}</div>
    ${body}
  </article>`;
}

$('shop-list').addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-shop]')) { e.preventDefault(); e.target.click(); }
});
$('shop-list').addEventListener('click', (e) => {
  const card = e.target.closest('[data-shop]');
  if (!card) return;
  const s = shops.find((x) => x.id === card.dataset.shop);
  if (!s) return;
  if (!s.paired) { native.open(s.id); return; }
  showShop(s.id);
});

function checkAll() {
  for (const s of shops) check(s.id);
}

function check(id) {
  checking.add(id);
  native.check(id);
}

window.onCheck = function onCheck(id, r) {
  checking.delete(id);
  const prev = results[id];
  if (!r.pulse && prev && prev.pulse) {
    // Keep showing the last update we have; say how old it is.
    r.pulse = prev.pulse;
    r.from_phone = true;
  }
  results[id] = r;
  stopPtr();
  if (screen === 'home') renderHome();
  if (screen === 'shop' && shopId === id) renderShop();
};

// ---------------------------------------------------------------
// One shop
// ---------------------------------------------------------------
window.showShop = function showShop(id, opts) {
  loadShops();
  if (!shops.some((s) => s.id === id)) { go('home', true); renderHome(); return; }
  hideOverlay();
  shopOpts = opts || {};
  shopId = id;
  if (screen !== 'shop') go('shop');
  renderShop();
  check(id);
};

function banner(cls, icon, html) {
  const icons = {
    ok: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    off: '<path d="M2 8.8a15 15 0 0 1 4.2-2.6M22 8.8A15 15 0 0 0 10.4 5M5.5 12.4a10 10 0 0 1 3.1-1.8M18.5 12.4a10 10 0 0 0-2-1.4M9 16a5 5 0 0 1 6 0M12 20h.01M3 3l18 18"/>',
    warn: '<path d="M12 3l10 18H2zM12 10v5M12 18h.01"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>'
  };
  return `<div class="banner ${cls}" role="status"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${icons[icon]}</svg><div>${html}</div></div>`;
}

function renderShop() {
  const s = shops.find((x) => x.id === shopId);
  if (!s) return;
  $('shop-title').textContent = s.name;
  const r = results[s.id];
  const p = r && r.pulse;

  let b = '';
  if (shopOpts.offline) {
    b = banner('off', 'off', `<b>Couldn't open the full admin.</b> ${esc(shopOpts.reason || '')}${p ? ' Here is the shop\'s last update.' : ''}`);
  } else if (r && r.stale_key) {
    b = banner('warn', 'warn', esc(r.error));
  } else if (!s.paired) {
    b = banner('warn', 'info', 'Added by address. Pair with the QR code in <b>Settings &gt; Remote access</b> to see sales, printers and alerts here, and get alerts.');
  } else if (r && r.online && p && !r.from_phone) {
    b = banner('ok', 'ok', `<b>Shop PC online.</b> Updated ${esc(ago(p.generated_at))}.`);
  } else if (r && r.unreachable) {
    b = banner('warn', 'off', `<b>Can't reach the shop.</b> ${esc(r.error || '')}${p ? ` Showing the update saved on this phone, from ${esc(ago(p.generated_at))}.` : ''}`);
  } else if (r && !r.online) {
    b = banner('off', 'off', `<b>Shop PC offline</b>${r.last_seen ? ` since ${esc(clock(r.last_seen))}` : ''}.${p ? ` Showing its last update, from ${esc(ago(p.generated_at))}.` : ''}`);
  }
  $('shop-banner').innerHTML = b;
  $('open-full').classList.toggle('btn-ghost', !!(r && !r.online && !r.unreachable && p));
  $('open-full').classList.toggle('btn-primary', !(r && !r.online && !r.unreachable && p));

  const body = $('shop-body');
  if (!p) {
    body.innerHTML = s.paired ? `<div class="card"><p class="muted">${checking.has(s.id) || !r ? 'Getting the latest update…' : esc((r && r.error) || 'No update yet.')}</p></div>` : '';
    return;
  }
  body.innerHTML = summaryHtml(p, s);
  tweenIn(body);
}

function summaryHtml(p, s) {
  const k = (name) => `data-key="${esc(s.id)}-${name}"`;
  const out = [];
  out.push(`<div class="kpis">
    <div class="card kpi today" ${k('today')}><div class="label">Today${p.closed_today ? ' · day closed' : ''}</div><div class="value">${moneyHtml(p.today.revenue, p.currency)}</div><div class="sub">${plural(p.today.count, 'sale')}${p.last_sale ? ` · last ${esc(ago(p.last_sale.created_at && p.last_sale.created_at.replace(' ', 'T') + 'Z'))}` : ''}</div></div>
    <div class="card kpi" ${k('yesterday')}><div class="label">Yesterday</div><div class="value">${moneyHtml(p.yesterday.revenue, '')}</div><div class="sub">${plural(p.yesterday.count, 'sale')}</div></div>
    <div class="card kpi" ${k('week')}><div class="label">Last 7 days</div><div class="value">${moneyHtml(p.week.revenue, '')}</div><div class="sub">${plural(p.week.count, 'sale')}</div></div>
    <div class="card kpi" ${k('month')} style="grid-column:1/-1;"><div class="label">This month</div><div class="value">${moneyHtml(p.month.revenue, p.currency)}</div><div class="sub">${plural(p.month.count, 'sale')}</div></div>
  </div>`);

  const series = p.series || [];
  if (series.length) {
    const max = Math.max(1, ...series.map((d) => d.revenue));
    out.push(`<div class="card stack"><div class="spread"><h2>Last 14 days</h2><span class="small muted">${esc(p.currency)}</span></div>
      <div class="bars" role="img" aria-label="Daily revenue for the last 14 days">${series.map((d, i) => `<span class="${i === series.length - 1 ? 'today' : ''}" style="height:${Math.max(2, (d.revenue / max) * 100)}%;animation-delay:${i * 25}ms" title="${esc(d.day)}: ${money(d.revenue, p.currency)}"></span>`).join('')}</div>
      <div class="bars-axis"><span>${esc(series[0].day.slice(5))}</span><span>Today</span></div></div>`);
  }

  const alerts = p.alerts || [];
  if (alerts.length) {
    out.push(`<div class="card stack"><div class="spread"><h2>Alerts</h2><span class="chip alert">${alerts.length}</span></div><div class="list">${alerts.slice(0, 12).map((a, i) => `
      <div class="list-row" style="animation-delay:${i * 35}ms"><span class="sev ${esc(a.severity)}"></span><div class="grow"><div class="title">${esc(a.title)}</div>${a.detail ? `<div class="detail">${esc(a.detail)}</div>` : ''}</div></div>`).join('')}</div></div>`);
  }

  const printers = p.printers || [];
  if (printers.length) {
    out.push(`<div class="card stack"><h2>Printers</h2><div class="list">${printers.map((x, i) => `
      <div class="list-row" style="animation-delay:${i * 35}ms"><span class="dot ${x.stale ? 'unknown' : esc(x.health)}"></span><div class="grow">
        <div class="spread"><span class="title">${esc(x.name)}</span>${x.queue ? `<span class="small muted">${plural(x.queue, 'job')} waiting</span>` : ''}</div>
        <div class="detail">${x.stale ? `Not reported since ${esc(ago(x.updated_at))}` : esc(x.headline || '')}${x.agent ? ` · ${esc(x.agent)}` : ''}</div>
        ${(x.issues || []).map((is) => `<div class="detail">• ${esc(is.title)}</div>`).join('')}
      </div></div>`).join('')}</div></div>`);
  }

  const toner = p.toner || [];
  if (toner.length) {
    out.push(`<div class="card stack"><h2>Toner and ink</h2>${toner.map((t) => `
      <div class="stack" style="gap:2px;"><div class="small" style="font-weight:600;">${esc(t.printer)}</div>
      ${t.supplies.map((x) => `<div class="supply"><span class="name">${esc(x.colorant)}</span><div class="meter"><span style="width:${Math.max(0, Math.min(100, x.percent))}%;background:${COLORANT[String(x.colorant).toLowerCase()] || 'var(--key-2)'}"></span></div><span class="num">${esc(x.percent)}%</span></div>`).join('')}</div>`).join('')}</div>`);
  }

  if (p.printing) {
    const pr = p.printing;
    out.push(`<div class="card stack"><h2>Printing today</h2>
      <div class="spread"><span class="muted">Pages printed</span><b class="num">${esc(pr.pages)}</b></div>
      <div class="spread"><span class="muted">Pages sold</span><b class="num">${esc(pr.pages_sold)}</b></div>
      ${pr.gap > 0 ? `<div class="spread"><span class="muted">Not billed</span><b class="num" style="color:var(--danger)">${esc(pr.gap)} pages · ${money(pr.estimated_value, p.currency)}</b></div>` : ''}</div>`);
  }

  const mix = p.payment_mix || [];
  if (mix.length) {
    const total = mix.reduce((a, m) => a + m.revenue, 0) || 1;
    const label = { cash: 'Cash', momo: 'Mobile money', card: 'Card' };
    out.push(`<div class="card stack"><h2>Payments today</h2>${mix.map((m) => `
      <div class="mix-row"><span>${esc(label[m.method] || m.method)} <span class="muted small">· ${plural(m.count, 'sale')}</span></span><span class="num">${money(m.revenue, p.currency)}</span>
      <div class="meter"><span style="width:${(m.revenue / total) * 100}%;background:var(--cyan)"></span></div></div>`).join('')}</div>`);
  }

  const cashiers = p.cashiers || [];
  if (cashiers.length) {
    out.push(`<div class="card stack"><h2>Cashiers today</h2><div class="list">${cashiers.map((c) => `
      <div class="list-row"><div class="grow">${esc(c.name)} <span class="muted small">· ${plural(c.count, 'sale')}</span></div><span class="num">${money(c.revenue, p.currency)}</span></div>`).join('')}</div></div>`);
  }

  const low = p.low_stock || [];
  if (low.length) {
    out.push(`<div class="card stack"><h2>Low stock</h2><div class="list">${low.map((x) => `
      <div class="list-row"><span class="sev ${x.stock_qty <= 0 ? 'high' : 'medium'}"></span><div class="grow">${esc(x.name)}</div><span class="num ${x.stock_qty <= 0 ? '' : 'muted'}">${esc(x.stock_qty)} left</span></div>`).join('')}</div></div>`);
  }

  out.push(`<p class="foot"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg> Update from ${esc(new Date(p.generated_at).toLocaleString())} · encrypted, only your paired phones can read it</p>`);
  return out.join('');
}

$('open-full').addEventListener('click', () => { if (shopId) native.open(shopId); });

// ---------- Shop menu (bottom sheet) ----------
function closeSheet() {
  const scrim = document.querySelector('.sheet-scrim');
  if (!scrim) return false;
  scrim.remove();
  document.querySelector('.sheet').remove();
  return true;
}

$('shop-menu').addEventListener('click', () => {
  const s = shops.find((x) => x.id === shopId);
  if (!s) return;
  const allowed = native.notificationsAllowed();
  const scrim = document.createElement('div');
  scrim.className = 'sheet-scrim';
  const sheet = document.createElement('div');
  sheet.className = 'sheet stack';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-label', `${s.name} options`);
  sheet.innerHTML = `
    <h2>${esc(s.name)}</h2>
    <div class="shop-host">${esc(s.url)}</div>
    ${s.paired ? `<label class="switch"><span>Alerts on this phone<br><span class="muted small">Printers stopping, risk alerts, toner and stock running out. Checked every 15 minutes.</span></span><input type="checkbox" id="notify-toggle" ${s.notify ? 'checked' : ''}></label>
    ${allowed ? '' : '<p class="small" style="color:var(--warn-ink)">Notifications are off for Receipt Admin in Android settings.</p>'}` : ''}
    <button class="btn btn-danger btn-block" type="button" id="remove-shop">Remove this shop</button>
    <button class="btn btn-ghost btn-block" type="button" id="close-sheet">Close</button>`;
  document.body.append(scrim, sheet);
  scrim.addEventListener('click', closeSheet);
  sheet.querySelector('#close-sheet').addEventListener('click', closeSheet);
  const toggle = sheet.querySelector('#notify-toggle');
  if (toggle) toggle.addEventListener('change', () => { native.setNotify(s.id, toggle.checked); s.notify = toggle.checked; });
  const remove = sheet.querySelector('#remove-shop');
  remove.addEventListener('click', () => {
    if (!remove.dataset.armed) {
      remove.dataset.armed = '1';
      remove.textContent = 'Tap again to remove';
      setTimeout(() => { if (remove.isConnected) { delete remove.dataset.armed; remove.textContent = 'Remove this shop'; } }, 4000);
      return;
    }
    native.remove(s.id);
    delete results[s.id];
    closeSheet();
    toast(`${s.name} removed from this phone.`);
    go('home', true);
    renderHome();
  });
});

// ---------------------------------------------------------------
// Add a shop
// ---------------------------------------------------------------
document.querySelectorAll('[data-go="add"]').forEach((b) => b.addEventListener('click', () => {
  $('add-error').hidden = true;
  $('code').value = '';
  go('add');
}));
document.querySelectorAll('[data-back]').forEach((b) => b.addEventListener('click', () => window.shellBack()));

$('paste-btn').addEventListener('click', () => {
  const text = native.clipboard();
  if (text) $('code').value = text.trim();
  else toast('Nothing to paste. Copy the connection code on the shop PC first.', true);
});

$('connect-btn').addEventListener('click', () => {
  const res = JSON.parse(native.add($('code').value));
  const err = $('add-error');
  if (!res.ok) {
    err.textContent = res.error;
    err.hidden = false;
    err.classList.remove('shake');
    void err.offsetWidth;
    err.classList.add('shake');
    return;
  }
  toast(res.paired ? 'Shop paired. Sign in to open the full admin.' : 'Shop added.');
  loadShops();
  if (res.paired) { showShop(res.id); native.open(res.id); } else { go('home', true); renderHome(); native.open(res.id); }
});

window.onPaired = function onPaired() {
  loadShops();
  toast('Shop paired. Sign in with your admin account.');
  if (screen === 'home') renderHome();
};

// ---------------------------------------------------------------
// Opening the full admin
// ---------------------------------------------------------------
let overlayTimer = 0;
function hideOverlay() {
  clearTimeout(overlayTimer);
  $('overlay-root').innerHTML = '';
}
window.onOpening = function onOpening(id) {
  const s = shops.find((x) => x.id === id) || { name: 'the shop' };
  $('overlay-root').innerHTML = `<div class="overlay" role="status"><div class="card stack">
    <div class="cmyk-bar" aria-hidden="true"><span class="c"></span><span class="m"></span><span class="y"></span><span class="k"></span></div>
    <h2>Opening ${esc(s.name)}…</h2><p class="muted small">Connecting to the shop's Receipt System.</p>
    <button class="btn btn-ghost" type="button" id="cancel-open">Cancel</button></div></div>`;
  $('cancel-open').addEventListener('click', hideOverlay);
  clearTimeout(overlayTimer);
  overlayTimer = setTimeout(hideOverlay, 35000);
};
window.onShellShown = function onShellShown() {
  hideOverlay();
  if (screen === 'home') { renderHome(); checkAll(); } else if (screen === 'shop' && shopId) { renderShop(); check(shopId); }
};
window.onNotifyPermission = function onNotifyPermission() { /* the sheet re-reads it when opened */ };

// ---------------------------------------------------------------
// Toasts, ripples, pull to refresh
// ---------------------------------------------------------------
function toast(message, isError) {
  const el = document.createElement('div');
  el.className = `toast${isError ? ' error' : ''}`;
  el.textContent = message;
  $('toasts').append(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 200); }, isError ? 5200 : 3200);
}
window.toast = toast;

document.addEventListener('pointerdown', (e) => {
  const btn = e.target.closest('.btn');
  if (!btn || reduce()) return;
  const r = btn.getBoundingClientRect();
  const size = Math.max(r.width, r.height) * 2.2;
  const dot = document.createElement('span');
  dot.className = 'ripple';
  dot.style.cssText = `width:${size}px;height:${size}px;left:${e.clientX - r.left - size / 2}px;top:${e.clientY - r.top - size / 2}px`;
  btn.append(dot);
  setTimeout(() => dot.remove(), 600);
});

let ptrStart = null;
let ptrDy = 0;
let ptrBusy = false;
const ptr = $('ptr');
function stopPtr() {
  if (!ptrBusy) return;
  ptrBusy = false;
  ptr.classList.remove('spin');
  ptr.style.transition = 'transform 240ms cubic-bezier(0.4,0,1,1), opacity 240ms';
  ptr.style.transform = 'translateY(-64px)';
  ptr.style.opacity = '0';
}
document.addEventListener('touchstart', (e) => {
  if (screen === 'add' || window.scrollY > 0 || ptrBusy || document.querySelector('.sheet')) return;
  ptrStart = e.touches[0].clientY;
  ptrDy = 0;
  ptr.style.transition = 'none';
}, { passive: true });
document.addEventListener('touchmove', (e) => {
  if (ptrStart === null) return;
  ptrDy = Math.max(0, e.touches[0].clientY - ptrStart);
  const y = Math.min(72, ptrDy * 0.45);
  ptr.style.transform = `translateY(${y - 8}px) rotate(${ptrDy * 1.6}deg)`;
  ptr.style.opacity = String(Math.min(1, ptrDy / 90));
}, { passive: true });
document.addEventListener('touchend', () => {
  if (ptrStart === null) return;
  ptrStart = null;
  if (ptrDy > 120) {
    ptrBusy = true;
    ptr.classList.add('spin');
    ptr.style.transition = 'transform 240ms cubic-bezier(0.16,1,0.3,1)';
    ptr.style.transform = 'translateY(48px)';
    refresh();
    setTimeout(stopPtr, 12000);
  } else {
    ptr.style.transition = 'transform 240ms cubic-bezier(0.4,0,1,1), opacity 240ms';
    ptr.style.transform = 'translateY(-64px)';
    ptr.style.opacity = '0';
  }
});

function refresh() {
  if (screen === 'shop' && shopId) { shopOpts = {}; check(shopId); renderShop(); } else checkAll();
}
$('refresh-all').addEventListener('click', () => {
  const icon = $('refresh-all').querySelector('svg');
  if (!reduce()) icon.animate([{ transform: 'rotate(0)' }, { transform: 'rotate(360deg)' }], { duration: 600, easing: 'cubic-bezier(0.16,1,0.3,1)' });
  checkAll();
  renderHome();
});

// Fresh numbers while the app is open.
setInterval(() => {
  if (document.hidden) return;
  if (screen === 'home') checkAll();
  else if (screen === 'shop' && shopId) check(shopId);
}, 60000);

// ---------------------------------------------------------------
// Start
// ---------------------------------------------------------------
$('version').textContent = `Receipt Admin ${native.version()}`;
renderHome();
checkAll();
