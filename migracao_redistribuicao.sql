-- Migração: redistribuição de leads sem contato do vendedor
-- Rodar no SQL Editor do Supabase (https://gnyvfslxoiobgmohejqf.supabase.co)

alter table status_de_leads
  add column if not exists vendedor_original text,
  add column if not exists redistribuido_em timestamptz;
