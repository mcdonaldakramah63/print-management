const db = require('../db');

const insertMovement = db.prepare(`
  INSERT INTO stock_movements (product_id, delta, reason, sale_id, user_id, note)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const applyDelta = db.prepare(`
  UPDATE products SET stock_qty = stock_qty + ? WHERE id = ? AND track_stock = 1
`);

/**
 * Change a tracked product's stock and log why. No-op (nothing logged) for
 * products that don't track stock. Call inside the caller's transaction.
 */
function moveStock({ productId, delta, reason, saleId = null, userId = null, note = '' }) {
  if (!productId || !delta) return;
  const info = applyDelta.run(delta, productId);
  if (info.changes > 0) {
    insertMovement.run(productId, delta, reason, saleId, userId, String(note).slice(0, 300));
  }
  // Stock changed: re-check low-stock alerts shortly (lazy require: no cycle).
  require('./notifications').soon();
}

module.exports = { moveStock, insertMovement };
