require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const PDFDocument = require('pdfkit');
const app = express();
app.use(express.json());

const URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const supabase = createClient(URL, KEY);

// ── Serve frontend ──
const path = require('path');
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── GET all drinks (with live stock) ──
app.get('/api/drinks', async (req, res) => {
  try {
    const { data, error } = await supabase.from('cold_drinks').select('*').order('id');
    if (error) throw error;
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST add new drink ──
app.post('/api/drinks', async (req, res) => {
  try {
    const { name, category, price, unit, stock_qty } = req.body;
    const { data, error } = await supabase.from('cold_drinks').insert([{
      name, category: category||'Soda', price: Number(price)||40,
      unit: unit||'bottle', stock_qty: parseInt(stock_qty)||0
    }]).select().single();
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE drink ──
app.delete('/api/drinks/:id', async (req, res) => {
  try {
    const { error } = await supabase.from('cold_drinks').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PUT refill stock ──
app.put('/api/drinks/:id/stock', async (req, res) => {
  try {
    const { qty } = req.body;
    if (!qty || qty < 0) return res.status(400).json({ error: 'Enter valid quantity' });
    const { data, error } = await supabase
      .from('cold_drinks')
      .update({ stock_qty: parseInt(qty), updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET all orders (optionally filter by table) ──
app.get('/api/orders', async (req, res) => {
  try {
    let q = supabase.from('table_orders')
      .select('*, cold_drinks(name,category,price)')
      .order('created_at', { ascending: false });
    if (req.query.table) q = q.eq('table_number', parseInt(req.query.table));
    const { data, error } = await q;
    if (error) throw error;
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET summary (which tables have orders) ──
app.get('/api/orders/summary', async (req, res) => {
  try {
    const { data, error } = await supabase.from('table_orders').select('table_number');
    if (error) throw error;
    const t = {};
    for (const r of (data || [])) {
      if (!t[r.table_number]) t[r.table_number] = { table_number: r.table_number, totalOrders: 0 };
      t[r.table_number].totalOrders++;
    }
    res.json(Object.values(t).sort((a, b) => a.table_number - b.table_number));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST new table order (reduces stock) ──
app.post('/api/orders', async (req, res) => {
  try {
    const { table_number, drink_id, quantity, notes } = req.body;
    const drinkId = parseInt(drink_id);
    const qty = parseInt(quantity) || 1;
    const tableNo = parseInt(table_number);

    // Check stock
    const { data: drink, error: dErr } = await supabase.from('cold_drinks').select('stock_qty, name').eq('id', drinkId).single();
    if (dErr) throw dErr;
    if (!drink || drink.stock_qty < qty) return res.status(400).json({ error: `Not enough stock! Available: ${drink ? drink.stock_qty : 0}` });

    // Reduce stock
    const { error: uErr } = await supabase.from('cold_drinks').update({ stock_qty: drink.stock_qty - qty }).eq('id', drinkId);
    if (uErr) throw uErr;

    // Create order
    const { data: order, error: oErr } = await supabase.from('table_orders')
      .insert([{ table_number: tableNo, drink_id: drinkId, quantity: qty, notes }])
      .select().single();
    if (oErr) throw oErr;
    res.json(order);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE order (cancel) — restores stock ──
app.delete('/api/orders/:id', async (req, res) => {
  try {
    // Get order details to restore stock
    const { data: order, error: oErr } = await supabase.from('table_orders').select('drink_id, quantity').eq('id', req.params.id).single();
    if (oErr || !order) return res.status(404).json({ error: 'Order not found' });

    // Restore stock
    const { data: drink, error: dErr } = await supabase.from('cold_drinks').select('stock_qty').eq('id', order.drink_id).single();
    if (!dErr && drink) {
      await supabase.from('cold_drinks').update({ stock_qty: drink.stock_qty + order.quantity }).eq('id', order.drink_id);
    }

    // Delete order
    const { error } = await supabase.from('table_orders').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PDF REPORT ──
app.get('/api/report/pdf', async (req, res) => {
  try {
    const selTable = req.query.table ? parseInt(req.query.table) : null;

    let q = supabase.from('table_orders').select('*, cold_drinks(name,category,price)').order('created_at');
    if (selTable) q = q.eq('table_number', selTable);
    const { data: orders, error: oErr } = await q;
    if (oErr) throw oErr;

    // Get current stock too
    const { data: stock } = await supabase.from('cold_drinks').select('*').order('id');

    // Build drink map
    const dm = {};
    for (const o of (orders || [])) {
      if (o.cold_drinks && !dm[o.drink_id]) {
        dm[o.drink_id] = { name: o.cold_drinks.name, price: parseFloat(o.cold_drinks.price || 0) };
      }
    }

    // Group orders by table
    const tg = {};
    for (const o of (orders || [])) {
      if (!tg[o.table_number]) tg[o.table_number] = [];
      tg[o.table_number].push(o);
    }

    const doc = new PDFDocument({ margin: 50 });
    const fn = selTable ? 'table-' + selTable + '-report.pdf' : 'full-inventory-report.pdf';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="' + fn + '"');
    doc.pipe(res);

    doc.fontSize(20).font('Helvetica-Bold').text("The Barkat's Heaven", { align: 'center' });
    doc.fontSize(14).text('Cold Drink Inventory Report', { align: 'center' });
    doc.fontSize(9).font('Helvetica').text('Generated: ' + new Date().toLocaleString('en-IN'), { align: 'center' });
    doc.moveDown(0.8);

    // Stock overview (all or per table)
    const sm = selTable ? 'Table #' + selTable : 'All Tables';
    doc.fontSize(12).font('Helvetica-Bold').text('Stock Overview - ' + sm, { align: 'left' });
    doc.moveDown(0.3);
    doc.font('Helvetica-Bold');
    doc.text('Drink', 55); doc.text('Stock Left', 220); doc.text('Price', 300); doc.text('Value', 370);
    doc.moveTo(50, doc.y).lineTo(460, doc.y).stroke(); doc.moveDown(0.3);

    let totalStockValue = 0;
    (stock || []).forEach(s => {
      const val = parseFloat(s.price || 0) * (s.stock_qty || 0);
      totalStockValue += val;
      doc.font('Helvetica');
      doc.text(s.name, 55);
      doc.text(s.stock_qty + ' bottles', 220);
      doc.text('Rs ' + parseFloat(s.price || 0).toFixed(2), 300);
      doc.text('Rs ' + val.toFixed(2), 370);
      doc.moveDown(0.25);
    });
    doc.moveDown(0.3);
    doc.font('Helvetica-Bold').text('Total Stock Value:     Rs ' + totalStockValue.toFixed(2));
    doc.moveDown(0.6);

    // Orders detail
    if (selTable) {
      doc.addPage();
      doc.fontSize(13).font('Helvetica-Bold').text('Table #' + selTable + ' - Orders', { align: 'center' });
      doc.moveDown(0.4);
      drawOrders(doc, tg[selTable] || [], dm);
    } else {
      const tns = Object.keys(tg).sort((a, b) => a - b);
      for (const t of tns) {
        doc.addPage();
        doc.fontSize(13).font('Helvetica-Bold').text('Table #' + t + ' - Orders', { align: 'center' });
        doc.moveDown(0.4);
        drawOrders(doc, tg[t], dm);
      }
    }

    doc.end();
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

function drawOrders(doc, orders, dm) {
  let tot = 0;
  doc.font('Helvetica-Bold');
  doc.text('Table', 55); doc.text('Drink', 100); doc.text('Qty', 230); doc.text('Price', 260); doc.text('Amount', 330);
  doc.moveTo(50, doc.y).lineTo(460, doc.y).stroke(); doc.moveDown(0.25);
  for (const o of orders) {
    const d = dm[o.drink_id] || { name: '?', price: 0 };
    const a = d.price * o.quantity; tot += a;
    doc.font('Helvetica');
    doc.text('#' + o.table_number, 55);
    doc.text(d.name + (o.notes ? ' (' + o.notes + ')' : ''), 100);
    doc.text('x' + o.quantity, 230);
    doc.text('Rs ' + d.price.toFixed(2), 260);
    doc.text('Rs ' + a.toFixed(2), 330);
    doc.moveDown(0.22);
  }
  doc.moveDown(0.3);
  doc.font('Helvetica-Bold').text('Total:                    Rs ' + tot.toFixed(2));
  return tot;
}

const port = process.env.PORT || 3000;
app.listen(port, () => console.log('Running on ' + port));
