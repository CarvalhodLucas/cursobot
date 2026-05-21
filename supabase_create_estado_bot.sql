-- ============================================================
-- Tabela: estado_bot
-- Persiste o estado em RAM do bot entre redeploys.
-- Evita: reengajamento duplicado, perda de flags confirmado/notificado,
--        e reset do timer de inatividade após restart do Railway.
-- ============================================================
-- Execute no Supabase: Dashboard → SQL Editor → New Query
-- ============================================================

CREATE TABLE IF NOT EXISTS estado_bot (
  telefone            TEXT PRIMARY KEY,
  ultima_atividade    TIMESTAMPTZ,
  reengajamento_env   BOOLEAN   NOT NULL DEFAULT FALSE,
  confirmado          BOOLEAN   NOT NULL DEFAULT FALSE,
  notificado          BOOLEAN   NOT NULL DEFAULT FALSE,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Índice para a checagem de inatividade (varre todos os registros ativos)
CREATE INDEX IF NOT EXISTS idx_estado_bot_ultima_atividade
  ON estado_bot (ultima_atividade);

-- Permissão para a service role do bot
GRANT ALL ON estado_bot TO service_role;

-- Verificar:
-- SELECT * FROM estado_bot LIMIT 10;
