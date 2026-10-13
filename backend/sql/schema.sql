-- DES chat backend · schema (architecture.md §2). Idempotent.
create extension if not exists vector;   -- gen_random_uuid() is built in since PG13

create table if not exists visitors (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  contact text,                     -- encrypted when PII_ENCRYPTION_KEY is set
  contact_hash text,                -- HMAC blind index for per-contact rate limits
  contact_type text,                -- email | mobile | null
  consent_at timestamptz not null,
  consent_version text not null,
  consent_method text,              -- chip | typed:<word>
  marketing_opt_in boolean default false,
  lang text default 'en',
  first_page_url text,
  ip_hash text,                     -- salted, purged after 7 days
  created_at timestamptz default now()
);
create index if not exists visitors_contact_hash_idx on visitors(contact_hash);
create index if not exists visitors_created_idx on visitors(created_at);

create table if not exists conversations (
  id uuid primary key default gen_random_uuid(),
  visitor_id uuid references visitors(id) on delete cascade,
  started_at timestamptz default now(),
  ended_at timestamptz,
  status text default 'open',       -- open | handed_off | closed
  lang text default 'en',
  summary text,
  turns int default 0
);

create table if not exists messages (
  id bigserial primary key,
  conversation_id uuid references conversations(id) on delete cascade,
  role text not null,               -- user | assistant | tool | system
  content text not null,
  tool_name text, tool_input jsonb, tool_output jsonb,
  tokens_in int, tokens_out int, cache_read int,
  cost_usd numeric(10,6),
  blocked_reason text,              -- set when a guardrail replaced the reply
  created_at timestamptz default now()
);
create index if not exists messages_conv_idx on messages(conversation_id, id);

create table if not exists leads (
  id uuid primary key default gen_random_uuid(),
  visitor_id uuid references visitors(id) on delete cascade,
  conversation_id uuid references conversations(id) on delete set null,
  company text, industry text, need text, team_size text, current_system text,
  product_interest text[],
  demo_requested boolean default false,
  status text default 'new',        -- new | contacted | qualified | closed
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create unique index if not exists leads_conversation_uidx on leads(conversation_id);

create table if not exists handoffs (
  id bigserial primary key,
  conversation_id uuid references conversations(id) on delete cascade,
  reason text,
  emailed_at timestamptz,
  created_at timestamptz default now()
);

create table if not exists feedback (
  id bigserial primary key,
  conversation_id uuid references conversations(id) on delete cascade,
  message_id bigint references messages(id) on delete cascade,
  kind text not null,               -- survey | thumb | thumb_reason
  trigger text,
  rating smallint,
  thumb smallint,
  reasons text[],
  comment text,
  resolved text,
  dismissed boolean default false,
  created_at timestamptz default now()
);

create table if not exists golden_answers (
  id bigserial primary key,
  message_id bigint references messages(id) on delete set null,
  question text not null, context text, ideal_answer text not null,
  product text, reviewed_by text,
  created_at timestamptz default now()
);

create table if not exists kb_documents (
  id serial primary key,
  url text unique not null,
  title text, kind text,            -- page | product | blog | career | news | testimonial
  lastmod timestamptz,
  content_hash text,
  status text default 'active',     -- active | archived
  updated_at timestamptz default now()
);

create table if not exists kb_chunks (
  id bigserial primary key,
  document_id int references kb_documents(id) on delete cascade,
  section text,
  chunk text not null,
  product text,
  embedding vector(1024),
  tsv tsvector generated always as (to_tsvector('english', chunk)) stored
);
create index if not exists kb_chunks_doc_idx on kb_chunks(document_id);
create index if not exists kb_chunks_tsv_idx on kb_chunks using gin(tsv);
-- hnsw needs rows > 0 to be useful; create lazily in migrate.js after first ingest
-- create index kb_chunks_emb_idx on kb_chunks using hnsw (embedding vector_cosine_ops);

create table if not exists facts (                -- admin-edited core facts injected into every prompt
  key text primary key,
  value text not null,
  updated_at timestamptz default now()
);
insert into facts(key,value) values
 ('company_name','DynamIQ Enterprise Solutions Inc.'),
 ('address','No. 12 Tagdalit Street, Manresa, Quezon City 1115, Metro Manila, Philippines'),
 ('sales_mobile','+63 917-630-4848'),
 ('landline','+63 (2) 8365 0228'),
 ('sales_email','sales@dynamiqes.com'),
 ('hr_email','hr@dynamiqes.com'),
 ('hr_mobile','+63 917 703 2701'),
 ('hours','Monday–Friday, 8:00 AM – 5:00 PM (Philippine time)'),
 ('partner_tier','SAP Premier Partner'),
 ('demo_url','https://dynamiqes.com/book-free-demo/'),
 ('dpo_email','dpo@dynamiqes.com')
on conflict (key) do nothing;

create table if not exists glossary (
  term text primary key,
  definition text not null
);
insert into glossary(term,definition) values
 ('ERP','Enterprise Resource Planning — one system where sales, inventory, purchasing and accounting share the same data.'),
 ('SAP B1','SAP Business One — SAP''s ERP for small and mid-size companies; the core system DynamIQ implements.'),
 ('CAS','Computerized Accounting System — the BIR''s term for accounting software whose books and forms it has reviewed and registered.'),
 ('BIR','Bureau of Internal Revenue — the Philippine tax authority.'),
 ('EWT','Expanded Withholding Tax — tax withheld on certain payments, reported on BIR Form 1601-EQ/2307.'),
 ('SOA','Statement of Account — a summary of what a customer has been billed and has paid.'),
 ('PAR','Property Acknowledgement Receipt — the signed form that records who is responsible for a company asset.'),
 ('HRIS','Human Resource Information System — software for employee records, attendance and payroll.'),
 ('POS','Point of Sale — the cashier/checkout system in a store.'),
 ('WMS','Warehouse Management System')
on conflict (term) do nothing;

create table if not exists usage_daily (          -- cost meter for the daily budget
  day date primary key,
  requests int default 0,
  tokens_in bigint default 0, tokens_out bigint default 0,
  cost_usd numeric(12,6) default 0
);

create table if not exists rate_events (          -- sliding-window rate limiting
  id bigserial primary key,
  bucket text not null,              -- session:<id> | ip:<hash> | contact:<hash>
  kind text not null,                -- msg | session
  at timestamptz default now()
);
create index if not exists rate_events_idx on rate_events(bucket, kind, at);

create table if not exists blocked (
  key text primary key,              -- ip:<hash> | contact:<hash> | session:<id>
  reason text, created_at timestamptz default now()
);

create table if not exists system_prompts (
  id serial primary key,
  version text not null,
  text text not null,
  active boolean default false,
  created_at timestamptz default now()
);

create table if not exists ingest_log (
  id bigserial primary key,
  source text,                       -- webhook | sweep | manual | scrape
  url text, action text, ok boolean, detail text,
  created_at timestamptz default now()
);

-- ---- dashboard: approved answers used live, per-product notes (2026-10-02) ----
alter table golden_answers add column if not exists active boolean default true;
alter table golden_answers add column if not exists updated_at timestamptz default now();
alter table golden_answers add column if not exists embedding vector(1024);
alter table golden_answers add column if not exists use_count int default 0;
alter table golden_answers add column if not exists last_used_at timestamptz;
alter table golden_answers add column if not exists variations text;   -- other ways visitors ask it, one per line

create table if not exists product_notes (        -- extra facts / instructions injected when the product comes up
  product text primary key,
  notes text not null default '',
  updated_at timestamptz default now()
);

alter table messages add column if not exists product text;        -- product detected in the visitor message
alter table messages add column if not exists golden_ids bigint[];  -- approved answers supplied for this reply
create index if not exists messages_created_idx on messages(created_at);

create table if not exists allowed_sites (        -- websites added in the dashboard that may show the widget (on top of ALLOWED_ORIGINS)
  origin text primary key,
  note text,
  added_at timestamptz default now()
);

-- ---- complete conversation capture (2026-10-13) ----
-- every message the visitor sees or sends is stored, in order: AI replies (incl. partial ones), scripted widget bubbles, notices
alter table messages add column if not exists seq int;                          -- order within the conversation (assigned on insert)
alter table messages add column if not exists kind text default 'chat';         -- chat (AI history) | script (widget bubble / sign-up) | event (notice)
alter table messages add column if not exists incomplete boolean default false; -- reply cut short (error, timeout, visitor left)
alter table messages add column if not exists delivered boolean default true;   -- false when the visitor had left before the reply finished
alter table messages add column if not exists original_content text;            -- AI text before a guardrail replaced or edited it
alter table messages add column if not exists source text default 'server';     -- server | widget (logged by the browser)
alter table messages add column if not exists held boolean default false;       -- first question held during sign-up, answered after it
alter table conversations add column if not exists last_seq int default 0;
alter table conversations add column if not exists last_activity_at timestamptz;
alter table visitors add column if not exists person_key text;                  -- same person across sign-ups (phone / contact HMAC)
create index if not exists visitors_person_key_idx on visitors(person_key);
create index if not exists messages_conv_seq_idx on messages(conversation_id, seq);
update messages m set seq = x.rn from (select id, row_number() over (partition by conversation_id order by id) rn from messages) x where m.id = x.id and m.seq is null;
update conversations c set last_seq = x.mx from (select conversation_id, max(seq) mx from messages group by conversation_id) x where x.conversation_id = c.id and coalesce(c.last_seq, 0) < x.mx;
update conversations c set last_activity_at = coalesce((select max(created_at) from messages m where m.conversation_id = c.id), c.started_at) where c.last_activity_at is null;
update visitors set person_key = contact_hash where person_key is null and contact_hash is not null;

-- ---- phone required, email optional (2026-10-13) ----
-- contact / contact_hash / contact_type stay for older code paths and history; new sign-ups fill both sets
alter table visitors add column if not exists phone text;          -- encrypted when PII_ENCRYPTION_KEY is set
alter table visitors add column if not exists phone_hash text;     -- HMAC blind index (rate limits, bans, same-person link)
alter table visitors add column if not exists phone_type text;     -- mobile | landline | viber | whatsapp | wechat | telegram | signal | line
alter table visitors add column if not exists email text;          -- optional, encrypted when PII_ENCRYPTION_KEY is set
alter table visitors add column if not exists email_hash text;
alter table visitors add column if not exists email_type text;     -- work_email | email
create index if not exists visitors_phone_hash_idx on visitors(phone_hash);
-- backfill from the single contact field (same key + same HMAC, so the stored values can be copied as they are)
update visitors set phone = contact, phone_hash = contact_hash, phone_type = contact_type
  where phone is null and contact is not null and contact_type in ('mobile','landline','viber','whatsapp','wechat','telegram','signal','line');
update visitors set email = contact, email_hash = contact_hash, email_type = contact_type
  where email is null and contact is not null and contact_type in ('email','work_email');
update visitors set person_key = phone_hash where phone_hash is not null and person_key is distinct from phone_hash;
-- full name split at sign-up; one word = first name only (the demo form asks for the last name later)
alter table visitors add column if not exists first_name text;
alter table visitors add column if not exists last_name text;
update visitors set first_name = split_part(name, ' ', 1), last_name = nullif(substr(name, length(split_part(name, ' ', 1)) + 2), '') where first_name is null;

-- ---- dashboard accounts, sessions, audit log, system settings (2026-10-13) ----
create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  name text,
  role text not null default 'user',          -- superuser | admin | user (permissions.js)
  password_hash text not null,                -- bcrypt
  failed_logins int not null default 0,       -- 5 in a row locks the account for 15 minutes
  locked_until timestamptz,
  disabled boolean not null default false,
  created_at timestamptz default now(),
  last_login_at timestamptz
);
create table if not exists admin_sessions (    -- dashboard sign-ins (cookie des_admin holds the token; only its hash is stored)
  token_hash text primary key,
  user_id uuid references users(id) on delete cascade,
  created_at timestamptz default now(),
  expires_at timestamptz not null,
  last_seen_at timestamptz default now(),
  ip text,
  user_agent text
);
create index if not exists admin_sessions_user_idx on admin_sessions(user_id);
create table if not exists audit_log (         -- who did what, when (kept when a user is deleted)
  id bigserial primary key,
  at timestamptz default now(),
  user_id uuid,
  user_email text,
  action text not null,                        -- login, login.failed, export.leads, visitor.deleted, prompt.changed, user.role_changed, …
  target text,
  detail jsonb,
  ip text
);
create index if not exists audit_log_at_idx on audit_log(at);
create table if not exists app_settings (      -- dashboard overrides of .env values (settings.js)
  key text primary key,
  value text,
  updated_by text,
  updated_at timestamptz default now()
);

-- ---- share links: one conversation as a read-only page without sign-in (2026-10-13) ----
create table if not exists share_links (
  id bigserial primary key,
  token_hash text unique not null,             -- sha256 of the 256-bit token in the link; the token itself is never stored
  conversation_id uuid references conversations(id) on delete cascade,
  created_by uuid,
  created_by_email text,
  created_at timestamptz default now(),
  expires_at timestamptz not null,             -- 24 h / 7 days (default) / 30 days
  revoked_at timestamptz,
  revoked_by_email text,
  view_count int not null default 0,
  last_viewed_at timestamptz,
  summary text                                 -- AI-written summary, made when the link is created
);
create index if not exists share_links_conv_idx on share_links(conversation_id);
