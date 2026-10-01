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
