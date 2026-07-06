// ============================================================================
// TodayBread Backend — single-file version
// Inventory, sales, offline-sync, owner/staff auth, reports/insights,
// and the daily WhatsApp summary job — all in one file for simplicity.
//
// Setup:
//   npm install express pg bcryptjs jsonwebtoken cors dotenv node-cron
//   cp .env.example .env   (fill in DATABASE_URL, JWT_SECRET, WHATSAPP_*)
//   node main.js -- migrate     (run once, to create tables)
//   node main.js                (starts the server)
// ============================================================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cron = require('node-cron');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false },
});

// ----------------------------------------------------------------------------
// SCHEMA — run once with: node main.js migrate
// ----------------------------------------------------------------------------
const SCHEMA_SQL = `
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS businesses (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  whatsapp_number TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,
  pin_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'staff')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS inventory_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  sku TEXT NOT NULL,
  name TEXT NOT NULL,
  size TEXT,
  category TEXT,
  cost_price NUMERIC(12,2) NOT NULL DEFAULT 0,
  sale_price NUMERIC(12,2) NOT NULL DEFAULT 0,
  stock INTEGER NOT NULL DEFAULT 0,
  reorder_level INTEGER NOT NULL DEFAULT 0,
  origin TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, sku)
);

CREATE TABLE IF NOT EXISTS sales (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES inventory_items(id),
  staff_user_id UUID NOT NULL REFERENCES users(id),
  qty INTEGER NOT NULL CHECK (qty > 0),
  unit_price NUMERIC(12,2) NOT NULL,
  unit_cost NUMERIC(12,2) NOT NULL,
  payment_method TEXT NOT NULL CHECK (payment_method IN ('Cash', 'Transfer', 'POS')),
  client_uuid UUID NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, client_uuid)
);

CREATE INDEX IF NOT EXISTS idx_sales_business_time ON sales (business_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_inventory_business ON inventory_items (business_id);
CREATE INDEX IF NOT EXISTS idx_users_business ON users (business_id);
`;

async function migrate() {
  await pool.query(SCHEMA_SQL);
  console.log('✓ Schema applied successfully');
  await pool.end();
}

if (process.argv.includes('migrate')) {
  migrate().catch((err) => { console.error('Migration failed:', err.message); process.exit(1); });
  return;
}

// ----------------------------------------------------------------------------
// AUTH HELPERS
// ----------------------------------------------------------------------------
function signToken(user) {
  return jwt.sign(
    { userId: user.id, businessId: user.business_id, role: user.role, name: user.name },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '30d' }
  );
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing auth token' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireOwner(req, res, next) {
  if (req.user?.role !== 'owner') return res.status(403).json({ error: 'Owner access required' });
  next();
}

// ----------------------------------------------------------------------------
// WHATSAPP HELPER
// ----------------------------------------------------------------------------
function naira(n) { return '₦' + Math.round(n).toLocaleString('en-NG'); }

async function sendWhatsAppTemplate(toNumber, params) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const templateName = process.env.WHATSAPP_TEMPLATE_NAME || 'daily_summary';

  if (!token || !phoneNumberId) {
    console.warn('[whatsapp] credentials not set — skipping send. Params were:', params);
    return { skipped: true };
  }

  const url = `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`;
  const body = {
    messaging_product: 'whatsapp',
    to: toNumber,
    type: 'template',
    template: {
      name: templateName,
      language: { code: 'en_US' },
      components: [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text: String(text) })) }],
    },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    console.error('[whatsapp] send failed:', data);
    throw new Error(data?.error?.message || 'WhatsApp send failed');
  }
  return data;
}

async function buildDailySummary(businessId) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const salesResult = await pool.query(
    `SELECT s.qty, s.unit_price, i.name AS item_name
     FROM sales s JOIN inventory_items i ON i.id = s.item_id
     WHERE s.business_id = $1 AND s.occurred_at >= $2`,
    [businessId, today]
  );
  const revenue = salesResult.rows.reduce((sum, r) => sum + r.qty * r.unit_price, 0);
  const tally = {};
  salesResult.rows.forEach((r) => { tally[r.item_name] = (tally[r.item_name] || 0) + r.qty; });
  const topSeller = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];

  const lowStockResult = await pool.query(
    'SELECT count(*) FROM inventory_items WHERE business_id = $1 AND stock <= reorder_level',
    [businessId]
  );

  return {
    revenue,
    topSellerName: topSeller ? topSeller[0] : 'No sales yet',
    lowStockCount: Number(lowStockResult.rows[0].count),
  };
}

async function runDailySummaries() {
  const businesses = await pool.query('SELECT id, name, whatsapp_number FROM businesses WHERE whatsapp_number IS NOT NULL');
  for (const business of businesses.rows) {
    try {
      const summary = await buildDailySummary(business.id);
      const dashboardUrl = process.env.DASHBOARD_URL || 'https://your-app-url.com';
      await sendWhatsAppTemplate(business.whatsapp_number, [
        business.name, naira(summary.revenue), summary.topSellerName, summary.lowStockCount, dashboardUrl,
      ]);
      console.log(`[whatsapp] daily summary sent for ${business.name}`);
    } catch (err) {
      console.error(`[whatsapp] failed for business ${business.id}:`, err.message);
    }
  }
}

function scheduleDailySummaryJob() {
  const hour = process.env.DAILY_SUMMARY_HOUR || '21';
  const minute = process.env.DAILY_SUMMARY_MINUTE || '0';
  const timezone = process.env.BUSINESS_TIMEZONE || 'Africa/Lagos';
  cron.schedule(`${minute} ${hour} * * *`, runDailySummaries, { timezone });
  console.log(`[whatsapp] daily summary job scheduled for ${hour}:${minute} (${timezone})`);
}

// ----------------------------------------------------------------------------
// EXPRESS APP
// ----------------------------------------------------------------------------
const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true }));

// --- AUTH ---
function generateSlug(name) {
  const base = name.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return base || 'shop-' + Date.now();
}

app.post('/auth/signup', async (req, res) => {
  const { businessName, ownerName, phone, pin, whatsappNumber, address } = req.body;
  if (!businessName || !ownerName || !phone || !pin) {
    return res.status(400).json({ error: 'businessName, ownerName, phone, and pin are required' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Generate a unique slug
    let slug = generateSlug(businessName);
    const existing = await client.query('SELECT id FROM businesses WHERE slug = $1', [slug]);
    if (existing.rows.length > 0) slug = slug + '-' + Date.now();

    const biz = await client.query(
      'INSERT INTO businesses (name, whatsapp_number, address, slug) VALUES ($1, $2, $3, $4) RETURNING *',
      [businessName, whatsappNumber || phone, address || null, slug]
    );
    const pinHash = await bcrypt.hash(pin, 10);
    const userRes = await client.query(
      `INSERT INTO users (business_id, name, phone, pin_hash, role) VALUES ($1,$2,$3,$4,'owner') RETURNING *`,
      [biz.rows[0].id, ownerName, phone, pinHash]
    );
    await client.query('COMMIT');
    const owner = userRes.rows[0];
    res.status(201).json({ token: signToken(owner), business: biz.rows[0], user: { id: owner.id, name: owner.name, role: owner.role } });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: 'Phone number already registered' });
    console.error(err);
    res.status(500).json({ error: 'Signup failed' });
  } finally {
    client.release();
  }
});

// Public catalogue endpoint — no auth required
app.get('/catalogue/:slug', async (req, res) => {
  try {
    const bizResult = await pool.query(
      'SELECT id, name, address, whatsapp_number, slug FROM businesses WHERE slug = $1',
      [req.params.slug]
    );
    if (!bizResult.rows[0]) return res.status(404).json({ error: 'Business not found' });
    const business = bizResult.rows[0];
    const itemsResult = await pool.query(
      `SELECT name, brand, category, size, sale_price, origin
       FROM inventory_items
       WHERE business_id = $1 AND is_public = true AND stock > 0
       ORDER BY category, name`,
      [business.id]
    );
    res.json({ business, items: itemsResult.rows });
  } catch (err) {
    console.error('[/catalogue/:slug]', err.message);
    res.status(500).json({ error: 'Could not load catalogue' });
  }
});

// PATCH /inventory/:id/visibility — owner toggles public/private per item
app.patch('/inventory/:id/visibility', requireAuth, requireOwner, async (req, res) => {
  const { isPublic } = req.body;
  try {
    const result = await pool.query(
      'UPDATE inventory_items SET is_public = $1, updated_at = now() WHERE id = $2 AND business_id = $3 RETURNING id, is_public',
      [!!isPublic, req.params.id, req.user.businessId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Item not found' });
    res.json({ id: result.rows[0].id, isPublic: result.rows[0].is_public });
  } catch (err) {
    console.error('[/inventory/visibility]', err.message);
    res.status(500).json({ error: 'Could not update visibility' });
  }
});


app.post('/auth/login', async (req, res) => {
  const { phone, pin } = req.body;
  if (!phone || !pin) return res.status(400).json({ error: 'phone and pin are required' });
  try {
    const result = await pool.query('SELECT * FROM users WHERE phone = $1', [phone]);
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(pin, user.pin_hash))) {
      return res.status(401).json({ error: 'Invalid phone or PIN' });
    }
    res.json({ token: signToken(user), user: { id: user.id, name: user.name, role: user.role, businessId: user.business_id } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/auth/staff', requireAuth, requireOwner, async (req, res) => {
  const { name, phone, pin } = req.body;
  if (!name || !phone || !pin) return res.status(400).json({ error: 'name, phone, and pin are required' });
  try {
    const pinHash = await bcrypt.hash(pin, 10);
    const result = await pool.query(
      `INSERT INTO users (business_id, name, phone, pin_hash, role) VALUES ($1,$2,$3,$4,'staff') RETURNING id, name, phone, role`,
      [req.user.businessId, name, phone, pinHash]
    );
    res.status(201).json({ user: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Phone number already registered' });
    console.error(err);
    res.status(500).json({ error: 'Could not create staff account' });
  }
});

app.get('/auth/staff', requireAuth, requireOwner, async (req, res) => {
  const result = await pool.query(
    'SELECT id, name, phone, role, created_at FROM users WHERE business_id = $1 AND role = $2',
    [req.user.businessId, 'staff']
  );
  res.json({ staff: result.rows });
});

// GET /me — who's logged in and which business they belong to (frontend uses this right after login)
// POST /auth/reset-pin — owner resets a staff member's PIN, or any user resets their own
app.post('/auth/reset-pin', requireAuth, async (req, res) => {
  const { userId, newPin } = req.body;
  if (!newPin || newPin.length < 4) return res.status(400).json({ error: 'New PIN must be at least 4 digits' });

  // owner can reset any staff in their business; staff can only reset themselves
  const targetId = userId || req.user.userId;
  if (targetId !== req.user.userId && req.user.role !== 'owner') {
    return res.status(403).json({ error: 'Only the owner can reset another user\'s PIN' });
  }

  try {
    // confirm the target user belongs to the same business
    const check = await pool.query('SELECT id FROM users WHERE id = $1 AND business_id = $2', [targetId, req.user.businessId]);
    if (check.rows.length === 0) return res.status(404).json({ error: 'User not found in this business' });

    const pinHash = await bcrypt.hash(String(newPin), 10);
    await pool.query('UPDATE users SET pin_hash = $1 WHERE id = $2', [pinHash, targetId]);
    res.json({ reset: true });
  } catch (err) {
    console.error('[/auth/reset-pin] error:', err.message);
    res.status(500).json({ error: 'Could not reset PIN' });
  }
});

app.get('/me', requireAuth, async (req, res) => {
  const business = await pool.query('SELECT id, name, address, whatsapp_number, created_at FROM businesses WHERE id = $1', [req.user.businessId]);
  res.json({
    user: { id: req.user.userId, name: req.user.name, role: req.user.role },
    business: business.rows[0] || null,
  });
});

// --- INVENTORY ---
app.get('/inventory', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM inventory_items WHERE business_id = $1 ORDER BY category, name', [req.user.businessId]);
    const items = req.user.role === 'owner'
      ? result.rows
      : result.rows.map(({ cost_price, warehouse_stock, ...rest }) => rest); // staff don't see cost or warehouse
    res.json({ items });
  } catch (err) {
    console.error('[/inventory] error:', err.message);
    res.status(500).json({ error: 'Could not load inventory right now, please retry' });
  }
});

app.post('/inventory', requireAuth, requireOwner, async (req, res) => {
  const { sku, name, size, category, costPrice, salePrice, stock, warehouseStock, reorderLevel, origin, brand } = req.body;
  if (!sku || !name) return res.status(400).json({ error: 'sku and name are required' });
  try {
    const result = await pool.query(
      `INSERT INTO inventory_items (business_id, sku, name, size, category, brand, cost_price, sale_price, stock, warehouse_stock, reorder_level, origin)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [req.user.businessId, sku, name, size, category, brand || '', costPrice || 0, salePrice || 0, stock || 0, warehouseStock || 0, reorderLevel || 0, origin]
    );
    res.status(201).json({ item: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'SKU already exists for this business' });
    console.error(err);
    res.status(500).json({ error: 'Could not create item' });
  }
});

app.put('/inventory/:id', requireAuth, requireOwner, async (req, res) => {
  const fields = ['name', 'size', 'category', 'brand', 'cost_price', 'sale_price', 'stock', 'warehouse_stock', 'reorder_level', 'origin'];
  const map = { costPrice: 'cost_price', salePrice: 'sale_price', reorderLevel: 'reorder_level', warehouseStock: 'warehouse_stock' };
  const updates = []; const values = []; let i = 1;
  for (const [key, val] of Object.entries(req.body)) {
    const col = map[key] || key;
    if (fields.includes(col)) { updates.push(`${col} = $${i++}`); values.push(val); }
  }
  if (updates.length === 0) return res.status(400).json({ error: 'No valid fields to update' });
  values.push(req.params.id, req.user.businessId);
  const result = await pool.query(
    `UPDATE inventory_items SET ${updates.join(', ')}, updated_at = now() WHERE id = $${i++} AND business_id = $${i} RETURNING *`,
    values
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'Item not found' });
  res.json({ item: result.rows[0] });
});

app.delete('/inventory/:id', requireAuth, requireOwner, async (req, res) => {
  const result = await pool.query('DELETE FROM inventory_items WHERE id = $1 AND business_id = $2 RETURNING id', [req.params.id, req.user.businessId]);
  if (result.rows.length === 0) return res.status(404).json({ error: 'Item not found' });
  res.json({ deleted: true });
});

// --- SALES ---
async function recordSale(client, businessId, staffUserId, { itemId, qty, paymentMethod, clientUuid, occurredAt }) {
  const itemResult = await client.query('SELECT * FROM inventory_items WHERE id = $1 AND business_id = $2 FOR UPDATE', [itemId, businessId]);
  const item = itemResult.rows[0];
  if (!item) return { error: 'Item not found', status: 404 };
  if (item.stock < qty) return { error: `Not enough stock for ${item.name}`, status: 409 };

  const saleResult = await client.query(
    `INSERT INTO sales (business_id, item_id, staff_user_id, qty, unit_price, unit_cost, payment_method, client_uuid, occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (business_id, client_uuid) DO NOTHING RETURNING *`,
    [businessId, itemId, staffUserId, qty, item.sale_price, item.cost_price, paymentMethod, clientUuid, occurredAt || new Date()]
  );
  if (saleResult.rows.length === 0) return { duplicate: true, item };

  const updatedItem = await client.query('UPDATE inventory_items SET stock = stock - $1, updated_at = now() WHERE id = $2 RETURNING *', [qty, itemId]);
  return { sale: saleResult.rows[0], item: updatedItem.rows[0] };
}

app.post('/sales', requireAuth, async (req, res) => {
  const { itemId, qty, paymentMethod, clientUuid } = req.body;
  if (!itemId || !qty || !paymentMethod || !clientUuid) {
    return res.status(400).json({ error: 'itemId, qty, paymentMethod, and clientUuid are required' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await recordSale(client, req.user.businessId, req.user.userId, req.body);
    if (result.error) { await client.query('ROLLBACK'); return res.status(result.status).json({ error: result.error }); }
    await client.query('COMMIT');
    res.status(201).json(result);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Could not record sale' });
  } finally {
    client.release();
  }
});

app.post('/sales/sync', requireAuth, async (req, res) => {
  const { sales } = req.body;
  if (!Array.isArray(sales) || sales.length === 0) return res.status(400).json({ error: 'sales must be a non-empty array' });
  const results = [];
  for (const saleInput of sales) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await recordSale(client, req.user.businessId, req.user.userId, saleInput);
      if (result.error) {
        await client.query('ROLLBACK');
        results.push({ clientUuid: saleInput.clientUuid, status: 'failed', error: result.error });
      } else {
        await client.query('COMMIT');
        results.push({ clientUuid: saleInput.clientUuid, status: result.duplicate ? 'already-synced' : 'synced' });
      }
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(err);
      results.push({ clientUuid: saleInput.clientUuid, status: 'failed', error: 'Server error' });
    } finally {
      client.release();
    }
  }
  const inventory = await pool.query('SELECT * FROM inventory_items WHERE business_id = $1', [req.user.businessId]);
  res.json({ results, inventory: inventory.rows });
});

app.get('/sales', requireAuth, async (req, res) => {
  try {
    const { since, until } = req.query;
    const conditions = ['s.business_id = $1']; const values = [req.user.businessId]; let i = 2;
    if (since) { conditions.push(`s.occurred_at >= $${i++}`); values.push(since); }
    if (until) { conditions.push(`s.occurred_at <= $${i++}`); values.push(until); }
    const result = await pool.query(
      `SELECT s.*, i.name AS item_name, i.category FROM sales s JOIN inventory_items i ON i.id = s.item_id
       WHERE ${conditions.join(' AND ')} ORDER BY s.occurred_at DESC`,
      values
    );
    res.json({ sales: result.rows });
  } catch (err) {
    console.error('[/sales] error:', err.message);
    res.status(500).json({ error: 'Could not load sales right now, please retry' });
  }
});

// --- REPORTS / INSIGHTS ---
function rangeToSince(range) {
  const now = new Date();
  if (range === 'today') { now.setHours(0, 0, 0, 0); return now; }
  if (range === '7d') { now.setDate(now.getDate() - 7); return now; }
  if (range === '30d') { now.setDate(now.getDate() - 30); return now; }
  return null;
}

app.get('/reports/summary', requireAuth, requireOwner, async (req, res) => {
  const since = rangeToSince(req.query.range || 'today');
  const conditions = ['business_id = $1']; const values = [req.user.businessId];
  if (since) { conditions.push('occurred_at >= $2'); values.push(since); }
  const result = await pool.query(`SELECT qty, unit_price, unit_cost, payment_method FROM sales WHERE ${conditions.join(' AND ')}`, values);

  let revenue = 0, cost = 0; const byPayment = {};
  for (const row of result.rows) {
    const rev = row.qty * row.unit_price;
    revenue += rev; cost += row.qty * row.unit_cost;
    byPayment[row.payment_method] = (byPayment[row.payment_method] || 0) + rev;
  }
  const profit = revenue - cost;
  res.json({ revenue, cost, profit, margin: revenue > 0 ? (profit / revenue) * 100 : 0, byPayment, transactionCount: result.rows.length });
});

app.get('/reports/insights', requireAuth, requireOwner, async (req, res) => {
  const businessId = req.user.businessId;
  const now = new Date();
  const sevenAgo = new Date(now); sevenAgo.setDate(sevenAgo.getDate() - 7);
  const fourteenAgo = new Date(now); fourteenAgo.setDate(fourteenAgo.getDate() - 14);

  const inventory = (await pool.query('SELECT * FROM inventory_items WHERE business_id = $1', [businessId])).rows;
  const thisWeek = (await pool.query('SELECT item_id, qty, unit_price FROM sales WHERE business_id = $1 AND occurred_at >= $2', [businessId, sevenAgo])).rows;
  const lastWeek = (await pool.query('SELECT qty, unit_price FROM sales WHERE business_id = $1 AND occurred_at >= $2 AND occurred_at < $3', [businessId, fourteenAgo, sevenAgo])).rows;
  const last14 = (await pool.query('SELECT DISTINCT item_id FROM sales WHERE business_id = $1 AND occurred_at >= $2', [businessId, fourteenAgo])).rows;

  const revThis = thisWeek.reduce((s, r) => s + r.qty * r.unit_price, 0);
  const revLast = lastWeek.reduce((s, r) => s + r.qty * r.unit_price, 0);
  const pctChange = revLast > 0 ? ((revThis - revLast) / revLast) * 100 : null;

  const costValue = inventory.reduce((s, i) => s + Number(i.cost_price) * i.stock, 0);
  const retailValue = inventory.reduce((s, i) => s + Number(i.sale_price) * i.stock, 0);

  const velocity = {};
  thisWeek.forEach((r) => { velocity[r.item_id] = (velocity[r.item_id] || 0) + r.qty; });
  const runningOutSoon = inventory
    .map((i) => { const dailyRate = (velocity[i.id] || 0) / 7; const daysLeft = dailyRate > 0 ? i.stock / dailyRate : Infinity; return { id: i.id, name: i.name, stock: i.stock, daysLeft }; })
    .filter((i) => i.daysLeft < Infinity).sort((a, b) => a.daysLeft - b.daysLeft).slice(0, 5);

  const soldIds = new Set(last14.map((r) => r.item_id));
  const deadStock = inventory.filter((i) => i.stock > 0 && !soldIds.has(i.id))
    .map((i) => ({ id: i.id, name: i.name, stock: i.stock, idleCapital: Number(i.cost_price) * i.stock })).slice(0, 5);

  const marginChampions = [...inventory]
    .map((i) => ({ id: i.id, name: i.name, margin: i.sale_price > 0 ? ((i.sale_price - i.cost_price) / i.sale_price) * 100 : 0, profitPerUnit: i.sale_price - i.cost_price }))
    .sort((a, b) => b.margin - a.margin).slice(0, 5);

  res.json({
    capital: { costValue, retailValue, lockedProfit: retailValue - costValue },
    weekOverWeek: { revenueThisWeek: revThis, revenueLastWeek: revLast, pctChange },
    runningOutSoon, deadStock, marginChampions,
  });
});

// --- SCAN A PAGE (photo → structured sales data via Claude's vision API) ---
// Flow: owner/staff photographs a notebook page → we send it to Claude →
// Claude returns raw {description, quantity, amount} rows → we fuzzy-match
// each description against this business's real inventory → return everything
// for human review. Nothing is recorded until /ocr/commit is called explicitly.

function normalize(str) {
  return String(str || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
}

// Simple word-overlap matcher — good enough for short product names typed
// or handwritten inconsistently (e.g. "brake fluid dot3" vs "DOT 3 Brake Fluid").
function fuzzyMatchItem(description, inventory) {
  const target = normalize(description).split(' ').filter(Boolean);
  if (target.length === 0) return null;
  let best = null, bestScore = 0;
  for (const item of inventory) {
    const words = normalize(item.name).split(' ').filter(Boolean);
    const overlap = target.filter((w) => words.includes(w)).length;
    const score = overlap / Math.max(target.length, words.length);
    if (score > bestScore) { bestScore = score; best = item; }
  }
  return bestScore >= 0.3 ? { item: best, confidence: bestScore } : null;
}

app.post('/ocr/parse-page', requireAuth, async (req, res) => {
  const { imageBase64, mediaType } = req.body;
  if (!imageBase64) return res.status(400).json({ error: 'imageBase64 is required' });
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not configured on the server' });
  }

  try {
    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1500,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: imageBase64 } },
            {
              type: 'text',
              text: `This is a photo of a handwritten or printed sales/inventory ledger page from an auto-parts shop. ` +
                `Extract every line item you can read. Respond with ONLY a JSON array, no other text, in this exact shape: ` +
                `[{"description": "...", "quantity": number, "amount": number_or_null}]. ` +
                `If a quantity or amount is unreadable or absent, use null. Do not guess values that aren't on the page.`,
            },
          ],
        }],
      }),
    });

    const aiData = await aiRes.json();
    if (!aiRes.ok) {
      console.error('[ocr] Claude API error:', aiData);
      return res.status(502).json({ error: 'Vision extraction failed' });
    }

    const text = aiData.content.map((b) => b.text || '').join('').trim();
    const cleaned = text.replace(/^```json\s*|\s*```$/g, '');
    let rows;
    try {
      rows = JSON.parse(cleaned);
    } catch (e) {
      console.error('[ocr] could not parse Claude output:', text);
      return res.status(502).json({ error: 'Could not parse extracted data — try a clearer photo' });
    }

    const inventory = (await pool.query('SELECT * FROM inventory_items WHERE business_id = $1', [req.user.businessId])).rows;

    const reviewed = rows.map((row) => {
      const match = fuzzyMatchItem(row.description, inventory);
      const qty = row.quantity || 1;
      const unitPrice = match ? Number(match.item.sale_price) : null;
      return {
        rawDescription: row.description,
        quantity: qty,
        amountOnPage: row.amount,
        matchedItem: match ? { id: match.item.id, name: match.item.name, confidence: Number(match.confidence.toFixed(2)) } : null,
        suggestedTotal: unitPrice ? unitPrice * qty : row.amount,
        needsReview: !match || match.confidence < 0.6,
      };
    });

    const totalFromPage = reviewed.reduce((s, r) => s + (r.suggestedTotal || 0), 0);
    res.json({ rows: reviewed, totalFromPage, rowCount: reviewed.length });
  } catch (err) {
    console.error('[ocr] error:', err);
    res.status(500).json({ error: 'Could not process the image' });
  }
});

// After the owner/staff reviews and corrects the extracted rows in the UI,
// this commits them as real sales — reusing the same recordSale() used by
// manual entry and offline sync, so stock and ledgers stay consistent.
app.post('/ocr/commit', requireAuth, async (req, res) => {
  const { rows } = req.body; // [{ itemId, quantity, paymentMethod }]
  if (!Array.isArray(rows) || rows.length === 0) return res.status(400).json({ error: 'rows must be a non-empty array' });

  const results = [];
  for (const row of rows) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await recordSale(client, req.user.businessId, req.user.userId, {
        itemId: row.itemId,
        qty: row.quantity,
        paymentMethod: row.paymentMethod || 'Cash',
        clientUuid: row.clientUuid || `ocr-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      });
      if (result.error) { await client.query('ROLLBACK'); results.push({ itemId: row.itemId, status: 'failed', error: result.error }); }
      else { await client.query('COMMIT'); results.push({ itemId: row.itemId, status: 'recorded' }); }
    } catch (err) {
      await client.query('ROLLBACK');
      results.push({ itemId: row.itemId, status: 'failed', error: 'Server error' });
    } finally {
      client.release();
    }
  }
  res.json({ results });
});

app.post('/internal/run-daily-summary-now', async (req, res) => {
  await runDailySummaries();
  res.json({ triggered: true });
});

// ============================================================================
// SUPER ADMIN ENDPOINTS — only accessible by users with is_super_admin = true
// ============================================================================

async function requireSuperAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const result = await pool.query('SELECT is_super_admin FROM users WHERE id = $1', [req.user.userId]);
    if (!result.rows[0]?.is_super_admin) return res.status(403).json({ error: 'Super admin access required' });
    next();
  } catch (err) {
    res.status(500).json({ error: 'Could not verify admin access' });
  }
}

// GET /admin/stats — platform-wide numbers
app.get('/admin/stats', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const [businesses, users, sales, items] = await Promise.all([
      pool.query('SELECT count(*) FROM businesses'),
      pool.query('SELECT count(*) FROM users'),
      pool.query('SELECT count(*), COALESCE(SUM(qty * unit_price), 0) AS total_revenue FROM sales'),
      pool.query('SELECT count(*) FROM inventory_items'),
    ]);
    res.json({
      totalBusinesses: Number(businesses.rows[0].count),
      totalUsers: Number(users.rows[0].count),
      totalSales: Number(sales.rows[0].count),
      totalRevenue: Number(sales.rows[0].total_revenue),
      totalItems: Number(items.rows[0].count),
    });
  } catch (err) {
    console.error('[/admin/stats]', err.message);
    res.status(500).json({ error: 'Could not load platform stats' });
  }
});

// GET /admin/businesses — all businesses with per-business stats
app.get('/admin/businesses', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        b.id, b.name, b.address, b.whatsapp_number, b.created_at,
        u.name AS owner_name, u.phone AS owner_phone,
        COUNT(DISTINCT i.id) AS item_count,
        COUNT(DISTINCT s.id) AS sale_count,
        COALESCE(SUM(s.qty * s.unit_price), 0) AS total_revenue,
        MAX(s.occurred_at) AS last_sale_at,
        COUNT(DISTINCT us.id) AS staff_count
      FROM businesses b
      LEFT JOIN users u ON u.business_id = b.id AND u.role = 'owner'
      LEFT JOIN inventory_items i ON i.business_id = b.id
      LEFT JOIN sales s ON s.business_id = b.id
      LEFT JOIN users us ON us.business_id = b.id AND us.role = 'staff'
      GROUP BY b.id, b.name, b.address, b.whatsapp_number, b.created_at, u.name, u.phone
      ORDER BY b.created_at DESC
    `);
    res.json({ businesses: result.rows });
  } catch (err) {
    console.error('[/admin/businesses]', err.message);
    res.status(500).json({ error: 'Could not load businesses' });
  }
});

// GET /admin/businesses/:id — single business detail
app.get('/admin/businesses/:id', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const [biz, staff, recentSales, topItems] = await Promise.all([
      pool.query(`
        SELECT b.*, u.name AS owner_name, u.phone AS owner_phone
        FROM businesses b
        LEFT JOIN users u ON u.business_id = b.id AND u.role = 'owner'
        WHERE b.id = $1
      `, [req.params.id]),
      pool.query('SELECT name, phone FROM users WHERE business_id = $1 AND role = $2', [req.params.id, 'staff']),
      pool.query(`
        SELECT s.qty, s.unit_price, s.occurred_at, i.name AS item_name
        FROM sales s JOIN inventory_items i ON i.id = s.item_id
        WHERE s.business_id = $1 ORDER BY s.occurred_at DESC LIMIT 10
      `, [req.params.id]),
      pool.query(`
        SELECT i.name, i.brand, i.stock, i.sale_price, COUNT(s.id) AS times_sold
        FROM inventory_items i
        LEFT JOIN sales s ON s.item_id = i.id
        WHERE i.business_id = $1
        GROUP BY i.id ORDER BY times_sold DESC LIMIT 5
      `, [req.params.id]),
    ]);
    if (!biz.rows[0]) return res.status(404).json({ error: 'Business not found' });
    res.json({ business: biz.rows[0], staff: staff.rows, recentSales: recentSales.rows, topItems: topItems.rows });
  } catch (err) {
    console.error('[/admin/businesses/:id]', err.message);
    res.status(500).json({ error: 'Could not load business detail' });
  }
});

// GET /admin/check — used by the frontend to detect super admin login
app.get('/admin/check', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT is_super_admin FROM users WHERE id = $1', [req.user.userId]);
    res.json({ isSuperAdmin: !!result.rows[0]?.is_super_admin });
  } catch (err) {
    res.json({ isSuperAdmin: false });
  }
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`TodayBread API listening on port ${PORT}`);
  scheduleDailySummaryJob();
});
