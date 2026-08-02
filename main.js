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
const crypto = require('crypto'); // built-in — used for Paystack webhook signature verification
// New dependency — run: npm install @simplewebauthn/server
const { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } = require('@simplewebauthn/server');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false },
});

// Starter categories per industry, seeded into the categories table once at
// signup. Purely a starting point — owners can rename, delete, or add their
// own at any time afterward. 'other' gets nothing, since there's no sane
// generic list that wouldn't just be noise for a business it doesn't fit.
const INDUSTRY_CATEGORIES = {
  auto_parts: ['Engine Oil', 'Brake Fluid', 'Coolant', 'Transmission Fluid', 'Power Steering Fluid', 'Grease & Sealant', 'Cleaner & Degreaser', 'Filters', 'Batteries', 'Tyres & Tubes'],
  cosmetics: ['Skincare', 'Haircare', 'Fragrance', 'Makeup', 'Body Care', 'Soap & Bath', 'Baby Care', "Men's Grooming", 'Nail Care', 'Hair Accessories'],
  pharmacy: ['Pain Relief', 'Antibiotics', 'Antimalarials', 'Vitamins & Supplements', 'First Aid', 'Cold & Flu', 'Digestive Health', 'Baby & Maternal', 'Medical Devices', 'Skin Treatments'],
  electronics: ['Phones', 'Chargers & Cables', 'Phone Cases & Screen Protectors', 'Laptops & Accessories', 'Earphones & Headphones', 'Power Banks', 'Memory Cards & Flash Drives', 'Smart Watches', 'Computer Accessories', 'Networking & Routers'],
  groceries: ['Beverages', 'Snacks', 'Grains & Cereals', 'Canned Goods', 'Dairy', 'Spices & Seasoning', 'Baking Supplies', 'Household Cleaning', 'Toiletries', 'Frozen Foods'],
  fashion: ["Men's Wear", "Women's Wear", "Children's Wear", 'Footwear', 'Bags', 'Jewelry & Watches', 'Belts', 'Underwear', 'Fabric & Textiles', 'Accessories'],
  other: [],
};

// Same idea as categories, but for the Brand field — real, recognizable
// brands for the Nigerian market so a fresh signup feels tailored on day one
// instead of a blank field. Just a starting menu; fully editable afterward.
const INDUSTRY_BRANDS = {
  auto_parts: ['Bosch', 'Castrol', 'Mobil', 'Shell', 'Total', 'Toyota Genuine', 'Honda Genuine', 'Prestone', 'Loctite', 'Permatex'],
  cosmetics: ['Nivea', 'Vaseline', 'Dove', 'Dettol', 'Cussons', 'Ori', 'Cantu', 'Nice & Lovely', 'Amila', 'St. Ives'],
  pharmacy: ['Emzor', 'Fidson', 'May & Baker', 'Neimeth', 'GSK', 'Panadol', 'Sanofi', 'Swiss Pharma', 'Juhel', 'Ranbaxy'],
  electronics: ['Samsung', 'Tecno', 'Infinix', 'Itel', 'Apple', 'Oraimo', 'Anker', 'HP', 'Dell', 'Xiaomi'],
  groceries: ['Indomie', 'Peak', 'Milo', 'Golden Morn', 'Dangote', 'Golden Penny', 'Nestlé', 'Knorr', 'Maggi', 'Coca-Cola'],
  fashion: ['Nike', 'Adidas', 'Vlisco', 'Puma', 'Woodin', 'Clarks', 'Skechers', 'Fila', 'Reebok', 'Hollandais'],
  other: [],
};

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

-- Subscription tracking. next_due_date starts equal to trial_ends_at (first
-- payment is due right when the trial ends), advances by 30 days from the
-- OLD due date each time an admin marks a business paid. Status itself is
-- computed at read time (trial / active / overdue) rather than stored, so it
-- can never drift out of sync with the dates.
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS next_due_date TIMESTAMPTZ;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS monthly_fee NUMERIC(12,2) NOT NULL DEFAULT 10000;
-- Tracks which due date the 7-day-before WhatsApp reminder was already sent
-- for, so the same cycle doesn't nag the admin more than once.
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS reminder_sent_for_due_date TIMESTAMPTZ;

-- One-time backfill for businesses that existed before this feature: give them
-- a clean 30-day due date starting now rather than retroactively marking them
-- overdue for a feature they never agreed to. New signups always set these
-- explicitly at signup time, so this only ever touches pre-existing rows.
UPDATE businesses SET trial_ends_at = now(), next_due_date = now() + interval '30 days' WHERE next_due_date IS NULL;

-- Which industry the business picked at signup (auto_parts, cosmetics, pharmacy,
-- groceries, fashion, other) — used once to pick a starter category set, and
-- kept around as descriptive metadata after that. Existing businesses predate
-- this and are left NULL — no retroactive guess, no seeded categories added.
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS industry TEXT;

-- Categories are tenant-owned and independent of items — this is what makes
-- pre-seeding possible (a category can exist with zero items using it yet).
-- Populated once at signup from the industry's starter set, and grows from
-- there any time an owner types a new category on an item.
CREATE TABLE IF NOT EXISTS categories (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, name)
);

-- Same idea, same shape, for brands — pre-seeded per industry so the Brand
-- field's autocomplete has real suggestions from day one too.
CREATE TABLE IF NOT EXISTS brands (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, name)
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

-- Email is needed to create a Paystack customer (required by their API) —
-- nullable since it predates this feature and isn't needed for anything else.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;

-- Paystack Dedicated Virtual Account details, once the owner sets one up —
-- one bank account per business, permanently theirs, any transfer to it is
-- auto-detected via webhook. Nothing here until they set it up.
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS paystack_customer_code TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS dva_account_number TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS dva_account_name TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS dva_bank_name TEXT;

-- Face ID / biometric login credentials (WebAuthn), owner-only by design —
-- this is for a personal device, not a shared shop terminal, so it's tied
-- to a specific user, not the business.
CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  counter BIGINT NOT NULL DEFAULT 0,
  device_label TEXT,
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
  expiry_date DATE,
  batch_number TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, sku)
);

-- Adds the two columns above to a database that already had inventory_items
-- before this change — CREATE TABLE IF NOT EXISTS above won't add columns
-- to an existing table, so these run every migrate and are no-ops once applied.
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS expiry_date DATE;
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS batch_number TEXT;

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

-- A voided sale isn't deleted — it stays in the log (so the record of what
-- happened is never lost) but is excluded from revenue/profit everywhere,
-- and its stock is restored when voided.
ALTER TABLE sales ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS voided_by UUID REFERENCES users(id);

-- Lightweight audit trail for the mutations an owner would actually want to
-- ask "who did this" about — price/cost changes, deletions, voided sales,
-- taxonomy cleanup. Not exhaustive (not every field edit on every entity),
-- deliberately scoped to what matters for accountability.
CREATE TABLE IF NOT EXISTS audit_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id),
  user_name TEXT,
  action TEXT NOT NULL,
  details TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sales_business_time ON sales (business_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_inventory_business ON inventory_items (business_id);
CREATE INDEX IF NOT EXISTS idx_users_business ON users (business_id);
CREATE INDEX IF NOT EXISTS idx_audit_business_time ON audit_log (business_id, created_at);
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

// Fire-and-forget by design — an audit log failure should never break the
// actual action being logged (e.g. a sale voiding successfully shouldn't
// fail just because the log insert had a hiccup).
function logAudit(businessId, user, action, details) {
  pool.query(
    'INSERT INTO audit_log (business_id, user_id, user_name, action, details) VALUES ($1, $2, $3, $4, $5)',
    [businessId, user?.userId || null, user?.name || null, action, details || null]
  ).catch((err) => console.error('[audit] log failed:', err.message));
}

// ----------------------------------------------------------------------------
// PAYSTACK HELPER
// ----------------------------------------------------------------------------
async function paystackRequest(path, method, body) {
  const res = await fetch(`https://api.paystack.co${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!data.status) {
    // Paystack's own error message is far more useful than a generic one —
    // e.g. "Your business needs to go live before you can create dedicated
    // virtual accounts" tells you exactly what to fix, a generic 500 doesn't.
    const err = new Error(data.message || 'Paystack request failed');
    err.paystackResponse = data;
    throw err;
  }
  return data;
}

// ----------------------------------------------------------------------------
// WEBAUTHN (FACE ID / BIOMETRIC LOGIN) CONFIG
// ----------------------------------------------------------------------------
// These MUST match your actual production frontend domain exactly, or every
// WebAuthn registration/login will fail — the browser enforces this strictly
// as an anti-phishing protection, it's not optional or a soft warning.
// WEBAUTHN_RP_ID is just the domain (e.g. "todaybreadify.app", no https://,
// no path). WEBAUTHN_ORIGIN is the full origin (e.g. "https://todaybreadify.app").
const WEBAUTHN_RP_ID = process.env.WEBAUTHN_RP_ID || 'localhost';
const WEBAUTHN_ORIGIN = process.env.WEBAUTHN_ORIGIN || 'http://localhost:3000';
const WEBAUTHN_RP_NAME = 'TodayBread';

// Short-lived, in-memory challenge storage — same pattern as loginAttempts.
// Registration is keyed by userId (always logged-in-via-PIN first), login is
// keyed by phone number (not logged in yet). 2-minute expiry either way.
const webauthnChallenges = new Map();
function storeChallenge(key, challenge) {
  webauthnChallenges.set(key, { challenge, expiresAt: Date.now() + 2 * 60 * 1000 });
}
function takeChallenge(key) {
  const entry = webauthnChallenges.get(key);
  webauthnChallenges.delete(key);
  if (!entry || entry.expiresAt < Date.now()) return null;
  return entry.challenge;
}

// ----------------------------------------------------------------------------
// WHATSAPP HELPER
// ----------------------------------------------------------------------------
function naira(n) { return '₦' + Math.round(n).toLocaleString('en-NG'); }

async function sendWhatsAppMessage(toNumber, messageBody) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886';

  if (!accountSid || !authToken) {
    console.warn('[whatsapp] Twilio credentials not set — skipping send');
    return { skipped: true };
  }

  const to = toNumber.startsWith('whatsapp:') ? toNumber : `whatsapp:+${toNumber.replace(/^\+/, '')}`;
  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const body = new URLSearchParams({ From: from, To: to, Body: messageBody });

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  const data = await res.json();
  if (!res.ok) {
    console.error('[whatsapp] Twilio send failed:', data);
    throw new Error(data?.message || 'WhatsApp send failed');
  }
  console.log('[whatsapp] sent successfully, SID:', data.sid);
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
      const dashboardUrl = process.env.DASHBOARD_URL || 'https://dapper-sable-ed0d32.netlify.app';

      const message =
        `📋 *TodayBread Daily Summary*\n` +
        `*${business.name}*\n\n` +
        `💰 Revenue today: *${naira(summary.revenue)}*\n` +
        `🏆 Best seller: *${summary.topSellerName}*\n` +
        `⚠️ Low stock alerts: *${summary.lowStockCount} item${summary.lowStockCount === 1 ? '' : 's'}*\n\n` +
        `👉 View dashboard: ${dashboardUrl}`;

      await sendWhatsAppMessage(business.whatsapp_number, message);
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
// SUBSCRIPTION REMINDERS — a single daily WhatsApp digest to the super admin
// (not to tenants) listing any business whose payment is due within 7 days
// or already overdue. Each business only appears once per billing cycle —
// reminder_sent_for_due_date tracks that, and gets cleared automatically
// whenever a business is marked paid, so the next cycle reminds again.
// ----------------------------------------------------------------------------
async function checkSubscriptionReminders() {
  const adminNumber = process.env.SUPER_ADMIN_WHATSAPP;
  if (!adminNumber) {
    console.warn('[subscription-reminders] SUPER_ADMIN_WHATSAPP not set — skipping');
    return;
  }
  try {
    const result = await pool.query(`
      SELECT id, name, next_due_date, monthly_fee
      FROM businesses
      WHERE next_due_date IS NOT NULL
        AND next_due_date <= now() + interval '7 days'
        AND (reminder_sent_for_due_date IS NULL OR reminder_sent_for_due_date <> next_due_date)
      ORDER BY next_due_date ASC
    `);
    if (result.rows.length === 0) return;

    const lines = result.rows.map((b) => {
      const overdue = new Date(b.next_due_date) < new Date();
      const dateStr = new Date(b.next_due_date).toLocaleDateString('en-NG', { day: 'numeric', month: 'short' });
      return `${overdue ? '🔴' : '🟡'} *${b.name}* — ${naira(b.monthly_fee)} ${overdue ? 'overdue since' : 'due'} ${dateStr}`;
    });
    const message = `💳 *TodayBread Subscription Reminders*\n\n${lines.join('\n')}`;

    await sendWhatsAppMessage(adminNumber, message);
    await pool.query(
      `UPDATE businesses SET reminder_sent_for_due_date = next_due_date WHERE id = ANY($1)`,
      [result.rows.map((b) => b.id)]
    );
    console.log(`[subscription-reminders] sent digest for ${result.rows.length} business(es)`);
  } catch (err) {
    console.error('[subscription-reminders] error:', err.message);
  }
}

function scheduleSubscriptionReminderJob() {
  const timezone = process.env.BUSINESS_TIMEZONE || 'Africa/Lagos';
  // Runs once a day, separate from the evening sales summary — subscription
  // reminders are for the admin, not tied to end-of-day business hours.
  cron.schedule('0 9 * * *', checkSubscriptionReminders, { timezone });
  console.log(`[subscription-reminders] job scheduled for 09:00 (${timezone})`);
}

// ----------------------------------------------------------------------------
// EXPRESS APP
// ----------------------------------------------------------------------------
const app = express();
app.use(cors());
// Also stash the raw bytes of every request body — Paystack's webhook
// signature is an HMAC over the exact original bytes, which re-serializing
// req.body back to JSON would not reliably reproduce.
app.use(express.json({ limit: '10mb', verify: (req, res, buf) => { req.rawBody = buf; } }));

app.get('/health', (req, res) => res.json({ ok: true }));

// --- AUTH ---
function generateSlug(name) {
  const base = name.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return base || 'shop-' + Date.now();
}

app.post('/auth/signup', async (req, res) => {
  const { businessName, ownerName, phone, pin, whatsappNumber, address, inviteCode, industry } = req.body;
  if (!businessName || !ownerName || !phone || !pin) {
    return res.status(400).json({ error: 'businessName, ownerName, phone, and pin are required' });
  }
  // Unknown or missing industry just falls back to 'other' (no seeded categories) rather than erroring
  const cleanIndustry = INDUSTRY_CATEGORIES.hasOwnProperty(industry) ? industry : 'other';

  // Invite code gate — only checked if INVITE_CODE env var is set
  const requiredCode = process.env.INVITE_CODE;
  if (requiredCode) {
    if (!inviteCode || inviteCode.trim().toUpperCase() !== requiredCode.toUpperCase()) {
      return res.status(403).json({ error: 'Invalid invite code. Contact TodayBread to get access.' });
    }
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Generate a unique slug
    let slug = generateSlug(businessName);
    const existing = await client.query('SELECT id FROM businesses WHERE slug = $1', [slug]);
    if (existing.rows.length > 0) slug = slug + '-' + Date.now();

    const biz = await client.query(
      `INSERT INTO businesses (name, whatsapp_number, address, slug, industry, trial_ends_at, next_due_date)
       VALUES ($1, $2, $3, $4, $5, now() + interval '14 days', now() + interval '14 days') RETURNING *`,
      [businessName, whatsappNumber || phone, address || null, slug, cleanIndustry]
    );
    const pinHash = await bcrypt.hash(pin, 10);
    const userRes = await client.query(
      `INSERT INTO users (business_id, name, phone, pin_hash, role) VALUES ($1,$2,$3,$4,'owner') RETURNING *`,
      [biz.rows[0].id, ownerName, phone, pinHash]
    );

    const starterCategories = INDUSTRY_CATEGORIES[cleanIndustry] || [];
    for (const catName of starterCategories) {
      await client.query(
        'INSERT INTO categories (business_id, name) VALUES ($1, $2) ON CONFLICT (business_id, name) DO NOTHING',
        [biz.rows[0].id, catName]
      );
    }
    const starterBrands = INDUSTRY_BRANDS[cleanIndustry] || [];
    for (const brandName of starterBrands) {
      await client.query(
        'INSERT INTO brands (business_id, name) VALUES ($1, $2) ON CONFLICT (business_id, name) DO NOTHING',
        [biz.rows[0].id, brandName]
      );
    }

    await client.query('COMMIT');
    const owner = userRes.rows[0];

    // Send welcome WhatsApp message (non-blocking — signup succeeds even if message fails)
    const catalogueUrl = `${process.env.DASHBOARD_URL || 'https://todaybread.netlify.app'}`;
    const shopUrl = `https://todaybread.onrender.com/shop/${biz.rows[0].slug}`;
    const welcomeMsg =
      `👋 Welcome to *TodayBread*, ${businessName}!\n\n` +
      `Your shop is now live. Here's what to do next:\n\n` +
      `1️⃣ Open your dashboard: ${catalogueUrl}\n` +
      `2️⃣ Add your inventory so customers can see your products\n` +
      `3️⃣ Share your public catalogue with customers: ${shopUrl}\n\n` +
      `Every evening at 9 PM you'll receive a daily summary of your sales right here on WhatsApp.\n\n` +
      `Need help? Reply to this message anytime.\n` +
      `— TodayBread Team`;

    const recipientNumber = whatsappNumber || phone;
    sendWhatsAppMessage(recipientNumber, welcomeMsg).catch(err =>
      console.error('[welcome-msg] failed for', businessName, err.message)
    );

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


// In-memory login attempt tracker, keyed by phone number. Resets on server
// restart, which is fine — the goal is stopping a sustained PIN-guessing
// script, not building a persistent security log. 5 failed attempts within
// 15 minutes locks that phone number out for 15 minutes.
const loginAttempts = new Map();
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;

app.post('/auth/login', async (req, res) => {
  const { phone, pin } = req.body;
  if (!phone || !pin) return res.status(400).json({ error: 'phone and pin are required' });
  const key = phone.trim();
  const now = Date.now();
  const existing = loginAttempts.get(key);
  if (existing?.lockedUntil && existing.lockedUntil > now) {
    const waitMin = Math.ceil((existing.lockedUntil - now) / 60000);
    return res.status(429).json({ error: `Too many failed attempts. Try again in ${waitMin} minute${waitMin === 1 ? '' : 's'}.` });
  }
  try {
    const result = await pool.query('SELECT * FROM users WHERE phone = $1', [phone]);
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(pin, user.pin_hash))) {
      const stillInWindow = existing && now - existing.firstAttemptAt < LOGIN_WINDOW_MS;
      const count = (stillInWindow ? existing.count : 0) + 1;
      const firstAttemptAt = stillInWindow ? existing.firstAttemptAt : now;
      const lockedUntil = count >= LOGIN_MAX_ATTEMPTS ? now + LOGIN_LOCKOUT_MS : null;
      loginAttempts.set(key, { count, firstAttemptAt, lockedUntil });
      if (lockedUntil) return res.status(429).json({ error: 'Too many failed attempts. Try again in 15 minutes.' });
      return res.status(401).json({ error: 'Invalid phone or PIN' });
    }
    loginAttempts.delete(key);
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
  try {
    const result = await pool.query(
      'SELECT id, name, phone, role, created_at FROM users WHERE business_id = $1 AND role = $2',
      [req.user.businessId, 'staff']
    );
    res.json({ staff: result.rows });
  } catch (err) {
    console.error('[/auth/staff] error:', err.message);
    res.status(500).json({ error: 'Could not load staff' });
  }
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
  try {
    const business = await pool.query(
      `SELECT id, name, address, whatsapp_number, created_at, trial_ends_at, next_due_date, monthly_fee, slug, industry,
              dva_account_number, dva_account_name, dva_bank_name
       FROM businesses WHERE id = $1`,
      [req.user.businessId]
    );
    const bioCheck = await pool.query('SELECT count(*)::int AS count FROM webauthn_credentials WHERE user_id = $1', [req.user.userId]);
    res.json({
      user: { id: req.user.userId, name: req.user.name, role: req.user.role, biometricsEnrolled: bioCheck.rows[0].count > 0 },
      business: business.rows[0] || null,
    });
  } catch (err) {
    console.error('[/me] error:', err.message);
    res.status(500).json({ error: 'Could not load account info' });
  }
});

// --- SUBSCRIPTION PAYMENT (PAYSTACK, TRANSFER-ONLY VIA DEDICATED VIRTUAL ACCOUNT) ---

// POST /subscription/setup-payment-account — creates (or returns the existing)
// Paystack customer + Dedicated Virtual Account for this business, so the
// owner has one permanent bank account number to transfer their subscription
// fee to each month. Requires Paystack's "go-live" process to be completed on
// your account — this will fail with Paystack's own explanation if it isn't.
app.post('/subscription/setup-payment-account', requireAuth, requireOwner, async (req, res) => {
  const { email } = req.body;
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'A valid email is required' });
  if (!process.env.PAYSTACK_SECRET_KEY) return res.status(500).json({ error: 'PAYSTACK_SECRET_KEY is not configured on the server' });

  try {
    const existing = await pool.query('SELECT dva_account_number, dva_account_name, dva_bank_name FROM businesses WHERE id = $1', [req.user.businessId]);
    if (existing.rows[0]?.dva_account_number) {
      // Already set up — just save the email if it changed, return what exists.
      await pool.query('UPDATE users SET email = $1 WHERE id = $2', [email, req.user.userId]);
      return res.json({
        accountNumber: existing.rows[0].dva_account_number,
        accountName: existing.rows[0].dva_account_name,
        bankName: existing.rows[0].dva_bank_name,
      });
    }

    await pool.query('UPDATE users SET email = $1 WHERE id = $2', [email, req.user.userId]);
    const [firstName, ...rest] = (req.user.name || 'Owner').trim().split(' ');
    const lastName = rest.join(' ') || firstName;

    const customer = await paystackRequest('/customer', 'POST', {
      email, first_name: firstName, last_name: lastName,
    });
    const customerCode = customer.data.customer_code;

    const dva = await paystackRequest('/dedicated_account', 'POST', {
      customer: customerCode,
      preferred_bank: 'wema-bank',
    });

    await pool.query(
      `UPDATE businesses SET paystack_customer_code = $1, dva_account_number = $2, dva_account_name = $3, dva_bank_name = $4
       WHERE id = $5`,
      [customerCode, dva.data.account_number, dva.data.account_name, dva.data.bank.name, req.user.businessId]
    );

    res.json({ accountNumber: dva.data.account_number, accountName: dva.data.account_name, bankName: dva.data.bank.name });
  } catch (err) {
    console.error('[/subscription/setup-payment-account] error:', err.message);
    res.status(502).json({ error: 'Could not set up payment account', debug: err.paystackResponse?.message || err.message });
  }
});

// POST /webhooks/paystack — Paystack calls this whenever a payment event
// happens on your account. We only act on charge.success events that came
// through a dedicated virtual account, matched to a business by its Paystack
// customer code. No auth (Paystack can't send a bearer token) — the HMAC
// signature check below is what proves this request really came from Paystack.
app.post('/webhooks/paystack', async (req, res) => {
  const signature = req.headers['x-paystack-signature'];
  if (!process.env.PAYSTACK_SECRET_KEY || !req.rawBody) return res.sendStatus(400);
  const expected = crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY).update(req.rawBody).digest('hex');
  if (signature !== expected) {
    console.warn('[paystack-webhook] signature mismatch — ignoring');
    return res.sendStatus(401);
  }
  // Acknowledge immediately — Paystack retries if it doesn't get a fast 200,
  // and the actual processing below doesn't need to block the response.
  res.sendStatus(200);

  try {
    const event = req.body;
    if (event.event !== 'charge.success') return;
    const data = event.data;
    const customerCode = data.customer?.customer_code;
    if (!customerCode) return;

    const bizResult = await pool.query('SELECT id, name, monthly_fee FROM businesses WHERE paystack_customer_code = $1', [customerCode]);
    const business = bizResult.rows[0];
    if (!business) { console.warn('[paystack-webhook] no business matches customer', customerCode); return; }

    const amountReceived = Number(data.amount) / 100; // Paystack sends kobo
    await pool.query(
      `UPDATE businesses SET next_due_date = COALESCE(next_due_date, now()) + interval '30 days', reminder_sent_for_due_date = NULL
       WHERE id = $1`,
      [business.id]
    );
    logAudit(business.id, { userId: null, name: 'Paystack' }, 'subscription_paid', `Subscription paid via bank transfer: ${naira(amountReceived)} received (expected ${naira(business.monthly_fee)})`);
    console.log(`[paystack-webhook] subscription extended for ${business.name} — ${naira(amountReceived)} received`);
  } catch (err) {
    console.error('[paystack-webhook] processing error:', err.message);
  }
});

// --- FACE ID / BIOMETRIC LOGIN (WEBAUTHN), OWNER ONLY ---
// This is scoped to the owner's own personal device on purpose — it enrolls
// ONE device's biometric sensor to ONE user account. That fits an owner's own
// phone; it doesn't fit a shared shop terminal where staff rotate, so staff
// keep using phone+PIN.

// Step 1 of registration: server issues a challenge, browser asks the device
// to create a new biometric credential. Requires being logged in via PIN first.
app.post('/auth/webauthn/register-options', requireAuth, requireOwner, async (req, res) => {
  try {
    const existingCreds = await pool.query('SELECT credential_id FROM webauthn_credentials WHERE user_id = $1', [req.user.userId]);
    const options = await generateRegistrationOptions({
      rpName: WEBAUTHN_RP_NAME,
      rpID: WEBAUTHN_RP_ID,
      userID: Buffer.from(req.user.userId),
      userName: req.user.name || 'Owner',
      attestationType: 'none',
      excludeCredentials: existingCreds.rows.map((c) => ({ id: c.credential_id, type: 'public-key' })),
      // 'platform' restricts this to the device's built-in sensor (Face ID,
      // Touch ID, Android fingerprint/face unlock) rather than external
      // security keys, which is what "Face ID / biometrics" actually means here.
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred', authenticatorAttachment: 'platform' },
    });
    storeChallenge(`reg:${req.user.userId}`, options.challenge);
    res.json(options);
  } catch (err) {
    console.error('[webauthn register-options] error:', err.message);
    res.status(500).json({ error: 'Could not start biometric registration' });
  }
});

// Step 2 of registration: browser sends back what the device signed, server
// verifies it and stores the credential permanently.
app.post('/auth/webauthn/register-verify', requireAuth, requireOwner, async (req, res) => {
  try {
    const expectedChallenge = takeChallenge(`reg:${req.user.userId}`);
    if (!expectedChallenge) return res.status(400).json({ error: 'Registration session expired — try again' });
    const verification = await verifyRegistrationResponse({
      response: req.body,
      expectedChallenge,
      expectedOrigin: WEBAUTHN_ORIGIN,
      expectedRPID: WEBAUTHN_RP_ID,
    });
    if (!verification.verified || !verification.registrationInfo) {
      return res.status(400).json({ error: 'Could not verify biometric registration' });
    }
    // NOTE: @simplewebauthn/server's return shape here has changed across
    // major versions. This targets v10+ (registrationInfo.credential.{id,
    // publicKey, counter}). If you're on an older version, check that
    // package's docs — it may be registrationInfo.credentialID /
    // credentialPublicKey / counter directly instead.
    const { credential } = verification.registrationInfo;
    await pool.query(
      'INSERT INTO webauthn_credentials (user_id, credential_id, public_key, counter, device_label) VALUES ($1, $2, $3, $4, $5)',
      [req.user.userId, credential.id, Buffer.from(credential.publicKey).toString('base64url'), credential.counter, req.body.deviceLabel || 'This device']
    );
    res.json({ verified: true });
  } catch (err) {
    console.error('[webauthn register-verify] error:', err.message);
    res.status(500).json({ error: 'Could not verify biometric registration', debug: err.message });
  }
});

// Step 1 of login: given a phone number (not authenticated yet), issue a
// challenge scoped to that user's enrolled credentials.
app.post('/auth/webauthn/login-options', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone is required' });
  try {
    const userResult = await pool.query('SELECT id FROM users WHERE phone = $1', [phone]);
    const user = userResult.rows[0];
    if (!user) return res.status(404).json({ error: 'No account found for that phone number' });
    const creds = await pool.query('SELECT credential_id FROM webauthn_credentials WHERE user_id = $1', [user.id]);
    if (creds.rows.length === 0) return res.status(404).json({ error: 'Biometric login is not set up for this account' });
    const options = await generateAuthenticationOptions({
      rpID: WEBAUTHN_RP_ID,
      allowCredentials: creds.rows.map((c) => ({ id: c.credential_id, type: 'public-key' })),
      userVerification: 'preferred',
    });
    storeChallenge(`login:${phone}`, options.challenge);
    res.json(options);
  } catch (err) {
    console.error('[webauthn login-options] error:', err.message);
    res.status(500).json({ error: 'Could not start biometric login' });
  }
});

// Step 2 of login: verify the signed challenge, issue a normal JWT — from
// here on it behaves exactly like a PIN login.
app.post('/auth/webauthn/login-verify', async (req, res) => {
  const { phone, response } = req.body;
  if (!phone || !response) return res.status(400).json({ error: 'phone and response are required' });
  try {
    const expectedChallenge = takeChallenge(`login:${phone}`);
    if (!expectedChallenge) return res.status(400).json({ error: 'Login session expired — try again' });

    const userResult = await pool.query('SELECT * FROM users WHERE phone = $1', [phone]);
    const user = userResult.rows[0];
    if (!user) return res.status(404).json({ error: 'Account not found' });

    const credResult = await pool.query('SELECT * FROM webauthn_credentials WHERE user_id = $1 AND credential_id = $2', [user.id, response.id]);
    const stored = credResult.rows[0];
    if (!stored) return res.status(400).json({ error: 'Unrecognized credential' });

    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: WEBAUTHN_ORIGIN,
      expectedRPID: WEBAUTHN_RP_ID,
      credential: {
        id: stored.credential_id,
        publicKey: Buffer.from(stored.public_key, 'base64url'),
        counter: Number(stored.counter),
      },
    });
    if (!verification.verified) return res.status(401).json({ error: 'Biometric verification failed' });

    await pool.query('UPDATE webauthn_credentials SET counter = $1 WHERE id = $2', [verification.authenticationInfo.newCounter, stored.id]);
    res.json({ token: signToken(user), user: { id: user.id, name: user.name, role: user.role, businessId: user.business_id } });
  } catch (err) {
    console.error('[webauthn login-verify] error:', err.message);
    res.status(500).json({ error: 'Could not verify biometric login', debug: err.message });
  }
});

// Turns off biometric login on this account (e.g. got a new phone) — owner
// can always re-enroll from Settings afterward.
app.delete('/auth/webauthn/credentials', requireAuth, requireOwner, async (req, res) => {
  try {
    await pool.query('DELETE FROM webauthn_credentials WHERE user_id = $1', [req.user.userId]);
    res.json({ removed: true });
  } catch (err) {
    console.error('[DELETE /auth/webauthn/credentials] error:', err.message);
    res.status(500).json({ error: 'Could not remove biometric login' });
  }
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

// GET /inventory/categories — every category currently in use by this business,
// derived straight from their own items (no shared/global list, no hardcoded
// auto-parts categories). A brand-new tenant with no items yet just gets [].
app.get('/inventory/categories', requireAuth, async (req, res) => {
  try {
    // Union of the tenant's category table (includes seeded-but-unused ones)
    // and whatever's actually in use on items — so a brand-new business sees
    // its industry starter set immediately, and nothing that's already in use
    // ever disappears even if it somehow isn't in the categories table.
    const result = await pool.query(
      `SELECT COALESCE(c.name, i.name) AS category, COALESCE(i.item_count, 0) AS item_count
       FROM (SELECT name FROM categories WHERE business_id = $1) c
       FULL OUTER JOIN (
         SELECT category AS name, count(*)::int AS item_count
         FROM inventory_items
         WHERE business_id = $1 AND category IS NOT NULL AND category <> ''
         GROUP BY category
       ) i ON c.name = i.name
       ORDER BY category ASC`,
      [req.user.businessId]
    );
    res.json({ categories: result.rows });
  } catch (err) {
    console.error('[/inventory/categories] error:', err.message);
    res.status(500).json({ error: 'Could not load categories' });
  }
});

// Same union pattern as categories, for the Brand field's autocomplete.
app.get('/inventory/brands', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT COALESCE(b.name, i.name) AS brand, COALESCE(i.item_count, 0) AS item_count
       FROM (SELECT name FROM brands WHERE business_id = $1) b
       FULL OUTER JOIN (
         SELECT brand AS name, count(*)::int AS item_count
         FROM inventory_items
         WHERE business_id = $1 AND brand IS NOT NULL AND brand <> ''
         GROUP BY brand
       ) i ON b.name = i.name
       ORDER BY brand ASC`,
      [req.user.businessId]
    );
    res.json({ brands: result.rows });
  } catch (err) {
    console.error('[/inventory/brands] error:', err.message);
    res.status(500).json({ error: 'Could not load brands' });
  }
});

// PATCH /inventory/categories/rename — owner renames a category across every
// item that currently uses it in one shot (e.g. "Brake Fluid" -> "Fluids").
app.patch('/inventory/categories/rename', requireAuth, requireOwner, async (req, res) => {
  const { from, to } = req.body;
  if (!from || !to || !to.trim()) return res.status(400).json({ error: 'from and to are required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE inventory_items SET category = $1, updated_at = now()
       WHERE business_id = $2 AND category = $3 RETURNING id`,
      [to.trim(), req.user.businessId, from]
    );
    await client.query('DELETE FROM categories WHERE business_id = $1 AND name = $2', [req.user.businessId, from]);
    await client.query(
      'INSERT INTO categories (business_id, name) VALUES ($1, $2) ON CONFLICT (business_id, name) DO NOTHING',
      [req.user.businessId, to.trim()]
    );
    await client.query('COMMIT');
    res.json({ renamed: true, itemsUpdated: result.rows.length });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[/inventory/categories/rename] error:', err.message);
    res.status(500).json({ error: 'Could not rename category' });
  } finally {
    client.release();
  }
});

// DELETE /inventory/categories/:name — clears that category off every item
// that has it (items aren't deleted, they just become uncategorized), and
// removes it from the tenant's category list too.
app.delete('/inventory/categories/:name', requireAuth, requireOwner, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE inventory_items SET category = NULL, updated_at = now()
       WHERE business_id = $1 AND category = $2 RETURNING id`,
      [req.user.businessId, req.params.name]
    );
    await client.query('DELETE FROM categories WHERE business_id = $1 AND name = $2', [req.user.businessId, req.params.name]);
    await client.query('COMMIT');
    res.json({ cleared: true, itemsUpdated: result.rows.length });
    logAudit(req.user.businessId, req.user, 'category_deleted', `Deleted category "${req.params.name}" (${result.rows.length} item${result.rows.length === 1 ? '' : 's'} affected)`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[/inventory/categories/:name] error:', err.message);
    res.status(500).json({ error: 'Could not clear category' });
  } finally {
    client.release();
  }
});

// Same rename/delete pattern as categories, for brands.
app.patch('/inventory/brands/rename', requireAuth, requireOwner, async (req, res) => {
  const { from, to } = req.body;
  if (!from || !to || !to.trim()) return res.status(400).json({ error: 'from and to are required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE inventory_items SET brand = $1, updated_at = now()
       WHERE business_id = $2 AND brand = $3 RETURNING id`,
      [to.trim(), req.user.businessId, from]
    );
    await client.query('DELETE FROM brands WHERE business_id = $1 AND name = $2', [req.user.businessId, from]);
    await client.query(
      'INSERT INTO brands (business_id, name) VALUES ($1, $2) ON CONFLICT (business_id, name) DO NOTHING',
      [req.user.businessId, to.trim()]
    );
    await client.query('COMMIT');
    res.json({ renamed: true, itemsUpdated: result.rows.length });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[/inventory/brands/rename] error:', err.message);
    res.status(500).json({ error: 'Could not rename brand' });
  } finally {
    client.release();
  }
});

app.delete('/inventory/brands/:name', requireAuth, requireOwner, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE inventory_items SET brand = '', updated_at = now()
       WHERE business_id = $1 AND brand = $2 RETURNING id`,
      [req.user.businessId, req.params.name]
    );
    await client.query('DELETE FROM brands WHERE business_id = $1 AND name = $2', [req.user.businessId, req.params.name]);
    await client.query('COMMIT');
    res.json({ cleared: true, itemsUpdated: result.rows.length });
    logAudit(req.user.businessId, req.user, 'brand_deleted', `Deleted brand "${req.params.name}" (${result.rows.length} item${result.rows.length === 1 ? '' : 's'} affected)`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[/inventory/brands/:name] error:', err.message);
    res.status(500).json({ error: 'Could not clear brand' });
  } finally {
    client.release();
  }
});

// SKU is an internal reference the tenant never has to think about — generated
// here, never typed by the owner. Short enough to write on a physical label
// if they ever need to, unique enough per business that collisions are rare.
function generateSku() {
  return 'ITM-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
}

app.post('/inventory', requireAuth, requireOwner, async (req, res) => {
  const { name, size, category, costPrice, salePrice, stock, warehouseStock, reorderLevel, origin, brand, expiryDate, batchNumber } = req.body;
  // Only the item name is truly required — everything else (including price)
  // can be filled in later. The frontend nudges for a sale price but the
  // backend won't block on it, since a blank/0 default is safe either way.
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  try {
    // Category is free-form text, owned by the tenant — whatever the owner types
    // when adding an item becomes a real category immediately, no fixed list
    // to update, no approval step. Trim it so "Skincare " and "Skincare" don't
    // silently become two different categories.
    const cleanCategory = category && category.trim() ? category.trim() : null;

    // Auto-generated SKUs collide essentially never (timestamp + random), but
    // retry once on the off chance of a same-millisecond clash within a business.
    let result;
    for (let attempt = 0; attempt < 2; attempt++) {
      const sku = generateSku();
      try {
        result = await pool.query(
          `INSERT INTO inventory_items (business_id, sku, name, size, category, brand, cost_price, sale_price, stock, warehouse_stock, reorder_level, origin, expiry_date, batch_number)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
          [req.user.businessId, sku, name.trim(), size, cleanCategory, brand || '', costPrice || 0, salePrice || 0, stock || 0, warehouseStock || 0, reorderLevel || 0, origin, expiryDate || null, batchNumber || null]
        );
        break;
      } catch (err) {
        if (err.code === '23505' && attempt === 0) continue; // sku collision — retry once with a new one
        throw err;
      }
    }
    res.status(201).json({ item: result.rows[0] });
    if (cleanCategory) {
      pool.query(
        'INSERT INTO categories (business_id, name) VALUES ($1, $2) ON CONFLICT (business_id, name) DO NOTHING',
        [req.user.businessId, cleanCategory]
      ).catch((err) => console.error('[categories upsert] error:', err.message));
    }
    if (brand && brand.trim()) {
      pool.query(
        'INSERT INTO brands (business_id, name) VALUES ($1, $2) ON CONFLICT (business_id, name) DO NOTHING',
        [req.user.businessId, brand.trim()]
      ).catch((err) => console.error('[brands upsert] error:', err.message));
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not create item' });
  }
});

app.put('/inventory/:id', requireAuth, requireOwner, async (req, res) => {
  const fields = ['name', 'size', 'category', 'brand', 'cost_price', 'sale_price', 'stock', 'warehouse_stock', 'reorder_level', 'origin', 'expiry_date', 'batch_number'];
  const map = { costPrice: 'cost_price', salePrice: 'sale_price', reorderLevel: 'reorder_level', warehouseStock: 'warehouse_stock', expiryDate: 'expiry_date', batchNumber: 'batch_number' };
  const updates = []; const values = []; let i = 1;
  for (const [key, val] of Object.entries(req.body)) {
    const col = map[key] || key;
    if (fields.includes(col)) {
      // Same trim-and-empty-to-null treatment as create, so edits stay consistent
      const cleanVal = (col === 'category' || col === 'expiry_date' || col === 'batch_number') && typeof val === 'string' ? (val.trim() || null) : val;
      updates.push(`${col} = $${i++}`); values.push(cleanVal);
    }
  }
  if (updates.length === 0) return res.status(400).json({ error: 'No valid fields to update' });
  const pricingChanged = updates.some((u) => u.startsWith('cost_price') || u.startsWith('sale_price'));
  values.push(req.params.id, req.user.businessId);
  try {
    // Grab the before-state only when it's actually needed for the audit
    // note — no point on every ordinary stock-count edit.
    const before = pricingChanged
      ? (await pool.query('SELECT name, cost_price, sale_price FROM inventory_items WHERE id = $1 AND business_id = $2', [req.params.id, req.user.businessId])).rows[0]
      : null;
    const result = await pool.query(
      `UPDATE inventory_items SET ${updates.join(', ')}, updated_at = now() WHERE id = $${i++} AND business_id = $${i} RETURNING *`,
      values
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Item not found' });
    res.json({ item: result.rows[0] });
    if (result.rows[0].category) {
      pool.query(
        'INSERT INTO categories (business_id, name) VALUES ($1, $2) ON CONFLICT (business_id, name) DO NOTHING',
        [req.user.businessId, result.rows[0].category]
      ).catch((err) => console.error('[categories upsert] error:', err.message));
    }
    if (result.rows[0].brand) {
      pool.query(
        'INSERT INTO brands (business_id, name) VALUES ($1, $2) ON CONFLICT (business_id, name) DO NOTHING',
        [req.user.businessId, result.rows[0].brand]
      ).catch((err) => console.error('[brands upsert] error:', err.message));
    }
    if (before && (Number(before.cost_price) !== Number(result.rows[0].cost_price) || Number(before.sale_price) !== Number(result.rows[0].sale_price))) {
      const parts = [];
      if (Number(before.cost_price) !== Number(result.rows[0].cost_price)) parts.push(`cost ₦${before.cost_price} → ₦${result.rows[0].cost_price}`);
      if (Number(before.sale_price) !== Number(result.rows[0].sale_price)) parts.push(`price ₦${before.sale_price} → ₦${result.rows[0].sale_price}`);
      logAudit(req.user.businessId, req.user, 'item_price_changed', `"${before.name}": ${parts.join(', ')}`);
    }
  } catch (err) {
    console.error('[PUT /inventory/:id] error:', err.message);
    res.status(500).json({ error: 'Could not update item' });
  }
});

app.delete('/inventory/:id', requireAuth, requireOwner, async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM inventory_items WHERE id = $1 AND business_id = $2 RETURNING id, name', [req.params.id, req.user.businessId]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Item not found' });
    res.json({ deleted: true });
    logAudit(req.user.businessId, req.user, 'item_deleted', `Deleted "${result.rows[0].name}"`);
  } catch (err) {
    console.error('[DELETE /inventory/:id] error:', err.message);
    res.status(500).json({ error: 'Could not delete item' });
  }
});

// PATCH /inventory/:id/restock — moves units from warehouse stock to shop
// floor stock. Internal transfer only, no cost implications (same items,
// same cost) — this is just relocating what's already owned, not receiving
// a new delivery. See /receive-stock below for that case.
app.patch('/inventory/:id/restock', requireAuth, requireOwner, async (req, res) => {
  const qty = Number(req.body.qty);
  if (!qty || qty <= 0) return res.status(400).json({ error: 'qty must be a positive number' });
  try {
    const result = await pool.query(
      `UPDATE inventory_items
       SET stock = stock + $1, warehouse_stock = warehouse_stock - $1, updated_at = now()
       WHERE id = $2 AND business_id = $3 AND warehouse_stock >= $1
       RETURNING stock, warehouse_stock`,
      [qty, req.params.id, req.user.businessId]
    );
    if (result.rows.length === 0) return res.status(409).json({ error: 'Not enough warehouse stock to move that much' });
    res.json({ stock: result.rows[0].stock, warehouseStock: result.rows[0].warehouse_stock });
  } catch (err) {
    console.error('[PATCH /inventory/:id/restock] error:', err.message);
    res.status(500).json({ error: 'Could not restock' });
  }
});

// PATCH /inventory/:id/receive-stock — a real delivery arriving, as opposed
// to /restock above (which just moves stock already owned between warehouse
// and shop floor). If a unit cost is given and it differs from the current
// cost_price, the new cost is calculated as a WEIGHTED AVERAGE across old and
// new stock — e.g. 10 units @ ₦100 + 5 units @ ₦130 becomes cost ₦110.
// If no cost is given, existing cost is left untouched (same as before).
// Expiry/batch are filled only if the item doesn't already have one — a
// second delivery's dates never silently overwrite the first's, since this
// model tracks one expiry per item, not per batch.
app.patch('/inventory/:id/receive-stock', requireAuth, requireOwner, async (req, res) => {
  const qty = Number(req.body.qty);
  const unitCost = req.body.unitCost != null ? Number(req.body.unitCost) : null;
  const expiryDate = req.body.expiryDate || null;
  const batchNumber = req.body.batchNumber || null;
  if (!qty || qty <= 0) return res.status(400).json({ error: 'qty must be a positive number' });
  try {
    const existing = await pool.query(
      'SELECT name, stock, cost_price, expiry_date, batch_number FROM inventory_items WHERE id = $1 AND business_id = $2',
      [req.params.id, req.user.businessId]
    );
    if (!existing.rows[0]) return res.status(404).json({ error: 'Item not found' });
    const item = existing.rows[0];

    let newCost = Number(item.cost_price);
    const costChanging = unitCost != null && unitCost > 0 && unitCost !== Number(item.cost_price);
    if (costChanging) {
      const oldStock = Number(item.stock);
      newCost = oldStock > 0
        ? Math.round(((oldStock * Number(item.cost_price)) + (qty * unitCost)) / (oldStock + qty) * 100) / 100
        : unitCost;
    }
    const newExpiry = item.expiry_date ? item.expiry_date : expiryDate;
    const newBatch = item.batch_number ? item.batch_number : batchNumber;

    const result = await pool.query(
      `UPDATE inventory_items
       SET stock = stock + $1, cost_price = $2, expiry_date = $3, batch_number = $4, updated_at = now()
       WHERE id = $5 AND business_id = $6 RETURNING *`,
      [qty, newCost, newExpiry, newBatch, req.params.id, req.user.businessId]
    );
    res.json({ item: result.rows[0] });
    if (costChanging) {
      logAudit(req.user.businessId, req.user, 'item_price_changed', `"${item.name}": cost ₦${item.cost_price} → ₦${newCost} (weighted average, received ${qty} @ ₦${unitCost})`);
    }
  } catch (err) {
    console.error('[PATCH /inventory/:id/receive-stock] error:', err.message);
    res.status(500).json({ error: 'Could not receive stock' });
  }
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

// POST /sales/:id/void — reverses a mistaken sale. The sale record itself
// is NEVER deleted (that would erase the fact it happened at all) — it's
// marked voided instead, and stays visible in the sales log crossed out.
// Stock is restored by the sold quantity. Owner only, since this touches
// both money and inventory counts.
app.post('/sales/:id/void', requireAuth, requireOwner, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const saleResult = await client.query(
      `SELECT s.*, i.name AS item_name FROM sales s JOIN inventory_items i ON i.id = s.item_id
       WHERE s.id = $1 AND s.business_id = $2 FOR UPDATE`,
      [req.params.id, req.user.businessId]
    );
    const sale = saleResult.rows[0];
    if (!sale) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Sale not found' }); }
    if (sale.voided_at) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'This sale is already voided' }); }

    const itemResult = await client.query(
      'UPDATE inventory_items SET stock = stock + $1, updated_at = now() WHERE id = $2 RETURNING stock',
      [sale.qty, sale.item_id]
    );
    await client.query(
      'UPDATE sales SET voided_at = now(), voided_by = $1 WHERE id = $2',
      [req.user.userId, req.params.id]
    );
    await client.query('COMMIT');
    res.json({ voided: true, restoredStock: itemResult.rows[0].stock });
    logAudit(req.user.businessId, req.user, 'sale_voided', `Voided sale of ${sale.qty} × "${sale.item_name}" (₦${sale.qty * sale.unit_price})`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[/sales/:id/void] error:', err.message);
    res.status(500).json({ error: 'Could not void sale' });
  } finally {
    client.release();
  }
});

// GET /audit-log — recent accountability events for this business (price/cost
// changes, deletions, voided sales, taxonomy cleanup). Owner only.
app.get('/audit-log', requireAuth, requireOwner, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 30, 100);
    const result = await pool.query(
      'SELECT id, user_name, action, details, created_at FROM audit_log WHERE business_id = $1 ORDER BY created_at DESC LIMIT $2',
      [req.user.businessId, limit]
    );
    res.json({ entries: result.rows });
  } catch (err) {
    console.error('[/audit-log] error:', err.message);
    res.status(500).json({ error: 'Could not load activity log' });
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
  try {
    const since = rangeToSince(req.query.range || 'today');
    const conditions = ['business_id = $1', 'voided_at IS NULL']; const values = [req.user.businessId];
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
  } catch (err) {
    console.error('[/reports/summary] error:', err.message);
    res.status(500).json({ error: 'Could not load summary' });
  }
});

app.get('/reports/insights', requireAuth, requireOwner, async (req, res) => {
  try {
    const businessId = req.user.businessId;
    const now = new Date();
    const sevenAgo = new Date(now); sevenAgo.setDate(sevenAgo.getDate() - 7);
    const fourteenAgo = new Date(now); fourteenAgo.setDate(fourteenAgo.getDate() - 14);

    const inventory = (await pool.query('SELECT * FROM inventory_items WHERE business_id = $1', [businessId])).rows;
    const thisWeek = (await pool.query('SELECT item_id, qty, unit_price FROM sales WHERE business_id = $1 AND occurred_at >= $2 AND voided_at IS NULL', [businessId, sevenAgo])).rows;
    const lastWeek = (await pool.query('SELECT qty, unit_price FROM sales WHERE business_id = $1 AND occurred_at >= $2 AND occurred_at < $3 AND voided_at IS NULL', [businessId, fourteenAgo, sevenAgo])).rows;
    const last14 = (await pool.query('SELECT DISTINCT item_id FROM sales WHERE business_id = $1 AND occurred_at >= $2 AND voided_at IS NULL', [businessId, fourteenAgo])).rows;

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
  } catch (err) {
    console.error('[/reports/insights] error:', err.message);
    res.status(500).json({ error: 'Could not load insights' });
  }
});

// --- SCAN A PAGE (photo → structured sales data via Gemini's vision API) ---
// Flow: owner/staff photographs a notebook page → we send it to Gemini →
// Gemini returns raw {description, quantity, amount} rows → we fuzzy-match
// each description against this business's real inventory → return everything
// for human review. Nothing is recorded until /ocr/commit is called explicitly.

function normalize(str) {
  return String(str || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
}

// Simple word-overlap matcher — good enough for short product names typed
// or handwritten inconsistently (e.g. "brake fluid dot3" vs "DOT 3 Brake Fluid").
// Always returns the single best candidate if one exists (even a weak one) —
// the caller decides what to do with a low-confidence result. A floor below
// 0.12 is filtered out entirely since that's indistinguishable from noise
// (e.g. matching on one common short word by coincidence).
function fuzzyMatchItem(description, inventory) {
  const target = normalize(description).split(' ').filter(Boolean);
  if (target.length === 0 || inventory.length === 0) return null;
  let best = null, bestScore = 0;
  for (const item of inventory) {
    const words = normalize(item.name).split(' ').filter(Boolean);
    const overlap = target.filter((w) => words.includes(w)).length;
    const score = overlap / Math.max(target.length, words.length);
    if (score > bestScore) { bestScore = score; best = item; }
  }
  return bestScore >= 0.12 ? { item: best, confidence: bestScore } : null;
}

app.post('/ocr/parse-page', requireAuth, async (req, res) => {
  const { imageBase64, mediaType, text: pastedText, mode } = req.body;
  const hasImage = !!imageBase64;
  const hasText = !!(pastedText && pastedText.trim());
  if (!hasImage && !hasText) {
    return res.status(400).json({ error: 'Provide either imageBase64 (photo) or text (pasted ledger text)' });
  }
  const MAX_PASTE_CHARS = 8000; // generous for a full day's ledger, cheap guard against runaway pastes
  if (hasText && pastedText.length > MAX_PASTE_CHARS) {
    return res.status(400).json({ error: `Pasted text is too long (${pastedText.length} characters, max ${MAX_PASTE_CHARS}) — split it into smaller batches` });
  }
  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: 'GEMINI_API_KEY is not configured on the server' });
  }

  try {
    // Grounds the category suggestion in categories this business actually
    // uses (seeded + custom-added) rather than letting the model invent its
    // own taxonomy — same union query as GET /inventory/categories.
    const categoryRows = await pool.query(
      `SELECT COALESCE(c.name, i.name) AS category
       FROM (SELECT name FROM categories WHERE business_id = $1) c
       FULL OUTER JOIN (
         SELECT category AS name FROM inventory_items
         WHERE business_id = $1 AND category IS NOT NULL AND category <> ''
         GROUP BY category
       ) i ON c.name = i.name
       ORDER BY category ASC`,
      [req.user.businessId]
    );
    const knownCategories = categoryRows.rows.map((r) => r.category);

    // Every business writes their sales/stock ledger differently — some list
    // "item — qty — price", some do "qty x item @unit price", some just
    // scrawl shorthand. We don't enforce a format; instead the prompt asks
    // Gemini to interpret whatever structure is actually on the page/text.
    const categoryHint = knownCategories.length > 0
      ? `This business's known categories are: ${knownCategories.join(', ')}. For each line, suggest the closest fitting category from that list, or null if genuinely none fit. Don't invent a new category name.`
      : `This business has no categories set up yet — leave "category" null for every line.`;
    // Some ledgers (especially pharmacy-style stock registers) have SEPARATE
    // columns for stock received, stock issued/sold, and running balance —
    // all for the same item, on the same row. Without knowing which one the
    // person actually wants, "quantity" is ambiguous. The current Notebook
    // mode disambiguates this.
    const quantityHint = mode === 'stock'
      ? `The person is in "Stock Arrival" mode — they're recording new stock coming IN. If a row has separate columns like "Qty Received"/"Stock In" vs "Qty Issued"/"Stock Out" vs "Balance", use the RECEIVED/STOCK-IN number as "quantity" and ignore the issued and balance numbers. If there's only one quantity on the line, use that.`
      : `The person is in "Recording Sales" mode — they're logging what was SOLD. If a row has separate columns like "Qty Issued"/"Stock Out"/"Sold" vs "Qty Received" vs "Balance", use the ISSUED/SOLD/STOCK-OUT number as "quantity" and ignore the received and balance numbers. A dash or blank in the issued column means nothing was sold on that row — skip that line entirely rather than inventing a number. If there's only one quantity on the line, use that.`;
    const expiryHint =
      `If a row has an expiry/expiration date, put it in "expiryDate" as strict YYYY-MM-DD. If only a month and year are ` +
      `given (e.g. "January 2027" or "01/27"), use the LAST day of that month (e.g. "2027-01-31"), since the product is ` +
      `valid through the end of that month. If no expiry is present or it's unreadable, use null — never guess a date. ` +
      `If a row has a batch or lot number/code, put it in "batchNumber" exactly as written; otherwise null.`;
    const instructions =
      `This is a business's own sales or inventory ledger — it could be a photo of a handwritten/printed page, ` +
      `or text already extracted from that page (e.g. via Google Lens) and pasted in. Different businesses lay ` +
      `this out differently (item then price, qty x item @unit price, shorthand abbreviations, etc.) — read ` +
      `whatever structure is actually there rather than expecting one fixed format. Lens-extracted text especially ` +
      `can be messy — numbers fused to words, stray brackets or symbols from table borders, misaligned columns, ` +
      `and entire rows run together with no clear line breaks between them (e.g. a date, item name, batch code, ` +
      `expiry date, and multiple quantity columns all concatenated in sequence). Use context clues — units like ` +
      `cartons/packs/bottles, batch-code patterns, date-like tokens, keywords like "Delivered"/"Sold"/"Restocked" — ` +
      `to figure out where one row ends and the next begins. Do your best to pull real item lines out of that noise. ` +
      `${quantityHint} ${expiryHint} ` +
      `Extract every line item you can make out. ${categoryHint} ` +
      `Respond with ONLY a JSON array — no explanation, no markdown code fences, no commentary before or after it, ` +
      `even if the input looks unusual or you're unsure. In this exact shape: ` +
      `[{"description": "...", "quantity": number, "amount": number_or_null, "category": string_or_null, "expiryDate": string_or_null, "batchNumber": string_or_null}]. ` +
      `If a quantity or amount is unreadable or absent, use null. Do not guess values that aren't actually there. ` +
      `If truly nothing on the page looks like an item line, respond with an empty array [].`;

    // Gemini's generateContent takes a flat "parts" array — text and inline
    // image data side by side, order doesn't matter the way it can for Claude.
    const parts = hasImage
      ? [
          { text: instructions },
          { inline_data: { mime_type: mediaType || 'image/jpeg', data: imageBase64 } },
        ]
      : [
          { text: `${instructions}\n\nHere is the pasted ledger text:\n\n${pastedText}` },
        ];

    const aiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts }],
          generationConfig: {
            maxOutputTokens: 8192,
            responseMimeType: 'application/json',
            responseSchema: {
              type: 'ARRAY',
              items: {
                type: 'OBJECT',
                properties: {
                  description: { type: 'STRING' },
                  quantity: { type: 'NUMBER', nullable: true },
                  amount: { type: 'NUMBER', nullable: true },
                  category: { type: 'STRING', nullable: true },
                  expiryDate: { type: 'STRING', nullable: true },
                  batchNumber: { type: 'STRING', nullable: true },
                },
                required: ['description'],
              },
            },
          },
        }),
      }
    );

    const aiData = await aiRes.json();
    if (!aiRes.ok) {
      console.error('[ocr] Gemini API error:', aiData);
      return res.status(502).json({ error: 'Vision extraction failed', debug: aiData?.error?.message || JSON.stringify(aiData).slice(0, 500) });
    }

    const finishReason = aiData.candidates?.[0]?.finishReason;
    const text = (aiData.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
    // Don't assume the whole response is pure JSON — strip fences if present,
    // then pull out the first [...] block from wherever it actually sits in
    // the response. Survives the model adding a stray sentence of commentary
    // before or after the array, which happens more often on messy/ambiguous
    // input than on a clean, obvious ledger.
    const fenceStripped = text.replace(/```json\s*|```/g, '');
    const arrayMatch = fenceStripped.match(/\[[\s\S]*\]/);
    const cleaned = arrayMatch ? arrayMatch[0] : fenceStripped;
    let rows;
    try {
      const parsed = JSON.parse(cleaned);
      rows = Array.isArray(parsed) ? parsed : (parsed.items || parsed.rows || parsed.lines || []);
      if (!Array.isArray(rows)) throw new Error('not an array');
    } catch (e) {
      console.error('[ocr] could not parse Gemini output:', text);
      if (finishReason === 'MAX_TOKENS') {
        // The response was cut off mid-generation — too many line items for
        // one request, not a formatting problem. Splitting the input is the
        // actual fix here, not a clearer photo.
        return res.status(502).json({
          error: 'This page has too many line items to process in one go — try splitting it into two smaller photos or pastes.',
          debug: `Response was truncated at the token limit (finishReason: MAX_TOKENS). Partial output: ${text.slice(-300)}`,
        });
      }
      return res.status(502).json({
        error: hasImage ? 'Could not parse extracted data — try a clearer photo' : 'Could not parse the pasted text — check it copied over correctly',
        // Raw model output, truncated — lets you see exactly what it said
        // instead of having to go dig through Render's server logs.
        debug: text.slice(0, 800),
      });
    }

    const inventory = (await pool.query('SELECT * FROM inventory_items WHERE business_id = $1', [req.user.businessId])).rows;

    const reviewed = rows.map((row) => {
      const match = fuzzyMatchItem(row.description, inventory);
      const qty = row.quantity || 1;
      const unitPrice = match ? Number(match.item.sale_price) : null;
      // Only pass through a date that actually matches the format we asked
      // for — protects the frontend's <input type="date"> from receiving
      // something malformed if the model didn't follow instructions exactly.
      const validExpiry = row.expiryDate && /^\d{4}-\d{2}-\d{2}$/.test(row.expiryDate) ? row.expiryDate : null;
      return {
        rawDescription: row.description,
        quantity: qty,
        amountOnPage: row.amount,
        suggestedCategory: row.category || null,
        suggestedExpiryDate: validExpiry,
        suggestedBatchNumber: row.batchNumber || null,
        matchedItem: match ? { id: match.item.id, name: match.item.name, confidence: Number(match.confidence.toFixed(2)) } : null,
        suggestedTotal: unitPrice ? unitPrice * qty : row.amount,
        needsReview: !match || match.confidence < 0.6,
      };
    });

    const totalFromPage = reviewed.reduce((s, r) => s + (r.suggestedTotal || 0), 0);
    res.json({ rows: reviewed, totalFromPage, rowCount: reviewed.length });
  } catch (err) {
    console.error('[ocr] error:', err);
    res.status(500).json({ error: 'Could not process the ledger entry', debug: err.message });
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

// Quick test — sends a single WhatsApp message to TWILIO_WHATSAPP_TO to verify credentials
app.post('/internal/test-whatsapp', async (req, res) => {
  const to = process.env.TWILIO_WHATSAPP_TO;
  if (!to) return res.status(400).json({ error: 'TWILIO_WHATSAPP_TO not set in environment' });
  try {
    const result = await sendWhatsAppMessage(to, '✅ TodayBread WhatsApp is working! Your daily summaries will arrive at 9 PM Lagos time.');
    res.json({ success: true, sid: result.sid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const [businesses, users, sales, items, activeBusinesses, ghostBusinesses, recentSignups] = await Promise.all([
      pool.query('SELECT count(*) FROM businesses'),
      pool.query('SELECT count(*) FROM users'),
      pool.query('SELECT count(*), COALESCE(SUM(qty * unit_price), 0) AS total_revenue FROM sales'),
      pool.query('SELECT count(*) FROM inventory_items'),
      // Active: had at least one sale in the last 7 days
      pool.query(`SELECT count(DISTINCT business_id) FROM sales WHERE occurred_at >= $1`, [sevenDaysAgo]),
      // Ghost: signed up but never recorded a single sale
      pool.query(`SELECT count(*) FROM businesses b WHERE NOT EXISTS (SELECT 1 FROM sales s WHERE s.business_id = b.id)`),
      // New signups in last 7 days
      pool.query(`SELECT count(*) FROM businesses WHERE created_at >= $1`, [sevenDaysAgo]),
    ]);

    res.json({
      totalBusinesses: Number(businesses.rows[0].count),
      totalUsers: Number(users.rows[0].count),
      totalSales: Number(sales.rows[0].count),
      totalRevenue: Number(sales.rows[0].total_revenue),
      totalItems: Number(items.rows[0].count),
      activeBusinesses: Number(activeBusinesses.rows[0].count),
      ghostBusinesses: Number(ghostBusinesses.rows[0].count),
      recentSignups: Number(recentSignups.rows[0].count),
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
        b.trial_ends_at, b.next_due_date, b.monthly_fee,
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
      GROUP BY b.id, b.name, b.address, b.whatsapp_number, b.created_at, b.trial_ends_at, b.next_due_date, b.monthly_fee, u.name, u.phone
      ORDER BY b.next_due_date ASC NULLS LAST
    `);
    res.json({ businesses: result.rows });
  } catch (err) {
    console.error('[/admin/businesses]', err.message);
    res.status(500).json({ error: 'Could not load businesses' });
  }
});

// POST /admin/businesses/:id/mark-paid — advances the business's due date by
// 30 days from its OLD due date (not from today), keeping them on their
// original monthly schedule even if payment came in late. Also clears the
// reminder flag so the next cycle's 7-day-before WhatsApp reminder can fire.
app.post('/admin/businesses/:id/mark-paid', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE businesses
       SET next_due_date = COALESCE(next_due_date, now()) + interval '30 days',
           reminder_sent_for_due_date = NULL
       WHERE id = $1
       RETURNING id, next_due_date`,
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Business not found' });
    res.json({ marked: true, nextDueDate: result.rows[0].next_due_date });
  } catch (err) {
    console.error('[/admin/businesses/:id/mark-paid]', err.message);
    res.status(500).json({ error: 'Could not mark as paid' });
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

// GET /admin/pin-resets — list users who requested a PIN reset
app.get('/admin/pin-resets', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT u.id, u.name, u.phone, b.name AS business_name
      FROM users u
      LEFT JOIN businesses b ON b.id = u.business_id
      WHERE u.pin_reset_requested = true
      ORDER BY u.name
    `);
    res.json({ resets: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Could not load reset requests' });
  }
});

// POST /admin/pin-resets/:userId/resolve — super admin resets a user's PIN
app.post('/admin/pin-resets/:userId/resolve', requireAuth, requireSuperAdmin, async (req, res) => {
  const { newPin } = req.body;
  if (!newPin || newPin.length < 4) return res.status(400).json({ error: 'New PIN must be at least 4 digits' });
  try {
    const pinHash = await bcrypt.hash(String(newPin), 10);
    await pool.query('UPDATE users SET pin_hash = $1, pin_reset_requested = false WHERE id = $2', [pinHash, req.params.userId]);
    res.json({ resolved: true });
  } catch (err) {
    res.status(500).json({ error: 'Could not resolve PIN reset' });
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
  scheduleSubscriptionReminderJob();
});
