-- Backup da base_conhecimento ANTES da revisão de 14/10/2026.
-- Para desfazer a revisão, rode este arquivo inteiro no SQL Editor do Supabase.
begin;
update base_conhecimento set categoria = 'professores', ativo = true, resposta = 'Nossa escola conta com professores qualificados e certificados. Informacoes sobre o corpo docente o comercial pode te passar com detalhes!' where id = 1;
update base_conhecimento set categoria = 'metodologia', ativo = true, resposta = 'Nossas aulas sao comunicativas e focadas em conversacao. Cada turma tem material didatico proprio por periodo.' where id = 2;
update base_conhecimento set categoria = 'material', ativo = true, resposta = 'Cada periodo tem seu proprio material didatico. Informacoes sobre valores o comercial passa pra voce!' where id = 3;
update base_conhecimento set categoria = 'espanhol', ativo = true, resposta = 'Sim, oferecemos curso de espanhol! Para informacoes sobre horarios e turmas, o comercial te atende.' where id = 4;
update base_conhecimento set categoria = 'online', ativo = true, resposta = 'Temos modalidade online com grade flexivel. O comercial passa os horarios disponiveis.' where id = 5;
update base_conhecimento set categoria = 'programacao robotica', ativo = true, resposta = 'Sim, temos curso de Programacao e Robotica! Para detalhes de turma e horario, o comercial te passa. Posso registrar seu interesse?' where id = 6;
update base_conhecimento set categoria = 'endereco', ativo = true, resposta = 'Estamos no Recreio dos Bandeirantes, Rio de Janeiro - Estrada Benvindo de Novaes, 1880.' where id = 7;
update base_conhecimento set categoria = 'vagas', ativo = true, resposta = 'A disponibilidade de vagas o comercial confirma. Qual turma ou horario voce tem interesse?' where id = 8;
update base_conhecimento set categoria = 'nivelamento', ativo = true, resposta = 'O nivelamento e uma avaliacao rapida obrigatoria antes de entrar na turma MASTER.' where id = 9;
update base_conhecimento set categoria = 'outro', ativo = true, resposta = 'Ingles e Espanhol' where id = 10;
update base_conhecimento set categoria = 'horario_seg_qua', ativo = true, resposta = 'Horarios de Segunda e Quarta: 14h-15h15, 15h15-16h30, 16h30-17h45, 18h-19h15, 19h15-20h30. O comercial confirma a vaga no horario que preferir!' where id = 12;
update base_conhecimento set categoria = 'horario_ter_qui', ativo = true, resposta = 'Horarios de Terca e Quinta: 10h-11h15, 14h-15h15, 15h15-16h30, 16h30-17h45, 18h-19h15, 19h15-20h30. O comercial confirma a vaga no horario que preferir!' where id = 13;
update base_conhecimento set categoria = 'horario_sabado', ativo = true, resposta = 'Horarios de Sabado: 8h-10h45, 10h45-13h30, 14h-15h15, 15h15-16h30, 16h30-17h45. O comercial confirma a vaga no horario que preferir!' where id = 14;
update base_conhecimento set categoria = 'turmas_detalhe', ativo = true, resposta = 'FUN (7-8 anos), KIDS (9-10 anos), TEEN UP (11-12 anos), FLY (13 anos ou mais, adolescentes e adultos), QUEST (intermediario), PRE ADV (pre-avancado), ADV (avancado), MASTER (avancado - exige nivelamento obrigatorio antes da matricula).' where id = 15;
update base_conhecimento set categoria = 'inscricao', ativo = true, resposta = 'Para se matricular, o comercial te orienta em todo o processo! Basta informar seu nome, faixa etaria e horario preferido que a gente entra em contato com os detalhes e valores.' where id = 16;
update base_conhecimento set categoria = 'duracao_aula', ativo = true, resposta = 'Cada aula tem duracao de 1h15 (75 minutos). As aulas acontecem duas vezes por semana no mesmo horario.' where id = 17;
update base_conhecimento set categoria = 'contato', ativo = true, resposta = 'Voce ja esta falando conosco pelo WhatsApp! O comercial pode te passar outros canais de contato se precisar.' where id = 18;
update base_conhecimento set categoria = 'faixa_etaria_adulto', ativo = true, resposta = 'Sim, temos turmas para adultos de todos os niveis! A turma FLY e para 13 anos ou mais, e temos tambem QUEST, PRE ADV, ADV e MASTER para quem ja tem algum conhecimento.' where id = 19;
update base_conhecimento set categoria = 'certificado', ativo = true, resposta = 'Informacoes sobre certificado ao final do curso o comercial passa com todos os detalhes!' where id = 20;
update base_conhecimento set categoria = 'aula_particular', ativo = true, resposta = 'Informacoes sobre aulas particulares o comercial pode te passar! Temos diferentes modalidades disponiveis.' where id = 21;
update base_conhecimento set categoria = 'reposicao', ativo = true, resposta = 'A politica de reposicao de aulas o comercial explica com detalhes. Cada caso e avaliado pela coordenacao.' where id = 22;
update base_conhecimento set categoria = 'frequencia_aula', ativo = true, resposta = 'As aulas acontecem 2 vezes por semana: Segunda e Quarta, ou Terca e Quinta. O Sabado tambem e uma opcao com grade propria.' where id = 23;
update base_conhecimento set categoria = '', ativo = true, resposta = 'Turmas por idade: GARDEN (4-6 anos)FUN (7-8 anos), KIDS (9-10 anos), TEEN UP (11-12 anos), FLY (13 anos ou mais, adolescentes e adultos). Turmas por nivel: QUEST (intermediario), PRE ADV (pre-avancado), ADV (avancado), MASTER (avancado, exige nivelamento obrigatorio antes da matricula).' where id = 24;
update base_conhecimento set categoria = 'cursos', ativo = true, resposta = 'Oferecemos: Ingles (curso principal, com turmas por faixa etaria e nivel), Espanhol (detalhes o comercial passa) e Programacao e Robotica (detalhes de turma e horario o comercial passa)!' where id = 25;
commit;
