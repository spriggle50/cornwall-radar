-- Cornwall Radar — Phase 1.5+ schema (run this in a NEW Supabase project,
-- fully separate from Spriggle's, once you're ready to add accounts/billing).
-- Not required to run Phase 1's live dashboard, which has no accounts yet.

create table consumers (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  stripe_customer_id text,
  subscription_status text not null default 'free', -- free | active | past_due | canceled
  created_at timestamptz not null default now()
);

create table saved_locations (
  id uuid primary key default gen_random_uuid(),
  consumer_id uuid not null references consumers(id) on delete cascade,
  label text not null,
  postcode text not null,
  lat numeric,
  lng numeric,
  created_at timestamptz not null default now()
);

create table alert_preferences (
  id uuid primary key default gen_random_uuid(),
  consumer_id uuid not null references consumers(id) on delete cascade,
  location_id uuid references saved_locations(id) on delete cascade,
  alert_type text not null, -- traffic_route | weather_warning | wildlife_nearby | morning_digest
  config jsonb not null default '{}',
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  consumer_id uuid not null references consumers(id) on delete cascade,
  endpoint text not null,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);

create table alert_log (
  id uuid primary key default gen_random_uuid(),
  consumer_id uuid not null references consumers(id) on delete cascade,
  alert_type text not null,
  dispatched_at timestamptz not null default now(),
  dedupe_key text not null
);

create table subscriptions (
  id uuid primary key default gen_random_uuid(),
  consumer_id uuid not null references consumers(id) on delete cascade,
  stripe_subscription_id text not null,
  stripe_price_id text not null,
  status text not null,
  current_period_end timestamptz,
  created_at timestamptz not null default now()
);

-- Row-Level Security — enable before going live with real user data.
alter table consumers enable row level security;
alter table saved_locations enable row level security;
alter table alert_preferences enable row level security;
alter table push_subscriptions enable row level security;
alter table subscriptions enable row level security;

create policy "consumers see own row" on consumers for select using (auth.uid() = id);
create policy "consumers manage own locations" on saved_locations for all using (auth.uid() = consumer_id);
create policy "consumers manage own alert prefs" on alert_preferences for all using (auth.uid() = consumer_id);
create policy "consumers manage own push subs" on push_subscriptions for all using (auth.uid() = consumer_id);
create policy "consumers see own subscriptions" on subscriptions for select using (auth.uid() = consumer_id);
