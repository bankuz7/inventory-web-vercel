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
 const { name, category, unit, stock_qty } = req.body;
 const { data, error } = await supabase.from('cold_drinks').insert([{
 name, category: category||'Soda', unit: unit||'bottle', stock_qty: parseInt(stock_qty)||0
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
 .select('*, cold_drinks(name,category,unit)')
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
 const now = new Date();
 const dateStr = now.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
 const timeStr = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });

 let q = supabase.from('table_orders').select('*, cold_drinks(name,category,unit)').order('created_at');
 if (selTable) q = q.eq('table_number', selTable);
 const { data: orders, error: oErr } = await q;
 if (oErr) throw oErr;

 const { data: stock } = await supabase.from('cold_drinks').select('*').order('id');

 const dm = {};
 for (const o of (orders || [])) {
 if (o.cold_drinks && !dm[o.drink_id]) {
 dm[o.drink_id] = { name: o.cold_drinks.name, category: o.cold_drinks.category, unit: o.cold_drinks.unit };
 }
 }

 const tg = {};
 for (const o of (orders || [])) {
 if (!tg[o.table_number]) tg[o.table_number] = [];
 tg[o.table_number].push(o);
 }

 const doc = new PDFDocument({ margin: 50, size: 'A4' });
 const chunks = [];
 doc.on('data', chunk => chunks.push(chunk));
 doc.on('end', () => {
 const buf = Buffer.concat(chunks);
 const fn = selTable ? 'table-' + selTable + '-report.pdf' : 'full-inventory-report.pdf';
 res.setHeader('Content-Type', 'application/pdf');
 res.setHeader('Content-Disposition', 'attachment; filename="' + fn + '"');
 res.setHeader('Content-Length', buf.length);
 res.send(buf);
 });

 doc.fillColor('#1a3c34').fontSize(22).font('Helvetica-Bold').text("The Barkat's Heaven", { align: 'center' });
 doc.fillColor('#2d6a4f').fontSize(12).text('Cold Drink Inventory Report', { align: 'center' });
 doc.fillColor('#666').fontSize(9).font('Helvetica').text('Date: ' + dateStr + '  ·  Time: ' + timeStr, { align: 'center' });
 doc.moveDown(1);

 const totalStock = (stock || []).reduce((s, d) => s + (parseInt(d.stock_qty) || 0), 0);
 const totalTypes = (stock || []).length;
 const totalOrders = (orders || []).length;
 const tablesServed = Object.keys(tg).length;

 doc.fillColor('#1a3c34').fontSize(10).font('Helvetica-Bold').text('SUMMARY', { align: 'left' });
 doc.moveDown(0.2);
 doc.fillColor('#2d6a4f').fontSize(9).font('Helvetica').text('  ' + totalTypes + ' drink types  ·  ' + totalStock + ' total stock  ·  ' + tablesServed + ' tables  ·  ' + totalOrders + ' orders');
 doc.moveDown(0.5);
 doc.strokeColor('#b8d4c8').lineWidth(1).moveTo(50, doc.y).lineTo(545, doc.y).stroke();
 doc.moveDown(0.6);

 const sm = selTable ? 'Table #' + selTable : 'All Tables';
 doc.fillColor('#1a3c34').fontSize(11).font('Helvetica-Bold').text('📦 Stock Overview - ' + sm, { align: 'left' });
 doc.moveDown(0.3);

 if (!stock || !stock.length) {
 doc.fillColor('#999').fontSize(9).font('Helvetica').text('  No drinks in fridge yet.');
 doc.moveDown(0.4);
 } else {
 doc.fillColor('#fff').font('Helvetica-Bold').fontSize(9);
 doc.rect(50, doc.y, 495, 18).fill('#2d6a4f');
 doc.fillColor('#fff').text('Drink', 55, doc.y, { width: 220 }).text('Category', 280, doc.y, { width: 100 }).text('Stock', 385, doc.y, { width: 70 }).text('Unit', 460, doc.y, { width: 70 });
 doc.y += 20;

 (stock || []).forEach((s, i) => {
 const bg = i % 2 === 0 ? '#f4faf6' : '#ffffff';
 doc.fillColor(bg).rect(50, doc.y, 495, 16).fill();
 doc.fillColor('#2c1810').font('Helvetica').text(s.name, 55, doc.y + 3, { width: 220, height: 12 });
 doc.text(s.category || '-', 280, doc.y + 3, { width: 100, height: 12 });
 doc.text(String(s.stock_qty || 0), 385, doc.y + 3, { width: 70, height: 12 });
 doc.text(s.unit || 'pc', 460, doc.y + 3, { width: 70, height: 12 });
 doc.y += 18;
 });
 doc.y += 4;
 }
 doc.moveDown(0.6);

 if (selTable) {
 doc.addPage();
 doc.fillColor('#1a3c34').fontSize(13).font('Helvetica-Bold').text('Table #' + selTable + ' Orders', { align: 'center' });
 doc.moveDown(0.3);
 drawOrders(doc, tg[selTable] || [], dm);
 } else {
 const tns = Object.keys(tg).sort((a, b) => a - b);
 for (const t of tns) {
 if (doc.y > 680) doc.addPage();
 doc.fillColor('#1a3c34').fontSize(11).font('Helvetica-Bold').text('Table #' + t, { align: 'left' });
 doc.moveDown(0.2);
 drawOrders(doc, tg[t], dm);
 doc.moveDown(0.4);
 }
 }

 doc.end();
 } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

function drawOrders(doc, orders, dm) {
 if (!orders.length) {
 doc.fillColor('#999').fontSize(9).font('Helvetica').text('  No orders');
 doc.moveDown(0.3);
 return;
 }

 // Table header
 doc.fillColor('#fff').font('Helvetica-Bold').fontSize(9);
 doc.rect(50, doc.y, 495, 18).fill('#2d6a4f');
 doc.fillColor('#fff').text('#', 55, doc.y, { width: 20 }).text('Table', 80, doc.y, { width: 40 }).text('Drink', 125, doc.y, { width: 180 }).text('Qty', 310, doc.y, { width: 40 }).text('Time', 355, doc.y, { width: 70 }).text('Note', 435, doc.y, { width: 100 });
 doc.y += 20;

 let rowCount = 0;
 orders.forEach(o => {
 const d = dm[o.drink_id] || { name: '?', category: '-', unit: 'pc' };
 const bg = rowCount % 2 === 0 ? '#f9f9f9' : '#ffffff';
 const t = new Date(o.created_at);
 const tStr = t.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });

 doc.fillColor(bg).rect(50, doc.y, 495, 16).fill();
 doc.fillColor('#2c1810').font('Helvetica').text(String(o.table_number), 55, doc.y + 3, { width: 20 }).text(d.name, 80, doc.y + 3, { width: 220 }).text('x' + o.quantity, 310, doc.y + 3, { width: 40 }).text(tStr, 355, doc.y + 3, { width: 70 }).text(o.notes || '-', 435, doc.y + 3, { width: 100 });
 doc.y += 18;
 rowCount++;
 });
 doc.y += 4;
}

const port = process.env.PORT || 3000;
app.listen(port, () => console.log('Running on ' + port));
