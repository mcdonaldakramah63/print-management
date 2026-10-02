// Minimal RFC 4180 CSV writer. Cells starting with = + - @ are prefixed with
// a quote so spreadsheet apps don't execute them as formulas.
function csvCell(value) {
  if (value === null || value === undefined) return '';
  let str = String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(str)) str = `'${str}`;
  return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function toCsv(headers, rows) {
  const lines = [headers.map(csvCell).join(',')];
  for (const row of rows) lines.push(row.map(csvCell).join(','));
  return lines.join('\r\n') + '\r\n';
}

function sendCsv(res, filename, headers, rows) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  // BOM so Excel opens UTF-8 (currency symbols, names) correctly.
  res.send('﻿' + toCsv(headers, rows));
}

module.exports = { toCsv, sendCsv };
