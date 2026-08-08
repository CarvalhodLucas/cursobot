-- Migração: pesquisa de feedback pra lead marcado como "perdido"
-- Rodar no SQL Editor do Supabase (https://gnyvfslxoiobgmohejqf.supabase.co)

alter table status_de_leads
  add column if not exists perdido_em timestamptz,
  add column if not exists feedback_perda_enviado boolean default false;
