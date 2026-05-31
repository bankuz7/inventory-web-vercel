const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();

// CORS
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'https://inventory-web-vercel.vercel.app,http://localhost:3000').split(',');
app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(express.static('public', { maxAge: '1d', etag: true }));

// Combined logging + CORS preflight
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
 console.error('Missing SUPABASE_URL / SUPABASE_ANON_KEY — local fallback will be active.');
}

const supabasePublic = createClient(
 SUPABASE_URL || 'https://placeholder.supabase.co',
 SUPABASE_ANON_KEY || 'placeholder',
 { auth: { persistSession: false } }
);

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

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// FALLBACK STORES — local JSON when Supabase is down
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const fs2 = require('fs');
const path2 = require('path');
const DATA_DIR = path2.join(__dirname, 'data');
const DB_FILE = path2.join(DATA_DIR, 'db.json');

function ensureDataDir() { if (!fs2.existsSync(DATA_DIR)) fs2.mkdirSync(DATA_DIR, { recursive: true }); }
function loadLocalDB() {
 ensureDataDir();
 if (!fs2.existsSync(DB_FILE)) fs2.writeFileSync(DB_FILE, JSON.stringify({ inventory: [], history: [] }, null, 2));
 try { return JSON.parse(fs2.readFileSync(DB_FILE, 'utf8')); } catch { return { inventory: [], history: [] }; }
}
function saveLocalDB(db) { ensureDataDir(); fs2.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }

let useLocal = false;
let localDB = loadLocalDB();
let nextInventoryId = (localDB.inventory.length ? Math.max(...localDB.inventory.map(i => i.id)) : 0) + 1;
let nextHistoryId = (localDB.history.length ? Math.max(...localDB.history.map(i => i.id)) : 0) + 1;

async function ensureSupabase() {
 if (useLocal) return true;
 if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.warn('[FALLBACK] No Supabase env — using local JSON');
  useLocal = true;
  return true;
 }
 try {
  const { error } = await supabaseAdmin.from('inventory').select('id').limit(1);
  if (error) throw error;
  return true;
 } catch (e) {
  console.warn('[FALLBACK] Supabase unreachable — using local JSON:', e.message);
  useLocal = true;
  return true;
 }
}

async function localLogHistory(entry) {
 const rec = {
  id: nextHistoryId++,
  item_id: entry.item_id ?? null,
  item_name: entry.item_name ?? null,
  action: entry.action,
  delta: toInt(entry.delta),
  qty_before: entry.qty_before,
  qty_after: entry.qty_after,
  table_number: entry.table_number ?? null,
  created_at: new Date().toISOString(),
 };
 localDB.history.unshift(rec);
 if (localDB.history.length > 5000) localDB.history.length = 5000;
 saveLocalDB(localDB);
 return rec;
}

// ─────────────────── AUTH ───────────────────
const requirePin = (req, res, next) => {
 const pin = req.headers['x-admin-pin'];
 if (pin !== (process.env.ADMIN_PIN || '9712')) {
  return res.status(401).json({ error: 'Unauthorized: Invalid or missing Admin PIN' });
 }
 next();
};

// ─────────────────── PUBLIC ROUTES ───────────────────

// Read-only: full inventory
app.get('/api/inventory', asyncHandler(async (_req, res) => {
 await ensureSupabase();
 if (useLocal) return res.json(localDB.inventory || []);
 const { data, error } = await supabasePublic
 .from('inventory').select('*').order('id', { ascending: true });
 if (error) throw error;
 res.json(data || []);
}));

// Read-only: history log (server-side filtered)
app.get('/api/history', asyncHandler(async (req, res) => {
 await ensureSupabase();
 const limit = Math.min(Math.max(toInt(req.query.limit, 200), 1), 1000);
 const tableNumber = req.query.table_number ? String(req.query.table_number).trim() : null;
 const dateFilter = String(req.query.date || '').trim();

 if (useLocal) {
  let rows = [...(localDB.history || [])];
  if (tableNumber) rows = rows.filter(r => r.table_number === tableNumber);
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (dateFilter === 'today') rows = rows.filter(r => new Date(r.created_at) >= startOfDay);
  else if (dateFilter === 'yesterday') {
  const yesterdayStart = new Date(startOfDay); yesterdayStart.setDate(yesterdayStart.getDate() - 1);
  const todayEnd = new Date(startOfDay);
  rows = rows.filter(r => { const d = new Date(r.created_at); return d >= yesterdayStart && d < todayEnd; });
  }
  rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  return res.json(rows.slice(0, limit));
 }

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
 await ensureSupabase();
 if (useLocal) {
  const items = localDB.inventory || [];
  const totalItems = items.length;
  let totalValue = 0, lowStock = 0, outOfStock = 0;
  const categories = new Set();
  items.forEach(item => {
  const qty = toInt(item.quantity);
  const cost = parseFloat(item.cost_per_unit || 0);
  totalValue += qty * cost;
  if (qty === 0) outOfStock++;
  else if (qty <= 5) lowStock++;
  if (item.category) categories.add(item.category);
  });
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const todayTxns = (localDB.history || []).filter(t => new Date(t.created_at) >= todayStart && ['add', 'adjust', 'delete', 'table_assign'].includes(t.action));
  return res.json({ totalItems, categories: categories.size, totalValue: Math.round(totalValue * 100) / 100, lowStock, outOfStock, todayTransactions: todayTxns.length });
 }

 const { data: items, error: itemsErr } = await supabasePublic
 .from('inventory').select('id,quantity,cost_per_unit,created_at,updated_at');
 if (itemsErr) throw itemsErr;

 const totalItems = items?.length || 0;
 let totalValue = 0, lowStock = 0, outOfStock = 0;
 const categories = new Set();
 (items || []).forEach(item => {
  const qty = toInt(item.quantity);
  const cost = parseFloat(item.cost_per_unit || 0);
  totalValue += qty * cost;
  if (qty === 0) outOfStock++;
  else if (qty <= 5) lowStock++;
  if (item.category) categories.add(item.category);
 });

 const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
 const { data: todayTxns, error: txnErr } = await supabasePublic
 .from('inventory_history').select('action').gte('created_at', todayStart.toISOString());
 if (txnErr) throw txnErr;
 const todayCount = (todayTxns || []).filter((t) => ['add', 'adjust', 'delete', 'table_assign'].includes(t.action)).length;

 res.json({ totalItems, categories: categories.size, totalValue: Math.round(totalValue * 100) / 100, lowStock, outOfStock, todayTransactions: todayCount });
}));

// ─────────────────── ADMIN ROUTES ───────────────────

// Add item
app.post('/api/inventory', requirePin, asyncHandler(async (req, res) => {
 await ensureSupabase();
 const { name, quantity, category = 'General', unit = 'pcs', cost_per_unit = 0, max_stock = 0, supplier = '', expiry = null, notes = '' } = req.body;

 if (!name || String(name).trim().length === 0) return res.status(400).json({ error: 'Item name is required' });

 const qty = toInt(quantity);
 const now = new Date().toISOString();

 if (useLocal) {
  const item = {
  id: nextInventoryId++,
  name: String(name).trim(),
  quantity: qty,
  category,
  unit,
  cost_per_unit: parseFloat(cost_per_unit) || 0,
  max_stock: toInt(max_stock),
  supplier: String(supplier).trim(),
  expiry: expiry || null,
  notes: String(notes).trim(),
  updated_at: now,
  };
  localDB.inventory.push(item);
  saveLocalDB(localDB);
  await localLogHistory({ item_id: item.id, item_name: item.name, action: 'add', delta: qty, qty_before: null, qty_after: qty });
  return res.json(item);
 }

 const { data, error } = await supabaseAdmin
 .from('inventory')
 .insert([{ name: String(name).trim(), quantity: qty, category, unit, cost_per_unit: parseFloat(cost_per_unit) || 0, max_stock: toInt(max_stock), supplier: String(supplier).trim(), expiry: expiry || null, notes: String(notes).trim(), updated_at: now }])
 .select().single();
 if (error) throw error;

 try { await localLogHistory({ item_id: data.id, item_name: data.name, action: 'add', delta: qty, qty_before: null, qty_after: qty }); } catch (_) {}
 res.json(data);
}));

// Update category
app.post('/api/inventory/:id/category', requirePin, asyncHandler(async (req, res) => {
 await ensureSupabase();
 const id = toInt(req.params.id);
 const category = String(req.body.category || 'General').trim();
 if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid ID' });

 if (useLocal) {
  const item = localDB.inventory.find(i => i.id === id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  const before = item.quantity;
  const now = new Date().toISOString();
  item.category = category;
  item.updated_at = now;
  saveLocalDB(localDB);
  await localLogHistory({ item_id: id, item_name: item.name, action: 'category', delta: 0, qty_before: before, qty_after: before });
  return res.json({ updated: 1, category, updated_at: now });
 }

 const { data: existing, error: fetchErr } = await supabaseAdmin
 .from('inventory').select('name,quantity').eq('id', id).single();
 if (fetchErr || !existing) return res.status(404).json({ error: 'Item not found' });

 const now = new Date().toISOString();
 const { error: updateErr } = await supabaseAdmin.from('inventory').update({ category, updated_at: now }).eq('id', id);
 if (updateErr) throw updateErr;
 try { await localLogHistory({ item_id: id, item_name: existing.name, action: 'category', delta: 0, qty_before: existing.quantity, qty_after: existing.quantity }); } catch (_) {}
 res.json({ updated: 1, category, updated_at: now });
}));

// Adjust quantity
app.post('/api/inventory/:id/update', requirePin, asyncHandler(async (req, res) => {
 await ensureSupabase();
 const id = toInt(req.params.id);
 const mode = req.body.mode || 'set';
 const newQty = parseFloat(req.body.newQuantity);
 if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid ID' });
 if (!Number.isFinite(newQty) || newQty < 0) return res.status(400).json({ error: 'Invalid quantity' });

 if (useLocal) {
  const item = localDB.inventory.find(i => i.id === id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  const before = toInt(item.quantity);
  const after = mode === 'add' ? before + newQty : mode === 'sub' ? Math.max(0, before - newQty) : newQty;
  if (after < 0) return res.status(400).json({ error: `Insufficient stock (have ${before})` });
  const now = new Date().toISOString();
  item.quantity = after;
  item.updated_at = now;
  saveLocalDB(localDB);
  const delta = after - before;
  await localLogHistory({ item_id: id, item_name: item.name, action: 'adjust', delta, qty_before: before, qty_after: after });
  return res.json({ updated: 1, newQuantity: after, updated_at: now });
 }

 const { data: existing, error: fetchErr } = await supabaseAdmin.from('inventory').select('name,quantity').eq('id', id).single();
 if (fetchErr || !existing) return res.status(404).json({ error: 'Item not found' });

 const before = toInt(existing.quantity);
 const after = mode === 'add' ? before + newQty : mode === 'sub' ? Math.max(0, before - newQty) : newQty;
 if (after < 0) return res.status(400).json({ error: `Insufficient stock (have ${before})` });
 const now = new Date().toISOString();

 const { error: updateErr } = await supabaseAdmin.from('inventory').update({ quantity: after, updated_at: now }).eq('id', id);
 if (updateErr) throw updateErr;
 try { await localLogHistory({ item_id: id, item_name: existing.name, action: 'adjust', delta: after - before, qty_before: before, qty_after: after }); } catch (_) {}
 res.json({ updated: 1, newQuantity: after, updated_at: now });
}));

// Delete item
app.delete('/api/inventory/:id', requirePin, asyncHandler(async (req, res) => {
 await ensureSupabase();
 const id = toInt(req.params.id);
 if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid ID' });

 if (useLocal) {
  const idx = localDB.inventory.findIndex(i => i.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Item not found' });
  const item = localDB.inventory[idx];
  const before = item.quantity;
  localDB.inventory.splice(idx, 1);
  saveLocalDB(localDB);
  await localLogHistory({ item_id: id, item_name: item.name, action: 'delete', delta: 0, qty_before: before, qty_after: null });
  return res.json({ deleted: true });
 }

 const { data: existing, error: fetchErr } = await supabaseAdmin.from('inventory').select('name,quantity').eq('id', id).single();
 if (fetchErr || !existing) return res.status(404).json({ error: 'Item not found' });

 const { error: deleteErr } = await supabaseAdmin.from('inventory').delete().eq('id', id);
 if (deleteErr) throw deleteErr;
 try { await localLogHistory({ item_id: id, item_name: existing.name, action: 'delete', delta: 0, qty_before: existing.quantity, qty_after: null }); } catch (_) {}
 res.json({ deleted: true });
}));

// Batch table assignment
app.post('/api/table/assign', requirePin, asyncHandler(async (req, res) => {
 await ensureSupabase();
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

 if (useLocal) {
  const item = localDB.inventory.find(i => i.id === itemId);
  if (!item) return res.status(404).json({ error: `Item ${itemId} not found` });
  const before = toInt(item.quantity);
  const after = before - qty;
  if (after < 0) return res.status(400).json({ error: `Insufficient stock for ${item.name}. Available: ${before}` });
  const now = new Date().toISOString();
  item.quantity = after;
  item.updated_at = now;
  saveLocalDB(localDB);
  try { await localLogHistory({ item_id: itemId, item_name: item.name, action: 'table_assign', delta: -qty, qty_before: before, qty_after: after, table_number: String(table_number) }); } catch (_) {}
  results.push({ item_id: itemId, item_name: item.name, assigned: qty, remaining: after });
  continue;
 }

 const { data: item, error: itemErr } = await supabaseAdmin
 .from('inventory').select('name,quantity').eq('id', itemId).single();
 if (itemErr) return res.status(404).json({ error: `Item ${itemId} not found` });

 const before = toInt(item.quantity);
 const after = before - qty;
 if (after < 0) return res.status(400).json({ error: `Insufficient stock for ${item.name}. Available: ${before}` });

 const now = new Date().toISOString();
 const { error: updateErr } = await supabaseAdmin.from('inventory').update({ quantity: after, updated_at: now }).eq('id', itemId);
 if (updateErr) throw updateErr;

 try {
  await localLogHistory({ item_id: itemId, item_name: item.name, action: 'table_assign', delta: -qty, qty_before: before, qty_after: after, table_number: String(table_number) });
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
 await ensureSupabase();
 const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);

 if (useLocal) {
  const rows = (localDB.history || []).filter(r => new Date(r.created_at) >= todayStart);
  const summary = {};
  rows.forEach(row => {
  const tbl = row.table_number || 'unknown';
  if (!summary[tbl]) summary[tbl] = { moves: 0, lastAt: null, assignCount: 0 };
  summary[tbl].moves++;
  summary[tbl].lastAt = row.created_at;
  if (row.action === 'table_assign') summary[tbl].assignCount++;
  });
  return res.json(summary);
 }

 const { data, error } = await supabasePublic
 .from('inventory_history').select('table_number, action, delta, created_at')
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
 res.json({ status: 'ok', local: useLocal, timestamp: new Date().toISOString() });
});

module.exports = app;

if (require.main === module) {
 const PORT = process.env.PORT || 3000;
 app.listen(PORT, () => console.log(`Inventory API on :${PORT}`));
}
