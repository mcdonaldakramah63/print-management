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

function normalizePrintColorMode(value) {
  if (value === 'color' || value === 'mono') return value;
  return null; // not a print-billing product
}

router.post('/', requireAdmin, (req, res) => {
  const { name, sku, category, price, stock_qty, reorder_level, track_stock, print_color_mode } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Product name is required' });
  }
  const priceNum = Number(price);
  if (Number.isNaN(priceNum) || priceNum < 0) {
    return res.status(400).json({ error: 'Price must be a non-negative number' });
  }

  if (sku && sku.trim()) {
    const existing = db.prepare('SELECT 1 FROM products WHERE sku = ?').get(sku.trim());
    if (existing) return res.status(409).json({ error: 'A product with that SKU already exists' });
  }

  const info = db.prepare(`
    INSERT INTO products (name, sku, category, price, stock_qty, reorder_level, track_stock, print_color_mode)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    name.trim(),
    sku && sku.trim() ? sku.trim() : null,
    (category || '').trim(),
    priceNum,
    Number(stock_qty) || 0,
    Number(reorder_level) || 5,
    track_stock === false ? 0 : 1,
    normalizePrintColorMode(print_color_mode)
  );

  res.status(201).json({ id: info.lastInsertRowid });
});

router.put('/:id', requireAdmin, (req, res) => {
  const { name, sku, category, price, stock_qty, reorder_level, track_stock, active, print_color_mode } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Product name is required' });
  }
  const priceNum = Number(price);
  if (Number.isNaN(priceNum) || priceNum < 0) {
    return res.status(400).json({ error: 'Price must be a non-negative number' });
  }

  if (sku && sku.trim()) {
    const existing = db.prepare('SELECT 1 FROM products WHERE sku = ? AND id != ?').get(sku.trim(), req.params.id);
    if (existing) return res.status(409).json({ error: 'A product with that SKU already exists' });
  }

  db.prepare(`
    UPDATE products SET
      name = ?, sku = ?, category = ?, price = ?, stock_qty = ?,
      reorder_level = ?, track_stock = ?, active = ?, print_color_mode = ?
    WHERE id = ?
  `).run(
    name.trim(),
    sku && sku.trim() ? sku.trim() : null,
    (category || '').trim(),
    priceNum,
    Number(stock_qty) || 0,
    Number(reorder_level) || 5,
    track_stock === false ? 0 : 1,
    active === false ? 0 : 1,
    normalizePrintColorMode(print_color_mode),
    req.params.id
  );

  res.json({ ok: true });
});

router.patch('/:id/active', requireAdmin, (req, res) => {
  db.prepare('UPDATE products SET active = ? WHERE id = ?').run(req.body.active ? 1 : 0, req.params.id);
  res.json({ ok: true });
});

// Manual stock adjustment (restock, correction) — admin only
router.post('/:id/adjust-stock', requireAdmin, (req, res) => {
  const delta = Number(req.body.delta);
  if (Number.isNaN(delta)) {
    return res.status(400).json({ error: 'delta must be a number' });
  }
  db.prepare('UPDATE products SET stock_qty = stock_qty + ? WHERE id = ?').run(delta, req.params.id);
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  res.json({ product });
});

module.exports = router;
