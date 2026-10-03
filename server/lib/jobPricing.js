// ---------------------------------------------------------------
// Job builder pricing
//
// A customer's job is a list of parts:
//   { type: 'print' | 'copy', pages, copies, color: 'mono' | 'color', sides: 1 | 2, paper: 'A4' | 'A3' | …, product_id? }
//   { type: 'item', product_id, qty }            binding, lamination, envelopes…
//   { type: 'custom', name, qty, unit_price }    anything not in the catalog
// Each print/copy part is priced from the shop's own print-service products
// (Products > Print service), so the builder always charges what the till
// charges:
//   * colour and kind (print or photocopy) must match; a photocopy falls back
//     to the print product of the same colour when there is no copy product;
//   * two-sided work uses a "both sides, per sheet" product when there is
//     one (charged per sheet), otherwise each side is charged as a page;
//   * paper size is matched on the product name ("A3 colour print"); plain
//     products count as A4.
// The server prices every job; the browser only shows the same quote.
// ---------------------------------------------------------------
const db = require('../db');

const SIZES = ['A3', 'A4', 'A5', 'A6', 'Letter', 'Legal'];
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const sizeOf = (name) => SIZES.find((s) => new RegExp(`\\b${s}\\b`, 'i').test(name)) || null;
const posInt = (v, max) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n >= 1 && n <= max ? n : null; };

function printProducts() {
  return db.prepare(`
    SELECT id, name, price, print_color_mode, print_kind, print_sides FROM products
    WHERE active = 1 AND print_color_mode IN ('color', 'mono')
  `).all();
}

/** The best print-service product for a part, and how it is charged. */
function matchProduct(part, products) {
  const want = { kind: part.type === 'copy' ? 'copy' : 'print', color: part.color === 'color' ? 'color' : 'mono', sides: part.sides === 2 ? 2 : 1, paper: part.paper || 'A4' };
  let best = null;
  for (const p of products) {
    if (p.print_color_mode !== want.color) continue;
    if (p.print_sides === 2 && want.sides === 1) continue; // never charge a one-sided page at the per-sheet price
    let score = 0;
    score += p.print_kind === want.kind ? 100 : 40;
    score += p.print_sides === want.sides ? 30 : 0;
    const size = sizeOf(p.name);
    if ((size || 'A4').toLowerCase() === want.paper.toLowerCase()) score += 50;
    else if (size) continue; // a different named size never matches
    else score -= 30; // unnamed size, asked for a non-A4 size: possible, but say so
    if (!best || score > best.score) best = { product: p, score, sizeGuess: !size && want.paper.toUpperCase() !== 'A4' };
  }
  return best;
}

function describe(part) {
  const bits = [`${part.pages} page${part.pages === 1 ? '' : 's'}`];
  if (part.copies > 1) bits.push(`× ${part.copies} copies`);
  if (part.sides === 2) bits.push('both sides');
  if (part.paper && part.paper !== 'A4') bits.push(part.paper);
  return bits.join(' ');
}

/**
 * Price a job. Returns { lines, subtotal, sheets, warnings, parts } where
 * parts are the cleaned inputs (stored with the job for editing).
 */
function quote(rawParts) {
  if (!Array.isArray(rawParts) || rawParts.length === 0) throw new Error('Add at least one part to the job.');
  if (rawParts.length > 30) throw new Error('A job can have at most 30 parts.');
  const products = printProducts();
  const byId = new Map(db.prepare('SELECT id, name, price, active FROM products').all().map((p) => [p.id, p]));
  const lines = [];
  const warnings = [];
  const parts = [];
  let sheets = 0;

  rawParts.forEach((raw, i) => {
    const n = i + 1;
    const type = String(raw && raw.type || '');
    if (type === 'print' || type === 'copy') {
      const part = {
        type,
        pages: posInt(raw.pages, 100000),
        copies: posInt(raw.copies ?? 1, 10000),
        color: raw.color === 'color' ? 'color' : 'mono',
        sides: Number(raw.sides) === 2 ? 2 : 1,
        paper: SIZES.find((s) => s.toLowerCase() === String(raw.paper || 'A4').toLowerCase()) || 'A4',
        product_id: raw.product_id ? Number(raw.product_id) : null
      };
      if (!part.pages) throw new Error(`Part ${n}: enter the number of pages.`);
      if (!part.copies) throw new Error(`Part ${n}: enter the number of copies.`);
      parts.push(part);
      const partSheets = (part.sides === 2 ? Math.ceil(part.pages / 2) : part.pages) * part.copies;
      sheets += partSheets;

      let product = null;
      let perSheet = false;
      if (part.product_id) {
        product = products.find((p) => p.id === part.product_id) || null;
        if (!product) warnings.push(`Part ${n}: the chosen product is no longer a print service; picked the best match instead.`);
      }
      if (!product) {
        const m = matchProduct(part, products);
        if (m) {
          product = m.product;
          if (m.sizeGuess) warnings.push(`Part ${n}: no ${part.paper} product, so the ${product.name} price is used. Check it.`);
        }
      }
      if (!product) {
        warnings.push(`Part ${n}: no ${part.color === 'color' ? 'colour' : 'B&W'} ${type === 'copy' ? 'photocopy' : 'print'} product. Mark one under Products > Print service, or add a custom line.`);
        return;
      }
      perSheet = product.print_sides === 2;
      if (part.sides === 2 && !perSheet) warnings.push(`Part ${n}: no "both sides" product for this, so each side is charged as a page.`);
      const qty = perSheet ? partSheets : part.pages * part.copies;
      lines.push({ part: i, product_id: product.id, name: `${product.name} (${describe(part)})`, qty, unit_price: product.price, line_total: round2(qty * product.price) });
    } else if (type === 'item') {
      const product = byId.get(Number(raw.product_id));
      const qty = Number(raw.qty);
      if (!product) throw new Error(`Part ${n}: choose a product.`);
      if (!(qty > 0) || qty > 100000) throw new Error(`Part ${n}: enter a quantity.`);
      if (!product.active) warnings.push(`Part ${n}: ${product.name} is no longer sold.`);
      parts.push({ type, product_id: product.id, qty });
      lines.push({ part: i, product_id: product.id, name: product.name, qty, unit_price: product.price, line_total: round2(qty * product.price) });
    } else if (type === 'custom') {
      const name = String(raw.name || '').trim().slice(0, 120);
      const qty = Number(raw.qty);
      const price = Number(raw.unit_price);
      if (!name) throw new Error(`Part ${n}: name the extra item.`);
      if (!(qty > 0) || qty > 100000) throw new Error(`Part ${n}: enter a quantity.`);
      if (!(price >= 0) || price > 1e7) throw new Error(`Part ${n}: enter a price.`);
      parts.push({ type, name, qty, unit_price: round2(price) });
      lines.push({ part: i, product_id: null, name, qty, unit_price: round2(price), line_total: round2(qty * price) });
    } else {
      throw new Error(`Part ${n}: unknown kind of work.`);
    }
  });

  return { lines, subtotal: round2(lines.reduce((s, l) => s + l.line_total, 0)), sheets, warnings, parts };
}

module.exports = { quote, matchProduct, SIZES };
