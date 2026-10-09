-- =============================================================================
-- schema.sql — VICE CONTABIL | Sistema de Gerenciamento de Análise de Processos Contábeis
-- -----------------------------------------------------------------------------
-- Execute ESTE ARQUIVO UMA ÚNICA VEZ no Supabase Studio > SQL Editor > New query.
-- Ele cria as tabelas usadas pelo frontend (processos, perfis, configuracoes),
-- o bucket de Storage e as policies de segurança (RLS).
-- Em instalações existentes, execute somente `migration-creditos.sql` para
-- adicionar o controle de créditos e validade sem reaplicar o restante do schema.
-- =============================================================================

-- 1) TABELA DE PERFIS (Administrador x Usuário Padrão) ------------------------
create table if not exists public.perfis (
    id         uuid primary key references auth.users(id) on delete cascade,
    nome       text,
    email      text,
    perfil     text not null default 'usuario' check (perfil in ('admin','usuario')),
    ativo      boolean not null default true,
    tipo_acesso text not null default 'creditos' check (tipo_acesso in ('creditos','tempo')),
    creditos_saldo integer not null default 0 check (creditos_saldo >= 0),
    acesso_expira_em timestamptz,
    created_at timestamptz not null default now()
);

-- Migração para instalações existentes: execute novamente este bloco ao
-- atualizar uma base que já possua a tabela perfis.
alter table public.perfis add column if not exists tipo_acesso text not null default 'creditos';
alter table public.perfis add column if not exists creditos_saldo integer not null default 0;
alter table public.perfis add column if not exists acesso_expira_em timestamptz;
do $$ begin
    alter table public.perfis add constraint perfis_tipo_acesso_check check (tipo_acesso in ('creditos','tempo'));
exception when duplicate_object then null; end $$;
do $$ begin
    alter table public.perfis add constraint perfis_creditos_saldo_check check (creditos_saldo >= 0);
exception when duplicate_object then null; end $$;

-- Consome atomicamente um crédito antes de cada análise e valida a validade
-- do plano. O usuário só pode consumir o próprio saldo.
create or replace function public.consumir_credito()
returns boolean
language plpgsql security definer set search_path = public
as $$
declare p public.perfis%rowtype;
begin
    select * into p from public.perfis where id = auth.uid() for update;
    if not found or not p.ativo then return false; end if;
    if p.perfil = 'admin' then return true; end if;
    if p.tipo_acesso = 'tempo' then
        return p.acesso_expira_em is not null and p.acesso_expira_em > now();
    end if;
    if p.tipo_acesso = 'creditos' and p.creditos_saldo > 0 then
        update public.perfis set creditos_saldo = creditos_saldo - 1 where id = p.id;
        return true;
    end if;
    return false;
end;
$$;
revoke all on function public.consumir_credito() from public;
grant execute on function public.consumir_credito() to authenticated;

-- Consulta se um e-mail existe no Auth para a tela de recuperação de senha.
-- SECURITY DEFINER permite consultar sem login; a função retorna somente boolean.
create or replace function public.email_cadastrado(p_email text)
returns boolean
language sql stable security definer set search_path = ''
as $$
    select coalesce(nullif(btrim(p_email), ''), '') <> ''
       and exists (
           select 1 from auth.users u
           where lower(u.email) = lower(btrim(p_email))
       );
$$;
revoke all on function public.email_cadastrado(text) from public;
grant execute on function public.email_cadastrado(text) to anon, authenticated;

-- 2) TABELA DE PROCESSOS (consultas salvas no Dashboard) ----------------------
create table if not exists public.processos (
    id              uuid primary key default gen_random_uuid(),
    user_id         uuid not null default auth.uid() references auth.users(id) on delete cascade,
    cliente         text,
    documento       text,
    numero_processo text,
    orgao           text,
    periodo         text,
    tipo_analise    text,
    email           text,
    telefone        text,
    observacoes     text,
    arquivo_nome    text,
    arquivo_path    text,          -- caminho do PDF no Storage
    docx_nome       text,
    docx_path       text,          -- caminho do Word no Storage
    docx_url        text,          -- URL devolvida pelo n8n (alternativa)
    docx_base64     text,          -- fallback: Word guardado na própria linha
    status          text not null default 'rascunho' check (status in ('rascunho','processando','concluido','erro')),
    resumo          text,
    resposta        jsonb,         -- JSON bruto retornado pelo n8n
    webhook_url     text,
    created_at      timestamptz not null default now()
);
create index if not exists processos_user_id_idx on public.processos(user_id, created_at desc);

-- 3) CONFIGURAÇÕES CHAVE-VALOR (URL do webhook do n8n) ------------------------
create table if not exists public.configuracoes (
    chave      text primary key,
    valor      text,
    updated_at timestamptz not null default now()
);

-- 4) RLS ---------------------------------------------------------------------
alter table public.perfis        enable row level security;
alter table public.processos     enable row level security;
alter table public.configuracoes enable row level security;

-- Função auxiliar: é administrador?
create or replace function public.eh_admin()
returns boolean
language sql stable security definer set search_path = public
as $$
    select exists (
        select 1 from public.perfis p
        where p.id = auth.uid() and p.perfil = 'admin' and p.ativo
    );
$$;

-- perfis: admin lê/gerencia tudo; usuário lê o próprio perfil
drop policy if exists "perfis_select"        on public.perfis;
drop policy if exists "perfis_admin_insert"  on public.perfis;
drop policy if exists "perfis_admin_update"  on public.perfis;
drop policy if exists "perfis_admin_delete"  on public.perfis;

create policy "perfis_select"       on public.perfis for select
    using (id = auth.uid() or public.eh_admin());
create policy "perfis_admin_insert" on public.perfis for insert
    with check (public.eh_admin());
create policy "perfis_admin_update" on public.perfis for update
    using (public.eh_admin()) with check (public.eh_admin());
create policy "perfis_admin_delete" on public.perfis for delete
    using (public.eh_admin());

-- processos: cada usuário vê os próprios; admin vê todos
drop policy if exists "processos_select"   on public.processos;
drop policy if exists "processos_insert"   on public.processos;
drop policy if exists "processos_update"   on public.processos;
drop policy if exists "processos_delete"   on public.processos;

create policy "processos_select" on public.processos for select
    using (user_id = auth.uid() or public.eh_admin());
create policy "processos_insert" on public.processos for insert
    with check (user_id = auth.uid());
create policy "processos_update" on public.processos for update
    using (user_id = auth.uid() or public.eh_admin());
create policy "processos_delete" on public.processos for delete
    using (user_id = auth.uid() or public.eh_admin());

-- configuracoes: só administrador escreve; todos autenticados leem
drop policy if exists "config_select"  on public.configuracoes;
drop policy if exists "config_write"   on public.configuracoes;

create policy "config_select" on public.configuracoes for select
    using (auth.uid() is not null);
create policy "config_write"  on public.configuracoes for all
    using (public.eh_admin()) with check (public.eh_admin());

-- 5) BUCKET DE STORAGE (PDFs e arquivos Word) --------------------------------
-- OBS: o INSERT abaixo cria a linha no banco, mas o serviço do Storage só passa
-- a enxergar o bucket quando ele é registrado pela API. Depois de rodar este
-- arquivo, crie a bucket pela UI (Storage > New bucket > nome: processos,
-- Private) OU rode 1x:
--   curl -X POST "$SUPABASE_URL/storage/v1/bucket" \
--     -H "apikey: $SERVICE_ROLE_KEY" -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
--     -H "Content-Type: application/json" \
--     -d '{"id":"processos","name":"processos","public":false}'
insert into storage.buckets (id, name, public)
values ('processos', 'processos', false)
on conflict (id) do nothing;

-- O storage.buckets vem com RLS ativo e SEM policies (o service_role enxerga,
-- o usuário comum não) — estas duas policies liberam a leitura do cadastro.
drop policy if exists "buckets_select_auth" on storage.buckets;
create policy "buckets_select_auth" on storage.buckets for select
    to authenticated using (true);

drop policy if exists "storage_processos_all" on storage.objects;
create policy "storage_processos_all" on storage.objects for all
    using (bucket_id = 'processos' and (owner = auth.uid() or public.eh_admin()))
    with check (bucket_id = 'processos' and owner = auth.uid());

-- 6) USUÁRIO ADMINISTRADOR INICIAL -------------------------------------------
-- Troque o e-mail abaixo pelo seu e-mail e rode DEPOIS de criar a conta pelo
-- painel de login (ou crie a conta no Supabase > Authentication > Users).
-- update public.perfis set perfil = 'admin'
--   where email = 'jorgecstbrt@exemplo.com.br';

-- =============================================================================
-- EDGE FUNCTION OPCIONAL (`admin-users`) — criar/editar/excluir login de verdade
-- -----------------------------------------------------------------------------
-- O frontend chama `supabase.functions.invoke('admin-users', {method, body})`.
-- Sem ela, o sistema apenas cria o login (signUp) e inativa perfis.
-- Deploy:  supabase functions deploy admin-users
-- -----------------------------------------------------------------------------
-- import { createClient } from 'jsr:@supabase/supabase-js@2'
--
-- Deno.serve(async (req) => {
--   const admin = createClient(
--     Deno.env.get('SUPABASE_URL')!,
--     Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
--   )
--   const { method } = req
--   const body = await req.json().catch(() => ({}))
--
--   if (method === 'DELETE') {
--     const { error } = await admin.auth.admin.deleteUser(body.id)
--     return Response.json({ error: error?.message ?? null })
--   }
--   if (method === 'PATCH') {
--     const { error } = await admin.auth.admin.updateUserById(body.id, { password: body.password })
--     return Response.json({ error: error?.message ?? null })
--   }
--   return Response.json({ error: 'method not allowed' }, { status: 405 })
-- })
-- =============================================================================
