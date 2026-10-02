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
    root.innerHTML = `<p style="text-align:center;padding:40px;color:#666">Could not load receipt: ${escapeHtml(err.message)}</p>`;
    return;
  }

  const s = settingsRes.settings;
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

  const voidedClass = sale.status === 'voided' ? 'voided' : '';
  const voidedStamp = sale.status === 'voided' ? '<div class="r-voided-stamp">VOIDED</div>' : '';

  root.innerHTML = `
    <div class="r-header ${voidedClass}">
      <div class="r-business">
        ${s.logo_data_url ? `<img class="r-logo" src="${s.logo_data_url}" alt="Logo">` : ''}
        <div>
          <h1>${escapeHtml(s.business_name || s.receipt_header)}</h1>
          <div class="meta">
            ${s.address ? escapeHtml(s.address) + '<br>' : ''}
            ${[s.phone, s.email].filter(Boolean).map(escapeHtml).join('<br>')}
          </div>
        </div>
      </div>
      <div class="r-doc-label">
        <div class="type">Receipt</div>
        <div class="no">${escapeHtml(sale.receipt_no)}</div>
        <div class="date">${formatDate(sale.created_at)}</div>
        ${voidedStamp}
      </div>
    </div>

    <div class="r-parties">
      <div>
        <div class="label">Customer</div>
        <div>${escapeHtml(sale.customer_name || 'Walk-in')}</div>
        ${sale.customer_phone ? `<div>${escapeHtml(sale.customer_phone)}</div>` : ''}
      </div>
      <div style="text-align:right">
        <div class="label">Operator</div>
        <div>${escapeHtml(sale.operator_name)}</div>
        ${sale.terminal_id ? `<div>${escapeHtml(sale.terminal_id)}</div>` : ''}
      </div>
    </div>

    <table class="r-items">
      <thead>
        <tr>
          <th>Item / Service</th>
          <th class="num">Qty</th>
          <th class="num">Unit</th>
          <th class="num">Total</th>
        </tr>
      </thead>
      <tbody>
        ${itemRows}
      </tbody>
    </table>

    <div class="r-totals">
      <div class="row"><span>Subtotal</span><span>${money(sale.subtotal, '')}</span></div>
      <div class="row"><span>${discountLabel}</span><span>-${money(sale.discount_amount, '')}</span></div>
      <div class="row"><span>Tax (${sale.tax_rate || 0}%)</span><span>${money(sale.tax_amount, '')}</span></div>
      <div class="row grand"><span>Total</span><span>${money(sale.total, '')}</span></div>
    </div>

    ${sale.payment_method ? `<div style="margin-top:12px;font-size:10px">Payment: ${escapeHtml(sale.payment_method)}</div>` : ''}

    <div class="r-footer">
      <div class="thanks">${escapeHtml(s.receipt_footer || 'Thank you for your patronage!')}</div>
      <div>Powered by Vicamp Print OS</div>
    </div>
  `;

  // Print button
  document.getElementById('print-btn').addEventListener('click', () => window.print());
  document.getElementById('download-btn').addEventListener('click', async () => {
    try {
      const blob = await api('GET', `/api/sales/${id}/pdf`);
      // Note: actual PDF download logic depends on server implementation
      alert('PDF download not implemented in this demo.');
    } catch (e) { alert(e.message); }
  });
})();
