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

create index if not exists ad_accounts_status_kind_idx on public.ad_accounts(status_kind);
create index if not exists rejected_ads_meta_account_id_idx on public.rejected_ads(meta_account_id);

alter table public.ad_accounts enable row level security;
alter table public.rejected_ads enable row level security;

-- The app uses SUPABASE_SERVICE_ROLE_KEY server-side only, so no public policies are required.
