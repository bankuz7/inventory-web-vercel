const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();

// CORS with configurable origin list
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'https://inventory-web-vercel.vercel.app,http://localhost:3000').split(',');
const corsMiddleware = cors({ origin: allowedOrigins, credentials: true });
app.use((req, res, next) => {
  corsMiddleware(req, res, (err) => {
    if (err) {
      res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      return res.status(400).json({ error: 'CORS error: ' + err.message });
    }
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
    next();
  });
});

app.use(express.json({ limit: '1mb' }));
app.use(express.static('public', { maxAge: '1d', etag: true }));

// Request logger (after CORS so preflight is clean)
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
  next();
});

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_ANON_KEY environment variables — server may not function correctly.');
}

// Public client (used for report page reads)
const supabasePublic = createClient(
  SUPABASE_URL || 'https://placeholder.supabase.co',
  SUPABASE_ANON_KEY || 'placeholder',
  { auth: { persistSession: false } }
);

// Admin client (used ONLY for writes). Service role bypasses RLS.
const supabaseAdmin = createClient(
  SUPABASE_URL || 'https://placeholder.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY || 'missing-service-role-key',
  { auth: { persistSession: false } }
);

async function logHistory(entry) {
 // entry: { item_id, item_name, action, delta, qty_before, qty_after, table_number }
 const payload = {
 item_id: entry.item_id ?? null,
 item_name: entry.item_name ?? null,
 action: entry.action,
 delta: Number.isFinite(Number(entry.delta)) ? parseInt(entry.delta, 10) : 0,
 qty_before: Number.isFinite(Number(entry.qty_before)) ? parseInt(entry.qty_before, 10) : null,
 qty_after: Number.isFinite(Number(entry.qty_after)) ? parseInt(entry.qty_after, 10) : null,
 table_number: entry.table_number ?? null,
 created_at: new Date().toISOString(),
 };

 try {
 const { error } = await supabaseAdmin
 .from('inventory_history')
 .insert([payload]);

 if (error) {
 // If table_number column doesn't exist yet, retry without it
 const msg = String(error.message || '').toLowerCase();
 const shouldRetry = msg.includes('table_number') || msg.includes('column') || msg.includes('schema');
 if (shouldRetry) {
 const { error: retryErr } = await supabaseAdmin
 .from('inventory_history')
 .insert([{ ...payload, table_number: null }]);
 if (retryErr) throw retryErr;
 return;
 }
 throw error;
 }
 } catch (err) {
 // Don't throw from logging helper; callers decide whether to fail the request.
 console.error('History log failed:', err.message);
 }
}

const requirePin = (req, res, next) => {
  const pin = req.headers['x-admin-pin'];
  if (pin !== ADMIN_PIN) {
    return res.status(401).json({ error: 'Unauthorized: Invalid or missing Admin PIN' });
  }
  if (!SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({
      error: 'Server not configured: missing SUPABASE_SERVICE_ROLE_KEY in Vercel Environment Variables.'
    });
  }
  next();
};

// PUBLIC: Get all inventory for report
app.get('/api/inventory', async (req, res) => {
  try {
    const { data, error } = await supabasePublic
      .from('inventory')
      .select('*')
      .order('id', { ascending: true });

    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUBLIC: Recent change history (for report page)
// Supports optional filtering: ?table_number=D3&date=today&limit=100
app.get('/api/history', async (req, res) => {
  try {
    const rawLimit = req.query.limit || '300';
    const limit = Math.min(Math.max(parseInt(rawLimit, 10), 1), 1000);
    const tableNumber = req.query.table_number ? String(req.query.table_number).trim() : null;
    const dateFilter = req.query.date ? String(req.query.date).trim() : null;

    // Build Supabase query with server-side filters
    let query = supabasePublic
      .from('inventory_history')
      .select('id,item_id,item_name,action,delta,qty_before,qty_after,table_number,created_at');

    if (tableNumber) {
      query = query.eq('table_number', tableNumber);
    }

    query = query.order('created_at', { ascending: false }).limit(limit);

    // Push date filtering down to the DB where possible
    if (dateFilter === 'today' || dateFilter === 'yesterday') {
      const now = new Date();
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (dateFilter === 'yesterday' ? 1 : 0));
      const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (dateFilter === 'yesterday' ? 0 : 1));
      query = query
        .gte('created_at', start.toISOString())
        .lt('created_at', end.toISOString());
    }

    const { data, error } = await query;

    if (error) throw error;

    const filtered = Array.isArray(data) ? data : [];

    res.json(filtered || []);
  } catch (err) {
    console.error('/api/history error:', err);
    res.status(500).json({ error: err.message });
  }
});


// ADMIN: Add new item
app.post('/api/inventory', requirePin, async (req, res) => {
  try {
    const { name, quantity, category } = req.body;

    if (!name || String(name).trim().length === 0) {
      return res.status(400).json({ error: 'Item name is required' });
    }

    const qty = Number.isFinite(Number(quantity)) ? parseInt(quantity, 10) : 0;
    const cat = (category && String(category).trim().length) ? String(category).trim() : 'General';
    const now = new Date().toISOString();

    const { data, error } = await supabaseAdmin
      .from('inventory')
      .insert([{ name: String(name).trim(), quantity: qty, category: cat, updated_at: now }])
      .select();

    if (error) throw error;
    const inserted = data?.[0] || null;

    // history log
    if (inserted) {
      try {
        await logHistory({
          item_id: inserted.id,
          item_name: inserted.name,
          action: 'add',
          delta: qty,
          qty_before: null,
          qty_after: qty,
        });
      } catch (e) {
        return res.status(500).json({
          error: `Item added but history logging failed: ${e.message}. Please create table inventory_history in Supabase.`
        });
      }
    }

    res.json(inserted);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ADMIN: Update quantity (+/-)

// ADMIN: Update category
app.post('/api/inventory/:id/category', requirePin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const category = (req.body.category && String(req.body.category).trim().length)
      ? String(req.body.category).trim()
      : 'General';

    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: 'Invalid ID' });
    }

    // fetch current item
    const { data: currentData, error: fetchError } = await supabaseAdmin
      .from('inventory')
      .select('name,category,quantity')
      .eq('id', id)
      .single();

    if (fetchError) throw fetchError;

    const now = new Date().toISOString();

    const { data, error } = await supabaseAdmin
      .from('inventory')
      .update({ category, updated_at: now })
      .eq('id', id)
      .select();

    if (error) throw error;

    // history log (delta 0; qty unchanged)
    try {
      await logHistory({
        item_id: id,
        item_name: currentData?.name || null,
        action: 'category',
        delta: 0,
        qty_before: currentData?.quantity ?? null,
        qty_after: currentData?.quantity ?? null,
      });
    } catch (e) {
      return res.status(500).json({
        error: `Category updated but history logging failed: ${e.message}. Please create table inventory_history in Supabase.`
      });
    }

    res.json({ updated: 1, category: data?.[0]?.category ?? category, updated_at: now });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/inventory/:id/update', requirePin, async (req, res) => {
  try {
    const delta = parseInt(req.body.delta, 10);
    const id = parseInt(req.params.id, 10);

    if (!Number.isFinite(delta) || !Number.isFinite(id)) {
      return res.status(400).json({ error: 'Invalid ID or delta' });
    }

    const { data: currentData, error: fetchError } = await supabaseAdmin
      .from('inventory')
      .select('name,quantity')
      .eq('id', id)
      .single();

    if (fetchError) throw fetchError;

    const beforeQty = currentData?.quantity || 0;
    const newQty = beforeQty + delta;
    const now = new Date().toISOString();

    const { data, error } = await supabaseAdmin
      .from('inventory')
      .update({ quantity: newQty, updated_at: now })
      .eq('id', id)
      .select();

    if (error) throw error;
    // history log
    try {
      await logHistory({
        item_id: id,
        item_name: currentData?.name || null,
        action: 'adjust',
        delta,
        qty_before: beforeQty,
        qty_after: newQty,
      });
    } catch (e) {
      return res.status(500).json({
        error: `Quantity updated but history logging failed: ${e.message}. Please create table inventory_history in Supabase.`
      });
    }

    res.json({ updated: 1, newQuantity: data?.[0]?.quantity ?? newQty, updated_at: now });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ADMIN: Delete item
app.delete('/api/inventory/:id', requirePin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid ID' });

    // fetch before delete for history
    const { data: before, error: beforeErr } = await supabaseAdmin
      .from('inventory')
      .select('name,quantity')
      .eq('id', id)
      .single();
    if (beforeErr) throw beforeErr;

    const { error } = await supabaseAdmin
      .from('inventory')
      .delete()
      .eq('id', id);

    if (error) throw error;
    // history log
    try {
      await logHistory({
        item_id: id,
        item_name: before?.name || null,
        action: 'delete',
        delta: 0,
        qty_before: before?.quantity ?? null,
        qty_after: null,
      });
    } catch (e) {
      return res.status(500).json({
        error: `Item deleted but history logging failed: ${e.message}. Please create table inventory_history in Supabase.`
      });
    }

    res.json({ deleted: true });
} catch (err) {
 res.status(400).json({ error: err.message });
 }
});

// ADMIN: Assign item(s) to a table
app.post('/api/table/assign', requirePin, async (req, res) => {
 try {
 const { table_number, assignments } = req.body;
 // assignments: [{ item_id, delta }]

 if (!table_number || !Array.isArray(assignments) || assignments.length === 0) {
 return res.status(400).json({ error: 'table_number and assignments are required' });
 }

 const results = [];
 for (const a of assignments) {
 const item_id = parseInt(a.item_id, 10);
 const delta = parseInt(a.delta, 10);
 if (!Number.isFinite(item_id) || !Number.isFinite(delta) || delta <= 0) {
 return res.status(400).json({ error: 'Each assignment must have a valid item_id and positive delta' });
 }

 const { data: item, error: itemErr } = await supabaseAdmin
 .from('inventory')
 .select('name,quantity')
 .eq('id', item_id)
 .single();

 if (itemErr) return res.status(404).json({ error: `Item id ${item_id} not found` });

 const beforeQty = item.quantity ?? 0;
 const newQty = beforeQty - delta;
 if (newQty < 0) {
 return res.status(400).json({ error: `Insufficient stock for ${item.name}. Available: ${beforeQty}` });
 }

 const now = new Date().toISOString();

 const { error: updateErr } = await supabaseAdmin
 .from('inventory')
 .update({ quantity: newQty, updated_at: now })
 .eq('id', item_id);

 if (updateErr) throw updateErr;

 try {
 await logHistory({
 item_id,
 item_name: item.name,
 action: 'table_assign',
 delta: -delta,
 qty_before: beforeQty,
 qty_after: newQty,
 table_number: String(table_number),
 });
 } catch (e) {
 // don't fail the whole batch on history failure, but include info
 results.push({ item_id, item_name: item.name, warning: e.message });
 continue;
 }

 results.push({ item_id, item_name: item.name, assigned: delta, remaining: newQty });
 }

 res.json({ assigned_to: table_number, results });
 } catch (err) {
 res.status(500).json({ error: err.message });
 }
});

module.exports = app;
