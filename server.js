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
    res.json(data?.[0] || null);
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
      .select('quantity')
      .eq('id', id)
      .single();

    if (fetchError) throw fetchError;

    const newQty = (currentData?.quantity || 0) + delta;
    const now = new Date().toISOString();

    const { data, error } = await supabaseAdmin
      .from('inventory')
      .update({ quantity: newQty, updated_at: now })
      .eq('id', id)
      .select();

    if (error) throw error;
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

    const { error } = await supabaseAdmin
      .from('inventory')
      .delete()
      .eq('id', id);

    if (error) throw error;
    res.json({ deleted: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = app;
