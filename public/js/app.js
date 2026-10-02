let currentUser = null;
let currentSettings = null;
let itemIdCounter = 0;
let products = [];
let editingProductId = null;

// ---------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------
(async function init() {
  const meRes = await api('GET', '/api/auth/me');
  if (!meRes.user) {
    window.location.href = 'login.html';
    return;
  }
  currentUser = meRes.user;
  document.getElementById('nav-user-name').textContent = currentUser.full_name;
  document.getElementById('nav-user-role').textContent = currentUser.role;

  if (currentUser.role !== 'admin') {
    document.querySelectorAll('.admin-only').forEach((el) => el.remove());
  }

  const settingsRes = await api('GET', '/api/settings');
  currentSettings = settingsRes.settings;
  document.getElementById('brand-business').textContent = currentSettings.business_name;

  await loadProductCatalog();

  setupNav();
  setupSaleForm();
  setupHistory();
  if (currentUser.role === 'admin') {
    setupUsers();
    setupSettingsForm();
    setupProductForm();
    setupPrintMonitor();
  }
  setupAccountForm();

  addItemRow();
  navigateTo(location.hash.replace('#', '') || 'dashboard');
})();

async function loadProductCatalog() {
  const { products: list } = await api('GET', '/api/products');
  products = list;
  const datalist = document.getElementById('products-datalist');
  datalist.innerHTML = products.map((p) => `<option value="${escapeHtml(p.name)}">`).join('');
}

document.getElementById('logout-btn').addEventListener('click', async () => {
  await api('POST', '/api/auth/logout');
  window.location.href = 'login.html';
});

// ---------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------
function setupNav() {
  document.querySelectorAll('.nav-link').forEach((link) => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      navigateTo(link.dataset.view);
    });
  });
}

function navigateTo(view) {
  const valid = ['dashboard', 'sale', 'history', 'products', 'print-monitor', 'users', 'settings', 'account'];
  if (!valid.includes(view)) view = 'dashboard';
  if (['users', 'settings', 'products', 'print-monitor'].includes(view) && currentUser.role !== 'admin') view = 'dashboard';

  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  document.querySelectorAll('.nav-link').forEach((l) => l.classList.remove('active'));
  document.getElementById(`view-${view}`).classList.add('active');
  const link = document.querySelector(`.nav-link[data-view="${view}"]`);
  if (link) link.classList.add('active');
  location.hash = view;

  if (view === 'dashboard') loadDashboard();
  if (view === 'history') loadHistory();
  if (view === 'users') loadUsers();
  if (view === 'settings') fillSettingsForm();
  if (view === 'products') loadProducts();
  if (view === 'print-monitor') {
    loadAgents();
    loadPrintSummary();
    loadPrintJobs();
  }
}

// ---------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------
async function loadDashboard() {
  const data = await api('GET', '/api/dashboard/summary');

  document.getElementById('kpi-today-revenue').textContent = money(data.today.revenue, currentSettings.currency);
  document.getElementById('kpi-today-count').textContent = `${data.today.count} sale${data.today.count === 1 ? '' : 's'}`;

  document.getElementById('kpi-week-revenue').textContent = money(data.last7Days.revenue, currentSettings.currency);
  document.getElementById('kpi-week-count').textContent = `${data.last7Days.count} sale${data.last7Days.count === 1 ? '' : 's'}`;

  document.getElementById('kpi-month-revenue').textContent = money(data.thisMonth.revenue, currentSettings.currency);
  document.getElementById('kpi-month-count').textContent = `${data.thisMonth.count} sale${data.thisMonth.count === 1 ? '' : 's'}`;

  drawRevenueChart(data.dailySeries);
  renderTopItems(data.topItems);
  renderLowStock(data.lowStock);
}

function drawRevenueChart(series) {
  const canvas = document.getElementById('revenue-chart');
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const padding = { top: 10, right: 10, bottom: 26, left: 10 };
  const chartW = w - padding.left - padding.right;
  const chartH = h - padding.top - padding.bottom;

  ctx.clearRect(0, 0, w, h);

  const maxVal = Math.max(1, ...series.map((d) => d.revenue));
  const barGap = 4;
  const barWidth = chartW / series.length - barGap;

  ctx.font = '10px Inter, -apple-system, sans-serif';
  ctx.fillStyle = '#9ca3af'; // --ink-soft
  ctx.textAlign = 'center';

  series.forEach((d, i) => {
    const barHeight = (d.revenue / maxVal) * chartH;
    const x = padding.left + i * (barWidth + barGap);
    const y = padding.top + (chartH - barHeight);

    ctx.fillStyle = d.revenue > 0 ? '#10b981' : '#1f2937'; // --accent / --surface-2
    ctx.fillRect(x, y, barWidth, Math.max(barHeight, 1));

    // Label every other day to avoid crowding
    if (i % 2 === 0) {
      const label = d.day.slice(5); // MM-DD
      ctx.fillStyle = '#9ca3af';
      ctx.fillText(label, x + barWidth / 2, h - 8);
    }
  });
}

function renderTopItems(items) {
  const wrap = document.getElementById('top-items-wrap');
  if (items.length === 0) {
    wrap.innerHTML = `<div class="empty-state">No sales in the last 30 days yet.</div>`;
    return;
  }
  const rows = items.map((item, i) => `
    <tr>
      <td>${i + 1}. ${escapeHtml(item.name)}</td>
      <td class="num">${item.qty}</td>
      <td class="num">${money(item.revenue, currentSettings.currency)}</td>
    </tr>
  `).join('');
  wrap.innerHTML = `
    <table>
      <thead><tr><th>Item</th><th class="num">Qty sold</th><th class="num">Revenue</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderLowStock(list) {
  const card = document.getElementById('low-stock-card');
  const wrap = document.getElementById('low-stock-wrap');
  if (list.length === 0) {
    card.style.display = 'none';
    return;
  }
  card.style.display = 'block';
  wrap.innerHTML = list.map((p) => `
    <div class="low-stock-row">
      <span>${escapeHtml(p.name)}</span>
      <span class="badge danger">${p.stock_qty} left (alert at ${p.reorder_level})</span>
    </div>
  `).join('');
}

// ---------------------------------------------------------------
// New Sale
// ---------------------------------------------------------------
function setupSaleForm() {
  document.getElementById('tax-rate-display').value = `${currentSettings.tax_rate}%`;
  document.getElementById('add-item-btn').addEventListener('click', () => addItemRow());
  document.getElementById('discount-value').addEventListener('input', recalcTotals);
  document.getElementById('discount-type').addEventListener('change', recalcTotals);
  document.getElementById('sale-form').addEventListener('submit', submitSale);
}

function addItemRow() {
  itemIdCounter += 1;
  const id = `item-${itemIdCounter}`;
  const wrap = document.getElementById('item-rows');
  const row = document.createElement('div');
  row.className = 'item-row';
  row.id = id;
  row.dataset.productId = '';
  row.innerHTML = `
    <div class="field">
      <input class="item-name" list="products-datalist" placeholder="Item name" required>
      <div class="stock-hint" style="display:none;"></div>
    </div>
    <div class="field"><input class="item-qty" type="number" min="0.01" step="0.01" value="1" placeholder="Qty" required></div>
    <div class="field"><input class="item-price" type="number" min="0" step="0.01" placeholder="Unit price" required></div>
    <div class="field"><input class="item-line-total" disabled value="0.00"></div>
    <button type="button" class="remove-item" title="Remove item">&times;</button>
  `;
  wrap.appendChild(row);

  const nameInput = row.querySelector('.item-name');
  const priceInput = row.querySelector('.item-price');

  nameInput.addEventListener('input', () => {
    const match = products.find((p) => p.name.toLowerCase() === nameInput.value.trim().toLowerCase());
    if (match) {
      row.dataset.productId = match.id;
      priceInput.value = match.price;
    } else {
      row.dataset.productId = '';
    }
    updateStockHint(row);
    recalcTotals();
  });

  row.querySelector('.item-qty').addEventListener('input', () => { updateStockHint(row); recalcTotals(); });
  priceInput.addEventListener('input', recalcTotals);
  row.querySelector('.remove-item').addEventListener('click', () => {
    row.remove();
    recalcTotals();
  });
  recalcTotals();
}

function updateStockHint(row) {
  const hint = row.querySelector('.stock-hint');
  const productId = row.dataset.productId;
  if (!productId) { hint.style.display = 'none'; return; }

  const product = products.find((p) => String(p.id) === String(productId));
  if (!product || !product.track_stock) { hint.style.display = 'none'; return; }

  const qty = parseFloat(row.querySelector('.item-qty').value) || 0;
  const short = qty > product.stock_qty;
  hint.style.display = 'block';
  hint.className = `stock-hint${short ? ' warn' : ''}`;
  hint.textContent = short
    ? `Only ${product.stock_qty} in stock`
    : `${product.stock_qty} in stock`;
}

function getSaleItems() {
  return Array.from(document.querySelectorAll('.item-row')).map((row) => {
    const name = row.querySelector('.item-name').value.trim();
    const qty = parseFloat(row.querySelector('.item-qty').value) || 0;
    const unit_price = parseFloat(row.querySelector('.item-price').value) || 0;
    const product_id = row.dataset.productId || null;
    return { name, qty, unit_price, product_id, row };
  });
}

function recalcTotals() {
  const items = getSaleItems();
  let subtotal = 0;
  items.forEach((item) => {
    const lineTotal = item.qty * item.unit_price;
    subtotal += lineTotal;
    item.row.querySelector('.item-line-total').value = lineTotal.toFixed(2);
  });

  const discountType = document.getElementById('discount-type').value;
  const discountValue = parseFloat(document.getElementById('discount-value').value) || 0;
  let discountAmount = discountType === 'percent' ? (subtotal * discountValue) / 100 : discountValue;
  discountAmount = Math.max(0, Math.min(discountAmount, subtotal));

  const taxable = subtotal - discountAmount;
  const taxAmount = (taxable * currentSettings.tax_rate) / 100;
  const total = taxable + taxAmount;

  document.getElementById('calc-subtotal').textContent = subtotal.toFixed(2);
  document.getElementById('calc-discount').textContent = discountAmount.toFixed(2);
  document.getElementById('calc-tax').textContent = taxAmount.toFixed(2);
  document.getElementById('calc-total').textContent = total.toFixed(2);
}

async function submitSale(e) {
  e.preventDefault();
  const errorEl = document.getElementById('sale-error');
  errorEl.style.display = 'none';

  const items = getSaleItems().map(({ name, qty, unit_price, product_id }) => ({ name, qty, unit_price, product_id }));
  if (items.length === 0 || items.some((i) => !i.name)) {
    errorEl.textContent = 'Add at least one item with a name.';
    errorEl.style.display = 'block';
    return;
  }

  const payload = {
    customer_name: document.getElementById('customer-name').value.trim(),
    items,
    discount_type: document.getElementById('discount-type').value,
    discount_value: parseFloat(document.getElementById('discount-value').value) || 0
  };

  try {
    const result = await api('POST', '/api/sales', payload);
    resetSaleForm();
    await loadProductCatalog(); // stock levels changed
    window.open(`receipt.html?id=${result.id}`, '_blank');
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.style.display = 'block';
  }
}

function resetSaleForm() {
  document.getElementById('customer-name').value = '';
  document.getElementById('discount-value').value = 0;
  document.getElementById('discount-type').value = 'amount';
  document.getElementById('item-rows').innerHTML = '';
  addItemRow();
  recalcTotals();
}

// ---------------------------------------------------------------
// History
// ---------------------------------------------------------------
function setupHistory() {
  document.getElementById('filter-btn').addEventListener('click', loadHistory);
}

async function loadHistory() {
  const from = document.getElementById('filter-from').value;
  const to = document.getElementById('filter-to').value;
  const q = document.getElementById('filter-q').value.trim();

  const params = new URLSearchParams();
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  if (q) params.set('q', q);

  const { sales } = await api('GET', `/api/sales?${params.toString()}`);
  const wrap = document.getElementById('history-table-wrap');

  if (sales.length === 0) {
    wrap.innerHTML = `<div class="empty-state">No sales found for this filter.</div>`;
    return;
  }

  const rows = sales.map((s) => `
    <tr>
      <td>${escapeHtml(s.receipt_no)}</td>
      <td>${new Date(s.created_at).toLocaleString()}</td>
      <td>${escapeHtml(s.customer_name || '&mdash;')}</td>
      <td>${escapeHtml(s.cashier_name)}</td>
      <td class="num">${money(s.total, currentSettings.currency)}</td>
      <td>${s.voided ? '<span class="badge danger">Voided</span>' : '<span class="badge">Completed</span>'}</td>
      <td>
        <a href="receipt.html?id=${s.id}" target="_blank" class="btn btn-outline btn-sm">View / Print</a>
        ${currentUser.role === 'admin' && !s.voided ? `<button class="btn btn-outline btn-sm void-btn" data-id="${s.id}">Void</button>` : ''}
      </td>
    </tr>
  `).join('');

  wrap.innerHTML = `
    <table>
      <thead><tr><th>Receipt #</th><th>Date</th><th>Customer</th><th>Cashier</th><th class="num">Total</th><th>Status</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;

  wrap.querySelectorAll('.void-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Void this sale? It will stay in history but be marked as voided.')) return;
      await api('PATCH', `/api/sales/${btn.dataset.id}/void`);
      loadHistory();
    });
  });
}

// ---------------------------------------------------------------
// Users (admin)
// ---------------------------------------------------------------
function setupUsers() {
  document.getElementById('user-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('user-error');
    errorEl.style.display = 'none';
    try {
      await api('POST', '/api/users', {
        full_name: document.getElementById('u-fullname').value.trim(),
        username: document.getElementById('u-username').value.trim(),
        password: document.getElementById('u-password').value,
        role: document.getElementById('u-role').value
      });
      document.getElementById('user-form').reset();
      loadUsers();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.style.display = 'block';
    }
  });
}

async function loadUsers() {
  const { users } = await api('GET', '/api/users');
  const wrap = document.getElementById('users-table-wrap');
  const rows = users.map((u) => `
    <tr>
      <td>${escapeHtml(u.full_name)}</td>
      <td>${escapeHtml(u.username)}</td>
      <td style="text-transform:capitalize;">${u.role}</td>
      <td>${u.active ? '<span class="badge">Active</span>' : '<span class="badge danger">Disabled</span>'}</td>
      <td>
        ${u.id === currentUser.id ? '' : `<button class="btn btn-outline btn-sm toggle-active" data-id="${u.id}" data-active="${u.active}">${u.active ? 'Disable' : 'Enable'}</button>`}
        <button class="btn btn-outline btn-sm reset-pw" data-id="${u.id}">Reset password</button>
      </td>
    </tr>
  `).join('');

  wrap.innerHTML = `
    <table>
      <thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Status</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;

  wrap.querySelectorAll('.toggle-active').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const active = btn.dataset.active === '1';
      await api('PATCH', `/api/users/${btn.dataset.id}/active`, { active: !active });
      loadUsers();
    });
  });

  wrap.querySelectorAll('.reset-pw').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const newPassword = prompt('Enter a new password for this user (min 6 characters):');
      if (!newPassword) return;
      try {
        await api('POST', `/api/users/${btn.dataset.id}/reset-password`, { newPassword });
        alert('Password updated.');
      } catch (err) {
        alert(err.message);
      }
    });
  });
}

// ---------------------------------------------------------------
// Products (admin)
// ---------------------------------------------------------------
function setupProductForm() {
  const trackCheckbox = document.getElementById('p-track-stock');
  const stockFields = document.getElementById('stock-fields');
  trackCheckbox.addEventListener('change', () => {
    stockFields.style.display = trackCheckbox.checked ? 'flex' : 'none';
  });

  document.getElementById('product-cancel-btn').addEventListener('click', resetProductForm);

  document.getElementById('product-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('product-error');
    errorEl.style.display = 'none';

    const payload = {
      name: document.getElementById('p-name').value.trim(),
      sku: document.getElementById('p-sku').value.trim(),
      category: document.getElementById('p-category').value.trim(),
      price: parseFloat(document.getElementById('p-price').value) || 0,
      track_stock: document.getElementById('p-track-stock').checked,
      stock_qty: parseFloat(document.getElementById('p-stock').value) || 0,
      reorder_level: parseFloat(document.getElementById('p-reorder').value) || 0,
    };

    try {
      if (editingProductId) {
        payload.active = true;
        await api('PUT', `/api/products/${editingProductId}`, payload);
      } else {
        await api('POST', '/api/products', payload);
      }
      resetProductForm();
      await loadProductCatalog();
      loadProducts();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.style.display = 'block';
    }
  });
}

function resetProductForm() {
  editingProductId = null;
  document.getElementById('product-form').reset();
  document.getElementById('p-track-stock').checked = true;
  document.getElementById('stock-fields').style.display = 'flex';
  document.getElementById('product-form-title').textContent = 'Add product';
  document.getElementById('product-submit-btn').textContent = 'Add product';
  document.getElementById('product-cancel-btn').style.display = 'none';
}

async function loadProducts() {
  const { products: list } = await api('GET', '/api/products?all=1');
  const wrap = document.getElementById('products-table-wrap');

  if (list.length === 0) {
    wrap.innerHTML = `<div class="empty-state">No products yet — add your first one above.</div>`;
    return;
  }

  const rows = list.map((p) => `
    <tr>
      <td>${escapeHtml(p.name)}${p.sku ? `<div class="muted" style="font-size:11.5px;">${escapeHtml(p.sku)}</div>` : ''}</td>
      <td>${escapeHtml(p.category || '&mdash;')}</td>
      <td class="num">${money(p.price, currentSettings.currency)}</td>
      <td class="num">${p.track_stock ? p.stock_qty : '&mdash;'}</td>
      <td>${p.active ? '<span class="badge">Active</span>' : '<span class="badge danger">Inactive</span>'}</td>
      <td>
        <button class="btn btn-outline btn-sm edit-product" data-id="${p.id}">Edit</button>
        ${p.track_stock ? `<button class="btn btn-outline btn-sm adjust-stock" data-id="${p.id}">Adjust stock</button>` : ''}
        <button class="btn btn-outline btn-sm toggle-product" data-id="${p.id}" data-active="${p.active}">${p.active ? 'Deactivate' : 'Activate'}</button>
      </td>
    </tr>
  `).join('');

  wrap.innerHTML = `
    <table>
      <thead><tr><th>Product</th><th>Category</th><th class="num">Price</th><th class="num">Stock</th><th>Status</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;

  wrap.querySelectorAll('.edit-product').forEach((btn) => {
    btn.addEventListener('click', () => {
      const product = list.find((p) => String(p.id) === btn.dataset.id);
      editingProductId = product.id;
      document.getElementById('p-name').value = product.name;
      document.getElementById('p-sku').value = product.sku || '';
      document.getElementById('p-category').value = product.category || '';
      document.getElementById('p-price').value = product.price;
      document.getElementById('p-track-stock').checked = !!product.track_stock;
      document.getElementById('stock-fields').style.display = product.track_stock ? 'flex' : 'none';
      document.getElementById('p-stock').value = product.stock_qty;
      document.getElementById('p-reorder').value = product.reorder_level;
      document.getElementById('product-form-title').textContent = `Edit ${product.name}`;
      document.getElementById('product-submit-btn').textContent = 'Save changes';
      document.getElementById('product-cancel-btn').style.display = 'inline-flex';
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });

  wrap.querySelectorAll('.toggle-product').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const active = btn.dataset.active === '1';
      await api('PATCH', `/api/products/${btn.dataset.id}/active`, { active: !active });
      await loadProductCatalog();
      loadProducts();
    });
  });

  wrap.querySelectorAll('.adjust-stock').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const input = prompt('Enter stock change (e.g. 20 to add stock, -5 to remove):');
      if (!input) return;
      const delta = parseFloat(input);
      if (Number.isNaN(delta)) { alert('Please enter a valid number.'); return; }
      await api('POST', `/api/products/${btn.dataset.id}/adjust-stock`, { delta });
      await loadProductCatalog();
      loadProducts();
    });
  });
}

// ---------------------------------------------------------------
// Print Monitoring (admin)
// ---------------------------------------------------------------
function setupPrintMonitor() {
  document.getElementById('agent-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('agent-error');
    errorEl.style.display = 'none';
    const label = document.getElementById('agent-label').value.trim();
    if (!label) return;

    try {
      const result = await api('POST', '/api/agents', { label });
      document.getElementById('agent-label').value = '';
      const reveal = document.getElementById('agent-key-reveal');
      reveal.style.display = 'block';
      reveal.innerHTML = `
        <div class="card" style="background:var(--accent-soft); border-color:var(--accent);">
          <strong>Agent "${escapeHtml(result.label)}" registered.</strong>
          <p style="margin:8px 0 4px; font-size:13px;">Copy this API key into the agent's <code>config.json</code> now &mdash; it will not be shown again:</p>
          <code style="display:block; padding:8px; background:#fff; color:#111827; border-radius:3px; word-break:break-all; font-size:12.5px;">${escapeHtml(result.api_key)}</code>
        </div>
      `;
      loadAgents();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.style.display = 'block';
    }
  });

  document.getElementById('pj-filter-btn').addEventListener('click', loadPrintJobs);
  document.getElementById('pj-bulk-review').addEventListener('click', () => bulkUpdatePrintJobs('review'));
  document.getElementById('pj-bulk-flag').addEventListener('click', () => bulkUpdatePrintJobs('flag'));

  const summaryDate = document.getElementById('summary-date');
  summaryDate.valueAsDate = new Date();
  summaryDate.addEventListener('change', loadPrintSummary);
}

async function loadAgents() {
  const { agents } = await api('GET', '/api/agents');
  const wrap = document.getElementById('agents-table-wrap');
  if (agents.length === 0) {
    wrap.innerHTML = `<div class="empty-state">No agents registered yet.</div>`;
    return;
  }
  const rows = agents.map((a) => `
    <tr>
      <td>${escapeHtml(a.label)}</td>
      <td>${a.online ? '<span class="badge">Online</span>' : '<span class="badge danger">Offline</span>'}</td>
      <td>${a.last_seen_at ? new Date(a.last_seen_at + 'Z').toLocaleString() : 'Never'}</td>
      <td>${a.active ? '<span class="badge">Active</span>' : '<span class="badge danger">Disabled</span>'}</td>
      <td><button class="btn btn-outline btn-sm toggle-agent" data-id="${a.id}" data-active="${a.active}">${a.active ? 'Disable' : 'Enable'}</button></td>
    </tr>
  `).join('');
  wrap.innerHTML = `
    <table>
      <thead><tr><th>Agent</th><th>Status</th><th>Last seen</th><th>Enabled</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
  wrap.querySelectorAll('.toggle-agent').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const active = btn.dataset.active === '1';
      await api('PATCH', `/api/agents/${btn.dataset.id}/active`, { active: !active });
      loadAgents();
    });
  });
}

async function loadPrintSummary() {
  const date = document.getElementById('summary-date').value || new Date().toISOString().slice(0, 10);
  const { totals, byPrinter } = await api('GET', `/api/print-jobs/summary?date=${date}`);

  const grid = document.getElementById('summary-kpi-grid');
  grid.innerHTML = `
    <div class="card kpi-card">
      <div class="kpi-label">Jobs printed</div>
      <div class="kpi-value">${totals.job_count}</div>
      <div class="kpi-sub">${totals.total_pages} pages total</div>
    </div>
    <div class="card kpi-card">
      <div class="kpi-label">Color / B&amp;W</div>
      <div class="kpi-value">${totals.color_jobs} / ${totals.mono_jobs}</div>
      <div class="kpi-sub">${totals.color_pages} color pages, ${totals.mono_pages} mono pages${totals.unknown_color_jobs ? ` &middot; ${totals.unknown_color_jobs} undetected` : ''}</div>
    </div>
    <div class="card kpi-card">
      <div class="kpi-label">Duplex / Single-sided</div>
      <div class="kpi-value">${totals.duplex_jobs} / ${totals.simplex_jobs}</div>
      <div class="kpi-sub">Duplex is a best-effort estimate (see agent docs)</div>
    </div>
  `;

  const byPrinterWrap = document.getElementById('summary-by-printer');
  if (byPrinter.length === 0) {
    byPrinterWrap.innerHTML = '';
  } else {
    const rows = byPrinter.map((p) => `
      <tr><td>${escapeHtml(p.printer_name)}</td><td class="num">${p.job_count}</td><td class="num">${p.total_pages}</td></tr>
    `).join('');
    byPrinterWrap.innerHTML = `
      <table>
        <thead><tr><th>Printer</th><th class="num">Jobs</th><th class="num">Pages</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }
}

async function loadPrintJobs() {
  const status = document.getElementById('pj-status').value;
  const from = document.getElementById('pj-from').value;
  const to = document.getElementById('pj-to').value;

  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (from) params.set('from', from);
  if (to) params.set('to', to);

  const { jobs } = await api('GET', `/api/print-jobs?${params.toString()}`);
  const wrap = document.getElementById('print-jobs-table-wrap');

  if (jobs.length === 0) {
    wrap.innerHTML = `<div class="empty-state">No print jobs found for this filter.</div>`;
    updateBulkButtons();
    return;
  }

  const rows = jobs.map((j) => `
    <tr>
      <td><input type="checkbox" class="pj-check" data-id="${j.id}"></td>
      <td>${escapeHtml(j.document_name) || '<span class="muted">(untitled)</span>'}</td>
      <td>${escapeHtml(j.printer_name)}<div class="muted" style="font-size:11px;">${escapeHtml(j.agent_label)}</div></td>
      <td>${escapeHtml(j.submitted_by) || '&mdash;'}</td>
      <td class="num">${j.pages || '<span class="muted">?</span>'}</td>
      <td>${colorModeBadge(j.color_mode)} ${duplexBadge(j.duplex)}</td>
      <td>${new Date(j.submitted_at).toLocaleString()}</td>
      <td>${statusCell(j)}</td>
    </tr>
  `).join('');

  wrap.innerHTML = `
    <table>
      <thead><tr><th></th><th>Document</th><th>Printer</th><th>Submitted by</th><th class="num">Pages</th><th>Type</th><th>Submitted</th><th>Status</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;

  wrap.querySelectorAll('.pj-check').forEach((cb) => cb.addEventListener('change', updateBulkButtons));
  updateBulkButtons();
}

function colorModeBadge(mode) {
  if (mode === 'color') return '<span class="badge" style="background:rgba(123,208,255,0.15); color:var(--tertiary);">Color</span>';
  if (mode === 'mono') return '<span class="badge">B&amp;W</span>';
  return '<span class="badge danger">Mode unknown</span>';
}

function duplexBadge(duplex) {
  if (duplex === 'duplex') return '<span class="badge">Duplex</span>';
  if (duplex === 'simplex') return '<span class="badge" style="background:rgba(123,208,255,0.15); color:var(--tertiary);">Single-sided</span>';
  return '<span class="badge danger">Sides unknown</span>';
}

function statusCell(j) {
  if (j.status === 'approved') return '<span class="badge">Reviewed</span>';
  if (j.status === 'rejected') {
    return `<span class="badge danger">Flagged</span>${j.note ? `<div class="muted" style="font-size:11px;">${escapeHtml(j.note)}</div>` : ''}`;
  }
  return '<span class="badge" style="background:rgba(245,158,11,0.15); color:#f59e0b;">Unreviewed</span>';
}

function updateBulkButtons() {
  const checked = document.querySelectorAll('.pj-check:checked').length;
  document.getElementById('pj-bulk-review').disabled = checked === 0;
  document.getElementById('pj-bulk-flag').disabled = checked === 0;
}

async function bulkUpdatePrintJobs(action) {
  const ids = Array.from(document.querySelectorAll('.pj-check:checked')).map((cb) => Number(cb.dataset.id));
  if (ids.length === 0) return;

  if (action === 'review') {
    await api('PATCH', '/api/print-jobs/bulk-review', { ids });
  } else {
    const note = prompt(`Optional note for flagging these ${ids.length} job(s):`) || '';
    await api('PATCH', '/api/print-jobs/bulk-flag', { ids, note });
  }
  loadPrintJobs();
}

// ---------------------------------------------------------------
// Settings (admin)
// ---------------------------------------------------------------
function fillSettingsForm() {
  document.getElementById('s-business-name').value = currentSettings.business_name;
  document.getElementById('s-address').value = currentSettings.address;
  document.getElementById('s-phone').value = currentSettings.phone;
  document.getElementById('s-email').value = currentSettings.email;
  document.getElementById('s-tax-rate').value = currentSettings.tax_rate;
  document.getElementById('s-currency').value = currentSettings.currency;
  document.getElementById('s-receipt-prefix').value = currentSettings.receipt_prefix;
  document.getElementById('s-footer').value = currentSettings.footer_note;

  const preview = document.getElementById('s-logo-preview');
  if (currentSettings.logo_data_url) {
    preview.src = currentSettings.logo_data_url;
    preview.style.display = 'block';
  } else {
    preview.style.display = 'none';
  }
}

function setupSettingsForm() {
  let logoDataUrl = '';

  document.getElementById('s-logo').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 1.5 * 1024 * 1024) {
      alert('Please choose a logo image smaller than 1.5MB.');
      e.target.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      logoDataUrl = reader.result;
      const preview = document.getElementById('s-logo-preview');
      preview.src = logoDataUrl;
      preview.style.display = 'block';
    };
    reader.readAsDataURL(file);
  });

  document.getElementById('settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('settings-error');
    const successEl = document.getElementById('settings-success');
    errorEl.style.display = 'none';
    successEl.style.display = 'none';

    try {
      await api('PUT', '/api/settings', {
        business_name: document.getElementById('s-business-name').value.trim(),
        address: document.getElementById('s-address').value.trim(),
        phone: document.getElementById('s-phone').value.trim(),
        email: document.getElementById('s-email').value.trim(),
        tax_rate: parseFloat(document.getElementById('s-tax-rate').value) || 0,
        currency: document.getElementById('s-currency').value.trim(),
        receipt_prefix: document.getElementById('s-receipt-prefix').value.trim(),
        footer_note: document.getElementById('s-footer').value.trim(),
        logo_data_url: logoDataUrl || currentSettings.logo_data_url
      });

      const settingsRes = await api('GET', '/api/settings');
      currentSettings = settingsRes.settings;
      document.getElementById('brand-business').textContent = currentSettings.business_name;
      document.getElementById('tax-rate-display').value = `${currentSettings.tax_rate}%`;
      successEl.style.display = 'block';
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.style.display = 'block';
    }
  });
}

// ---------------------------------------------------------------
// Account
// ---------------------------------------------------------------
function setupAccountForm() {
  document.getElementById('password-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('password-error');
    const successEl = document.getElementById('password-success');
    errorEl.style.display = 'none';
    successEl.style.display = 'none';

    try {
      await api('POST', '/api/auth/change-password', {
        currentPassword: document.getElementById('cur-password').value,
        newPassword: document.getElementById('new-password').value
      });
      document.getElementById('password-form').reset();
      successEl.style.display = 'block';
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.style.display = 'block';
    }
  });
}
