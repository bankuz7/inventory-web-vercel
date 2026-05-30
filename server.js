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

if (!supabaseUrl || !supabaseKey) {
  console.log("WARNING: Supabase URL or Key is missing. App will fail to connect.");
}

const supabase = createClient(supabaseUrl || 'https://placeholder.supabase.co', supabaseKey || 'placeholder');

// Get all inventory (Report)
app.get('/api/inventory', async (req, res) => {
  const { data, error } = await supabase
    .from('inventory')
    .select('*')
    .order('id', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Add new item
app.post('/api/inventory', async (req, res) => {
  const { name, quantity } = req.body;
  const qty = quantity || 0;
  
  const { data, error } = await supabase
    .from('inventory')
    .insert([{ name, quantity: qty }])
    .select();

  if (error) return res.status(400).json({ error: error.message });
  res.json(data[0]);
});

// Update quantity (+ or -)
app.post('/api/inventory/:id/update', async (req, res) => {
  const { delta } = req.body;
  const id = req.params.id;

  // Supabase doesn't have a simple "increment" via REST API directly without RPC,
  // so we fetch current, modify, and update.
  const { data: currentData, error: fetchError } = await supabase
    .from('inventory')
    .select('quantity')
    .eq('id', id)
    .single();

  if (fetchError) return res.status(400).json({ error: fetchError.message });

  const newQty = currentData.quantity + delta;

  const { data, error } = await supabase
    .from('inventory')
    .update({ quantity: newQty })
    .eq('id', id)
    .select();

  if (error) return res.status(400).json({ error: error.message });
  res.json({ updated: 1, newQuantity: data[0].quantity });
});

app.listen(port, () => {
  console.log(`[+] Inventory System online on port ${port}`);
});

module.exports = app;