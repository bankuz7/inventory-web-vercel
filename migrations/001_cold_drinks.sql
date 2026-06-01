-- Cold Drink Inventory Schema
-- Tracks fridge stock + table orders (reduce stock on serve)

-- Cold drinks catalog (user adds their own)
CREATE TABLE IF NOT EXISTS cold_drinks (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT DEFAULT 'Soda',
  price NUMERIC(10,2) DEFAULT 40,
  unit TEXT DEFAULT 'bottle',
  stock_qty INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Table orders: track what was served to which table
CREATE TABLE IF NOT EXISTS table_orders (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  table_number INTEGER NOT NULL,
  drink_id BIGINT NOT NULL REFERENCES cold_drinks(id) ON DELETE CASCADE,
  quantity INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_orders_table ON table_orders(table_number);
CREATE INDEX IF NOT EXISTS idx_orders_drink ON table_orders(drink_id);

-- RLS
ALTER TABLE cold_drinks ENABLE ROW LEVEL SECURITY;
ALTER TABLE table_orders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "public read drinks" ON cold_drinks FOR SELECT USING (true);
CREATE POLICY "public update drinks" ON cold_drinks FOR UPDATE USING (true);
CREATE POLICY "public insert drinks" ON cold_drinks FOR INSERT WITH CHECK (true);
CREATE POLICY "public delete drinks" ON cold_drinks FOR DELETE USING (true);

CREATE POLICY "public read orders" ON table_orders FOR SELECT USING (true);
CREATE POLICY "public insert orders" ON table_orders FOR INSERT WITH CHECK (true);
CREATE POLICY "public delete orders" ON table_orders FOR DELETE USING (true);
