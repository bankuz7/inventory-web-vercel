const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const ADMIN_PIN = process.env.ADMIN_PIN || '9712';

const supabase = createClient(supabaseUrl || 'https://placeholder.supabase.co', supabaseKey || 'placeholder');

// Middleware to check Admin PIN
const requirePin = (req, res, next) => {
  const pin = req.headers['x-admin-pin'];
  if (pin !== ADMIN_PIN) {
    return res.status(401).json({ error: "Unauthorized: Invalid or missing Admin PIN" });
  }
  next();
};

// Get all inventory (Report) - PUBLIC (No PIN required)
app.get('/api/inventory', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('inventory')
      .select('*')
      .order('id', { ascending: true });

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add new item - PROTECTED (PIN required)
app.post('/api/inventory', requirePin, async (req, res) => {
  try {
    const { name, quantity } = req.body;
    const qty = parseInt(quantity, 10) || 0;
    
    const { data, error } = await supabase
      .from('inventory')
      .insert([{ name, quantity: qty }])
      .select();

    if (error) throw error;
    res.json(data[0]);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Update quantity (+ or -) - PROTECTED (PIN required)
app.post('/api/inventory/:id/update', requirePin, async (req, res) => {
  try {
    const delta = parseInt(req.body.delta, 10);
    const id = parseInt(req.params.id, 10);

    if (isNaN(delta) || isNaN(id)) {
      return res.status(400).json({ error: "Invalid ID or delta" });
    }

    // Fetch current quantity
    const { data: currentData, error: fetchError } = await supabase
      .from('inventory')
      .select('quantity')
      .eq('id', id)
      .single();

    if (fetchError) throw fetchError;

    // Calculate new quantity
    const newQty = (currentData.quantity || 0) + delta;

    // Update in database
    const { data, error } = await supabase
      .from('inventory')
      .update({ quantity: newQty })
      .eq('id', id)
      .select();

    if (error) throw error;
    res.json({ updated: 1, newQuantity: data[0].quantity });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Export for Vercel
module.exports = app;
