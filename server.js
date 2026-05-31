const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();

// CORS with explicit origin whitelist
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'https://inventory-web-vercel.vercel.app,http://localhost:3000').split(',');
app.use(cors({ origin: allowedOrigins, credentials: true }));

app.use(express.json({ limit: '1mb' }));
app.use(express.static('public', { maxAge: '1d', etag: true }));

// Request + CORS combined middleware (preflight-safe)
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && !allowedOrigins.includes(origin) && process.env.NODE_ENV !== 'development') {
    return res.status(403).json({ error: 'Origin not allowed' });
  }
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
  next();
});

// ─────────────────── ENV ───────────────────
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_ANON_KEY — app will not function.');
}

// Public client (read-only, RLS-protected)
const supabasePublic = createClient(
  SUPABASE_URL || 'https://placeholder.supabase.co',
  SUPABASE_ANON_KEY || 'placeholder',
  { auth: { persistSession: false } }
);

// Admin client (bypasses RLS for writes — secret, never expose to browser)
const supabaseAdmin = createClient(
  SUPABASE_URL || 'https://placeholder.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY || 'missing-service-role-key',
  { auth: { persistSession: false } }
);

// ─────────────────── HELPERS ───────────────────
function toInt(n, fallback = 0) {
  const v = parseInt(String(n), 10);
  return Number.isFinite(v) ? v : fallback;
}

function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch((err) => {
      console.error(`[${req.method} ${req.originalUrl}] —`, err.message);
      res.status(500).json({ error: err.message || 'Internal server error' });
    });
  };
}

async function logHistory(entry) {
  const payload = {
    item_id: entry.item_id ?? null,
    item_name: entry.item_name ?? null,
    action: entry.action,
    delta: toInt(entry.delta),
    qty_before: entry.qty_before,
    qty_after: entry.qty_after,
    table_number: entry.table_number ?? null,
    created_at: new Date().toISOString(),
  };

  try {
    const { error } = await supabaseAdmin
      .from('inventory_history')
      .insert([payload]);

    if (error) {
      const msg = String(error.message || '').toLowerCase();
      if (msg.includes('column') || msg.includes('schema') || msg.includes('table_number')) {
        // Retry without table_number if column is missing
        await supabaseAdmin.from('inventory_history').insert([{ ...payload, table_number: null }]);
        return;
      }
      throw error;
    }
  } catch (err) {
    console.error('History log failed:', err.message);
    // Don't break the main request flow on history failures
  }
}

const requirePin = (req, res, next) => {
  const pin = req.headers['x-admin-pin'];
  if (pin !== (process.env.ADMIN_PIN || '9712')) {
    return res.status(401).json({ error: 'Unauthorized: Invalid or missing Admin PIN' });
  }
  if (!SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'Server misconfigured: missing SUPABASE_SERVICE_ROLE_KEY' });
  }
  next();
};

// ─────────────────── PUBLIC ROUTES ───────────────────

// Read-only: full inventory
app.get('/api/inventory', asyncHandler(async (req, res) => {
  const { data, error } = await supabasePublic
    .from('inventory')
    .select('*')
    .order('id', { ascending: true });

  if (error) throw error;
  res.json(data || []);
}));

// Read-only: history log (server-side filtered)
app.get('/api/history', asyncHandler(async (req, res) => {
  const limit = Math.min(Math.max(toInt(req.query.limit, 200), 1), 1000);
  const tableNumber = req.query.table_number ? String(req.query.table_number).trim() : null;
  const dateFilter = String(req.query.date || '').trim();

  let query = supabasePublic
    .from('inventory_history')
    .select('id,item_id,item_name,action,delta,qty_before,qty_after,table_number,created_at');

  if (tableNumber) query = query.eq('table_number', tableNumber);

  const now = new Date();
  if (dateFilter === 'today') {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    query = query.gte('created_at', start.toISOString());
  } else if (dateFilter === 'yesterday') {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    query = query.gte('created_at', start.toISOString()).lt('created_at', end.toISOString());
  }

  const { data, error } = await query
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw error;
  res.json(data || []);
}));

// Public: summary stats (for dashboard + report)
app.get('/api/stats', asyncHandler(async (_req, res) => {
  const { data: items, error: itemsErr } = await supabasePublic
    .from('inventory')
    .select('id,quantity,cost_per_unit,created_at,updated_at');

  if (itemsErr) throw itemsErr;

  const totalItems = items?.length || 0;

  let totalValue = 0;
  let lowStock = 0;
  let outOfStock = 0;
  const categories = new Set();

  (items || []).forEach((item) => {
    const qty = toInt(item.quantity);
    const cost = parseFloat(item.cost_per_unit || 0);
    totalValue += qty * cost;
    if (qty === 0) outOfStock++;
    else if (qty <= 5) lowStock++;
    if (item.category) categories.add(item.category);
  });

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const { data: todayTxns, error: txnErr } = await supabasePublic
    .from('inventory_history')
    .select('action')
    .gte('created_at', todayStart.toISOString());

  const todayCount = (todayTxns || []).filter((t) =>
    ['add', 'adjust', 'delete', 'table_assign'].includes(t.action)
  ).length;

  res.json({
    totalItems,
    categories: categories.size,
    totalValue: Math.round(totalValue * 100) / 100,
    lowStock,
    outOfStock,
    todayTransactions: todayCount,
  });
}));

// ─────────────────── ADMIN ROUTES ───────────────────

// Add item
app.post('/api/inventory', requirePin, asyncHandler(async (req, res) => {
  const { name, quantity, category = 'General' } = req.body;

  if (!name || String(name).trim().length === 0) {
    return res.status(400).json({ error: 'Item name is required' });
  }

  const qty = toInt(quantity);
  const now = new Date().toISOString();

  const { data, error } = await supabaseAdmin
    .from('inventory')
    .insert([{ name: String(name).trim(), quantity: qty, category, updated_at: now }])
    .select()
    .single();

  if (error) throw error;

  const inserted = data;
  if (inserted?.id) {
    try {
      await logHistory({
        item_id: inserted.id,
        item_name: inserted.name,
        action: 'add',
        delta: qty,
        qty_before: null,
        qty_after: qty,
      });
    } catch (_) {
      // best-effort history
    }
  }

  res.json(inserted);
}));

// Update category
app.post('/api/inventory/:id/category', requirePin, asyncHandler(async (req, res) => {
  const id = toInt(req.params.id);
  const category = String(req.body.category || 'General').trim();

  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid ID' });

  const { data: existing, error: fetchErr } = await supabaseAdmin
    .from('inventory')
    .select('name,quantity')
    .eq('id', id)
    .single();

  if (fetchErr || !existing) return res.status(404).json({ error: 'Item not found' });

  const now = new Date().toISOString();
  const { error: updateErr } = await supabaseAdmin
    .from('inventory')
    .update({ category, updated_at: now })
    .eq('id', id);

  if (updateErr) throw updateErr;

  try {
    await logHistory({
      item_id: id,
      item_name: existing.name,
      action: 'category',
      delta: 0,
      qty_before: existing.quantity,
      qty_after: existing.quantity,
    });
  } catch (_) {
    // best-effort
  }

  res.json({ updated: 1, category, updated_at: now });
}));

// Adjust quantity
app.post('/api/inventory/:id/update', requirePin, asyncHandler(async (req, res) => {
  const id = toInt(req.params.id);
  const delta = toInt(req.body.delta);

  if (!Number.isFinite(id) || !Number.isFinite(delta)) {
    return res.status(400).json({ error: 'Invalid ID or delta' });
  }

  const { data: existing, error: fetchErr } = await supabaseAdmin
    .from('inventory')
    .select('name,quantity')
    .eq('id', id)
    .single();

  if (fetchErr || !existing) return res.status(404).json({ error: 'Item not found' });

  const before = toInt(existing.quantity);
  const after = before + delta;
  if (after < 0) return res.status(400).json({ error: `Insufficient stock (have ${before})` });

  const now = new Date().toISOString();
  const { error: updateErr } = await supabaseAdmin
    .from('inventory')
    .update({ quantity: after, updated_at: now })
    .eq('id', id);

  if (updateErr) throw updateErr;

  try {
    await logHistory({
      item_id: id,
      item_name: existing.name,
      action: 'adjust',
      delta,
      qty_before: before,
      qty_after: after,
    });
  } catch (_) {}

  res.json({ updated: 1, newQuantity: after, updated_at: now });
}));

// Delete item
app.delete('/api/inventory/:id', requirePin, asyncHandler(async (req, res) => {
  const id = toInt(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid ID' });

  const { data: existing, error: fetchErr } = await supabaseAdmin
    .from('inventory')
    .select('name,quantity')
    .eq('id', id)
    .single();

  if (fetchErr || !existing) return res.status(404).json({ error: 'Item not found' });

  const { error: deleteErr } = await supabaseAdmin
    .from('inventory')
    .delete()
    .eq('id', id);

  if (deleteErr) throw deleteErr;

  try {
    await logHistory({
      item_id: id,
      item_name: existing.name,
      action: 'delete',
      delta: 0,
      qty_before: existing.quantity,
      qty_after: null,
    });
  } catch (_) {}

  res.json({ deleted: true });
}));

// Batch table assignment
app.post('/api/table/assign', requirePin, asyncHandler(async (req, res) => {
  const { table_number, assignments } = req.body;

  if (!table_number || !Array.isArray(assignments) || assignments.length === 0) {
    return res.status(400).json({ error: 'table_number and non-empty assignments[] are required' });
  }

  const results = [];
  for (const a of assignments) {
    const itemId = toInt(a.item_id);
    const qty = toInt(a.delta);

    if (!Number.isFinite(itemId) || !Number.isFinite(qty) || qty <= 0) {
      return res.status(400).json({ error: `Invalid assignment for item ${a.item_id}` });
    }

    const { data: item, error: itemErr } = await supabaseAdmin
      .from('inventory')
      .select('name,quantity')
      .eq('id', itemId)
      .single();

    if (itemErr) return res.status(404).json({ error: `Item ${itemId} not found` });

    const before = toInt(item.quantity);
    const after = before - qty;

    if (after < 0) return res.status(400).json({ error: `Insufficient stock for ${item.name}. Available: ${before}` });

    const now = new Date().toISOString();
    const { error: updateErr } = await supabaseAdmin
      .from('inventory')
      .update({ quantity: after, updated_at: now })
      .eq('id', itemId);

    if (updateErr) throw updateErr;

    try {
      await logHistory({
        item_id: itemId,
        item_name: item.name,
        action: 'table_assign',
        delta: -qty,
        qty_before: before,
        qty_after: after,
        table_number: String(table_number),
      });
    } catch (e) {
      results.push({ item_id: itemId, item_name: item.name, warning: e.message });
      continue;
    }

    results.push({ item_id: itemId, item_name: item.name, assigned: qty, remaining: after });
  }

  res.json({ assigned_to: table_number, results });
}));

// ─────────────────── TABLE STATS ───────────────────
app.get('/api/tables/summary', asyncHandler(async (_req, res) => {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const { data, error } = await supabasePublic
    .from('inventory_history')
    .select('table_number, action, delta, created_at')
    .gte('created_at', todayStart.toISOString());

  if (error) throw error;

  const summary = {};
  (data || []).forEach(row => {
    const tbl = row.table_number || 'unknown';
    if (!summary[tbl]) summary[tbl] = { moves: 0, lastAt: null, assignCount: 0 };
    summary[tbl].moves++;
    summary[tbl].lastAt = row.created_at;
    if (row.action === 'table_assign') summary[tbl].assignCount++;
  });

  res.json(summary);
}));

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Export
module.exports = app;

// Local dev boot
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Inventory API on :${PORT}`));
}
