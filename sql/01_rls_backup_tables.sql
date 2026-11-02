-- Turn on row-level security for the five backup tables created on 30 Oct 2026.
-- With RLS on and no policy, the app (logged-in users) cannot read or write them;
-- you can still open them from the Supabase dashboard / SQL Editor.
ALTER TABLE "public"."batch_merge_map_20261030"        ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."batches_backup_20261030"          ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."product_stock_before_20261030"    ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."sales_items_backup_20261030"      ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."sale_items_batch_backup_20261030" ENABLE ROW LEVEL SECURITY;
