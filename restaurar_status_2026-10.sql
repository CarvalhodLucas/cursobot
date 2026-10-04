-- Restaura status sobrescritos pra 'perdido' pela classificação automática (bug do .in() gigante).
-- A tabela historico_leads não existe no banco, então a restauração usa as evidências que sobraram:
-- anotação do vendedor dizendo matriculado/aluno, e data_retorno preenchida (só existe quando o vendedor escolheu "pausado").
-- Rodar no SQL Editor do Supabase. Só mexe em quem está como 'perdido' hoje.

begin;

-- Anotação diz MATRICULADO/MATRICULOU
update status_de_leads set status = 'matriculado', perdido_em = null
where status = 'perdido' and telefone in (
  '5521992602318','5521973508924','5521998382385','5521974062552','5521964191855','5521985941606',
  '5521965890441','5521994241160','5521990737510','5521982954282','5521969957774','5521970809878'
);

-- Anotação diz que já é aluno / responsável de aluno / rematrícula
update status_de_leads set status = 'aluno', perdido_em = null
where status = 'perdido' and telefone in (
  '5521973171551','5521991907520','5521970844646','5521999816171','5521991618117','5521988754823',
  '5521997508226','5521988874222','5521964297348','5511942146430','5521965883919','5521974575559',
  '5521999667496','5521982027816','5521981448042','5521999473656'
);

-- data_retorno preenchida = vendedor tinha colocado em pausa
update status_de_leads set status = 'pausado', perdido_em = null
where status = 'perdido' and data_retorno is not null;

-- Decisão: a pesquisa de lead perdido só vale pra quem virar 'perdido' a partir de 04/10/2026.
-- Tira TODO MUNDO que já está perdido da fila (e marca como enviado, pra nunca entrar de novo).
update status_de_leads set feedback_perda_enviado = true, perdido_em = null
where status = 'perdido' and feedback_perda_enviado = false;

commit;

-- Conferência
select status, count(*) from status_de_leads group by status order by 2 desc;
