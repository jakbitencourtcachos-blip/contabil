-- Execute no Supabase SQL Editor para atualizar uma instalação existente.
-- Para instalações novas, as mesmas estruturas já estão em schema.sql.

alter table public.perfis add column if not exists tipo_acesso text not null default 'creditos';
alter table public.perfis add column if not exists creditos_saldo integer not null default 0;
alter table public.perfis add column if not exists acesso_expira_em timestamptz;

do $$ begin
    alter table public.perfis add constraint perfis_tipo_acesso_check
        check (tipo_acesso in ('creditos','tempo'));
exception when duplicate_object then null; end $$;

do $$ begin
    alter table public.perfis add constraint perfis_creditos_saldo_check
        check (creditos_saldo >= 0);
exception when duplicate_object then null; end $$;

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
