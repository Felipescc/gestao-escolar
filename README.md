# Sistema de Reserva e Gestão de Laboratórios Escolares

Sistema web responsivo (computador e celular) para professores reservarem aulas
em laboratórios, com painéis de gestão para cadastrar laboratórios, professores,
horários e as regras de reserva.

O acesso tem três níveis:

| Nível | Entra por | O que faz |
|-------|-----------|-----------|
| **Gerente Geral** | `/gerente` | Vê os indicadores da escola e cria/edita/desativa as contas dos gestores locais |
| **Gestor Local** | `/gestor` | Cadastra laboratórios, professores, horários, bloqueios e regras (era o antigo *administrador*) |
| **Professor** | `/` | Reserva os laboratórios respeitando as regras |

Cada nível cria as contas do nível de baixo: o gerente geral cria os gestores
locais, e o gestor local cria os professores — sempre com o mesmo fluxo de
senha sorteada e envio por e-mail/WhatsApp.

Construído a partir do `questionario-reserva-laboratorios.md`.

- **Backend:** Python + Flask + SQLite (só o `sqlite3` da biblioteca padrão)
- **Frontend:** HTML + CSS + JavaScript puro (sem framework, sem build)
- **Interface:** padrão HRMS / Employee Management System — menu lateral escuro,
  topbar com a escola, a data e o avatar (o nome da tela fica só no título do
  conteúdo, sem repetir na barra), cartões brancos e indicadores. No celular o menu
  lateral vira barra inferior e as tabelas viram cartões.

---

## Como rodar

### Windows (mais simples)

Dê um duplo clique em **`iniciar.bat`**. Ele instala o Flask (se necessário) e
sobe o servidor.

### Qualquer sistema

```bash
pip install -r requirements.txt
python app.py
```

Depois abra no navegador:

| Onde | Endereço |
|------|----------|
| Professores (mesmo PC) | http://localhost:5000 |
| Professores (celular)  | `http://SEU_IP:5000` — o IP aparece no terminal ao iniciar |
| Gestor local           | http://localhost:5000/gestor |
| Gerente geral          | http://localhost:5000/gerente |

Na tela de login do professor, os dois últimos aparecem em **Outros acessos**,
no rodapé. O endereço antigo `/admin` continua funcionando: ele redireciona
para `/gestor`.

> Para acessar pelo celular, o celular precisa estar na **mesma rede Wi-Fi** do
> computador que está rodando o sistema. Se não abrir, libere a porta 5000 no
> Firewall do Windows para o Python.

### Acessos iniciais

| Perfil | Como entrar |
|--------|-------------|
| Professor | matrícula `1001` a `1004` com a senha **`prof123`** (dados de exemplo) |
| Gestor local | usuário **`gestor`** com a senha **`gestor123`** — troque em *Conta* |
| Gerente geral | senha **`gerente123`** — troque em *Minha conta* |

> **Quem já usava a versão anterior:** o antigo administrador virou o gestor
> local `gestor`, e a senha de admin que você já usava continua valendo (a
> senha `gestor123` só vale para bancos criados do zero).

---

## O que o sistema faz

### Área do professor (`/`)

- **Agenda semanal** de cada laboratório: no computador vira uma grade
  dias × horários; no celular vira uma lista de um dia por vez, com seletor
  de dias no topo.
- **Nova reserva** com laboratório, data, aulas seguidas, disciplina, tipo de
  aula (prática, teórica, avaliação…), quantidade de alunos e observação.
- **Minhas aulas**: próximas reservas e histórico, com cancelamento.
- **Calendário Escolar**: o PDF do ano letivo que a gestão publicou, para ler
  dentro do sistema ou abrir/baixar — veja *Calendário escolar em PDF* mais
  abaixo. Enquanto a escola não publica, aparece um aviso no lugar.
- **Regras**: mostra ao professor, em cartões, todas as regras vigentes.
- **Relatório**: o uso do próprio professor no período escolhido — aulas,
  faltas, tempo em laboratório, uso por laboratório, por turno, por tipo de
  aula e mês a mês. Traz também o **uso por professor de toda a escola**, com a
  média por professor e a posição de cada um: é a mesma informação que já
  aparece com o nome de todos na agenda da semana, só que somada, para o
  rodízio dos laboratórios ficar à vista de todos. Faltas e cancelamentos de
  cada professor continuam aparecendo só para o gestor.
- **Computadores**: a distribuição da turma pelas máquinas do laboratório.
  O professor escolhe a aula, confirma a turma (que a grade já sugere) e senta
  os alunos: toca no nome e depois no computador — ou no computador e depois no
  nome. **Cada máquina comporta no máximo 2 alunos**, e o botão *Formar duplas*
  distribui a turma inteira na ordem da chamada, respeitando quem já foi
  colocado à mão. Ao salvar, a aula entra no histórico que a gestão acompanha;
  salvar de novo corrige o mesmo registro em vez de criar outro. O atalho
  *Computadores* também aparece em cada aula de **Minhas aulas**.
- **Projetos**: a reserva do laboratório no **intervalo de 1 hora que vem
  depois da 5ª aula** — veja *Projetos no intervalo* mais abaixo. A reserva
  dura **50 minutos fixos**, nasce com o nome *Elaboração de Projetos* (que o
  professor troca pelo nome do evento) e é ali também que ele registra quem
  usou cada computador, **chamando o aluno pela matrícula**.
- **Conta**: o professor vê nome, matrícula e disciplina (mantidos pela
  coordenação) e altera por conta própria o e-mail, o WhatsApp e a senha —
  esta pedindo a senha atual e com no mínimo 6 caracteres.
- Aviso automático quando o professor está em **período de carência**, já
  informando a data em que ele volta a poder reservar.

### Painel do gestor local (`/gestor`)

- **Laboratórios**: cadastrar, editar, desativar ou excluir. Excluir um
  laboratório com reservas futuras pede confirmação dupla.
- **Professores**: cadastrar, editar, desativar ou excluir — veja o fluxo de
  acesso logo abaixo. **Clicar no nome do professor abre a ficha dele**
  (no computador e no celular): dados em modo consulta, com o WhatsApp e o
  e-mail como atalhos e o botão *Editar cadastro* para abrir o formulário.
- **Alunos**: a lista de cada turma, que é de onde o professor puxa os nomes na
  hora de distribuir os computadores. Dá para cadastrar um a um ou usar
  **Importar turma**, que aceita a lista colada com um aluno por linha, com ou
  sem o número de chamada na frente (`12 - Ana Souza`, `12. Ana Souza`,
  `12 Ana Souza` ou só o nome). Colar a mesma lista de novo não duplica
  ninguém: quem já está na turma é apenas contado como repetido. Aluno **não
  entra no sistema** — não tem login nem senha.
  Cada aluno pode ter uma **matrícula**, que não se repete dentro da escola: é
  por ela que o professor chama o aluno no laboratório de projetos, onde o
  grupo mistura turmas e a lista da turma não ajuda. Na importação ela vem
  depois do nome, separada por `;` ou por tabulação
  (`12 - Ana Souza;20260012`) — que é como a lista sai colada de uma planilha.
  Quem entrar sem matrícula é contado no resultado da importação, para você
  saber quantas faltam preencher.
- **Reservas**: listar com filtros e mudar a situação
  (ativa / realizada / falta / cancelada).
- **Projetos no Intervalo**: a agenda do intervalo de toda a escola. O gestor
  reserva **em nome de um professor**, troca o nome do projeto, muda a
  situação e abre a ficha de cada reserva — que já traz o mapa dos
  computadores registrado pelo responsável. Veja *Projetos no intervalo*
  abaixo.
- **Uso de Computadores**: o histórico do laboratório. Cada linha é uma aula —
  ou um projeto do intervalo — que um professor registrou: data e hora,
  professor, turma (ou o nome do projeto), laboratório, quantas máquinas foram
  ocupadas e quantos alunos sentaram. Filtros por **data (de/até), professor,
  turma, laboratório e origem** (aulas da grade, projetos do intervalo, ou as
  duas coisas), e ao clicar em uma linha sai o mapa computador a computador,
  com o nome e a matrícula de cada dupla.
- **Horários**: montar a grade de aulas de cada turno (manhã, tarde, noite).
- **Datas bloqueadas**: feriados, recessos e manutenções — para a escola toda
  ou para um laboratório específico.
- **Calendário Escolar**: envia, substitui ou remove o PDF do calendário do ano
  letivo, que os professores da escola passam a ver no menu deles. Não se
  confunde com *Datas bloqueadas*: o PDF é só para consulta e não trava
  nenhuma reserva.
- **Regras**: todos os parâmetros de reserva, os **parâmetros do intervalo de
  projetos**, a **exceção de aulas seguidas por professor** (veja abaixo) e a
  configuração de e-mail.
- **Relatórios**: taxa de ocupação, uso por laboratório (com divisão por turno)
  e uso por professor, com contagem de faltas.
- **Conta**: nome, cidade e endereço da escola, mais o nome e o usuário do
  gestor — tudo em modo consulta, porque quem mantém esses dados é o gerente
  geral. O gestor altera por conta própria o **e-mail, o WhatsApp e a senha**,
  esta pedindo a senha atual e com no mínimo 6 caracteres.

O gestor local entra com **usuário (ou e-mail) + senha**, criados pelo gerente
geral. Cada gestor tem a sua conta: dá para ter mais de um por escola, e a
lista mostra quando cada um acessou pela última vez.

### Painel do gerente geral (`/gerente`)

- **Visão geral**: em um período escolhido (por padrão, 30 dias para trás e 30
  para a frente) mostra equipe ativa, taxa de ocupação, reservas por situação e
  por turno, uso por laboratório, professores que mais usam e as próximas aulas.
- **Gestores locais**: criar, editar, desativar, excluir e reenviar acesso —
  o mesmo fluxo que o gestor usa com os professores. O sistema não deixa a
  escola ficar sem nenhum gestor ativo. **Clicar no nome do gestor abre a ficha
  dele**, em modo consulta, com o botão *Editar cadastro*.
- **Unidades / Escolas**: cadastro das escolas da rede. Cada cartão mostra
  quantos gestores e professores a unidade tem, e *Ver usuários* abre a lista
  com os dois grupos. Nessa lista o nome também abre a ficha — a do gestor com
  *Editar cadastro*, a do **professor apenas para consulta**, porque quem edita
  professor é o gestor local, no painel da escola. O gestor local é vinculado a
  uma unidade no cadastro dele, e **o professor herda a unidade do gestor que o
  cadastrou**. A escola tem **dois telefones**, os dois opcionais: o celular /
  WhatsApp — **(81)9 8458-7555**, 11 números — e o fixo — **(81) 3421-5566**,
  10 números. Preenchidos pela metade, o cadastro não é salvo.

### Mostrar a senha

Todo campo de senha traz o **ícone de olho** do lado direito: um toque mostra o
que foi digitado, outro esconde de novo. Vale para as três telas de entrada
(professor, gestor local e gerente geral) e também para a troca de senha —
*Conta* do professor, *Conta* do gestor local e *Minha conta* do gerente.
Ajuda a conferir a senha recebida antes de entrar e a comparar a nova senha com
a repetição, principalmente no celular. É coisa só do navegador: a senha
continua indo para o servidor do mesmo jeito e nada extra fica guardado.

### Sai sozinho depois de 15 minutos parado

Vale para os três acessos — professor, gestor local e gerente geral. Passados
**15 minutos sem ninguém mexer**, o sistema encerra a sessão e volta para a tela
de entrada, explicando o motivo. É o caso do computador da sala dos professores
que ficou aberto no painel enquanto a aula começava.

- **Um minuto antes** aparece uma faixa no alto da tela com a contagem
  regressiva e o botão *Continuar conectado*. Enquanto ela está na tela, mover o
  mouse não conta: é preciso clicar, digitar ou rolar a página — assim ninguém
  perde o que estava preenchendo por causa de um esbarrão na mesa, nem segura a
  sessão sem estar ali.
- **Quem está usando não é interrompido.** Ler um relatório longo ou preencher
  um cadastro grande não gera pedido ao servidor, então a tela renova a sessão
  sozinha de tempos em tempos enquanto houver uso.
- **Quem manda é o servidor.** O cookie da sessão vale esses mesmos 15 minutos e
  é renovado a cada pedido: deixar a tela aberta, fechar o navegador ou desligar
  a máquina não estica o prazo.
- Ao sair, a página é recarregada — nada da escola fica na tela para quem chegar
  no computador depois.

O tempo é o `MINUTOS_DE_INATIVIDADE`, no começo do `app.py`. Mudar esse número
muda ao mesmo tempo o limite do servidor e a contagem das telas.

### As fichas de professor e de gestor

Abertas pelo nome nas listas, valem para consulta rápida — nenhum campo é
editável nelas:

- **WhatsApp**: clicar no número abre a conversa no WhatsApp (Web ou app), com
  o DDI 55 já na frente. Sem telefone cadastrado aparece um traço.
- **E-mail**: clicar copia o endereço para a área de transferência.
- **Editar cadastro** só aparece para quem pode alterar aquele cadastro: o
  gestor local na ficha do professor, o gerente geral na ficha do gestor.

### Cada escola é separada

O gestor local só alcança a **própria unidade**: laboratórios, professores,
horários, datas bloqueadas, reservas e relatórios são sempre filtrados pela
escola dele. Tentar abrir um item de outra unidade pelo endereço direto é
recusado pelo servidor, não só escondido na tela.

Por isso duas escolas podem ter, cada uma, o seu “Laboratório de Informática 1”
e a sua própria grade de horários. Um professor só reserva laboratórios da
escola dele, e o recesso cadastrado numa unidade não bloqueia as outras.

O **gerente geral** é a exceção: ele vê a rede inteira e, no painel do gestor,
escolhe no topo qual escola quer olhar (ou *Todas as unidades*).

> Continuam valendo para a rede toda: as **regras de reserva** (carência,
> antecedência, aulas seguidas…) e a configuração de e-mail, na aba *Regras*.
> São parâmetros da secretaria, não de cada escola. O nome de cada escola fica
> no cadastro da unidade, com o gerente geral — o gestor local só consulta,
> na aba *Conta*.
- **Minha conta**: troca da senha do gerente (pede a senha atual).
- O gerente continua tendo acesso ao painel do gestor local — a sessão dele já
  vale lá, sem pedir outra senha —, mas **o atalho some depois que ele entra**:
  o caminho é abrir `/gestor` (ou usar *Outros acessos*, na tela de entrada).

---

## Como o professor recebe o acesso

O professor **não se cadastra sozinho**. Quem cria o acesso é o gestor local:

1. **Professores → + Novo professor**: preencha nome, e-mail, WhatsApp (com DDD)
   e disciplina. Não existe campo de matrícula.
   O campo **WhatsApp aceita apenas números e exige os 11** (DDD + celular):
   letras e pontuação não entram, o 12º número não é aceito e, com menos de 11,
   o cadastro e a edição não são salvos. A máscara aparece sozinha enquanto se
   digita — **(81)9 8458-7555** —, mas no banco fica só o número puro. Vale o
   mesmo para o WhatsApp do gestor local (tela do gerente) e para o do próprio
   professor em **Conta**.
   **O e-mail e o WhatsApp não podem se repetir** entre professores: cadastrar
   ou editar com um contato que já é de outro professor é recusado. A mesma
   regra vale entre os gestores locais, na tela do gerente geral. Professor e
   gestor local são listas separadas — quem acumula os dois papéis pode usar o
   mesmo contato nos dois cadastros.
2. **A matrícula é gerada pelo sistema**: um número sequencial de 4 a 7 dígitos
   (o primeiro cadastro recebe `1001`, depois `1002`, e assim por diante).
   A matrícula é definitiva — na edição ela aparece bloqueada.
3. **A senha é criada pelo gestor local**: o campo já vem com uma senha
   sorteada, e o botão *Gerar* sorteia outra. Também dá para digitar uma.
4. Ao confirmar, abre a tela **“Enviar acesso ao professor”** com a matrícula,
   a senha e três botões:
   - **Enviar por e-mail** — o servidor envia a mensagem pelo SMTP configurado.
     Sem SMTP, o sistema avisa e oferece o link *“Abrir no meu programa de
     e-mail”*, que abre o Outlook/Gmail com tudo preenchido.
   - **Enviar por WhatsApp** — abre o WhatsApp (Web ou app) já na conversa do
     professor, com a mensagem pronta. Não precisa de nenhuma configuração.
   - **Copiar mensagem** — para colar onde quiser.
5. O professor entra com **matrícula (ou e-mail) + senha**.

> A senha aparece **uma única vez**, nessa tela de envio: no banco fica apenas
> um hash (PBKDF2-SHA256 com sal). Se ela se perder, use **Senha e envio** na
> lista de professores para gerar outra e reenviar. Quem está sem senha aparece
> com a etiqueta **“Sem senha”** e não consegue entrar.

### Configurar o envio por e-mail (opcional)

Em **Regras → Envio de acesso aos professores**:

| Campo | Exemplo |
|-------|---------|
| Endereço do sistema | `http://192.168.0.10:5000` (em branco = IP detectado) |
| Servidor SMTP | `smtp.gmail.com` |
| Porta | `587` (TLS) ou `465` (SSL) |
| Usuário / E-mail remetente | a conta que envia |
| Senha do e-mail | senha de aplicativo da conta |

A senha do SMTP fica gravada no banco e nunca é devolvida para a tela. Se
preferir não guardá-la no arquivo, defina a variável de ambiente `SMTP_SENHA`
antes de iniciar o sistema — ela tem prioridade sobre o valor salvo.

O WhatsApp funciona sem nada disso: ele só monta o link `wa.me` com o telefone
do professor (o DDI 55 é acrescentado automaticamente aos 11 números do
cadastro).

---

## As regras de reserva

Todas ficam na aba **Regras** do gestor local e valem imediatamente, sem
precisar mexer no código.

| Regra | Padrão | O que faz |
|-------|--------|-----------|
| Antecedência máxima | 30 dias | Até quando dá para agendar a partir de hoje |
| Aulas seguidas | 2 por dia | Máximo de aulas consecutivas no mesmo laboratório, por dia |
| Carência (o “X”) | 7 dias | Intervalo que o professor espera para reservar de novo depois de usar (não vale para quem tem exceção) |
| Alcance da carência | só o mesmo laboratório | Ou todos os laboratórios de uma vez |
| Contagem da carência | dias corridos | Ou apenas dias letivos (pulando fins de semana e bloqueios) |
| Falta gera carência | sim | Se reservou e não usou, conta como uso mesmo assim |
| Cancelamento | 24 horas antes | Antecedência mínima para cancelar |
| Fim de semana | bloqueado | Libera sábados e domingos se a escola funcionar |

### Projetos no intervalo

Fora das aulas, a escola tem um **intervalo de uma hora depois da 5ª aula** —
na grade da ETE, das 12:10 às 13:10, entre o fim da manhã e o começo da tarde.
Esse intervalo pode ser reservado para os alunos trabalharem em projetos.

A reserva dura **50 minutos** (12:10–13:00 na grade da ETE): os 10 que sobram
são para a turma entrar e sair sem atrasar a aula seguinte.

**A hora não se escolhe.** O sistema a calcula a partir da grade de
**Horários**: o intervalo começa quando a 5ª aula termina, e a reserva ocupa os
primeiros 50 minutos dele. Se a escola mudar o horário da 5ª aula, a janela
acompanha sozinha. Os três números dessa conta — *depois de qual aula*, *quanto
dura o intervalo* e *quanto dura a reserva* — ficam em **Regras**, junto com o
nome que a reserva já vem preenchida. O próprio formulário de Regras mostra a
hora que os números acabaram de produzir.

**Quem reserva:** o professor, para si, na aba *Projetos*; ou o gestor, em nome
de qualquer professor da escola, em *Projetos no Intervalo*. Toda reserva tem
um **professor responsável** e um **laboratório**.

**O nome do projeto** nasce como *Elaboração de Projetos* e pode ser trocado
pelo nome do evento (*Feira de Ciências 2026*, *Robótica*, o que for) tanto na
hora de reservar quanto depois, em *Editar*.

**Um laboratório por intervalo:** dois projetos não ocupam o mesmo laboratório
no mesmo dia, e o mesmo professor não responde por dois ao mesmo tempo. Valem
também as regras de calendário — dia letivo, feriado, recesso e manutenção — e
a antecedência máxima de reserva. Não vale a carência: a reserva do intervalo
não tira o laboratório de ninguém, porque naquela hora não há aula.

#### Os computadores, chamados pela matrícula

Quem registra é o professor responsável, na aba *Projetos* da tela dele. Ele
digita a **matrícula do aluno**, escolhe o computador (o seletor já vem no
primeiro com lugar livre) e confirma — no Enter, sem tirar a mão do teclado.
Digitando parte da matrícula ou do nome aparecem sugestões.

**Cada computador comporta 1 ou 2 alunos**, nunca mais, e o mesmo aluno não
senta em dois computadores. As duas travas valem no servidor, não só na tela.
Para tirar alguém, o professor toca no nome dentro da máquina.

Ao salvar, o projeto entra no mesmo histórico das aulas, em *Uso de
Computadores* — salvar de novo corrige o registro em vez de criar outro. O que
fica gravado é a data, os 50 minutos, o laboratório, o professor responsável, o
nome do projeto e a relação de cada computador com as matrículas dos alunos.

> A matrícula é copiada para o registro junto com o nome. Se o aluno sair da
> escola e a ficha for excluída, o histórico daquele dia continua legível.

### Exceção de aulas seguidas por professor

O limite de *aulas seguidas* vale para a escola inteira, mas alguns professores
precisam encadear mais aulas (aula dupla de laboratório, projeto que só rende
em bloco). Em vez de afrouxar a regra para todo mundo, o gestor abre a exceção
nome a nome, na própria aba **Regras**:

1. marca na lista quem recebe a exceção (busca por nome ou matrícula);
2. escolhe **quantas aulas seguidas** esses professores podem ter num mesmo dia
   (2, 3, 4 ou 5);
3. escolhe **por quantos dias seguidos da semana** a exceção pode ser usada
   (1, 2 ou 3);
4. clica em *Salvar exceção*.

Os valores escolhidos valem para todos os marcados. Desmarcar alguém e salvar
devolve esse professor ao limite geral — salvar com ninguém marcado apaga todas
as exceções e pede confirmação antes.

A exceção vale na **Nova reserva**: ao reservar um laboratório, o sistema soma
as aulas que o professor já tem naquele dia e recusa o que passar do limite
dele.

A **Grade de aulas** do professor não passa por essa conferência. A grade só
descreve as aulas que ele já tem e não tira laboratório de ninguém, então é
gravada sem bloqueio por esse critério.

> O campo **por quantos dias seguidos da semana** continua sendo gravado e
> mostrado na exceção, mas hoje não é conferido em lugar nenhum — ele só valia
> para a antiga validação da grade.

> **A exceção também dispensa a carência.** Quem está na lista não espera o
> intervalo entre um uso do laboratório e o seguinte — a exceção existe para o
> professor que precisa do laboratório em bloco e com frequência, e cobrar a
> carência dele desmontaria a folga concedida. Tirando o nome da lista, a
> carência volta a valer na hora.

Além dessas, o sistema sempre valida:

- o horário não pode estar ocupado por outro professor (com trava no banco
  contra dois cliques simultâneos);
- o professor não pode ter duas reservas no mesmo horário em laboratórios
  diferentes;
- as aulas selecionadas precisam ser seguidas e do mesmo turno;
- a quantidade de alunos não pode passar da capacidade do laboratório;
- a data não pode estar no passado nem em feriado/recesso/manutenção;
- no dia de hoje, a aula que já começou some da agenda (“Já passou”) e é
  recusada na gravação — o relógio que vale é o do servidor, não o do
  computador do professor.

---

## Calendário escolar em PDF

Cada escola tem **um** calendário: o gestor local publica o PDF e todos os
professores daquela unidade o encontram em **Calendário Escolar**, no menu —
no computador, na barra lateral; no celular, dentro de **Mais**.

**Quem pode o quê** (conferido no servidor, não só escondido na tela):

| Perfil | Ler e baixar | Enviar, substituir e remover |
|--------|--------------|------------------------------|
| Professor | o da própria escola | não |
| Gestor local | o da própria escola | sim |
| Gerente geral | o da escola escolhida no topo do painel do gestor | sim, na escola escolhida |

Sem login, nem os dados do arquivo nem o PDF saem do servidor. O gerente geral
olhando *Todas as unidades* é convidado a escolher uma escola antes, porque não
existe um calendário da rede.

**Enviar.** A área de envio aceita o arquivo arrastado (no computador) ou
escolhido pelo botão grande *Escolher arquivo PDF* (no celular a área inteira é
tocável). Só entra **PDF de até 20 MB** — o servidor confere os bytes do
arquivo, então uma imagem renomeada para `.pdf` é recusada. Uma barra mostra o
andamento do envio. Mandar outro arquivo **substitui** o anterior para todos, e
a tela avisa isso antes de confirmar. Ao lado fica o arquivo ativo: nome, data
de envio, tamanho e quem enviou.

**Ler.** No alto da aba ficam os botões **Abrir em tela cheia** e **Baixar
PDF**. Logo abaixo, o calendário aparece desenhado página a página:

- zoom pelos botões **−** e **+** (tocar na porcentagem volta a caber na
  largura), pela **pinça de dois dedos** no celular e por **Ctrl + roda do
  mouse** no computador;
- um dedo rola a página, inclusive para o lado quando o zoom passa da tela;
- o contador mostra em que página a pessoa está.

*Abrir em tela cheia* coloca esse mesmo leitor em tela cheia no computador e no
Android. No iPhone, que não deixa, o botão abre o PDF no leitor do próprio
aparelho.

> O leitor usa o **PDF.js**, carregado da internet (jsDelivr) só quando a aba é
> aberta. Sem internet — o PC da escola numa rede fechada, por exemplo — o
> computador mostra o PDF pelo visualizador do próprio navegador, e o celular
> mostra um aviso apontando para *Abrir em tela cheia* e *Baixar PDF*, que
> continuam funcionando porque falam só com o servidor da escola. Voltando a
> internet, basta sair da aba e entrar de novo.

O PDF fica em `dados/calendarios/` e, com o R2 configurado, também na pasta
`calendarios/` do bucket, como as fotos. O banco guarda só o nome do arquivo e
os dados mostrados na tela (tabela `calendarios_escolares`, uma linha por
escola). Excluir a unidade apaga o calendário dela junto.

---

## Alocação de computadores e histórico de uso

A **reserva** é o agendamento; o **registro de uso** é o que aconteceu de fato.
São coisas separadas de propósito: uma reserva pode ser cancelada ou o professor
pode faltar, e nem toda aula reservada rende um registro.

Quatro tabelas sustentam isso:

| Tabela | Guarda |
|--------|--------|
| `alunos` | Nome, turma, número de chamada e **matrícula** (única na escola). Sem login. |
| `reservas_projeto` | A reserva do intervalo: data, turno, `inicio`/`fim` em texto (`12:10`/`13:00`), laboratório, professor responsável, nome do projeto e situação. |
| `sessoes_laboratorio` | O cabeçalho do que foi registrado: data, professor, turma, disciplina, laboratório, quantas máquinas havia e quando foi registrado. Aponta para a origem — `reserva_id` (aula da grade) **ou** `projeto_id` (intervalo), nunca os dois. |
| `alocacoes_computador` | Uma linha por cadeira ocupada: sessão, computador, posição (1 ou 2), aluno e **uma cópia do nome e da matrícula**. |

A reserva do intervalo não entra em `reservas` de propósito: aquela tabela
aponta para uma linha de `horarios`, e o intervalo não é uma aula da grade — é
justamente o vão entre duas. Por isso ele guarda a própria hora. Como as duas
origens desembocam em `sessoes_laboratorio`, o histórico do gestor mostra aula
e projeto na mesma lista, com o filtro de origem para separar.

Detalhes que valem conhecer:

- **O limite de 2 alunos por computador é conferido no servidor**, não só na
  tela — junto com “o mesmo aluno não senta em duas máquinas” e “o computador
  precisa existir no laboratório daquela aula”.
- **Quantas máquinas o laboratório tem** vem de `laboratorios.equipamentos`, que
  o gestor já cadastra. O professor ajusta o número na própria aula (máquina em
  manutenção, laboratório dividido) sem mexer no cadastro.
- **A turma vem da grade**: o sistema olha o horário do professor naquele dia e
  já sugere a turma, com a exceção da data ganhando do padrão.
- **Uma reserva rende um registro só.** Salvar de novo corrige o que existe, em
  vez de duplicar a aula no histórico do gestor.
- **Registrar o uso marca a reserva como *realizada***, se a aula já aconteceu.
  Aula futura fica como está — dá para montar as duplas antes do dia chegar.
- **O nome do aluno é copiado para o histórico** — e, no projeto, a matrícula
  junto. Se o aluno sair da escola e for excluído do cadastro, as aulas antigas
  continuam legíveis: some apenas o vínculo com a ficha dele.
- **Na aula, o aluno entra pela lista da turma; no projeto, pela matrícula.**
  São os dois jeitos de identificar a mesma pessoa, e caem nas mesmas travas —
  o grupo do projeto mistura turmas, então a lista da turma não serviria.

---

## Arquivos

```
app.py                      Servidor Flask: páginas + API dos três perfis
banco.py                    Estrutura do SQLite, dados de exemplo e configurações
regras.py                   Motor de regras (carência, conflitos, calendário)
mensagens.py                Mensagem de credenciais, envio por SMTP e link do WhatsApp
armazenamento.py            Fotos, calendários e backups no Cloudflare R2 (com disco local de reserva)
restaurar_backup.py         Lista e restaura os backups guardados no R2
verificar_r2.py             Testa a conexão com o R2 antes de publicar
enviar_banco.py             Envia o banco deste PC para o R2 (semeia o sistema online)
HOSPEDAGEM.md               Passo a passo para colocar o sistema online (Railway + R2)
Dockerfile                  Imagem usada pela hospedagem
railway.json                Configuração do deploy no Railway
schema.sql                  Migração da ficha escolar do aluno (SQLite)
import_alunos.py            Importa os alunos das planilhas .xls da secretaria
importar_horario_2026.py    Importa a grade de aulas da planilha de horários
alunos/*.xls                Listas da secretaria, uma aba por turma
templates/index.html        Tela do professor
templates/gestor.html       Tela do gestor local
templates/gerente.html      Tela do gerente geral
static/css/estilo.css       Estilo responsivo (mobile-first)
static/js/api.js            API, notificações, modal e envio de credenciais
static/js/calendario.js     Calendário escolar em PDF: leitor (professor e gestor) e envio (gestor)
static/js/app.js            Lógica da área do professor
static/js/gestor.js         Lógica do painel do gestor local
static/js/gerente.js        Lógica do painel do gerente geral
dados/escola.db             Banco de dados (criado na 1ª execução)
dados/chave_sessao.txt      Chave de sessão (criada na 1ª execução)
```

## Carregar as listas de alunos da secretaria

As listas oficiais ficam na pasta `alunos/`, uma planilha por curso e uma aba por
turma (`alunos ADM.xls`, `ALUNOS REDES.xls`, `ALUNOS SISTEMAS.xls`). Para jogar
tudo no sistema:

```bash
py import_alunos.py --simular   # confere o que seria importado, sem gravar
py import_alunos.py             # importa (pede confirmação e faz backup do banco)
```

O script traduz o código da secretaria para o nome de turma que a grade de aulas
usa — `ADM1IN-A` vira `1º A ADM`, `TRC2IN-U` vira `2º U RED`, `TDS3IN-U` vira
`3º U SIST` — que é o que faz a lista aparecer para o professor na hora de
distribuir os computadores do laboratório.

Rodar de novo é seguro: o aluno é reconhecido pela matrícula (e, sem ela, pelo
nome dentro da turma), então ninguém entra duas vezes. Quem mudou de turma é
movido; quem sumiu da planilha fica **inativo**, não é apagado, para o histórico
das aulas já registradas continuar de pé. Telefone e endereço digitados pelo
gestor nunca são apagados por uma reimportação.

Além de nome, turma e número de chamada, a ficha guarda matrícula, sexo, data de
nascimento, raça/cor, curso, procedência e a situação escolar. Clicar no nome do
aluno em **Alunos** abre a ficha completa — a mesma janela usada em Professores,
com o WhatsApp formatado e um atalho “abrir conversa”. O professor vê matrícula e
nascimento no balão de cada aluno da alocação.

A ficha também guarda **quem responde pelo aluno** — nome, grau de parentesco
(mãe, pai, avó, tio, irmã…) e WhatsApp próprio, com o mesmo atalho “abrir
conversa”. É o número que a escola procura quando o aluno é menor de idade, e por
isso ele fica ao lado do telefone do próprio aluno, não no lugar dele.

O contato (WhatsApp, e-mail, endereço e responsável) não vem da secretaria: quem
preenche é o gestor, no “Editar”. O endereço é digitado a partir do **CEP** — ao completar os
8 dígitos, o sistema consulta o [ViaCEP](https://viacep.com.br) e preenche rua,
bairro, cidade e UF sozinho, restando o número e o complemento. Quando o CEP é o
geral do município (aqueles terminados em `-000`, que voltam sem rua), o cursor
vai para o campo da rua para o gestor digitar. Nenhum campo fica travado, e a
escola sem internet continua cadastrando à mão: o autopreenchimento é um atalho,
não uma exigência.

A tabela é criada/atualizada sozinha quando o sistema sobe. Para aplicar só a
migração, sem importar nada: `py import_alunos.py --migrar-apenas` (o DDL
equivalente está em `schema.sql`).

## Perguntas do questionário que ficaram em aberto

O sistema foi entregue com padrões razoáveis para os pontos que o questionário
ainda não respondeu. Quando a escola definir, é só ajustar:

- **Valores das regras** (carência, antecedência, aulas seguidas): aba *Regras*.
- **Turnos e quantidade de aulas**: aba *Horários* (vem com 6 aulas de manhã,
  6 à tarde e 4 à noite).
- **Aprovação da coordenação**: hoje a reserva é **automática** — se respeitar
  as regras, está confirmada na hora. Não há fila de aprovação.
- **Lista de espera** e **reserva recorrente** (ex.: toda terça o semestre
  inteiro): não implementadas nesta versão.
- **Notificações de reserva por e-mail/WhatsApp** (confirmação, lembrete,
  cancelamento): não implementadas — esses avisos aparecem na tela do professor.
  O envio por e-mail/WhatsApp existe hoje só para entregar o acesso (matrícula
  e senha).
- **Empate entre dois professores**: vence quem confirmar primeiro (ordem de
  chegada no sistema).

## Recomeçar do zero

Para apagar os dados de exemplo e começar com o banco vazio, feche o servidor,
apague a pasta `dados/` e edite a última linha de `app.py` trocando
`banco.inicializar()` por `banco.inicializar(com_exemplos=False)`.
