require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const PDFDocument = require('pdfkit');
const app = express();
app.use(express.json());

const URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
let supabase;
try { supabase = createClient(URL, KEY); } catch(e) { console.error('Supabase init error:', e.message); }

// ── Serve frontend ──
const path = require('path');
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── GET all drinks ──
app.get('/api/drinks', async (req, res) => {
 try {
 if (!supabase) throw new Error('Database not configured');
 const { data, error } = await supabase.from('cold_drinks').select('*').order('id');
 if (error) throw error;
 res.json(data || []);
 } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST add drink ──
app.post('/api/drinks', async (req, res) => {
 try {
 if (!supabase) throw new Error('Database not configured');
 const { name, category, unit, stock_qty } = req.body;
 if (!name) return res.status(400).json({ error: 'Name required' });
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
 if (!supabase) throw new Error('Database not configured');
 const { error } = await supabase.from('cold_drinks').delete().eq('id', req.params.id);
 if (error) throw error;
 res.json({ success: true });
 } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PUT refill stock ──
app.put('/api/drinks/:id/stock', async (req, res) => {
 try {
 if (!supabase) throw new Error('Database not configured');
 const { qty } = req.body;
 if (!qty || qty < 0) return res.status(400).json({ error: 'Enter valid quantity' });
 const { data, error } = await supabase
 .from('cold_drinks')
 .update({ stock_qty: parseInt(qty), updated_at: new Date().toISOString() })
 .eq('id', req.params.id)
 .select().single();
 if (error) throw error;
 res.json(data);
 } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET orders ──
app.get('/api/orders', async (req, res) => {
 try {
 if (!supabase) throw new Error('Database not configured');
 let q = supabase.from('table_orders').select('*, cold_drinks(name,category,unit)').order('created_at', { ascending: false });
 if (req.query.table) q = q.eq('table_number', parseInt(req.query.table));
 const { data, error } = await q;
 if (error) throw error;
 res.json(data || []);
 } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET orders summary ──
app.get('/api/orders/summary', async (req, res) => {
 try {
 if (!supabase) throw new Error('Database not configured');
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

// ── POST order (reduces stock) ──
app.post('/api/orders', async (req, res) => {
 try {
 if (!supabase) throw new Error('Database not configured');
 const { table_number, drink_id, quantity, notes } = req.body;
 const drinkId = parseInt(drink_id);
 const qty = parseInt(quantity) || 1;
 const tableNo = parseInt(table_number);

 const { data: drink, error: dErr } = await supabase.from('cold_drinks').select('stock_qty, name').eq('id', drinkId).single();
 if (dErr) throw dErr;
 if (!drink || drink.stock_qty < qty) return res.status(400).json({ error: 'Not enough stock! Available: ' + (drink ? drink.stock_qty : 0) });

 const { error: uErr } = await supabase.from('cold_drinks').update({ stock_qty: drink.stock_qty - qty }).eq('id', drinkId);
 if (uErr) throw uErr;

 const { data: order, error: oErr } = await supabase.from('table_orders')
 .insert([{ table_number: tableNo, drink_id: drinkId, quantity: qty, notes }])
 .select().single();
 if (oErr) throw oErr;
 res.json(order);
 } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE order (cancel + restore stock) ──
app.delete('/api/orders/:id', async (req, res) => {
 try {
 if (!supabase) throw new Error('Database not configured');
 const { data: order, error: oErr } = await supabase.from('table_orders').select('drink_id, quantity').eq('id', req.params.id).single();
 if (oErr || !order) return res.status(404).json({ error: 'Order not found' });

 const { data: drink } = await supabase.from('cold_drinks').select('stock_qty').eq('id', order.drink_id).single();
 if (drink) {
 await supabase.from('cold_drinks').update({ stock_qty: drink.stock_qty + order.quantity }).eq('id', order.drink_id);
 }

 const { error } = await supabase.from('table_orders').delete().eq('id', req.params.id);
 if (error) throw error;
 res.json({ success: true });
 } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PDF REPORT ──────────────────────────────────────
app.get('/api/report/pdf', async (req, res) => {
 try {
 if (!supabase) throw new Error('Database not configured');
 const selTable = req.query.table ? parseInt(req.query.table) : null;

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

 const doc = new PDFDocument({ size: 'A4', margin: 50 });
 const chunks = [];
 doc.on('data', c => chunks.push(c));
 doc.on('error', err => {
 console.error('PDF doc error:', err);
 if (!res.headersSent) res.status(500).json({ error: 'PDF generation failed' });
 });
 doc.on('end', () => {
 try {
 const buf = Buffer.concat(chunks);
 const fn = selTable ? 'Barkats-Heaven-Table-' + selTable + '.pdf' : 'Barkats-Heaven-Full-Report.pdf';
 res.setHeader('Content-Type', 'application/pdf');
 res.setHeader('Content-Disposition', 'attachment; filename="' + fn + '"');
 res.setHeader('Content-Length', buf.length);
 res.setHeader('Cache-Control', 'no-cache');
 res.send(buf);
 } catch(e) { console.error('Send error:', e); if (!res.headersSent) res.status(500).json({ error: e.message }); }
 });

 const now = new Date();
 doc.fontSize(20).font('Helvetica-Bold').text("The Barkat's Heaven", { align: 'center' });
 doc.fontSize(11).font('Helvetica').fillColor('#555').text('Cold Drink Inventory Report', { align: 'center' });
 doc.fontSize(9).fillColor('#888').text(now.toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' }) + '  ' + now.toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit' }), { align: 'center' });
 doc.moveDown(0.8);

 const totalStock = (stock||[]).reduce((s,d)=>s+(parseInt(d.stock_qty)||0),0);
 const totalTypes = (stock||[]).length;
 const totalOrders = (orders||[]).length;
 const tablesServed = Object.keys(tg).length;

 doc.fillColor('#1a3c34').fontSize(9).font('Helvetica-Bold').text('SUMMARY:  ' + totalTypes + ' drink types  |  ' + totalStock + ' total stock  |  ' + tablesServed + ' tables served  |  ' + totalOrders + ' orders');
 doc.moveDown(0.4);
 doc.strokeColor('#ccc').lineWidth(0.5).moveTo(50, doc.y).lineTo(545, doc.y).stroke();
 doc.moveDown(0.4);

 doc.fillColor('#1a3c34').fontSize(10).font('Helvetica-Bold').text(selTable ? 'Table #' + selTable + ' - Stock Left' : 'All Fridge Stock');
 doc.moveDown(0.2);

 if (!stock || !stock.length) {
 doc.fillColor('#999').fontSize(9).text('No drinks in fridge yet.');
 } else {
 const colX = [55, 240, 340, 420];
 doc.fillColor('#2d6a4f').font('Helvetica-Bold').fontSize(8);
 doc.text('DRINK', colX[0], doc.y, { width: 180 });
 doc.text('CATEGORY', colX[1], doc.y, { width: 90 });
 doc.text('STOCK', colX[2], doc.y, { width: 70 });
 doc.text('UNIT', colX[3], doc.y, { width: 60 });
 doc.y += 4;
 doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#2d6a4f').lineWidth(0.8).stroke();
 doc.y += 4;

 (stock||[]).forEach((s, i) => {
 if (doc.y > 750) { doc.addPage(); doc.y = 50; }
 const sc = s.stock_qty <= 0 ? '#c0392b' : s.stock_qty <= 5 ? '#e67e22' : '#2d6a4f';
 doc.fillColor('#2c1810').font('Helvetica').fontSize(9);
 doc.text(s.name, colX[0], doc.y, { width: 180 });
 doc.text(s.category||'-', colX[1], doc.y, { width: 90 });
 doc.fillColor(sc).text(String(s.stock_qty||0), colX[2], doc.y, { width: 70 });
 doc.fillColor('#2c1810').text(s.unit||'pc', colX[3], doc.y, { width: 60 });
 doc.y += 14;
 });
 }

 doc.moveDown(0.6);

 if (selTable) {
 doc.addPage();
 doc.fillColor('#1a3c34').fontSize(12).font('Helvetica-Bold').text('Table #' + selTable + ' Orders', { align: 'center' });
 doc.moveDown(0.3);
 drawOrdersPdf(doc, tg[selTable]||[], dm);
 } else {
 const tns = Object.keys(tg).sort((a,b)=>a-b);
 for (const t of tns) {
 if (doc.y > 720) doc.addPage();
 doc.fillColor('#1a3c34').fontSize(10).font('Helvetica-Bold').text('Table #' + t);
 doc.moveDown(0.15);
 drawOrdersPdf(doc, tg[t], dm);
 doc.moveDown(0.3);
 }
 }

 doc.end();
 } catch (e) {
 console.error('PDF route error:', e);
 if (!res.headersSent) res.status(500).json({ error: e.message });
 }
});

function drawOrdersPdf(doc, orders, dm) {
 if (!orders || !orders.length) {
 doc.fillColor('#999').fontSize(9).text('  No orders');
 doc.moveDown(0.3);
 return;
 }
 const colX2 = [55, 90, 310, 360, 400];
 doc.fillColor('#2d6a4f').font('Helvetica-Bold').fontSize(8);
 doc.text('#', colX2[0], doc.y, { width: 30 }).text('DRINK', colX2[1], doc.y, { width: 210 }).text('QTY', colX2[2], doc.y, { width: 40 }).text('TIME', colX2[3], doc.y, { width: 80 }).text('NOTE', colX2[4], doc.y, { width: 100 });
 doc.y += 4;
 doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#2d6a4f').lineWidth(0.8).stroke();
 doc.y += 4;

 orders.forEach((o, i) => {
 if (doc.y > 750) doc.addPage();
 const d = dm[o.drink_id] || { name: '?', unit: 'pc' };
 const t = new Date(o.created_at);
 const tStr = t.toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit' });
 doc.fillColor('#2c1810').font('Helvetica').fontSize(9);
 doc.text(String(o.table_number), colX2[0], doc.y, { width: 30 }).text(d.name, colX2[1], doc.y, { width: 210 }).text('x'+o.quantity, colX2[2], doc.y, { width: 40 }).text(tStr, colX2[3], doc.y, { width: 80 }).text(o.notes||'-', colX2[4], doc.y, { width: 100 });
 doc.y += 13;
 });
}

const port = process.env.PORT || 3000;
app.listen(port, () => console.log('Running on ' + port));
