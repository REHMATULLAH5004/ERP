-- MONTH-END RECORDS: bank statements, filed returns, collection notes, accruals & prepayments
-- Run once in the Supabase SQL Editor. Creates 6 NEW tables only; nothing existing is changed.
-- Access: Admin / Accountant / Manager can read; Admin / Accountant can write.

-- 1. Bank statement balances (one row per account per statement date)
create table if not exists public.bank_statements (
  id uuid primary key default gen_random_uuid(),
  account_code text not null check (account_code in ('1121','1120')),
  statement_date date not null,
  statement_balance numeric(14,2) not null,
  note text,
  created_by uuid default auth.uid(),
  created_at timestamptz default now(),
  unique (account_code, statement_date)
);
-- 2. Items on the books but not yet on the bank statement (or the reverse)
create table if not exists public.bank_reconciling_items (
  id uuid primary key default gen_random_uuid(),
  statement_id uuid not null references public.bank_statements(id) on delete cascade,
  item_type text not null check (item_type in ('Deposit in transit','Cheque / payment not yet cleared','Bank charge not yet booked','Bank interest not yet booked','Other')),
  description text,
  amount numeric(14,2) not null,       -- + increases the bank balance, - decreases it (as seen on the statement side)
  cleared boolean default false,
  created_at timestamptz default now()
);
-- 3. Filed statutory returns and their receipts
create table if not exists public.statutory_returns (
  id uuid primary key default gen_random_uuid(),
  tax_type text not null check (tax_type in ('PAYE','NAPSA','NHIMA','VAT','Other')),
  period_month text not null,           -- 'YYYY-MM'
  amount_declared numeric(14,2) not null default 0,
  filed_date date,
  receipt_number text,
  amount_paid numeric(14,2) default 0,
  paid_date date,
  notes text,
  created_by uuid default auth.uid(),
  created_at timestamptz default now()
);
-- 4. Collection notes (NHIMA and wholesale customers)
create table if not exists public.collection_notes (
  id uuid primary key default gen_random_uuid(),
  party_type text not null check (party_type in ('NHIMA','Wholesale customer','Other')),
  party_name text not null,
  reference text,                       -- claim batch / invoice number
  note_date date not null default current_date,
  contact_person text,
  what_was_said text not null,
  promised_amount numeric(14,2),
  promised_date date,
  next_follow_up date,
  resolved boolean default false,
  created_by uuid default auth.uid(),
  created_at timestamptz default now()
);
-- 5. Accruals and prepayments
create table if not exists public.accrual_prepayments (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('Prepayment','Accrual')),
  description text not null,
  expense_account text not null default '6199',   -- expense account the cost belongs to
  total_amount numeric(14,2) not null,
  start_month text not null,            -- 'YYYY-MM' first month the cost belongs to
  months int not null default 1 check (months between 1 and 60),
  paid_from_account text,               -- prepayment: where the money came from (1111/1121)
  status text default 'Active' check (status in ('Active','Completed','Cancelled')),
  created_by uuid default auth.uid(),
  created_at timestamptz default now()
);
-- 6. Each monthly release already posted to the books
create table if not exists public.accrual_prepayment_releases (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.accrual_prepayments(id) on delete cascade,
  period_month text not null,
  amount numeric(14,2) not null,
  journal_entry_id uuid,
  created_at timestamptz default now(),
  unique (item_id, period_month)
);

-- Accounts used by the screen (created only if missing)
insert into public.chart_of_accounts (code, name, type, category, normal_balance, is_active)
select '1150','Prepayments','Asset','Current Asset','Debit',true
where not exists (select 1 from public.chart_of_accounts where code='1150');
insert into public.chart_of_accounts (code, name, type, category, normal_balance, is_active)
select '2180','Accrued Expenses','Liability','Current Liability','Credit',true
where not exists (select 1 from public.chart_of_accounts where code='2180');

-- Row-level security
do $$
declare t text;
begin
  foreach t in array array['bank_statements','bank_reconciling_items','statutory_returns','collection_notes','accrual_prepayments','accrual_prepayment_releases']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t||'_read', t);
    execute format('drop policy if exists %I on public.%I', t||'_write', t);
    execute format($p$create policy %I on public.%I for select using (get_current_user_role() = any (array['Admin','Accountant','Manager']))$p$, t||'_read', t);
    execute format($p$create policy %I on public.%I for all using (get_current_user_role() = any (array['Admin','Accountant'])) with check (get_current_user_role() = any (array['Admin','Accountant']))$p$, t||'_write', t);
  end loop;
end $$;

-- Book balance of an account as at a date (used by the bank reconciliation screen)
create or replace function public.account_balance_at(p_code text, p_date date)
returns numeric language sql stable security invoker set search_path = public as $$
  select coalesce(sum(jl.debit),0) - coalesce(sum(jl.credit),0)
  from journal_lines jl join journal_entries je on je.id = jl.journal_entry_id
  where jl.account_code = p_code and je.status = 'Posted' and je.entry_date <= p_date;
$$;
grant execute on function public.account_balance_at(text, date) to authenticated;
