require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const PDFDocument = require('pdfkit');
const app = express();
app.use(express.json());

const URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

let supabase = null;
if (!URL || !KEY) {
  console.warn('Supabase not configured: missing SUPABASE_URL and/or SUPABASE_ANON_KEY');
} else {
  try {
    supabase = createClient(URL, KEY);
  } catch (e) {
    console.error('Supabase init error:', e.message);
    supabase = null;
  }
}

// ── Serve frontend ──
const path = require('path');
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── Health check (useful on Vercel) ──
app.get('/api/health', async (req, res) => {
  try {
    const env = {
      hasUrl: Boolean(URL),
      hasKey: Boolean(KEY),
      supabaseReady: Boolean(supabase),
    };

    // Optional lightweight DB ping
    let db = { ok: false };
    if (supabase) {
      const { error } = await supabase.from('cold_drinks').select('id').limit(1);
      db = { ok: !error, error: error ? error.message : null };
    }

    res.json({ ok: true, env, db });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

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

 // Layout constants
 const M = 40;
 const W = doc.page.width - (M * 2);
 const PAGE_H = doc.page.height;

 function drawTopHeader(isContinued = false) {
   const title = "The Barkat's Heaven";
   const sub = isContinued ? 'Fridge Stock Report (continued)' : 'Fridge Stock Report';
   const dt = now.toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' }) +
     '  |  ' +
     now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });

   doc.font('Helvetica-Bold').fontSize(18).fillColor('#1a3c34').text(title, M, doc.y, { width: W, align: 'center' });
   doc.moveDown(0.15);
   doc.font('Helvetica').fontSize(11).fillColor('#555').text(sub, M, doc.y, { width: W, align: 'center' });
   doc.moveDown(0.15);
   doc.font('Helvetica').fontSize(9).fillColor('#777').text(dt, M, doc.y, { width: W, align: 'center' });
   doc.moveDown(0.8);
 }

 function drawSummaryCards() {
   const gap = 12;
   const cardH = 46;
   const cardW = (W - (gap * 2)) / 3;
   const y0 = doc.y;

   // Force exact, symmetric positions to avoid any rounding drift
   const x1 = M;
   const x2 = M + cardW + gap;
   const x3 = M + (cardW * 2) + (gap * 2);

   const cards = [
     { x: x1, bg: '#f0fff4', value: String(totalStock), label: 'Total Stock', color: '#2d6a4f' },
     { x: x2, bg: '#fff7e6', value: String(lowStock), label: 'Low Stock', color: '#c77d00' },
     { x: x3, bg: '#fde8e8', value: String(outStock), label: 'Out of Stock', color: '#c0392b' },
   ];

   for (const c of cards) {
     doc.roundedRect(c.x, y0, cardW, cardH, 8).fill(c.bg);
     doc.strokeColor('#e6e6e6').lineWidth(1).roundedRect(c.x, y0, cardW, cardH, 8).stroke();

     doc.font('Helvetica-Bold').fontSize(16).fillColor(c.color)
       .text(c.value, c.x, y0 + 9, { width: cardW, align: 'center' });
     doc.font('Helvetica').fontSize(9).fillColor('#1a3c34')
       .text(c.label, c.x, y0 + 28, { width: cardW, align: 'center' });
   }

   doc.y = y0 + cardH + 16;
 }

 function drawTableHeader() {
   const headerH = 22;
   const yH = doc.y;

   // column widths (sum = W)
   const colName = 250;
   const colCat = 130;
   const colQty = 55;
   const colUnit = W - (colName + colCat + colQty);

   const xName = M;
   const xCat = xName + colName;
   const xQty = xCat + colCat;
   const xUnit = xQty + colQty;

   doc.rect(M, yH, W, headerH).fill('#2d6a4f');
   doc.font('Helvetica-Bold').fontSize(9).fillColor('#fff');

   const ty = yH + 6;
   doc.text('DRINK NAME', xName + 10, ty, { width: colName - 10 });
   doc.text('CATEGORY', xCat + 10, ty, { width: colCat - 10 });
   doc.text('QTY', xQty, ty, { width: colQty - 10, align: 'right' });
   doc.text('UNIT', xUnit + 10, ty, { width: colUnit - 10 });

   doc.y = yH + headerH;

   return { colName, colCat, colQty, colUnit, xName, xCat, xQty, xUnit };
 }

 function ensureSpace(rowH, columns) {
   const bottom = PAGE_H - M;
   if (doc.y + rowH > bottom) {
     doc.addPage();
     doc.y = M;
     drawTopHeader(true);
     return drawTableHeader();
   }
   return columns;
 }

 drawTopHeader(false);
 drawSummaryCards();
 let cols = drawTableHeader();

 const rowH = 22;
 stock.forEach((s, i) => {
   cols = ensureSpace(rowH, cols);

   const yR = doc.y;
   const sq = parseInt(s.stock_qty) || 0;
   const statusColor = sq <= 0 ? '#c0392b' : sq <= 5 ? '#e67e22' : '#2d6a4f';
   const rowBg = i % 2 === 0 ? '#f9fbf9' : '#ffffff';

   doc.rect(M, yR, W, rowH).fill(rowBg);
   doc.strokeColor('#e5e5e5').lineWidth(0.5).rect(M, yR, W, rowH).stroke();

   doc.font('Helvetica').fontSize(9).fillColor('#2c1810');
   doc.text(s.name || '-', cols.xName + 10, yR + 7, { width: cols.colName - 12 });
   doc.text(s.category || '-', cols.xCat + 10, yR + 7, { width: cols.colCat - 12 });

   doc.font('Helvetica-Bold').fillColor(statusColor);
   doc.text(String(sq), cols.xQty, yR + 7, { width: cols.colQty - 10, align: 'right' });

   doc.font('Helvetica').fillColor('#2c1810');
   doc.text(s.unit || 'pc', cols.xUnit + 10, yR + 7, { width: cols.colUnit - 12 });

   doc.y = yR + rowH;
 });

 doc.moveDown(0.7);
 const yF = doc.y;
 doc.strokeColor('#bbb').lineWidth(0.5).moveTo(M, yF).lineTo(M + W, yF).stroke();
 doc.moveDown(0.4);
 doc.font('Helvetica').fillColor('#444').fontSize(9)
   .text('Generated by The Barkat\'s Heaven Cold Drink Inventory System', M, doc.y, { width: W, align: 'center' });

 doc.end();
 } catch (e) {
 console.error('PDF route error:', e);
 if (!res.headersSent) res.status(500).json({ error: e.message });
 }
});

// Local dev only: Vercel serverless does not require app.listen().
if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log('Running on ' + port));
}

module.exports = app;
