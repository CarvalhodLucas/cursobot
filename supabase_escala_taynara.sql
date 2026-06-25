-- ============================================================
-- ATUALIZAÇÃO DA ESCALA DE VENDEDORES — CNA Recreio
-- Manhã  (8h–12h)        → Rebecca
-- Tarde  (12h–16h50)     → Taynara  ← nova
-- Noite  (16h50–21h)     → Paulo    ← troca do tarde para noite
-- ============================================================

-- PASSO 1: Mover Paulo do slot "tarde" para o slot "noite"
UPDATE escala_vendedores
SET hora_inicio = 16.83, hora_fim = 21
WHERE vendedor = 'Paulo'
  AND hora_inicio = 12
  AND hora_fim = 16.83;

-- PASSO 2: Adicionar Taynara no slot "tarde" (seg a sex)
INSERT INTO escala_vendedores (dia_semana, hora_inicio, hora_fim, vendedor)
VALUES
  (1, 12, 16.83, 'Taynara'),   -- Segunda
  (2, 12, 16.83, 'Taynara'),   -- Terça
  (3, 12, 16.83, 'Taynara'),   -- Quarta
  (4, 12, 16.83, 'Taynara'),   -- Quinta
  (5, 12, 16.83, 'Taynara'),   -- Sexta
  (6, 12, 16.83, 'Taynara')    -- Sábado
ON CONFLICT DO NOTHING;

-- ============================================================
-- Se Paulo estiver no slot de tarde com horários diferentes,
-- rode primeiro: SELECT * FROM escala_vendedores WHERE vendedor = 'Paulo';
-- e ajuste os valores acima conforme o resultado.
-- ============================================================
