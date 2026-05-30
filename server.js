const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY; // server-only secret

const ADMIN_PIN = process.env.ADMIN_PIN || '9712';

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  // fail fast with a helpful message
  console.error('Missing SUPABASE_URL / SUPABASE_ANON_KEY environment variables');
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
  // entry: { item_id, item_name, action, delta, qty_before, qty_after }
  const payload = {
    item_id: entry.item_id ?? null,
    item_name: entry.item_name ?? null,
    action: entry.action,
    delta: Number.isFinite(Number(entry.delta)) ? parseInt(entry.delta, 10) : 0,
    qty_before: Number.isFinite(Number(entry.qty_before)) ? parseInt(entry.qty_before, 10) : null,
    qty_after: Number.isFinite(Number(entry.qty_after)) ? parseInt(entry.qty_after, 10) : null,
    created_at: new Date().toISOString(),
  };

  const { error } = await supabaseAdmin
    .from('inventory_history')
    .insert([payload]);

  if (error) throw error;
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
app.get('/api/history', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '300', 10) || 300, 1000);

    const { data, error } = await supabasePublic
      .from('inventory_history')
      .select('id,item_id,item_name,action,delta,qty_before,qty_after,created_at')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) throw error;
    res.json(data || []);
  } catch (err) {
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

module.exports = app;
