-- Naru chat, LOCAL version: plain Postgres on your own machine. No Supabase.
-- Access control is done in the server code (every query filters by the signed-in user's id).
create extension if not exists pgcrypto;

create table users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  password_hash text not null,           -- argon2/bcrypt hash, never the password
  created_at timestamptz not null default now()
);
create table sessions (
  token_hash text primary key,           -- sha-256 of the cookie value
  user_id uuid not null references users(id) on delete cascade,
  expires_at timestamptz not null
);
create index on sessions (user_id);

create table profiles (
  id uuid primary key references users(id) on delete cascade,
  display_name text not null default 'You' check (char_length(display_name) between 1 and 60),
  plan text not null default 'free' check (plan in ('free','pro')),
  system_prompt text not null default '' check (char_length(system_prompt) <= 4000),
  theme text not null default 'system' check (theme in ('system','light','dark')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  title text not null default 'New chat' check (char_length(title) <= 120),
  model text not null default 'naru',
  share_token text unique,
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on conversations (user_id, updated_at desc);

-- Messages form a tree: parent_id lets edit and regenerate create branches. active_child picks the branch shown.
create table messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  parent_id uuid references messages(id) on delete cascade,
  role text not null check (role in ('user','assistant')),
  content jsonb not null default '[]',          -- blocks: [{type:'text',text}, {type:'attachment',id}]
  status text not null default 'complete' check (status in ('streaming','complete','stopped','error')),
  stop_reason text,
  tokens_in int check (tokens_in >= 0),
  tokens_out int check (tokens_out >= 0),
  created_at timestamptz not null default now()
);
create index on messages (conversation_id, created_at);
create index on messages (parent_id);
create index on messages (user_id);
alter table conversations add column active_leaf uuid references messages(id) on delete set null;

create table attachments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  message_id uuid references messages(id) on delete cascade,
  name text not null check (char_length(name) <= 200),
  mime text not null check (mime in ('image/png','image/jpeg','image/webp','application/pdf','text/plain','text/markdown')),
  size_bytes int not null check (size_bytes between 1 and 10485760),
  storage_path text not null,
  created_at timestamptz not null default now()
);
create index on attachments (user_id);
create index on attachments (message_id);

create table feedback (
  message_id uuid not null references messages(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  rating smallint not null check (rating in (-1, 1)),
  note text check (char_length(note) <= 1000),
  created_at timestamptz not null default now(),
  primary key (message_id, user_id)
);

-- Usage: rolling 5-hour windows, written only by the server (tokens are what costs money).
create table usage_windows (
  user_id uuid not null references profiles(id) on delete cascade,
  window_start timestamptz not null,
  tokens_used int not null default 0 check (tokens_used >= 0),
  primary key (user_id, window_start)
);

-- Batch jobs for long prompts / long answers (resume after a crash or restart).
create table jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  conversation_id uuid not null references conversations(id) on delete cascade,
  kind text not null check (kind in ('long_input','long_answer')),
  status text not null default 'queued' check (status in ('queued','running','done','failed','cancelled')),
  total_steps int not null default 0, done_steps int not null default 0,
  state jsonb not null default '{}',     -- notes so far / finished sections, so a restart continues
  error text, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index on jobs (user_id, created_at desc);
create index on jobs (status);

-- The app connects as a role that cannot change usage or plan except through server code you write.
create or replace function shared_chat(p_token text)
returns json language sql stable as $$
  select json_build_object('title', c.title, 'messages', coalesce((
    select json_agg(json_build_object('role', m.role, 'content', m.content) order by m.created_at)
    from messages m where m.conversation_id = c.id and m.status <> 'error'), '[]'::json))
  from conversations c where c.share_token = p_token and p_token is not null and char_length(p_token) >= 20
$$;
