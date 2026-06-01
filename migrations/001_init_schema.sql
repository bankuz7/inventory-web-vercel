-- Drinks Inventory Schema for The Barkat's Heaven

-- Drinks table: list of all drinks with price
CREATE TABLE IF NOT EXISTS drinks (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT DEFAULT 'Other',
  price NUMERIC(10,2) NOT NULL DEFAULT 0,
  unit TEXT DEFAULT 'peg',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Table orders: tracks which table consumed which drink and how many
CREATE TABLE IF NOT EXISTS table_orders (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  table_number INTEGER NOT NULL,
  drink_id BIGINT NOT NULL REFERENCES drinks(id) ON DELETE CASCADE,
  quantity INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_table_orders_table ON table_orders(table_number);
CREATE INDEX IF NOT EXISTS idx_table_orders_drink ON table_orders(drink_id);

-- Enable Row Level Security
ALTER TABLE drinks ENABLE ROW LEVEL SECURITY;
ALTER TABLE table_orders ENABLE ROW LEVEL SECURITY;

-- Public policies for demo
CREATE POLICY "Allow public read on drinks" ON drinks FOR SELECT USING (true);
CREATE POLICY "Allow public insert on drinks" ON drinks FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow public update on drinks" ON drinks FOR UPDATE USING (true);
CREATE POLICY "Allow public delete on drinks" ON drinks FOR DELETE USING (true);

CREATE POLICY "Allow public read on table_orders" ON table_orders FOR SELECT USING (true);
CREATE POLICY "Allow public insert on table_orders" ON table_orders FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow public update on table_orders" ON table_orders FOR UPDATE USING (true);
CREATE POLICY "Allow public delete on table_orders" ON table_orders FOR DELETE USING (true);
