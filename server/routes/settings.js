const express = require('express');
const db = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();

router.get('/', requireAuth, (req, res) => {
  const settings = db.prepare('SELECT * FROM settings WHERE id = 1').get();
  res.json({ settings });
});

router.put('/', requireAdmin, (req, res) => {
  const {
    business_name, address, phone, email,
    logo_data_url, tax_rate, currency, footer_note, receipt_prefix
  } = req.body;

  if (typeof business_name !== 'string' || !business_name.trim()) {
    return res.status(400).json({ error: 'Business name is required' });
  }
  const rate = Number(tax_rate);
  if (Number.isNaN(rate) || rate < 0 || rate > 100) {
    return res.status(400).json({ error: 'Tax rate must be a number between 0 and 100' });
  }
  // The logo is rendered as an <img src> on every receipt, so only accept an
  // actual base64 image data URL (not arbitrary markup or a remote URL).
  if (logo_data_url && !/^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+$/i.test(logo_data_url)) {
    return res.status(400).json({ error: 'Logo must be an image file' });
  }

  db.prepare(`
    UPDATE settings SET
      business_name = ?, address = ?, phone = ?, email = ?,
      logo_data_url = ?, tax_rate = ?, currency = ?, footer_note = ?, receipt_prefix = ?
    WHERE id = 1
  `).run(
    business_name.trim(), address || '', phone || '', email || '',
    logo_data_url || '', rate, currency || 'GHS', footer_note || '', receipt_prefix || 'RCT'
  );

  res.json({ ok: true });
});

module.exports = router;
