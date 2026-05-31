-- Add table_number column to existing inventory_history
ALTER TABLE inventory_history
ADD COLUMN IF NOT EXISTS table_number text;

-- Update existing rows where action is 'table_assign' to set a default table_number
-- (this is optional; you can change 'D1' to whatever default is meaningful)
UPDATE inventory_history
SET table_number = 'D1'
WHERE action = 'table_assign'
AND table_number IS NULL;
