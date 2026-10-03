// Job ticket: the shop's copy (what to do, ticked off as it's done) and a
// tear-off slip for the customer with the job number and when to collect.
const STATUS_LABEL = { queued: 'Queued', printing: 'Printing', ready: 'Ready', collected: 'Collected', cancelled: 'Cancelled' };

function partSpec(p, products) {
  if (p.type === 'print' || p.type === 'copy') {
    const sheets = (p.sides === 2 ? Math.ceil(p.pages / 2) : p.pages) * p.copies;
    return {
      what: `${p.color === 'color' ? 'Colour' : 'B&W'} ${p.type === 'copy' ? 'photocopy' : 'print'}`,
      how: [`${p.pages} page${p.pages === 1 ? '' : 's'}`, `${p.copies} cop${p.copies === 1 ? 'y' : 'ies'}`, p.sides === 2 ? 'both sides' : 'one side', p.paper || 'A4', `${sheets} sheet${sheets === 1 ? '' : 's'}`].join(' · ')
    };
  }
  if (p.type === 'item') {
    const product = products.get(p.product_id);
    return { what: product ? product.name : 'Item', how: `Qty ${p.qty}` };
  }
  return { what: p.name, how: `Qty ${p.qty}` };
}

function dueLabel(iso) {
  if (!iso) return 'No due time';
  return new Date(iso).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

(async function init() {
  const id = new URLSearchParams(location.search).get('id');
  const root = document.getElementById('job-root');
  if (!id) { root.innerHTML = '<p>No job specified.</p>'; return; }

  let settings, job, products;
  try {
    const me = await api('GET', '/api/auth/me');
    if (!me.user) { window.location.replace('login.html'); return; }
    [{ settings }, { job }, { products }] = await Promise.all([
      api('GET', '/api/settings'), api('GET', `/api/jobs/${encodeURIComponent(id)}`), api('GET', '/api/products')
    ]);
  } catch (err) {
    root.innerHTML = `<p>Could not load this job: ${escapeHtml(err.message)}</p>`;
    return;
  }
  const byId = new Map(products.map((p) => [p.id, p]));
  const cur = settings.currency;
  document.getElementById('toolbar-title').textContent = `Job ${job.job_no}`;
  document.title = `Job ${job.job_no}`;

  const paid = job.paid ? `Paid · ${escapeHtml(job.receipt_no || '')}` : 'Not paid';
  root.innerHTML = `
    <div class="r-header">
      <div class="r-business">
        ${settings.logo_data_url ? `<img class="r-logo" src="${escapeHtml(settings.logo_data_url)}" alt="Logo">` : ''}
        <div>
          <h1>${escapeHtml(settings.business_name)}</h1>
          <div class="meta">${[settings.phone, settings.email].filter(Boolean).map(escapeHtml).join('<br>')}</div>
        </div>
      </div>
      <div class="r-doc-label">
        <div class="type">JOB TICKET</div>
        <div class="j-no">${escapeHtml(job.job_no)}</div>
        <div class="date">${escapeHtml(STATUS_LABEL[job.status] || job.status)}</div>
        ${job.status === 'cancelled' ? '<div class="r-voided-stamp">CANCELLED</div>' : ''}
      </div>
    </div>

    <div class="r-parties">
      <div>
        <div class="label">Customer</div>
        <div><strong>${escapeHtml(job.customer_name) || 'Walk-in customer'}</strong></div>
        ${job.customer_phone ? `<div>${escapeHtml(job.customer_phone)}</div>` : ''}
        ${job.title ? `<div>${escapeHtml(job.title)}</div>` : ''}
      </div>
      <div style="text-align:right;">
        <div class="label">Due</div>
        <div class="j-due">${escapeHtml(dueLabel(job.due_at))}</div>
        <div class="label" style="margin-top:4px;">Taken by ${escapeHtml(job.created_by_name || '')} · ${escapeHtml(formatDbDate(job.created_at))}</div>
      </div>
    </div>

    <div class="z-section">
      <h2>The work</h2>
      <ol class="j-checklist">
        ${job.parts.map((p) => { const s = partSpec(p, byId); return `<li><span class="j-box"></span><div><strong>${escapeHtml(s.what)}</strong><div class="j-how">${escapeHtml(s.how)}</div></div></li>`; }).join('')}
      </ol>
    </div>
    ${job.notes ? `<div class="z-section"><h2>Notes</h2><div class="j-notes">${escapeHtml(job.notes)}</div></div>` : ''}

    <div class="z-section">
      <h2>Price</h2>
      <table class="r-items">
        <thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">Amount</th></tr></thead>
        <tbody>${job.lines.map((l) => `<tr><td>${escapeHtml(l.name)}</td><td class="num">${l.qty}</td><td class="num">${money(l.unit_price, '')}</td><td class="num">${money(l.line_total, '')}</td></tr>`).join('')}</tbody>
      </table>
      <div class="r-totals">
        <div class="row grand"><span>Total${settings.tax_rate > 0 ? ' (before tax)' : ''}</span><span>${money(job.total, cur)}</span></div>
        <div class="row"><span>${paid}</span><span></span></div>
      </div>
    </div>

    <div class="j-stub">
      <div class="j-cut">&#9986; Customer slip</div>
      <div class="j-stub-body">
        <div>
          <div class="j-stub-shop">${escapeHtml(settings.business_name)}${settings.phone ? ` · ${escapeHtml(settings.phone)}` : ''}</div>
          <div>${escapeHtml(job.customer_name) || 'Walk-in customer'}${job.title ? ` · ${escapeHtml(job.title)}` : ''}</div>
          <div>Collect: <strong>${escapeHtml(dueLabel(job.due_at))}</strong></div>
          <div>${money(job.total, cur)} · ${paid}</div>
        </div>
        <div class="j-no j-stub-no">${escapeHtml(job.job_no)}</div>
      </div>
    </div>
  `;
})();

document.getElementById('print-btn').addEventListener('click', () => window.print());
document.getElementById('back-btn').addEventListener('click', () => {
  window.location.href = 'app.html#jobs';
});
