-- MONTH LOCK
-- Nothing is locked now (locked_through is empty), so December 2026 and earlier stay open.
-- From January 2027, lock the closed period by running ONE line in the SQL Editor:
--     update public.period_lock set locked_through = '2026-12-31' where id = 1;
-- To open it again:  update public.period_lock set locked_through = null where id = 1;

create table if not exists public.period_lock (
  id int primary key default 1 check (id = 1),
  locked_through date,
  note text,
  updated_at timestamptz default now()
);
insert into public.period_lock (id, locked_through, note)
values (1, null, 'No month is locked yet. Planned: lock through 2026-12-31 from January 2027.')
on conflict (id) do nothing;

alter table public.period_lock enable row level security;
drop policy if exists period_lock_read on public.period_lock;
create policy period_lock_read on public.period_lock for select to authenticated using (true);
-- no insert/update/delete policy: only the SQL Editor / service role can change the lock

create or replace function public.enforce_period_lock_entries()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_lock date;
begin
  select locked_through into v_lock from public.period_lock where id = 1;
  if v_lock is null then
    return coalesce(new, old);
  end if;
  if tg_op in ('UPDATE','DELETE') then
    if old.entry_date <= v_lock then
      raise exception 'This month is closed (books are locked through %). Entry % dated % cannot be changed.', v_lock, old.journal_number, old.entry_date;
    end if;
  end if;
  if tg_op in ('INSERT','UPDATE') then
    if new.entry_date <= v_lock then
      raise exception 'This month is closed (books are locked through %). You cannot post an entry dated % - use a date after the lock.', v_lock, new.entry_date;
    end if;
  end if;
  return coalesce(new, old);
end $$;

create or replace function public.enforce_period_lock_lines()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_lock date; v_date date; v_id uuid;
begin
  select locked_through into v_lock from public.period_lock where id = 1;
  if v_lock is null then
    return coalesce(new, old);
  end if;
  v_id := case when tg_op = 'DELETE' then old.journal_entry_id else new.journal_entry_id end;
  select entry_date into v_date from public.journal_entries where id = v_id;
  if v_date is not null and v_date <= v_lock then
    raise exception 'This month is closed (books are locked through %). Lines of an entry dated % cannot be changed.', v_lock, v_date;
  end if;
  return coalesce(new, old);
end $$;

drop trigger if exists trg_period_lock_entries on public.journal_entries;
create trigger trg_period_lock_entries before insert or update or delete on public.journal_entries
  for each row execute function public.enforce_period_lock_entries();
drop trigger if exists trg_period_lock_lines on public.journal_lines;
create trigger trg_period_lock_lines before insert or update or delete on public.journal_lines
  for each row execute function public.enforce_period_lock_lines();
