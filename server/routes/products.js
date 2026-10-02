const express = require('express');
const db = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');

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
      track_stock: body.track_stock === false ? 0 : 1
    }
  };
}

router.post('/', requireAdmin, (req, res) => {
  const parsed = parseProductBody(req.body);
  if (parsed.error) return res.status(parsed.status || 400).json({ error: parsed.error });
  const v = parsed.values;

  const info = db.prepare(`
    INSERT INTO products (name, sku, category, price, stock_qty, reorder_level, track_stock)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(v.name, v.sku, v.category, v.price, v.stock_qty, v.reorder_level, v.track_stock);

  res.status(201).json({ id: info.lastInsertRowid });
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

  db.prepare(`
    UPDATE products SET
      name = ?, sku = ?, category = ?, price = ?, stock_qty = ?,
      reorder_level = ?, track_stock = ?, active = ?
    WHERE id = ?
  `).run(v.name, v.sku, v.category, v.price, v.stock_qty, v.reorder_level, v.track_stock, active, product.id);

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
  const info = db.prepare('UPDATE products SET stock_qty = stock_qty + ? WHERE id = ?').run(delta, req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Product not found' });
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  res.json({ product });
});

module.exports = router;
