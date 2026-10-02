const db = require('../db');

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function localDateStamp(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

function generateReceiptNo() {
  const settings = db.prepare('SELECT receipt_prefix FROM settings WHERE id = 1').get();
  const prefix = (settings && settings.receipt_prefix) || 'RCT';
  // Use the shop's local date, not UTC, so receipts issued just after
  // midnight local time aren't stamped with the previous day.
  const base = `${prefix}-${localDateStamp()}-`;

  // Continue from the highest sequence already used for this prefix+day.
  // (Counting LIKE matches instead treats "_" / "%" in a custom prefix as
  // wildcards, which can produce a duplicate receipt number.)
  const row = db.prepare(`
    SELECT MAX(CAST(substr(receipt_no, ?) AS INTEGER)) AS maxSeq
    FROM sales WHERE substr(receipt_no, 1, ?) = ?
  `).get(base.length + 1, base.length, base);

  const seq = String((row.maxSeq || 0) + 1).padStart(4, '0');
  return `${base}${seq}`;
}

/**
 * Validate a list of { name, qty, unit_price, product_id? } items.
 * Throws an Error with a user-facing message on the first problem found.
 */
function validateItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('At least one item is required');
  }
  for (const item of items) {
    if (!item.name || !String(item.name).trim()) {
      throw new Error('Every item needs a name');
    }
    if (!Number.isFinite(item.qty) || item.qty <= 0) {
      throw new Error(`Invalid quantity for "${item.name}"`);
    }
    if (!Number.isFinite(item.unit_price) || item.unit_price < 0) {
      throw new Error(`Invalid unit price for "${item.name}"`);
    }
    if (item.product_id != null && item.product_id !== '') {
      const product = db.prepare('SELECT 1 FROM products WHERE id = ?').get(Number(item.product_id));
      if (!product) throw new Error(`Product for "${item.name}" no longer exists`);
    }
  }
}

/**
 * Create a sale + its line items in one transaction, decrementing stock for
 * any tracked products referenced. Returns { id, receipt_no, total }.
 *
 * userId        - the user the sale is recorded under
 * customerName  - free text, may be blank
 * items         - [{ name, qty, unit_price, product_id? }]
 * discountType  - 'amount' | 'percent'
 * discountValue - number
 */
function createSale({ userId, customerName, items, discountType, discountValue }) {
  validateItems(items);

  const settings = db.prepare('SELECT tax_rate FROM settings WHERE id = 1').get();
  const taxRate = settings ? settings.tax_rate : 0;

  // Sum the rounded line totals (what's printed on the receipt) so the
  // subtotal always equals the sum of the lines shown above it.
  const subtotal = round2(items.reduce((sum, i) => sum + round2(i.qty * i.unit_price), 0));

  const dType = discountType === 'percent' ? 'percent' : 'amount';
  const dValue = Math.max(0, Number(discountValue) || 0);
  let discountAmount = dType === 'percent' ? (subtotal * dValue) / 100 : dValue;
  discountAmount = round2(Math.max(0, Math.min(discountAmount, subtotal)));

  const taxableAmount = subtotal - discountAmount;
  const taxAmount = round2((taxableAmount * taxRate) / 100);
  const total = round2(taxableAmount + taxAmount);

  const insertSale = db.prepare(`
    INSERT INTO sales (
      receipt_no, user_id, customer_name, subtotal,
      discount_type, discount_value, discount_amount,
      tax_rate, tax_amount, total
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertItem = db.prepare(`
    INSERT INTO sale_items (sale_id, name, qty, unit_price, line_total, product_id) VALUES (?, ?, ?, ?, ?, ?)
  `);
  const decrementStock = db.prepare(`
    UPDATE products SET stock_qty = stock_qty - ? WHERE id = ? AND track_stock = 1
  `);

  let receiptNo;
  const saleId = db.transaction(() => {
    // Generated inside the transaction so the number and the insert are atomic.
    receiptNo = generateReceiptNo();
    const info = insertSale.run(
      receiptNo, userId, String(customerName || '').trim(), subtotal,
      dType, dValue, discountAmount, taxRate, taxAmount, total
    );
    const id = info.lastInsertRowid;
    for (const item of items) {
      const productId = item.product_id ? Number(item.product_id) : null;
      insertItem.run(id, String(item.name).trim(), item.qty, item.unit_price, round2(item.qty * item.unit_price), productId);
      if (productId) decrementStock.run(item.qty, productId);
    }
    return id;
  })();

  return { id: saleId, receipt_no: receiptNo, total };
}

module.exports = { createSale, round2, generateReceiptNo, validateItems };
