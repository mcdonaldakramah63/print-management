const express = require('express');
const db = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { moveStock, insertMovement } = require('../lib/stock');

const router = express.Router();

// List products. By default only active ones (for the sale screen);
// pass ?all=1 to include inactive ones (for the admin product manager).
router.get('/', requireAuth, (req, res) => {
  const sql = req.query.all
    ? 'SELECT * FROM products ORDER BY name ASC'
    : 'SELECT * FROM products WHERE active = 1 ORDER BY name ASC';
  const products = db.prepare(sql).all();
  res.json({ products });
});

function numberOr(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// Shared validation for create/update. Returns { error } or { values }.
function parseProductBody(body, existingId) {
  const name = cleanText(body.name);
  if (!name) return { error: 'Product name is required' };

  const priceNum = Number(body.price);
  if (!Number.isFinite(priceNum) || priceNum < 0) {
    return { error: 'Price must be a non-negative number' };
  }
  if (body.cost_price !== undefined && body.cost_price !== null && body.cost_price !== '' &&
      !(Number.isFinite(Number(body.cost_price)) && Number(body.cost_price) >= 0)) {
    return { error: 'Cost price must be a non-negative number' };
  }

  const sku = cleanText(body.sku) || null;
  if (sku) {
    const existing = existingId
      ? db.prepare('SELECT 1 FROM products WHERE sku = ? AND id != ?').get(sku, existingId)
      : db.prepare('SELECT 1 FROM products WHERE sku = ?').get(sku);
    if (existing) return { error: 'A product with that SKU already exists', status: 409 };
  }

  return {
    values: {
      name,
      sku,
      category: cleanText(body.category),
      price: priceNum,
      stock_qty: numberOr(body.stock_qty, 0),
      // A reorder level of 0 is a valid choice ("never alert"), so only fall
      // back to the default when nothing usable was sent.
      reorder_level: numberOr(body.reorder_level, 5),
      track_stock: body.track_stock === false ? 0 : 1,
      // 'color' / 'mono' marks a print service: its quantity sold counts as
      // pages in the printed-vs-sold reconciliation.
      print_color_mode: body.print_color_mode === 'color' || body.print_color_mode === 'mono' ? body.print_color_mode : null,
      // Optional: what one unit costs you, for margin reports.
      cost_price: body.cost_price === '' || body.cost_price == null ? null : numberOr(body.cost_price, null)
    }
  };
}

router.post('/', requireAdmin, (req, res) => {
  const parsed = parseProductBody(req.body);
  if (parsed.error) return res.status(parsed.status || 400).json({ error: parsed.error });
  const v = parsed.values;

  const id = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO products (name, sku, category, price, stock_qty, reorder_level, track_stock, print_color_mode, cost_price)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(v.name, v.sku, v.category, v.price, v.track_stock ? v.stock_qty : 0, v.reorder_level, v.track_stock, v.print_color_mode, v.cost_price);
    if (v.track_stock && v.stock_qty) {
      insertMovement.run(info.lastInsertRowid, v.stock_qty, 'initial', null, req.session.user.id, '');
    }
    return info.lastInsertRowid;
  })();

  res.status(201).json({ id });
});

router.put('/:id', requireAdmin, (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });

  const parsed = parseProductBody(req.body, product.id);
  if (parsed.error) return res.status(parsed.status || 400).json({ error: parsed.error });
  const v = parsed.values;

  // Only change active status when the caller explicitly asks to; editing a
  // deactivated product's details shouldn't silently reactivate it.
  const active = typeof req.body.active === 'boolean' ? (req.body.active ? 1 : 0) : product.active;

  db.transaction(() => {
    db.prepare(`
      UPDATE products SET
        name = ?, sku = ?, category = ?, price = ?,
        reorder_level = ?, track_stock = ?, active = ?, print_color_mode = ?, cost_price = ?
      WHERE id = ?
    `).run(v.name, v.sku, v.category, v.price, v.reorder_level, v.track_stock, active, v.print_color_mode,
      req.body.cost_price === undefined ? product.cost_price : v.cost_price, product.id);
    // A changed stock count from the edit form is logged like any other
    // stock movement, so the history always adds up to the current level.
    const delta = v.stock_qty - product.stock_qty;
    if (v.track_stock && delta) {
      moveStock({ productId: product.id, delta, reason: 'edit', userId: req.session.user.id, note: 'Stock set in product editor' });
    }
  })();

  res.json({ ok: true });
});

router.patch('/:id/active', requireAdmin, (req, res) => {
  const info = db.prepare('UPDATE products SET active = ? WHERE id = ?').run(req.body.active ? 1 : 0, req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Product not found' });
  res.json({ ok: true });
});

// Manual stock adjustment (restock, correction) — admin only
router.post('/:id/adjust-stock', requireAdmin, (req, res) => {
  const delta = Number(req.body.delta);
  if (!Number.isFinite(delta)) {
    return res.status(400).json({ error: 'delta must be a number' });
  }
  const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Product not found' });
  if (!existing.track_stock) return res.status(400).json({ error: 'This product does not track stock' });
  db.transaction(() => {
    moveStock({ productId: existing.id, delta, reason: 'adjust', userId: req.session.user.id, note: req.body.note || '' });
  })();
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  res.json({ product });
});

// Stock history for one product, newest first
router.get('/:id/movements', requireAdmin, (req, res) => {
  const product = db.prepare('SELECT id, name, stock_qty FROM products WHERE id = ?').get(req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });
  const movements = db.prepare(`
    SELECT m.*, u.full_name AS user_name, s.receipt_no
    FROM stock_movements m
    LEFT JOIN users u ON u.id = m.user_id
    LEFT JOIN sales s ON s.id = m.sale_id
    WHERE m.product_id = ?
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT 200
  `).all(product.id);
  res.json({ product, movements });
});

module.exports = router;
