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

// ── PDF REPORT (fridge stock only) ──
app.get('/api/report/pdf', async (req, res) => {
 try {
 if (!supabase) throw new Error('Database not configured');

 const { data: stock } = await supabase.from('cold_drinks').select('*').order('id');
 if (!stock || !stock.length) return res.status(400).json({ error: 'No drinks in fridge!' });

 const now = new Date();
 const doc = new PDFDocument({ size: 'A4', margin: 40 });
 const chunks = [];
 doc.on('data', c => chunks.push(c));
 doc.on('error', err => {
 console.error('PDF err:', err);
 if (!res.headersSent) res.status(500).json({ error: 'PDF generation failed' });
 });
 doc.on('end', () => {
 try {
 const buf = Buffer.concat(chunks);
 const fn = 'Barkats-Heaven-Stock-' + now.toISOString().slice(0,10) + '.pdf';
 res.setHeader('Content-Type', 'application/pdf');
 res.setHeader('Content-Disposition', 'attachment; filename="' + fn + '"');
 res.setHeader('Content-Length', buf.length);
 res.setHeader('Cache-Control', 'no-store');
 res.send(buf);
 } catch(e) {
 console.error('Send err:', e);
 if (!res.headersSent) res.status(500).json({ error: e.message });
 }
 });

 const totalStock = stock.reduce((s, d) => s + (parseInt(d.stock_qty) || 0), 0);
 const lowStock = stock.filter(d => parseInt(d.stock_qty) <= 5 && parseInt(d.stock_qty) > 0).length;
 const outStock = stock.filter(d => parseInt(d.stock_qty) <= 0).length;

 // Header
 doc.fontSize(20).font('Helvetica-Bold').fillColor('#1a3c34').text("The Barkat's Heaven", { align: 'center' });
 doc.fontSize(11).font('Helvetica').fillColor('#555').text('Fridge Stock Report', { align: 'center' });
 doc.fontSize(9).fillColor('#999').text(now.toLocaleDateString('en-IN', { day:'2-digit', month:'long', year:'numeric' }) + '  |  ' + now.toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit' }), { align: 'center' });
 doc.moveDown(0.7);

 // Summary cards
 doc.rect(40, doc.y, 220, 50).fill('#f0fff4');
 doc.rect(270, doc.y, 110, 50).fill('#fff7e6');
 doc.rect(395, doc.y, 135, 50).fill('#fde8e8');
 doc.font('Helvetica-Bold').fillColor('#2d6a4f').fontSize(14).text(totalStock + '', 90, doc.y + 5);
 doc.fillColor('#1a3c34').fontSize(8).text('Total Stock', 80, doc.y + 26);
 doc.fillColor('#c77d00').fontSize(14).text(lowStock + '', 290, doc.y + 5);
 doc.fillColor('#1a3c34').fontSize(8).text('Low Stock', 295, doc.y + 26);
 doc.fillColor('#c0392b').fontSize(14).text(outStock + '', 415, doc.y + 5);
 doc.fillColor('#1a3c34').fontSize(8).text('Out of Stock', 405, doc.y + 26);
 doc.y += 60;
 doc.moveDown(0.4);

 // Table
 doc.fillColor('#2d6a4f').font('Helvetica-Bold').fontSize(9);
 doc.rect(40, doc.y, 490, 20).fill('#2d6a4f');
 doc.fillColor('#fff').text('DRINK NAME', 50, doc.y + 5, { width: 180 }).text('CATEGORY', 240, doc.y + 5, { width: 90 }).text('STOCK', 340, doc.y + 5, { width: 60 }).text('UNIT', 410, doc.y + 5, { width: 90 });
 doc.y += 22;

 stock.forEach((s, i) => {
 if (doc.y > 760) { doc.addPage(); doc.y = 50; }
 const sq = parseInt(s.stock_qty) || 0;
 const statusColor = sq <= 0 ? '#c0392b' : sq <= 5 ? '#e67e22' : '#2d6a4f';
 const rowBg = i % 2 === 0 ? '#f9fbf9' : '#ffffff';
 doc.rect(40, doc.y, 490, 16).fill(rowBg);
 doc.strokeColor('#e0e0e0').lineWidth(0.5).rect(40, doc.y, 490, 16).stroke();
 doc.fillColor('#2c1810').font('Helvetica').fontSize(9);
 doc.text(s.name || '-', 50, doc.y + 4, { width: 180 });
 doc.text(s.category || '-', 240, doc.y + 4, { width: 90 });
 doc.fillColor(statusColor).font('Helvetica-Bold').text(String(sq), 340, doc.y + 4, { width: 60 });
 doc.fillColor('#2c1810').font('Helvetica').text(s.unit || 'pc', 410, doc.y + 4, { width: 90 });
 doc.y += 17;
 });

 doc.y += 10;
 doc.strokeColor('#bbb').lineWidth(0.5).moveTo(40, doc.y).lineTo(530, doc.y).stroke();
 doc.y += 8;
 doc.font('Helvetica-Bold').fillColor('#1a3c34').fontSize(9).text('Generated by The Barkat\'s Heaven Cold Drink Inventory System', { align: 'center' });

 doc.end();
 } catch (e) {
 console.error('PDF route error:', e);
 if (!res.headersSent) res.status(500).json({ error: e.message });
 }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log('Running on ' + port));
