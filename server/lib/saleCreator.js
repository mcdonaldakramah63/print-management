const db = require('../db');
const { moveStock } = require('./stock');
const { localDateString } = require('./dates');

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function generateReceiptNo() {
  const settings = db.prepare('SELECT receipt_prefix FROM settings WHERE id = 1').get();
  const prefix = (settings && settings.receipt_prefix) || 'RCT';
  // Use the shop's local date, not UTC, so receipts issued just after
  // midnight local time aren't stamped with the previous day.
  const base = `${prefix}-${localDateString().replace(/-/g, '')}-`;

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

const PAYMENT_METHODS = ['cash', 'momo', 'card'];

function isDayClosed(date) {
  return !!db.prepare('SELECT 1 FROM day_closings WHERE business_date = ?').get(date);
}

/**
 * Create a sale + its line items in one transaction, decrementing (and
 * logging) stock for any tracked products referenced.
 * Returns { id, receipt_no, total, change_due }.
 *
 * userId         - the user the sale is recorded under
 * customerName   - free text, may be blank
 * customerPhone  - free text, may be blank
 * items          - [{ name, qty, unit_price, product_id? }]
 * discountType   - 'amount' | 'percent'
 * discountValue  - number
 * paymentMethod  - 'cash' | 'momo' | 'card' (default cash)
 * amountTendered - cash handed over (cash only, optional; must cover the total)
 * printSessionIds - client print sessions this sale bills (optional)
 * copyEventIds   - detected photocopy runs this sale bills (optional)
 * jobIds         - job builder orders this sale pays for (optional)
 */
function createSale({
  userId, customerName, customerPhone, items, discountType, discountValue,
  paymentMethod, amountTendered, printSessionIds, copyEventIds, jobIds
}) {
  validateItems(items);
  const sessionIds = Array.isArray(printSessionIds) ? [...new Set(printSessionIds.map(Number))] : [];
  if (sessionIds.some((id) => !Number.isInteger(id))) throw new Error('Invalid print session');
  const copyIds = Array.isArray(copyEventIds) ? [...new Set(copyEventIds.map(Number))] : [];
  if (copyIds.some((id) => !Number.isInteger(id))) throw new Error('Invalid photocopy run');
  const orderIds = Array.isArray(jobIds) ? [...new Set(jobIds.map(Number))] : [];
  if (orderIds.some((id) => !Number.isInteger(id))) throw new Error('Invalid job');

  if (isDayClosed(localDateString())) {
    throw new Error('Today has already been closed. An admin must reopen it in Reports before more sales can be recorded.');
  }

  const method = paymentMethod == null || paymentMethod === '' ? 'cash' : paymentMethod;
  if (!PAYMENT_METHODS.includes(method)) {
    throw new Error('Payment method must be cash, momo or card');
  }

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

  let tendered = null;
  let changeDue = null;
  if (method === 'cash' && amountTendered != null && amountTendered !== '') {
    tendered = round2(Number(amountTendered));
    if (!Number.isFinite(tendered) || tendered < total) {
      throw new Error('Amount tendered is less than the total');
    }
    changeDue = round2(tendered - total);
  }

  const insertSale = db.prepare(`
    INSERT INTO sales (
      receipt_no, user_id, customer_name, customer_phone, subtotal,
      discount_type, discount_value, discount_amount,
      tax_rate, tax_amount, total, payment_method, amount_tendered, change_due
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertItem = db.prepare(`
    INSERT INTO sale_items (sale_id, name, qty, unit_price, line_total, product_id, unit_cost) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const productCost = db.prepare('SELECT cost_price FROM products WHERE id = ?');

  const linkSession = db.prepare(`
    UPDATE print_sessions SET sale_id = ?, billed_at = datetime('now') WHERE id = ? AND sale_id IS NULL
  `);

  const linkCopies = db.prepare(`
    UPDATE copy_events SET status = 'billed', sale_id = ?, billed_at = datetime('now') WHERE id = ? AND status = 'open'
  `);

  // A job is paid for once; one that is ready is handed over with the sale.
  const linkJob = db.prepare(`
    UPDATE jobs SET sale_id = ?, updated_at = datetime('now'),
      collected_at = CASE WHEN status = 'ready' THEN datetime('now') ELSE collected_at END,
      status = CASE WHEN status = 'ready' THEN 'collected' ELSE status END
    WHERE id = ? AND sale_id IS NULL AND status != 'cancelled'
  `);

  let receiptNo;
  const saleId = db.transaction(() => {
    // Generated inside the transaction so the number and the insert are atomic.
    receiptNo = generateReceiptNo();
    const info = insertSale.run(
      receiptNo, userId, String(customerName || '').trim().slice(0, 200),
      String(customerPhone || '').trim().slice(0, 40), subtotal,
      dType, dValue, discountAmount, taxRate, taxAmount, total, method, tendered, changeDue
    );
    const id = info.lastInsertRowid;
    for (const item of items) {
      const productId = item.product_id ? Number(item.product_id) : null;
      const cost = productId ? productCost.get(productId) : null;
      insertItem.run(id, String(item.name).trim(), item.qty, item.unit_price, round2(item.qty * item.unit_price), productId,
        cost && cost.cost_price != null ? cost.cost_price : null);
      if (productId) moveStock({ productId, delta: -item.qty, reason: 'sale', saleId: id, userId });
    }
    // Print sessions rung up in this sale are marked billed; a session can
    // only be billed once, so two tills can't charge the same client twice.
    for (const sessionId of sessionIds) {
      const linked = linkSession.run(id, sessionId);
      if (linked.changes === 0) throw new Error('That print session was already billed or no longer exists');
    }
    for (const copyId of copyIds) {
      if (linkCopies.run(id, copyId).changes === 0) throw new Error('Those photocopies were already billed or dismissed');
    }
    for (const jobId of orderIds) {
      if (linkJob.run(id, jobId).changes === 0) throw new Error('That job was already paid for or was cancelled');
    }
    return id;
  })();

  return { id: saleId, receipt_no: receiptNo, total, change_due: changeDue };
}

module.exports = { createSale, round2, generateReceiptNo, validateItems, isDayClosed, PAYMENT_METHODS };
