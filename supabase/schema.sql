create table if not exists public.ad_accounts (
  meta_account_id text primary key,
  name text not null,
  account_status integer not null,
  status_label text not null,
  status_kind text not null,
  last_checked_at timestamptz not null,
  status_changed_at timestamptz not null
);

create table if not exists public.rejected_ads (
  ad_id text primary key,
  ad_name text not null,
  meta_account_id text not null,
  account_name text not null,
  first_seen_at timestamptz not null
);

create table if not exists public.invoice_subscriptions (
  id bigserial primary key,
  telegram_chat_id text not null,
  meta_account_id text not null,
  account_name text not null,
  currency text,
  start_date date not null,
  enabled boolean not null default true,
  last_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (telegram_chat_id, meta_account_id)
);

create table if not exists public.invoice_setup_sessions (
  telegram_chat_id text primary key,
  step text not null check (step in ('awaiting_account_id', 'awaiting_start_date')),
  meta_account_id text,
  account_name text,
  currency text,
  updated_at timestamptz not null default now()
);

create table if not exists public.invoice_documents (
  id bigserial primary key,
  meta_account_id text not null,
  invoice_key text not null,
  invoice_date date,
  amount numeric,
  currency text,
  file_name text,
  source_url text,
  telegram_chat_id text not null,
  telegram_message_id text,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  unique (telegram_chat_id, meta_account_id, invoice_key)
);

create table if not exists public.reporting_configs (
  meta_account_id text primary key references public.ad_accounts(meta_account_id) on delete cascade,
  project_name text not null,
  goal_key text not null,
  goal_label text not null,
  currency text,
  timezone text not null default 'Europe/Kyiv',
  report_start_date date not null,
  report_end_date date not null,
  report_file_id text not null,
  report_url text not null,
  status text not null default 'configured',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ad_accounts_status_kind_idx on public.ad_accounts(status_kind);
create index if not exists rejected_ads_meta_account_id_idx on public.rejected_ads(meta_account_id);
create index if not exists invoice_subscriptions_enabled_idx on public.invoice_subscriptions(enabled, meta_account_id);
create index if not exists invoice_documents_account_idx on public.invoice_documents(meta_account_id, invoice_date desc);
create index if not exists reporting_configs_status_idx on public.reporting_configs(status);

alter table public.ad_accounts enable row level security;
alter table public.rejected_ads enable row level security;
alter table public.invoice_subscriptions enable row level security;
alter table public.invoice_setup_sessions enable row level security;
alter table public.invoice_documents enable row level security;
alter table public.reporting_configs enable row level security;

-- The app uses SUPABASE_SERVICE_ROLE_KEY server-side only, so no public policies are required.
