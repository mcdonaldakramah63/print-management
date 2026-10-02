const db = require('../db');

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function generateReceiptNo() {
  const settings = db.prepare('SELECT receipt_prefix FROM settings WHERE id = 1').get();
  const prefix = (settings && settings.receipt_prefix) || 'RCT';
  const today = new Date();
  const datePart = today.toISOString().slice(0, 10).replace(/-/g, '');

  const row = db.prepare(`
    SELECT COUNT(*) AS count FROM sales WHERE receipt_no LIKE ?
  `).get(`${prefix}-${datePart}-%`);

  const seq = String(row.count + 1).padStart(4, '0');
  return `${prefix}-${datePart}-${seq}`;
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
    if (typeof item.qty !== 'number' || item.qty <= 0) {
      throw new Error(`Invalid quantity for "${item.name}"`);
    }
    if (typeof item.unit_price !== 'number' || item.unit_price < 0) {
      throw new Error(`Invalid unit price for "${item.name}"`);
    }
  }
}

/**
 * Create a sale + its line items in one transaction, decrementing stock for
 * any tracked products referenced. Returns { id, receipt_no, total }.
 *
 * userId        - the user (or the system "print-monitor" account) the sale is recorded under
 * customerName  - free text, may be blank
 * items         - [{ name, qty, unit_price, product_id? }]
 * discountType  - 'amount' | 'percent'
 * discountValue - number
 */
function createSale({ userId, customerName, items, discountType, discountValue }) {
  validateItems(items);

  const settings = db.prepare('SELECT tax_rate FROM settings WHERE id = 1').get();
  const taxRate = settings ? settings.tax_rate : 0;

  const subtotal = round2(items.reduce((sum, i) => sum + i.qty * i.unit_price, 0));

  const dType = discountType === 'percent' ? 'percent' : 'amount';
  const dValue = Number(discountValue) || 0;
  let discountAmount = dType === 'percent' ? (subtotal * dValue) / 100 : dValue;
  discountAmount = round2(Math.max(0, Math.min(discountAmount, subtotal)));

  const taxableAmount = subtotal - discountAmount;
  const taxAmount = round2((taxableAmount * taxRate) / 100);
  const total = round2(taxableAmount + taxAmount);

  const receiptNo = generateReceiptNo();

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

  const saleId = db.transaction(() => {
    const info = insertSale.run(
      receiptNo, userId, (customerName || '').trim(), subtotal,
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
