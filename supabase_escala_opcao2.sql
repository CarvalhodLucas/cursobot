-- ============================================================
-- ESCALA OPÇÃO 2 — Terços iguais por dia
-- Rebecca : 8h00 – 12h20  (8.0  → 12.33)
-- Taynara : 12h20 – 16h40 (12.33 → 16.67)
-- Paulo   : 16h40 – 21h00 (16.67 → 21.0)
-- ============================================================

-- 1. Limpar escala atual (seg a sáb)
DELETE FROM escala_vendedores WHERE dia_semana BETWEEN 1 AND 6;

-- 2. Inserir nova escala em terços iguais
INSERT INTO escala_vendedores (dia_semana, hora_inicio, hora_fim, vendedor, tipo)
VALUES
  -- Segunda-feira
  (1,  8,     12.33, 'Rebecca', 'exclusivo'),
  (1,  12.33, 16.67, 'Taynara', 'exclusivo'),
  (1,  16.67, 21,    'Paulo',   'exclusivo'),
  -- Terça-feira
  (2,  8,     12.33, 'Rebecca', 'exclusivo'),
  (2,  12.33, 16.67, 'Taynara', 'exclusivo'),
  (2,  16.67, 21,    'Paulo',   'exclusivo'),
  -- Quarta-feira
  (3,  8,     12.33, 'Rebecca', 'exclusivo'),
  (3,  12.33, 16.67, 'Taynara', 'exclusivo'),
  (3,  16.67, 21,    'Paulo',   'exclusivo'),
  -- Quinta-feira
  (4,  8,     12.33, 'Rebecca', 'exclusivo'),
  (4,  12.33, 16.67, 'Taynara', 'exclusivo'),
  (4,  16.67, 21,    'Paulo',   'exclusivo'),
  -- Sexta-feira
  (5,  8,     12.33, 'Rebecca', 'exclusivo'),
  (5,  12.33, 16.67, 'Taynara', 'exclusivo'),
  (5,  16.67, 21,    'Paulo',   'exclusivo'),
  -- Sábado
  (6,  8,     12.33, 'Rebecca', 'exclusivo'),
  (6,  12.33, 16.67, 'Taynara', 'exclusivo'),
  (6,  16.67, 21,    'Paulo',   'exclusivo');
