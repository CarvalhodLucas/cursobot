-- ============================================================
-- ESCALA COM SOBREPOSIÇÃO — Rodízio automático nas janelas compartilhadas
-- Rebecca : 8h00  – 17h00  (8.0  → 17.0)
-- Taynara : 10h30 – 19h30  (10.5 → 19.5)
-- Paulo   : 12h00 – 21h00  (12.0 → 21.0)
--
-- O bot detecta automaticamente quantos vendedores estão ativos
-- e faz rodízio entre eles nas janelas de sobreposição:
--   08h00 – 10h30 → só Rebecca
--   10h30 – 12h00 → Rebecca + Taynara (rodízio)
--   12h00 – 17h00 → Rebecca + Taynara + Paulo (rodízio entre os 3)
--   17h00 – 19h30 → Taynara + Paulo (rodízio)
--   19h30 – 21h00 → só Paulo
-- ============================================================

-- 1. Limpar escala atual (seg a sáb)
DELETE FROM escala_vendedores WHERE dia_semana BETWEEN 1 AND 6;

-- 2. Inserir nova escala — um registro por vendedor por dia
INSERT INTO escala_vendedores (dia_semana, hora_inicio, hora_fim, vendedor, tipo)
VALUES
  -- Segunda-feira
  (1,  8.0, 17.0, 'Rebecca', 'exclusivo'),
  (1, 10.5, 19.5, 'Taynara', 'exclusivo'),
  (1, 12.0, 21.0, 'Paulo',   'exclusivo'),
  -- Terça-feira
  (2,  8.0, 17.0, 'Rebecca', 'exclusivo'),
  (2, 10.5, 19.5, 'Taynara', 'exclusivo'),
  (2, 12.0, 21.0, 'Paulo',   'exclusivo'),
  -- Quarta-feira
  (3,  8.0, 17.0, 'Rebecca', 'exclusivo'),
  (3, 10.5, 19.5, 'Taynara', 'exclusivo'),
  (3, 12.0, 21.0, 'Paulo',   'exclusivo'),
  -- Quinta-feira
  (4,  8.0, 17.0, 'Rebecca', 'exclusivo'),
  (4, 10.5, 19.5, 'Taynara', 'exclusivo'),
  (4, 12.0, 21.0, 'Paulo',   'exclusivo'),
  -- Sexta-feira
  (5,  8.0, 17.0, 'Rebecca', 'exclusivo'),
  (5, 10.5, 19.5, 'Taynara', 'exclusivo'),
  (5, 12.0, 21.0, 'Paulo',   'exclusivo'),
  -- Sábado
  (6,  8.0, 17.0, 'Rebecca', 'exclusivo'),
  (6, 10.5, 19.5, 'Taynara', 'exclusivo'),
  (6, 12.0, 21.0, 'Paulo',   'exclusivo');
