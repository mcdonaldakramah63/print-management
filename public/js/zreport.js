(async function init() {
  const root = document.getElementById('z-root');
  const date = new URLSearchParams(location.search).get('date') || localDateString();

  let settings, data;
  try {
    const me = await api('GET', '/api/auth/me');
    if (!me.user) { window.location.replace('login.html'); return; }
    settings = (await api('GET', '/api/settings')).settings;
    data = await api('GET', `/api/reports/close?date=${encodeURIComponent(date)}`);
  } catch (err) {
    root.innerHTML = `<p>Could not load this report: ${escapeHtml(err.message)}</p>`;
    return;
  }

  const c = data.closing;
  const f = c || data.figures;
  const cur = (n) => money(n, settings.currency);
  const [y, m, d] = data.date.split('-').map(Number);
  const dayText = new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const title = c ? 'Z-report' : 'X-report (day not closed)';
  document.getElementById('toolbar-title').textContent = `${title} · ${data.date}`;
  document.title = `${title} ${data.date}`;

  const variance = c ? c.variance : null;
  const varianceLabel = variance == null ? '' : variance < 0 ? 'Short' : variance > 0 ? 'Over' : 'Balanced';

  root.innerHTML = `
    <div class="r-header">
      <div class="r-business">
        ${settings.logo_data_url ? `<img class="r-logo" src="${escapeHtml(settings.logo_data_url)}" alt="Logo">` : ''}
        <div>
          <h1>${escapeHtml(settings.business_name)}</h1>
          <div class="meta">${settings.address ? escapeHtml(settings.address) : ''}</div>
        </div>
      </div>
      <div class="r-doc-label">
        <div class="type">${c ? 'END-OF-DAY Z-REPORT' : 'X-REPORT'}</div>
        <div class="no">${escapeHtml(data.date)}</div>
        <div class="date">${escapeHtml(dayText)}</div>
      </div>
    </div>

    ${c ? '' : '<p style="font-size:11px; color:#a33327; margin:0 0 8px;">This day has not been closed. Figures are live and may still change.</p>'}

    <div class="z-section">
      <h2>Sales</h2>
      <div class="r-totals" style="max-width:none;">
        <div class="row"><span>Completed sales</span><span>${f.sales_count}</span></div>
        <div class="row"><span>Voided sales</span><span>${f.voided_count}</span></div>
        <div class="row"><span>Cash</span><span>${cur(f.cash_total)}</span></div>
        <div class="row"><span>Mobile money</span><span>${cur(f.momo_total)}</span></div>
        <div class="row"><span>Card</span><span>${cur(f.card_total)}</span></div>
        <div class="row grand"><span>Gross takings</span><span>${cur(f.gross_total)}</span></div>
      </div>
    </div>

    ${data.figures.byCashier.length ? `
    <div class="z-section">
      <h2>By cashier${c ? ' (live)' : ''}</h2>
      <table class="r-items">
        <thead><tr><th>Cashier</th><th class="num">Sales</th><th class="num">Cash</th><th class="num">Total</th></tr></thead>
        <tbody>${data.figures.byCashier.map((r) => `<tr><td>${escapeHtml(r.name)}</td><td class="num">${r.count}</td><td class="num">${money(r.cash, '')}</td><td class="num">${money(r.revenue, '')}</td></tr>`).join('')}</tbody>
      </table>
    </div>` : ''}

    ${c ? `
    <div class="z-section">
      <h2>Cash drawer</h2>
      <div class="r-totals" style="max-width:none;">
        <div class="row"><span>Cash expected</span><span>${cur(c.cash_total)}</span></div>
        <div class="row"><span>Cash counted</span><span>${cur(c.cash_counted)}</span></div>
        <div class="row grand"><span>${varianceLabel}</span><span>${variance ? cur(Math.abs(variance)) : cur(0)}</span></div>
      </div>
      ${c.note ? `<p style="font-size:10.5px; margin:6px 0 0;">Note: ${escapeHtml(c.note)}</p>` : ''}
      <p style="font-size:10px; color:#5a5548; margin:6px 0 0;">Closed by ${escapeHtml(c.closed_by_name)} · ${escapeHtml(formatDbDate(c.closed_at))}</p>
    </div>
    <div class="z-signoff"><div>Cashier signature</div><div>Manager signature</div></div>` : ''}
  `;
})();

document.getElementById('print-btn').addEventListener('click', () => window.print());
document.getElementById('back-btn').addEventListener('click', () => {
  window.location.href = 'app.html#reports';
});
