-- Migração: persistir a espera pela resposta da pesquisa de lead perdido
-- (sobrevive a redeploy/restart do Railway)
-- Rodar no SQL Editor do Supabase (https://gnyvfslxoiobgmohejqf.supabase.co)

alter table estado_bot
  add column if not exists aguardando_feedback_perdido boolean default false;
