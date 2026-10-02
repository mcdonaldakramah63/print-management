(async function init() {
  const params = new URLSearchParams(location.search);
  const id = params.get('id');
  const root = document.getElementById('receipt-root');

  if (!id) {
    root.innerHTML = `<p>No receipt specified.</p>`;
    return;
  }

  let me, settingsRes, saleRes;
  try {
    me = await api('GET', '/api/auth/me');
    if (!me.user) { window.location.href = 'login.html'; return; }
    settingsRes = await api('GET', '/api/settings');
    saleRes = await api('GET', `/api/sales/${id}`);
  } catch (err) {
    root.innerHTML = `<p>Could not load this receipt: ${escapeHtml(err.message)}</p>`;
    return;
  }

  const settings = settingsRes.settings;
  const { sale, items } = saleRes;

  document.getElementById('toolbar-title').textContent = `Receipt ${sale.receipt_no}`;
  document.title = `Receipt ${sale.receipt_no}`;

  const itemRows = items.map((item) => `
    <tr>
      <td>${escapeHtml(item.name)}</td>
      <td class="num">${item.qty}</td>
      <td class="num">${money(item.unit_price, '')}</td>
      <td class="num">${money(item.line_total, '')}</td>
    </tr>
  `).join('');

  const discountLabel = sale.discount_type === 'percent'
    ? `Discount (${sale.discount_value}%)`
    : 'Discount';

  root.innerHTML = `
    <div class="r-header">
      <div class="r-business">
        ${settings.logo_data_url ? `<img class="r-logo" src="${settings.logo_data_url}" alt="Logo">` : ''}
        <div>
          <h1>${escapeHtml(settings.business_name)}</h1>
          <div class="meta">
            ${settings.address ? escapeHtml(settings.address) + '<br>' : ''}
            ${[settings.phone, settings.email].filter(Boolean).map(escapeHtml).join('<br>')}
          </div>
        </div>
      </div>
      <div class="r-doc-label">
        <div class="type">SALES RECEIPT</div>
        <div class="no">No. ${escapeHtml(sale.receipt_no)}</div>
        <div class="date">${new Date(sale.created_at).toLocaleString()}</div>
        ${sale.voided ? '<div class="r-voided-stamp">VOID</div>' : ''}
      </div>
    </div>

    <div class="r-parties">
      <div>
        <div class="label">Billed to</div>
        <div>${escapeHtml(sale.customer_name) || 'Walk-in customer'}</div>
      </div>
      <div style="text-align:right;">
        <div class="label">Served by</div>
        <div>${escapeHtml(sale.cashier_name)}</div>
      </div>
    </div>

    <table class="r-items">
      <thead>
        <tr>
          <th>Item</th>
          <th class="num">Qty</th>
          <th class="num">Unit price</th>
          <th class="num">Amount</th>
        </tr>
      </thead>
      <tbody>${itemRows}</tbody>
    </table>

    <div class="r-totals">
      <div class="row"><span>Subtotal</span><span>${money(sale.subtotal, settings.currency)}</span></div>
      ${sale.discount_amount > 0 ? `<div class="row"><span>${discountLabel}</span><span>-${money(sale.discount_amount, settings.currency)}</span></div>` : ''}
      ${sale.tax_amount > 0 ? `<div class="row"><span>Tax (${sale.tax_rate}%)</span><span>${money(sale.tax_amount, settings.currency)}</span></div>` : ''}
      <div class="row grand"><span>Total</span><span>${money(sale.total, settings.currency)}</span></div>
    </div>

    <div class="r-footer">
      <div class="thanks">${escapeHtml(settings.footer_note || 'Thank you!')}</div>
      <div>This receipt was generated electronically and is valid without a signature.</div>
    </div>
  `;

  document.getElementById('print-btn').addEventListener('click', () => window.print());
  document.getElementById('back-btn').addEventListener('click', () => {
    window.location.href = 'app.html#history';
  });
})();
