-- READ-ONLY data health checks for the ERP database.
-- Run each block in the Supabase SQL editor. Every check should return ZERO rows;
-- any row returned is something to look at. Nothing here changes data.

-- 1. A batch must never hold negative stock
select 'negative_batch' as check, id, total_qty from batches where total_qty < 0;

-- 2. Every journal entry must balance (debits = credits)
select 'unbalanced_journal' as check, je.id, je.journal_number, je.reference,
       sum(jl.debit) as debit, sum(jl.credit) as credit
from journal_entries je join journal_lines jl on jl.journal_entry_id = je.id
group by je.id, je.journal_number, je.reference
having round(sum(jl.debit)::numeric, 2) <> round(sum(jl.credit)::numeric, 2);

-- 3. No two sales may share an invoice number
select 'duplicate_invoice_number' as check, sale_id, count(*) from sales
group by sale_id having count(*) > 1;

-- 4. Every sale line must belong to a sale, and point at a real batch when it has one
select 'orphan_sale_line' as check, si.id from sale_items si left join sales s on s.id = si.sale_id where s.id is null;
select 'line_with_missing_batch' as check, si.id, si.batch_id from sale_items si
left join batches b on b.id = si.batch_id where si.batch_id is not null and b.id is null;

-- 5. Money in the ledger must equal the invoice total (sales of the last 60 days).
--    KNOWN EXCEPTION at the time of writing: GMLR-2026-320465-1736 (ledger 4850.10 vs invoice 4081.20).
select 'sale_ledger_mismatch' as check, sale_id, sale_date, grand_total, ledger_total, missing_ledger
from v_sale_consistency_check
where sale_date >= now() - interval '60 days'
  and (missing_ledger or ledger_total_differs);

-- 5b. INFORMATION ONLY (expected to return rows today): invoice lines that do not add up to the invoice
--     total. For NHIMA sales this is usually claim pricing / older invoices saved without lines, so it is
--     not part of the pass/fail checks above.
select 'info_lines_vs_total' as check, client_sub_type, count(*) as sales
from v_sale_consistency_check
where sale_date >= now() - interval '60 days' and lines_total_differs
group by client_sub_type;

-- 6. KNOWN: 311 old tickets (Sep-Oct 2026) were never closed. Harmless for the TV (it only reads today) but
--    they should be closed in a clean-up. Queue tickets must not stay "serving" or "waiting" after the day they were issued
select 'stale_queue_ticket' as check, id, token_number, status, queue_date from queue_tickets
where queue_date < current_date
  and status in ('waiting_billing','serving_billing','waiting_dispensing','serving_dispensing');

-- 7. Two tickets must never be served at the same counter at once
select 'double_booked_counter' as check, queue_date, billing_counter, count(*) from queue_tickets
where status = 'serving_billing' group by queue_date, billing_counter having count(*) > 1;
select 'double_booked_counter' as check, queue_date, dispensing_counter, count(*) from queue_tickets
where status = 'serving_dispensing' group by queue_date, dispensing_counter having count(*) > 1;
