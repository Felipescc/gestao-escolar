# Questionário de Levantamento de Requisitos
## Sistema de Reserva e Gestão de Laboratórios Escolares

Este questionário serve para reunir todas as informações necessárias antes de iniciar o desenvolvimento do sistema web (responsivo, para desktop e mobile) de reserva de laboratórios.

---

## 1. Identificação da Escola

- Nome da escola:
- Quantidade total de salas de aula:
- Quantidade total de professores:
- Quantidade total de alunos:
  - Turno manhã:
  - Turno tarde:
  - Turno noite:

---

## 2. Turnos de Funcionamento

- A escola funciona em quais turnos? (manhã / tarde / noite)
- Horário de início e fim de cada turno
- Quantos horários/aulas (períodos) tem cada turno?
- Duração de cada aula (ex: 50 minutos)

---

## 3. Professores

- Cada professor tem uma sala de aula fixa, ou circula entre salas?
- Quantas disciplinas, em média, cada professor leciona?
- Existem dias da semana em que um professor não trabalha (folga fixa)? Quais e quantos professores têm essa condição?
- Como o professor será identificado/cadastrado no sistema (matrícula, e-mail institucional, CPF)?
- Os professores já usam algum sistema digital da escola hoje (portal, app, planilha)?

---

## 4. Laboratórios (preencher para cada laboratório existente)

- Nome/identificação do laboratório:
- Tipo (informática, ciências, robótica, línguas, etc.):
- Quantidade de computadores/equipamentos:
- Capacidade máxima de alunos:
- Existem softwares específicos instalados? Quais?
- Há um responsável ou monitor pelo laboratório?
- O laboratório tem restrições de uso (manutenção programada, dias bloqueados)?

---

## 5. Regras de Reserva e Prioridade (o coração do sistema)

- Com quantos dias de antecedência um professor pode reservar?
- Quantas horas/aulas seguidas um professor pode reservar de uma vez?
- Qual o valor de **X** (dias de carência) que o último professor que usou o laboratório fica sem poder reservar de novo?
- Essa carência vale por laboratório específico, ou o professor fica de fora de **todos** os laboratórios?
- A carência é contada em dias corridos ou apenas em dias letivos?
- É permitido reservar de forma recorrente (ex: toda terça, mesmo horário, semestre inteiro)?
- Se o horário desejado já estiver ocupado, deve existir uma **lista de espera**?
- Se dois professores tentam reservar o mesmo horário ao mesmo tempo, como decidir (ordem de chegada no sistema, prioridade por disciplina, decisão da coordenação)?
- Se o professor reserva e **falta** no dia, a reserva conta como "uso" (gerando a carência) mesmo assim?
- É permitido cancelar uma reserva já feita? Com quanto tempo mínimo de antecedência?

---

## 6. Uso Pretendido do Laboratório (por reserva)

- Disciplina/matéria que será ministrada
- Tipo de aula (prática, teórica, avaliação, apresentação)
- Quantidade de horas/aulas necessárias
- Quantidade de alunos que participarão

---

## 7. Perfis de Acesso

- Quem pode reservar: só professores, ou também coordenação/direção?
- Quem administra o sistema (cadastra laboratórios, define regras, resolve conflitos)?
- A reserva precisa de aprovação da coordenação antes de ser confirmada, ou é automática (respeitando as regras)?

---

## 8. Notificações

- Como o professor deve ser avisado (e-mail, WhatsApp, notificação no próprio site)?
  - Reserva confirmada
  - Reserva cancelada
  - Lembrete próximo à data
  - Liberação de vaga (quando a carência de outro professor termina)

---

## 9. Relatórios e Gestão

- A gestão precisa de relatórios de uso (quais professores mais usam, taxa de ocupação por turno/laboratório)?
- É necessário manter histórico de reservas para consulta futura?

---

## 10. Aspectos Técnicos

- Os professores vão acessar principalmente por celular, computador, ou os dois?
- Há internet estável disponível nas salas dos professores e nos laboratórios?
- Existe algum controle atual (planilha, caderno, agenda física) que este sistema vai substituir?

---

## 11. Calendário Letivo

- O sistema precisa bloquear datas de feriados e recessos escolares automaticamente?
- Existe um calendário letivo anual que deveria ser cadastrado no sistema?

---

### Observações adicionais
*(espaço para qualquer informação que não se encaixe nas perguntas acima)*
