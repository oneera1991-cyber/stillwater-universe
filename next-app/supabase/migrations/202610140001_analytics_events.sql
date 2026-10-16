create table if not exists public.analytics_events (
  event_id uuid primary key,
  session_id uuid not null,
  event_name text not null check (event_name in (
    'landing_page_view', 'starter_started', 'question_submitted',
    'starter_result_viewed', 'deeper_cta_clicked', 'payhip_checkout_opened',
    'payment_verified', 'payment_refunded', 'deeper_result_unlocked'
  )),
  acquisition_source text check (acquisition_source is null or acquisition_source in ('facebook', 'tiktok', 'instagram', 'youtube')),
  question text check (question is null or length(question) <= 2000),
  created_at timestamptz not null default now()
);

create index if not exists analytics_events_session_created_idx
  on public.analytics_events (session_id, created_at desc);
create index if not exists analytics_events_name_created_idx
  on public.analytics_events (event_name, created_at desc);

alter table public.analytics_events enable row level security;
revoke all on public.analytics_events from anon, authenticated;
grant all on public.analytics_events to service_role;
