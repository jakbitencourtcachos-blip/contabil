-- Permite verificar existência do e-mail antes de solicitar recuperação.
-- Execute no Supabase SQL Editor ou via psql no banco do projeto.
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
