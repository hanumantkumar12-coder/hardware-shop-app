-- ============================================================
-- ShopHisaab — Hardware & Paint Shop Manager
-- SUPABASE BACKEND SCHEMA (run once in SQL Editor)
-- Lifetime-free stack • append-only audit • RLS protected
-- ============================================================

-- ---------- profiles (members) FIRST ----------
create table if not exists profiles (
  id      uuid primary key references auth.users(id) on delete cascade,
  name    text,
  phone   text,
  role    text not null default 'staff' check (role in ('owner','staff')),
  active  boolean not null default false,
  created_at timestamptz default now()
);

-- ---------- helpers ----------
create or replace function is_active_member() returns boolean
language sql stable security definer set search_path = public as $$
  select exists(select 1 from profiles where id = auth.uid() and active);
$$;

create or replace function is_owner() returns boolean
language sql stable security definer set search_path = public as $$
  select exists(select 1 from profiles where id = auth.uid() and role = 'owner' and active);
$$;

-- first ever signup becomes OWNER+active; later signups are inactive staff
create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, name, phone, role, active)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'name', split_part(new.email,'@',1)),
    nullif(new.raw_user_meta_data->>'phone',''),
    case when (select count(*) from profiles) = 0 then 'owner' else 'staff' end,
    (select count(*) from profiles) = 0
  );
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ---------- catalogue ----------
create table if not exists products (
  id            bigint generated always as identity primary key,
  name          text not null,
  name_hi       text,
  unit          text default 'pcs',
  barcode       text unique,
  category      text,
  purchase_price numeric(12,2) not null default 0,
  selling_price  numeric(12,2) not null default 0,
  gst_rate       numeric(5,2)  default 0,
  current_stock  numeric(12,3) not null default 0,
  reorder_level  numeric(12,3) not null default 0,
  is_active      boolean default true,
  created_by     uuid references auth.users(id),
  created_at     timestamptz default now(),
  updated_at     timestamptz default now()
);

create table if not exists customers (
  id        bigint generated always as identity primary key,
  name      text not null,
  phone     text,
  address   text,
  gstin     text,
  balance   numeric(12,2) not null default 0,   -- +ve = udhaar outstanding
  created_by uuid references auth.users(id),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists suppliers (
  id        bigint generated always as identity primary key,
  name      text not null,
  phone     text,
  balance   numeric(12,2) not null default 0,
  created_at timestamptz default now()
);

-- ---------- transactions ----------
create sequence if not exists sale_invoice_seq;

create table if not exists sales (
  id           bigint generated always as identity primary key,
  invoice_no   bigint not null default nextval('sale_invoice_seq'),
  customer_id  bigint references customers(id),
  total        numeric(12,2) not null default 0,
  paid_amount  numeric(12,2) not null default 0,
  due_amount   numeric(12,2) generated always as (greatest(total - paid_amount, 0)) stored,
  payment_mode text default 'cash',
  notes        text,
  created_by   uuid references auth.users(id) default auth.uid(),
  created_at   timestamptz default now()
);

create table if not exists sale_items (
  id         bigint generated always as identity primary key,
  sale_id    bigint not null references sales(id) on delete cascade,
  product_id bigint references products(id),
  qty        numeric(12,3) not null,
  unit_price numeric(12,2) not null,
  cost_at_sale numeric(12,2) default 0,
  amount     numeric(12,2) generated always as (qty * unit_price) stored
);

create table if not exists purchases (
  id            bigint generated always as identity primary key,
  supplier_name text,
  total         numeric(12,2) not null default 0,
  paid_amount   numeric(12,2) not null default 0,
  notes         text,
  created_by    uuid references auth.users(id) default auth.uid(),
  created_at    timestamptz default now()
);

create table if not exists purchase_items (
  id          bigint generated always as identity primary key,
  purchase_id bigint not null references purchases(id) on delete cascade,
  product_id  bigint references products(id),
  qty         numeric(12,3) not null,
  unit_cost   numeric(12,2) not null default 0,
  amount      numeric(12,2) generated always as (qty * unit_cost) stored
);

create table if not exists payments (
  id          bigint generated always as identity primary key,
  direction   text not null check (direction in ('received','paid')),
  customer_id bigint references customers(id),
  supplier_id bigint references suppliers(id),
  amount      numeric(12,2) not null,
  mode        text default 'cash',
  note        text,
  created_by  uuid references auth.users(id) default auth.uid(),
  created_at  timestamptz default now()
);

create table if not exists stock_movements (
  id         bigint generated always as identity primary key,
  product_id bigint not null references products(id),
  qty        numeric(12,3) not null,          -- +in / -out
  reason     text not null,                   -- purchase/sale/adjustment/damage/return
  ref_table  text,
  ref_id     bigint,
  created_by uuid references auth.users(id) default auth.uid(),
  created_at timestamptz default now()
);

-- paint-shop special: repeat exact shades for repeat customers
create table if not exists paint_mixes (
  id              bigint generated always as identity primary key,
  customer_id     bigint references customers(id),
  base_product_id bigint references products(id),
  brand           text, shade_code text, shade_name text,
  formula         jsonb,                        -- [{"color":"OX Red","ml":12}, ...]
  batch_no        text,
  mixed_by        uuid references auth.users(id) default auth.uid(),
  created_at      timestamptz default now()
);

-- ---------- AUDIT LOG (append-only) ----------
create table if not exists audit_log (
  id         bigint generated always as identity primary key,
  acted_at   timestamptz not null default now(),
  actor      uuid references auth.users(id),
  actor_name text,
  action     text not null check (action in ('INSERT','UPDATE','DELETE')),
  table_name text not null,
  row_id     text,
  old_row    jsonb,
  new_row    jsonb
);
revoke update, delete on audit_log from authenticated;
revoke all on audit_log from anon;

create or replace function audit_trigger_fn() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_old jsonb; v_new jsonb; v_actor uuid := auth.uid(); v_name text;
begin
  if tg_op = 'DELETE' then v_old := to_jsonb(old);
  elsif tg_op = 'INSERT' then v_new := to_jsonb(new);
  else
    v_old := to_jsonb(old); v_new := to_jsonb(new);
    if v_old = v_new then return coalesce(new, old); end if;  -- ignore no-op saves
  end if;
  select name into v_name from profiles where id = v_actor;
  insert into audit_log (actor, actor_name, action, table_name, row_id, old_row, new_row)
  values (v_actor, coalesce(v_name,'?'), tg_op, tg_table_name,
          coalesce(v_new->>'id', v_old->>'id'), v_old, v_new);
  return coalesce(new, old);
end $$;

do $$
declare tb text;
begin
  foreach tb in array array['products','customers','suppliers','sales','purchases','payments']
  loop
    execute format('drop trigger if exists aud_%1$s on %1$s', tb);
    execute format('create trigger aud_%1$s after insert or update or delete on %1$s
                    for each row execute function audit_trigger_fn()', tb);
  end loop;
end $$;

-- ---------- RPC: create_sale (atomic) ----------
create or replace function create_sale(
  p_customer_id bigint, p_items jsonb, p_paid numeric, p_mode text)
returns bigint
language plpgsql security definer set search_path = public as $$
declare
  v_sale bigint; v_total numeric := 0; it record; v_due numeric;
begin
  if not is_active_member() then raise exception 'not allowed'; end if;
  insert into sales (customer_id, payment_mode, paid_amount)
  values (p_customer_id, p_mode, p_paid) returning id into v_sale;

  for it in select * from jsonb_populate_recordset(null::record, p_items)
             as x(product_id bigint, qty numeric, unit_price numeric)
  loop
    insert into sale_items (sale_id, product_id, qty, unit_price, cost_at_sale)
    values (v_sale, it.product_id, it.qty, it.unit_price,
            (select purchase_price from products where id = it.product_id));
    update products
       set current_stock = current_stock - it.qty, updated_at = now()
     where id = it.product_id;
    insert into stock_movements (product_id, qty, reason, ref_table, ref_id)
    values (it.product_id, -it.qty, 'sale', 'sales', v_sale);
    v_total := v_total + it.qty * it.unit_price;
  end loop;

  update sales set total = v_total where id = v_sale;
  v_due := greatest(v_total - p_paid, 0);
  if p_customer_id is not null and v_due > 0 then
    update customers set balance = balance + v_due, updated_at = now() where id = p_customer_id;
  elsif p_customer_id is not null and p_paid > v_total then
    update customers set balance = balance - (p_paid - v_total), updated_at = now() where id = p_customer_id;
  end if;
  return v_sale;
end $$;

-- ---------- RPC: create_purchase (atomic stock-in) ----------
create or replace function create_purchase(
  p_supplier text, p_items jsonb, p_paid numeric)
returns bigint
language plpgsql security definer set search_path = public as $$
declare
  v_pur bigint; v_total numeric := 0; it record;
begin
  if not is_active_member() then raise exception 'not allowed'; end if;
  insert into purchases (supplier_name, paid_amount)
  values (p_supplier, p_paid) returning id into v_pur;

  for it in select * from jsonb_populate_recordset(null::record, p_items)
             as x(product_id bigint, qty numeric, unit_cost numeric)
  loop
    insert into purchase_items (purchase_id, product_id, qty, unit_cost)
    values (v_pur, it.product_id, it.qty, it.unit_cost);
    update products
       set current_stock = current_stock + it.qty,
           purchase_price = case when it.unit_cost > 0 then it.unit_cost else purchase_price end,
           updated_at = now()
     where id = it.product_id;
    insert into stock_movements (product_id, qty, reason, ref_table, ref_id)
    values (it.product_id, it.qty, 'purchase', 'purchases', v_pur);
    v_total := v_total + it.qty * coalesce(it.unit_cost,0);
  end loop;

  update purchases set total = v_total where id = v_pur;
  return v_pur;
end $$;

-- ---------- RPC: receive_payment ----------
create or replace function receive_payment(
  p_customer_id bigint, p_amount numeric, p_mode text, p_note text default null)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_active_member() then raise exception 'not allowed'; end if;
  insert into payments (direction, customer_id, amount, mode, note)
  values ('received', p_customer_id, p_amount, p_mode, p_note);
  update customers set balance = balance - p_amount, updated_at = now() where id = p_customer_id;
end $$;

-- ---------- ROW LEVEL SECURITY ----------
alter table profiles        enable row level security;
alter table products        enable row level security;
alter table customers       enable row level security;
alter table suppliers       enable row level security;
alter table sales           enable row level security;
alter table sale_items      enable row level security;
alter table purchases       enable row level security;
alter table purchase_items  enable row level security;
alter table payments        enable row level security;
alter table stock_movements enable row level security;
alter table paint_mixes     enable row level security;
alter table audit_log       enable row level security;

-- profiles: see all members; edit yourself; owner edits anyone
create policy p_profiles_sel on profiles for select to authenticated
  using (id = auth.uid() or is_active_member());
create policy p_profiles_upd on profiles for update to authenticated
  using (id = auth.uid() or is_owner());

-- business tables: members read+insert, only owner updates/deletes
do $$
declare tb text;
begin
  foreach tb in array array['products','customers','suppliers','sales','sale_items',
                            'purchases','purchase_items','payments','stock_movements','paint_mixes']
  loop
    execute format('create policy %I on %I for select to authenticated using (is_active_member())',   'sel_'||tb, tb);
    execute format('create policy %I on %I for insert to authenticated with check (is_active_member())','ins_'||tb, tb);
    execute format('create policy %I on %I for update to authenticated using (is_owner())',            'upd_'||tb, tb);
    execute format('create policy %I on %I for delete to authenticated using (is_owner())',            'del_'||tb, tb);
  end loop;
end $$;

-- audit log: owner reads, nobody writes directly (trigger handles it)
create policy p_audit_sel on audit_log for select to authenticated using (is_owner());

-- ---------- useful indexes ----------
create index if not exists idx_sales_date      on sales (created_at desc);
create index if not exists idx_sales_cust      on sales (customer_id);
create index if not exists idx_cust_balance    on customers (balance desc);
create index if not exists idx_moves_product   on stock_movements (product_id, created_at desc);
create index if not exists idx_audit_recent    on audit_log (id desc);
