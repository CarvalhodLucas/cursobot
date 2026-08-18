-- Migração: persistir o mapeamento LID → telefone real e a fila de mensagens
-- de vendedor que chegam com um LID ainda não resolvido (não salva mais o LID
-- cru como telefone, evitando leads "fantasma" no CRM).
-- Rodar no SQL Editor do Supabase (https://gnyvfslxoiobgmohejqf.supabase.co)

create table if not exists lid_telefone_map (
  lid text primary key,
  telefone text not null,
  created_at timestamptz default now()
);

create table if not exists mensagens_lid_pendentes (
  id bigserial primary key,
  lid text not null,
  mensagem text,
  de text,
  vendedor text,
  created_at timestamptz default now()
);

create index if not exists idx_mensagens_lid_pendentes_lid on mensagens_lid_pendentes (lid);
