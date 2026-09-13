"""Camada de banco de dados (SQLite) do Sistema de Reserva de Laboratorios.

Nao usa ORM: apenas o modulo sqlite3 da biblioteca padrao do Python.
O arquivo do banco fica em ./dados/escola.db e e criado automaticamente
na primeira execucao, ja com horarios, laboratorios, um gestor local e
professores de exemplo.
"""

import hashlib
import os
import re
import secrets
import sqlite3
import unicodedata
from datetime import datetime

PASTA_BASE = os.path.dirname(os.path.abspath(__file__))
# Onde ficam o banco, a chave de sessao e as fotos. No PC da escola e a pasta
# "dados" aqui do lado do codigo. Na hospedagem (Railway) o codigo e trocado
# inteiro a cada atualizacao, entao PASTA_DADOS aponta para o disco persistente
# montado em /data -- fora da pasta do codigo, para o deploy nao levar o banco
# junto. Veja HOSPEDAGEM.md.
PASTA_DADOS = os.environ.get("PASTA_DADOS") or os.path.join(PASTA_BASE, "dados")
CAMINHO_BANCO = os.path.join(PASTA_DADOS, "escola.db")
PASTA_FOTOS = os.path.join(PASTA_DADOS, "fotos")
PASTA_CALENDARIOS = os.path.join(PASTA_DADOS, "calendarios")

TURNOS = ("manha", "tarde", "noite")

ROTULO_TURNO = {"manha": "Manhã", "tarde": "Tarde", "noite": "Noite"}

# A matricula e gerada pelo sistema: numero sequencial de 4 ate 7 digitos.
MATRICULA_MINIMA = 1001
MATRICULA_MAXIMA = 9999999

# Alfabeto sem caracteres ambiguos (0/O, 1/l) para senhas faceis de digitar.
ALFABETO_SENHA = ("ABCDEFGHJKLMNPQRSTUVWXYZ"
                  "abcdefghijkmnpqrstuvwxyz"
                  "23456789")

# Configuracoes padrao do sistema (todas editaveis pelo gestor local).
CONFIG_PADRAO = {
    "nome_escola": "Escola Municipal Exemplo",
    # Regras de reserva
    "antecedencia_maxima_dias": "30",   # com quantos dias de antecedencia da para reservar
    "max_aulas_seguidas": "2",          # aulas seguidas por professor, por dia, no mesmo laboratorio
    "carencia_dias": "7",               # o "X" do questionario
    "carencia_escopo": "laboratorio",   # "laboratorio" ou "global"
    "carencia_dias_letivos": "0",       # 0 = dias corridos, 1 = apenas dias letivos
    "falta_conta_como_uso": "1",        # 1 = faltar gera carencia do mesmo jeito
    "cancelamento_antecedencia_horas": "24",
    "permitir_fim_de_semana": "0",
    "max_alunos_padrao": "40",
    # Reserva do intervalo para elaboracao de projetos (veja as constantes acima)
    "projeto_nome_padrao": "Elaboração de Projetos",
    "projeto_aula_referencia": "5",     # o intervalo fica logo depois desta aula
    "projeto_duracao_min": "50",        # quanto dura a reserva dentro do intervalo
    "projeto_intervalo_min": "60",      # quanto dura o proprio intervalo
    # Grade de aulas da escola
    # 1 = todo professor logado ve a grade da escola inteira (aba "Grade da
    # escola"); 0 = cada um so ve a propria. Professores marcados com
    # `grade_visivel = 0` ficam de fora da grade publica mesmo com a chave ligada.
    "grade_visivel_todos": "0",
    # Endereco que o professor usa para abrir o sistema (vai nas credenciais)
    "endereco_sistema": "",
    # Envio de credenciais por e-mail (opcional)
    "smtp_servidor": "",
    "smtp_porta": "587",
    "smtp_usuario": "",
    "smtp_remetente": "",
    "smtp_tls": "1",
}

# Chaves que nunca sao devolvidas para a tela.
CONFIG_SECRETAS = ("senha_gerente_hash", "senha_admin_hash", "smtp_senha")

# Excecao de aulas seguidas: o gestor escolhe entre estas opcoes, entao o
# servidor recusa qualquer outro valor mesmo que a tela seja burlada.
EXCECAO_AULAS_OPCOES = (2, 3, 4, 5, 6, 7, 8, 9)
EXCECAO_DIAS_OPCOES = (1, 2, 3)

# Alocacao de computadores: cada maquina do laboratorio comporta no maximo
# duas pessoas (o aluno e a dupla dele). O limite e conferido no servidor, nao
# so na tela, entao vale mesmo para um pedido montado a mao.
ALUNOS_POR_COMPUTADOR = 2

# Teto de maquinas que uma aula pode declarar. Existe para uma tela burlada
# nao gravar um laboratorio com mil computadores no historico.
MAX_COMPUTADORES = 60

# Reserva do intervalo para elaboracao de projetos. O intervalo de uma hora
# que a escola tem depois da 5a aula comporta uma reserva de 50 minutos: sobram
# 10 para a turma subir e descer do laboratorio. Os numeros ficam em `config`
# porque a grade de cada escola e diferente; estes sao so os valores de fabrica.
NOME_PROJETO_PADRAO = "Elaboracao de Projetos"
AULA_ANTES_DO_INTERVALO = 5
DURACAO_PROJETO_MIN = 50
INTERVALO_PROJETO_MIN = 60

# Hierarquia de acesso:
#   Gerente Geral  -> um unico acesso (senha guardada em config), ve tudo e
#                     cria as contas dos gestores locais;
#   Gestor Local   -> contas na tabela `gestores`, cuidam do dia a dia da
#                     escola (era o antigo "administrador");
#   Professor      -> contas na tabela `professores`, reservam laboratorios.
SENHA_GERENTE_PADRAO = "gerente123"
SENHA_GESTOR_PADRAO = "gestor123"
USUARIO_GESTOR_PADRAO = "gestor"

# Grade de horarios padrao (turno, ordem, inicio, fim).
HORARIOS_PADRAO = [
    ("manha", 1, "07:00", "07:50"),
    ("manha", 2, "07:50", "08:40"),
    ("manha", 3, "08:40", "09:30"),
    ("manha", 4, "09:50", "10:40"),
    ("manha", 5, "10:40", "11:30"),
    ("manha", 6, "11:30", "12:20"),
    ("tarde", 1, "13:00", "13:50"),
    ("tarde", 2, "13:50", "14:40"),
    ("tarde", 3, "14:40", "15:30"),
    ("tarde", 4, "15:50", "16:40"),
    ("tarde", 5, "16:40", "17:30"),
    ("tarde", 6, "17:30", "18:20"),
    ("noite", 1, "19:00", "19:45"),
    ("noite", 2, "19:45", "20:30"),
    ("noite", 3, "20:45", "21:30"),
    ("noite", 4, "21:30", "22:15"),
]

LABORATORIOS_EXEMPLO = [
    ("Laboratório de Informática 1", "Informática", 32, 30, "Coordenação de TI",
     "Windows 11, LibreOffice, Scratch"),
    ("Laboratório de Ciências", "Ciências", 30, 12, "Prof. responsável do turno",
     "Microscópios e bancadas"),
    ("Laboratório de Robótica", "Robótica", 24, 10, "Coordenação",
     "Kits Arduino e impressora 3D"),
]

# nome, capacidade, observacoes — salas de aula comuns da escola
SALAS_EXEMPLO = [
    ("Sala 01", 35, ""),
    ("Sala 02", 35, ""),
    ("Sala 03", 35, ""),
    ("Sala 04", 35, ""),
]

# nome, matricula, email, telefone, disciplina — a senha de todos e "prof123"
PROFESSORES_EXEMPLO = [
    ("Ana Beatriz Moraes", "1001", "ana.moraes@escola.edu.br", "11987650001", "Matemática"),
    ("Carlos Henrique Lima", "1002", "carlos.lima@escola.edu.br", "11987650002", "Física"),
    ("Daniela Prado", "1003", "daniela.prado@escola.edu.br", "11987650003", "Biologia"),
    ("Eduardo Ramos", "1004", "eduardo.ramos@escola.edu.br", "11987650004", "Informática"),
]

SENHA_EXEMPLO = "prof123"

ESQUEMA = """
-- Escolas da rede. O gerente geral cadastra; gestores e professores ficam
-- ligados a uma delas.
CREATE TABLE IF NOT EXISTS unidades (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    nome          TEXT    NOT NULL UNIQUE,
    cidade        TEXT,
    endereco      TEXT,
    telefone      TEXT,
    telefone_fixo TEXT,
    ativo         INTEGER NOT NULL DEFAULT 1,
    criado_em     TEXT    NOT NULL
);

-- `professor_id` so vem preenchido quando a conta nasceu da promocao de um
-- professor. E por ele que o sistema sabe que aquela pessoa passou a
-- administrar a escola e, por isso, deixou de reservar laboratorio.
CREATE TABLE IF NOT EXISTS gestores (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    nome          TEXT    NOT NULL,
    usuario       TEXT    NOT NULL UNIQUE,
    email         TEXT,
    telefone      TEXT,
    unidade_id    INTEGER REFERENCES unidades(id) ON DELETE SET NULL,
    professor_id  INTEGER REFERENCES professores(id) ON DELETE SET NULL,
    senha_hash    TEXT,
    ativo         INTEGER NOT NULL DEFAULT 1,
    ultimo_acesso TEXT,
    criado_em     TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS professores (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    nome        TEXT    NOT NULL,
    matricula   TEXT    NOT NULL UNIQUE,
    email       TEXT,
    telefone    TEXT,
    disciplina  TEXT,
    foto        TEXT,
    unidade_id  INTEGER REFERENCES unidades(id) ON DELETE SET NULL,
    senha_hash  TEXT,
    ativo       INTEGER NOT NULL DEFAULT 1,
    -- 0 = fica de fora da grade que os outros professores enxergam
    grade_visivel INTEGER NOT NULL DEFAULT 1,
    criado_em   TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS laboratorios (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    nome         TEXT    NOT NULL,
    tipo         TEXT,
    capacidade   INTEGER NOT NULL DEFAULT 30,
    equipamentos INTEGER NOT NULL DEFAULT 0,
    responsavel  TEXT,
    observacoes  TEXT,
    unidade_id   INTEGER REFERENCES unidades(id) ON DELETE SET NULL,
    ativo        INTEGER NOT NULL DEFAULT 1,
    criado_em    TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS horarios (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    turno      TEXT    NOT NULL,
    ordem      INTEGER NOT NULL,
    inicio     TEXT    NOT NULL,
    fim        TEXT    NOT NULL,
    unidade_id INTEGER REFERENCES unidades(id) ON DELETE SET NULL
);

-- Salas de aula comuns. Nao se confundem com `laboratorios`: laboratorio e
-- reservado aula a aula pelo professor; sala e onde a turma tem aula todo dia,
-- e so aparece na grade montada pelo gestor.
CREATE TABLE IF NOT EXISTS salas (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    nome        TEXT    NOT NULL,
    capacidade  INTEGER NOT NULL DEFAULT 35,
    observacoes TEXT,
    unidade_id  INTEGER REFERENCES unidades(id) ON DELETE SET NULL,
    ativo       INTEGER NOT NULL DEFAULT 1,
    criado_em   TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS reservas (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    laboratorio_id INTEGER NOT NULL REFERENCES laboratorios(id) ON DELETE CASCADE,
    professor_id   INTEGER NOT NULL REFERENCES professores(id) ON DELETE CASCADE,
    horario_id     INTEGER NOT NULL REFERENCES horarios(id)    ON DELETE CASCADE,
    data           TEXT    NOT NULL,
    disciplina     TEXT,
    tipo_aula      TEXT,
    qtd_alunos     INTEGER,
    observacao     TEXT,
    status         TEXT    NOT NULL DEFAULT 'ativa',
    grupo          TEXT,
    criado_em      TEXT    NOT NULL
);

-- Impede duas reservas validas no mesmo laboratorio/data/horario (trava de corrida).
CREATE UNIQUE INDEX IF NOT EXISTS idx_reserva_unica
    ON reservas (laboratorio_id, data, horario_id)
    WHERE status <> 'cancelada';

CREATE INDEX IF NOT EXISTS idx_reserva_professor ON reservas (professor_id, data);
CREATE INDEX IF NOT EXISTS idx_reserva_data      ON reservas (data);

CREATE TABLE IF NOT EXISTS bloqueios (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    data_inicio    TEXT NOT NULL,
    data_fim       TEXT NOT NULL,
    descricao      TEXT,
    laboratorio_id INTEGER REFERENCES laboratorios(id) ON DELETE CASCADE,
    unidade_id     INTEGER REFERENCES unidades(id)     ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS config (
    chave TEXT PRIMARY KEY,
    valor TEXT NOT NULL
);

-- Grade semanal de aulas de cada professor (turma/disciplina por dia da
-- semana e horario), montada e editada pelo gestor local. E independente das
-- reservas de laboratorio: so usa `horarios` para saber os horarios das aulas.
-- vigencia_inicio/vigencia_fim (AAAA-MM-DD) marcam desde quando ate quando
-- aquela versao da grade vale; vigencia_fim NULL = ainda vigente. Cada
-- "salvar grade" grava uma versao inteira nova em vez de editar celula a
-- celula, entao a vigencia e por versao, nao por linha isolada.
CREATE TABLE IF NOT EXISTS aulas_grade (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    professor_id    INTEGER NOT NULL REFERENCES professores(id) ON DELETE CASCADE,
    dia_semana      INTEGER NOT NULL,   -- 0=Segunda ... 4=Sexta
    horario_id      INTEGER NOT NULL REFERENCES horarios(id)    ON DELETE CASCADE,
    turma           TEXT,
    disciplina      TEXT,
    sala_id         INTEGER REFERENCES salas(id)    ON DELETE SET NULL,
    unidade_id      INTEGER REFERENCES unidades(id) ON DELETE SET NULL,
    vigencia_inicio TEXT NOT NULL DEFAULT '2000-01-01',
    vigencia_fim    TEXT,
    criado_em       TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_aula_grade_unica
    ON aulas_grade (professor_id, dia_semana, horario_id, vigencia_inicio);

-- Excecoes de uma data concreta, que se sobrepoem ao template de `aulas_grade`.
-- So guarda o que difere do padrao naquele dia: o que nao tem linha aqui vem da
-- grade padrao. `cancelada = 1` e a excecao que apaga uma aula do padrao (a
-- turma nao tem aquela aula naquele dia especifico).
CREATE TABLE IF NOT EXISTS aulas_semana (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    data_aula    TEXT    NOT NULL,   -- AAAA-MM-DD, o dia exato
    professor_id INTEGER NOT NULL REFERENCES professores(id) ON DELETE CASCADE,
    horario_id   INTEGER NOT NULL REFERENCES horarios(id)    ON DELETE CASCADE,
    turma        TEXT,
    disciplina   TEXT,
    sala_id      INTEGER REFERENCES salas(id)    ON DELETE SET NULL,
    cancelada    INTEGER NOT NULL DEFAULT 0,
    unidade_id   INTEGER REFERENCES unidades(id) ON DELETE SET NULL,
    criado_em    TEXT    NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_aula_semana_unica
    ON aulas_semana (data_aula, professor_id, horario_id);

CREATE INDEX IF NOT EXISTS idx_aula_semana_data ON aulas_semana (data_aula);

-- Excecao, por professor, do limite de aulas seguidas por dia. Quem tem linha
-- aqui pode encadear `max_aulas` aulas em vez do `max_aulas_seguidas` geral,
-- mas so em ate `max_dias` dias seguidos dentro da mesma semana. Um professor
-- tem no maximo uma excecao — salvar de novo reescreve a que ja existe.
CREATE TABLE IF NOT EXISTS excecoes_aulas_seguidas (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    professor_id  INTEGER NOT NULL UNIQUE REFERENCES professores(id) ON DELETE CASCADE,
    max_aulas     INTEGER NOT NULL,
    max_dias      INTEGER NOT NULL,
    unidade_id    INTEGER REFERENCES unidades(id) ON DELETE SET NULL,
    criado_em     TEXT    NOT NULL,
    atualizado_em TEXT
);

-- Alunos da escola, agrupados pela turma. `turma` e o mesmo texto livre usado
-- em `aulas_grade.turma` ("1o A ADM"), para a lista casar com a grade sem
-- precisar de uma tabela de turmas. Aluno nao tem login: esta aqui para o
-- professor montar a alocacao dos computadores sem redigitar nomes toda aula.
CREATE TABLE IF NOT EXISTS alunos (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    nome       TEXT    NOT NULL,
    turma      TEXT    NOT NULL,
    numero     INTEGER,           -- numero de chamada, quando a escola usa
    -- Matricula do aluno na escola. Diferente do `numero`, que so vale dentro
    -- da turma: e por ela que o professor chama o aluno no laboratorio de
    -- projetos, onde a turma nao ajuda porque o grupo mistura varias.
    matricula  TEXT,

    -- Ficha que vem das planilhas da secretaria (veja import_alunos.py). Tudo
    -- opcional: aluno cadastrado a mao pelo gestor entra so com nome e turma.
    sexo                          TEXT,     -- 'M' ou 'F'
    data_nascimento               TEXT,     -- AAAA-MM-DD, como as outras datas
    raca_cor                      TEXT,
    curso                         TEXT,     -- "Tecnico em Administracao"
    procedencia_modalidade_curso  TEXT,     -- de onde o aluno veio
    turma_codigo                  TEXT,     -- codigo da secretaria: "ADM1IN-A"

    -- Contato. A planilha da secretaria nao traz nada disso: quem preenche e o
    -- gestor, e por isso uma reimportacao nunca apaga estes campos.
    telefone                      TEXT,     -- WhatsApp, so digitos
    email                         TEXT,

    -- Endereco em pedacos, do jeito que o ViaCEP devolve. `endereco` continua
    -- existindo, mas virou texto montado a partir destes campos: e o que as
    -- telas mostram em uma linha so.
    cep                           TEXT,     -- so os 8 digitos
    logradouro                    TEXT,
    numero_endereco               TEXT,     -- texto: existe "s/n" e "120-A"
    complemento                   TEXT,
    bairro                        TEXT,
    cidade                        TEXT,
    uf                            TEXT,
    endereco                      TEXT,     -- montado por app.py, nao digitado

    -- Quem responde pelo aluno. A escola liga para este numero quando o aluno
    -- e menor de idade, que e o caso da maioria: por isso ele fica na ficha, ao
    -- lado do telefone do proprio aluno, e nao no lugar dele.
    responsavel_nome              TEXT,
    responsavel_parentesco        TEXT,     -- "Mae", "Pai", "Avo"...
    responsavel_telefone          TEXT,     -- WhatsApp, so digitos

    -- Situacao escolar em texto ("ATIVO", "TRANSFERIDO"...). Anda junto com
    -- `ativo`, o 0/1 que todas as consultas do sistema filtram.
    situacao   TEXT    NOT NULL DEFAULT 'ATIVO',

    unidade_id INTEGER REFERENCES unidades(id) ON DELETE SET NULL,
    ativo      INTEGER NOT NULL DEFAULT 1,
    criado_em  TEXT    NOT NULL,
    atualizado_em TEXT
);

CREATE INDEX IF NOT EXISTS idx_aluno_turma ON alunos (unidade_id, turma);

-- O mesmo nome nao entra duas vezes na mesma turma da mesma escola: e o que
-- deixa a importacao em massa ser repetida sem duplicar a lista. `COALESCE`
-- porque unidade_id NULL nunca colide com NULL num indice unico comum.
CREATE UNIQUE INDEX IF NOT EXISTS idx_aluno_unico
    ON alunos (COALESCE(unidade_id, 0), turma, nome COLLATE NOCASE);

-- Turmas abertas pelo gestor.
--
-- O sistema continua tratando turma como texto livre (`alunos.turma`,
-- `aulas_grade.turma`): esta tabela nao substitui isso e nada aponta para ela.
-- Ela existe para a turma poder ser criada antes de ter aluno ou aula na grade
-- — ate entao a turma so aparecia depois que alguem cadastrava alguem nela, e
-- o nome tinha de ser redigitado (com o risco da outra grafia) em cada tela.
-- `nome` e o mesmo texto que vai para `alunos.turma`.
CREATE TABLE IF NOT EXISTS turmas (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    nome          TEXT    NOT NULL,   -- "1o A ADM"
    curso         TEXT,               -- "Tecnico em Administracao"
    turno         TEXT,               -- 'manha', 'tarde' ou 'noite'
    unidade_id    INTEGER REFERENCES unidades(id) ON DELETE SET NULL,
    ativo         INTEGER NOT NULL DEFAULT 1,
    criado_em     TEXT    NOT NULL,
    atualizado_em TEXT
);

-- A mesma turma nao entra duas vezes na mesma escola. `COALESCE` pelo mesmo
-- motivo de `idx_aluno_unico`: NULL nao colide com NULL num indice unico.
CREATE UNIQUE INDEX IF NOT EXISTS idx_turma_unica
    ON turmas (COALESCE(unidade_id, 0), nome COLLATE NOCASE);

-- Reserva do laboratorio no intervalo de uma hora que vem depois da 5a aula.
--
-- Nao entra em `reservas` de proposito: aquela tabela aponta para uma linha de
-- `horarios`, e o intervalo nao e uma aula da grade — ele e justamente o vao
-- entre duas. Por isso a hora fica gravada aqui, em texto "HH:MM", ja com os
-- 50 minutos de duracao calculados na hora de reservar.
--
-- `projeto` nasce com "Elaboracao de Projetos" e o professor ou o gestor troca
-- pelo nome do evento quando for outra coisa. `professor_id` e o responsavel:
-- e ele quem registra os computadores depois.
CREATE TABLE IF NOT EXISTS reservas_projeto (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    laboratorio_id INTEGER NOT NULL REFERENCES laboratorios(id) ON DELETE CASCADE,
    professor_id   INTEGER NOT NULL REFERENCES professores(id)  ON DELETE CASCADE,
    data           TEXT    NOT NULL,   -- AAAA-MM-DD
    turno          TEXT    NOT NULL,   -- de qual turno e a 5a aula que abre o intervalo
    inicio         TEXT    NOT NULL,   -- HH:MM, o comeco dos 50 minutos
    fim            TEXT    NOT NULL,   -- HH:MM, inicio + duracao
    projeto        TEXT    NOT NULL,
    observacao     TEXT,
    status         TEXT    NOT NULL DEFAULT 'ativa',
    unidade_id     INTEGER REFERENCES unidades(id) ON DELETE SET NULL,
    criado_por     TEXT,               -- 'professor' ou 'gestor', so para o historico
    criado_em      TEXT    NOT NULL,
    atualizado_em  TEXT
);

-- O intervalo e um so por turno: um laboratorio nao aceita duas reservas de
-- projeto no mesmo dia e turno (trava de corrida, igual a das reservas de aula).
CREATE UNIQUE INDEX IF NOT EXISTS idx_projeto_unico
    ON reservas_projeto (laboratorio_id, data, turno)
 WHERE status <> 'cancelada';

CREATE INDEX IF NOT EXISTS idx_projeto_data      ON reservas_projeto (data);
CREATE INDEX IF NOT EXISTS idx_projeto_professor ON reservas_projeto (professor_id, data);

-- Uma aula de laboratorio ja registrada pelo professor: a foto de quem sentou
-- em qual computador. Fica separada de `reservas` de proposito — a reserva e o
-- agendamento (pode ser cancelada ou nem acontecer) e isto e o registro do que
-- aconteceu de fato, que o gestor consulta depois no historico.
CREATE TABLE IF NOT EXISTS sessoes_laboratorio (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    reserva_id       INTEGER REFERENCES reservas(id)              ON DELETE SET NULL,
    -- Preenchido no lugar de `reserva_id` quando a aula veio da reserva do
    -- intervalo. Sao as duas origens possiveis, e nunca as duas juntas: assim
    -- o historico do gestor mostra as duas na mesma lista.
    projeto_id       INTEGER REFERENCES reservas_projeto(id)      ON DELETE CASCADE,
    laboratorio_id   INTEGER NOT NULL REFERENCES laboratorios(id) ON DELETE CASCADE,
    professor_id     INTEGER NOT NULL REFERENCES professores(id)  ON DELETE CASCADE,
    horario_id       INTEGER REFERENCES horarios(id)              ON DELETE SET NULL,
    data_aula        TEXT    NOT NULL,   -- AAAA-MM-DD do dia da aula
    turma            TEXT,
    disciplina       TEXT,
    observacao       TEXT,
    qtd_computadores INTEGER NOT NULL DEFAULT 0,  -- maquinas disponiveis na aula
    unidade_id       INTEGER REFERENCES unidades(id) ON DELETE SET NULL,
    registrado_em    TEXT    NOT NULL,   -- data/hora em que o professor fechou a aula
    atualizado_em    TEXT
);

-- Uma reserva rende um registro so: salvar de novo corrige o que ja existe em
-- vez de duplicar a mesma aula no historico do gestor.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessao_reserva
    ON sessoes_laboratorio (reserva_id) WHERE reserva_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sessao_data      ON sessoes_laboratorio (data_aula);
CREATE INDEX IF NOT EXISTS idx_sessao_professor ON sessoes_laboratorio (professor_id, data_aula);

-- Uma linha por cadeira ocupada. `posicao` e 1 ou 2 — as duas cadeiras que
-- cada maquina comporta. `aluno_nome` e copia proposital do nome: se o aluno
-- sair da escola, o historico daquela aula continua legivel.
CREATE TABLE IF NOT EXISTS alocacoes_computador (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    sessao_id  INTEGER NOT NULL REFERENCES sessoes_laboratorio(id) ON DELETE CASCADE,
    computador INTEGER NOT NULL,
    posicao    INTEGER NOT NULL,
    aluno_id   INTEGER REFERENCES alunos(id) ON DELETE SET NULL,
    aluno_nome TEXT    NOT NULL,
    -- copia da matricula pelo mesmo motivo do nome: e por ela que o professor
    -- registrou o aluno, entao ela precisa sobreviver a exclusao da ficha
    aluno_matricula TEXT
);

-- Duas travas de coerencia do registro: a cadeira nao recebe dois alunos e o
-- mesmo aluno nao senta em dois computadores na mesma aula.
CREATE UNIQUE INDEX IF NOT EXISTS idx_alocacao_cadeira
    ON alocacoes_computador (sessao_id, computador, posicao);

CREATE UNIQUE INDEX IF NOT EXISTS idx_alocacao_aluno
    ON alocacoes_computador (sessao_id, aluno_id) WHERE aluno_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_alocacao_sessao ON alocacoes_computador (sessao_id);

-- O calendario escolar em PDF: um por escola, enviado pelo gestor local e lido
-- por todo mundo da unidade. O PDF mora no disco e no R2, como as fotos; aqui
-- fica so o nome sorteado com que ele foi gravado (`arquivo`, que muda a cada
-- envio), o nome que o arquivo tinha no computador de quem enviou e o tamanho.
-- Substituir o calendario troca esta linha, nao cria outra.
CREATE TABLE IF NOT EXISTS calendarios_escolares (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    unidade_id    INTEGER REFERENCES unidades(id) ON DELETE CASCADE,
    arquivo       TEXT    NOT NULL,
    nome_original TEXT    NOT NULL,
    tamanho       INTEGER NOT NULL,
    enviado_por   TEXT,
    enviado_em    TEXT    NOT NULL
);

-- COALESCE pelo mesmo motivo de `idx_turma_unica`: sem ele, duas linhas sem
-- unidade nao colidiriam e a escola "sem unidade" ficaria com dois calendarios.
CREATE UNIQUE INDEX IF NOT EXISTS idx_calendario_unidade
    ON calendarios_escolares (COALESCE(unidade_id, 0));
"""


# As colunas da ficha do aluno, na ordem em que `migrar` as acrescenta a um
# banco antigo. O ESQUEMA acima ja cria todas num banco novo — esta lista existe
# porque o ALTER do SQLite nao tem "IF NOT EXISTS" e precisa da conferencia.
COLUNAS_FICHA_ALUNO = (
    ("sexo", "TEXT"),
    ("data_nascimento", "TEXT"),
    ("raca_cor", "TEXT"),
    ("curso", "TEXT"),
    ("procedencia_modalidade_curso", "TEXT"),
    ("turma_codigo", "TEXT"),
    ("telefone", "TEXT"),
    ("endereco", "TEXT"),
    ("email", "TEXT"),
    ("cep", "TEXT"),
    ("logradouro", "TEXT"),
    ("numero_endereco", "TEXT"),
    ("complemento", "TEXT"),
    ("bairro", "TEXT"),
    ("cidade", "TEXT"),
    ("uf", "TEXT"),
    ("responsavel_nome", "TEXT"),
    ("responsavel_parentesco", "TEXT"),
    ("responsavel_telefone", "TEXT"),
    ("situacao", "TEXT NOT NULL DEFAULT 'ATIVO'"),
    ("atualizado_em", "TEXT"),
)

# `alunos` com os nomes canonicos da ficha (nome_completo, numero_classe). As
# colunas fisicas continuam `nome` e `numero` porque e o que o sistema inteiro
# consulta; renomear so quebraria app.py sem ganho nenhum.
VIEW_ALUNOS = """
CREATE VIEW vw_alunos AS
SELECT id,
       matricula,
       nome   AS nome_completo,
       turma,
       numero AS numero_classe,
       sexo,
       data_nascimento,
       raca_cor,
       curso,
       procedencia_modalidade_curso,
       telefone,
       email,
       cep,
       logradouro,
       numero_endereco,
       complemento,
       bairro,
       cidade,
       uf,
       endereco,
       responsavel_nome,
       responsavel_parentesco,
       responsavel_telefone,
       situacao,
       turma_codigo,
       unidade_id,
       ativo,
       criado_em,
       atualizado_em
  FROM alunos
"""

# Situacoes que a secretaria usa na planilha. Qualquer uma diferente de ATIVO
# faz `alunos.ativo` virar 0: e assim que o aluno some das listas do professor
# sem sumir do historico ja gravado.
SITUACAO_ATIVA = "ATIVO"


def agora():
    """Data/hora atual em texto ISO (segundos)."""
    return datetime.now().replace(microsecond=0).isoformat(sep=" ")


def conectar():
    """Abre uma conexao com o banco, com linhas acessiveis por nome de coluna."""
    os.makedirs(PASTA_DADOS, exist_ok=True)
    # timeout: com varios professores reservando ao mesmo tempo, quem chega no
    # meio de uma gravacao espera a vez em vez de levar "database is locked".
    conexao = sqlite3.connect(CAMINHO_BANCO, timeout=15)
    conexao.row_factory = sqlite3.Row
    conexao.execute("PRAGMA foreign_keys = ON")
    # WAL: leitura nao trava escrita nem vice-versa. Fica gravado no proprio
    # arquivo do banco, mas repetir a cada conexao nao custa nada e garante o
    # modo certo tambem num banco antigo que ainda estava em journal padrao.
    conexao.execute("PRAGMA journal_mode = WAL")
    conexao.execute("PRAGMA busy_timeout = 15000")
    return conexao


def linha_para_dict(linha):
    return dict(linha) if linha is not None else None


def linhas_para_lista(linhas):
    return [dict(linha) for linha in linhas]


# --------------------------------------------------------------------------- #
# Configuracoes
# --------------------------------------------------------------------------- #

def ler_config(conexao, chave, padrao=None):
    linha = conexao.execute("SELECT valor FROM config WHERE chave = ?", (chave,)).fetchone()
    if linha is None:
        return CONFIG_PADRAO.get(chave, padrao)
    return linha["valor"]


def ler_config_int(conexao, chave):
    try:
        return int(float(ler_config(conexao, chave)))
    except (TypeError, ValueError):
        return int(float(CONFIG_PADRAO.get(chave, 0)))


def ler_config_bool(conexao, chave):
    return str(ler_config(conexao, chave)).strip() in ("1", "true", "True", "sim")


def gravar_config(conexao, chave, valor):
    conexao.execute(
        "INSERT INTO config (chave, valor) VALUES (?, ?) "
        "ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor",
        (chave, str(valor)),
    )


def todas_configs(conexao):
    valores = dict(CONFIG_PADRAO)
    for linha in conexao.execute("SELECT chave, valor FROM config"):
        valores[linha["chave"]] = linha["valor"]
    for chave in CONFIG_SECRETAS:
        valores.pop(chave, None)
    return valores


def config_smtp(conexao):
    """Configuracao de envio de e-mail. A senha pode vir da variavel SMTP_SENHA."""
    return {
        "servidor": ler_config(conexao, "smtp_servidor") or "",
        "porta": ler_config_int(conexao, "smtp_porta") or 587,
        "usuario": ler_config(conexao, "smtp_usuario") or "",
        "senha": os.environ.get("SMTP_SENHA") or ler_config(conexao, "smtp_senha") or "",
        "remetente": (ler_config(conexao, "smtp_remetente")
                      or ler_config(conexao, "smtp_usuario") or ""),
        "tls": ler_config_bool(conexao, "smtp_tls"),
    }


# --------------------------------------------------------------------------- #
# Excecoes de aulas seguidas (por professor)
# --------------------------------------------------------------------------- #
#
# `max_aulas_seguidas` vale para a escola inteira. Alguns professores, porem,
# precisam encadear mais aulas (aula dupla de laboratorio, projeto que so
# rende em bloco). Em vez de afrouxar a regra para todo mundo, o gestor abre
# a excecao nome a nome e ainda limita em quantos dias seguidos ela pode ser
# usada na semana.

def excecao_de_aulas_seguidas(conexao, professor_id):
    """A excecao do professor, ou None quando ele segue a regra geral."""
    linha = conexao.execute(
        "SELECT * FROM excecoes_aulas_seguidas WHERE professor_id = ?", (professor_id,)
    ).fetchone()
    return linha_para_dict(linha)


def listar_excecoes_de_aulas_seguidas(conexao, onde="1 = 1", parametros=()):
    """Excecoes cadastradas, ja com nome e matricula de quem recebeu."""
    return linhas_para_lista(conexao.execute(
        f"""
        SELECT e.professor_id, e.max_aulas, e.max_dias,
               e.criado_em, e.atualizado_em,
               p.nome AS professor, p.matricula, p.ativo
          FROM excecoes_aulas_seguidas e
          JOIN professores p ON p.id = e.professor_id
         WHERE {onde}
         ORDER BY p.nome COLLATE NOCASE
        """,
        tuple(parametros),
    ).fetchall())


def gravar_excecao_de_aulas_seguidas(conexao, professor_id, max_aulas, max_dias,
                                     unidade_id=None):
    """Cria ou reescreve a excecao do professor (uma por pessoa)."""
    conexao.execute(
        """
        INSERT INTO excecoes_aulas_seguidas (professor_id, max_aulas, max_dias,
                                             unidade_id, criado_em)
             VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(professor_id) DO UPDATE SET
               max_aulas = excluded.max_aulas,
               max_dias = excluded.max_dias,
               unidade_id = COALESCE(excluded.unidade_id, excecoes_aulas_seguidas.unidade_id),
               atualizado_em = ?
        """,
        (professor_id, int(max_aulas), int(max_dias), unidade_id, agora(), agora()),
    )


def remover_excecao_de_aulas_seguidas(conexao, professor_id):
    return conexao.execute(
        "DELETE FROM excecoes_aulas_seguidas WHERE professor_id = ?", (professor_id,)
    ).rowcount


# --------------------------------------------------------------------------- #
# Alunos e alocacao de computadores
# --------------------------------------------------------------------------- #

def chave_de_nome(texto):
    """Nome reduzido a uma chave de comparacao: sem acento, sem caixa e sem
    espaco sobrando. "José  da Silva" e "JOSE DA SILVA" viram a mesma chave, e
    e por ela que o sistema sabe que e a mesma pessoa na hora de importar uma
    turma inteira duas vezes.
    """
    limpo = unicodedata.normalize("NFKD", str(texto or "")).encode("ascii", "ignore").decode()
    return " ".join(limpo.lower().split())


def texto_limpo(valor):
    """Tira espaco das pontas e junta os do meio: "1o   A  ADM" -> "1o A ADM"."""
    return " ".join(str(valor or "").split())


def alunos_da_turma(conexao, turma, onde_unidade="1 = 1", parametros=(), so_ativos=True):
    """Alunos de uma turma, na ordem da chamada (numero, depois nome)."""
    filtros = [onde_unidade, "turma = ?"]
    valores = [*parametros, turma]
    if so_ativos:
        filtros.append("ativo = 1")
    linhas = conexao.execute(
        f"""
        SELECT id, nome, turma, numero, matricula, ativo,
               sexo, data_nascimento, curso, situacao
          FROM alunos
         WHERE {' AND '.join(filtros)}
         ORDER BY CASE WHEN numero IS NULL THEN 1 ELSE 0 END, numero, nome COLLATE NOCASE
        """,
        valores,
    ).fetchall()
    return linhas_para_lista(linhas)


def so_digitos_ou_texto(valor):
    """Matricula normalizada: sem espaco nas pontas e sem os do meio.

    Nao forca so numeros porque escola tambem usa matricula com letra ("2026A15").
    """
    return " ".join(str(valor or "").split()).upper()


def aluno_por_matricula(conexao, matricula, onde_unidade="1 = 1", parametros=(),
                        so_ativos=True):
    """O aluno daquela matricula dentro da escola, ou None.

    A comparacao ignora caixa e espaco sobrando porque a matricula chega
    digitada a mao, no laboratorio, quase sempre pelo celular.
    """
    chave = so_digitos_ou_texto(matricula)
    if not chave:
        return None
    filtros = [onde_unidade, "UPPER(TRIM(matricula)) = ?"]
    valores = [*parametros, chave]
    if so_ativos:
        filtros.append("ativo = 1")
    return conexao.execute(
        f"""
        SELECT id, nome, turma, numero, matricula, ativo,
               sexo, data_nascimento, curso, situacao
          FROM alunos WHERE {' AND '.join(filtros)} LIMIT 1
        """,
        valores,
    ).fetchone()


# --------------------------------------------------------------------------- #
# O intervalo depois da 5a aula: a janela onde a reserva de projetos cabe
# --------------------------------------------------------------------------- #

def para_minutos(hora):
    """'12:10' -> 730. Os horarios sao texto no banco, entao a conta sai daqui."""
    try:
        horas, minutos = str(hora).split(":")[:2]
        return int(horas) * 60 + int(minutos)
    except (ValueError, AttributeError):
        return None


def para_hora(minutos):
    """730 -> '12:10'."""
    return f"{minutos // 60:02d}:{minutos % 60:02d}"


def janelas_de_intervalo(conexao, unidade_id=None):
    """As janelas de reserva do intervalo da escola, uma por turno que tem a 5a aula.

    A janela nao e cadastrada: ela e deduzida da grade de horarios. O intervalo
    comeca quando a 5a aula termina e vai ate a proxima aula do dia — em geral a
    primeira do turno seguinte. A reserva ocupa os primeiros 50 minutos dele.

    Cada janela vem com `livre` (quanto tempo o intervalo tem de fato) e `cabe`,
    que e o que diz se aquela grade comporta a reserva. Turno sem 5a aula
    simplesmente nao aparece.
    """
    aula = ler_config_int(conexao, "projeto_aula_referencia") or AULA_ANTES_DO_INTERVALO
    duracao = ler_config_int(conexao, "projeto_duracao_min") or DURACAO_PROJETO_MIN
    intervalo = ler_config_int(conexao, "projeto_intervalo_min") or INTERVALO_PROJETO_MIN

    onde = "1 = 1" if unidade_id is None else "unidade_id = ?"
    valores = () if unidade_id is None else (unidade_id,)
    horarios = conexao.execute(
        f"SELECT turno, ordem, inicio, fim FROM horarios WHERE {onde}", valores
    ).fetchall()

    # o dia inteiro em ordem de relogio: o intervalo da manha termina na
    # primeira aula da tarde, entao nao da para olhar so o turno da 5a aula
    comecos = sorted(m for m in (para_minutos(h["inicio"]) for h in horarios)
                     if m is not None)

    janelas = []
    for horario in horarios:
        if horario["ordem"] != aula:
            continue
        comeco = para_minutos(horario["fim"])
        if comeco is None:
            continue

        proxima = next((m for m in comecos if m > comeco), None)
        livre = intervalo if proxima is None else proxima - comeco
        janelas.append({
            "turno": horario["turno"],
            "aula_referencia": aula,
            "aula_termina": horario["fim"],
            "inicio": para_hora(comeco),
            "fim": para_hora(comeco + duracao),
            "fim_intervalo": para_hora(comeco + livre),
            "duracao": duracao,
            "intervalo": intervalo,
            "livre": livre,
            "cabe": livre >= duracao,
        })

    ordem_turno = {"manha": 1, "tarde": 2, "noite": 3}
    janelas.sort(key=lambda j: (ordem_turno.get(j["turno"], 9), j["inicio"]))
    return janelas


def janela_de_intervalo(conexao, unidade_id=None, turno=None):
    """A janela de um turno — ou a unica/primeira da escola, sem turno informado."""
    janelas = janelas_de_intervalo(conexao, unidade_id)
    if turno:
        return next((j for j in janelas if j["turno"] == turno), None)
    return next((j for j in janelas if j["cabe"]), janelas[0] if janelas else None)


def alocacoes_da_sessao(conexao, sessao_id):
    """As cadeiras ocupadas de uma aula, na ordem dos computadores."""
    linhas = conexao.execute(
        """
        SELECT a.computador, a.posicao, a.aluno_id, a.aluno_nome,
               COALESCE(a.aluno_matricula, al.matricula) AS aluno_matricula,
               al.turma AS aluno_turma
          FROM alocacoes_computador a
     LEFT JOIN alunos al ON al.id = a.aluno_id
         WHERE a.sessao_id = ?
         ORDER BY a.computador, a.posicao
        """,
        (sessao_id,),
    ).fetchall()
    return linhas_para_lista(linhas)


def computadores_da_sessao(conexao, sessao_id, qtd_computadores):
    """As alocacoes agrupadas por maquina: [{numero, alunos:[...]}, ...].

    Devolve todas as maquinas declaradas na aula, inclusive as que ficaram
    vazias — o gestor precisa enxergar tambem o que nao foi usado.
    """
    por_maquina = {}
    for linha in alocacoes_da_sessao(conexao, sessao_id):
        por_maquina.setdefault(linha["computador"], []).append(linha)

    maiores = max(por_maquina) if por_maquina else 0
    total = max(int(qtd_computadores or 0), maiores)
    return [{"numero": numero, "alunos": por_maquina.get(numero, [])}
            for numero in range(1, total + 1)]


# --------------------------------------------------------------------------- #
# Senhas: gerente geral (config) e gestores locais (tabela)
# --------------------------------------------------------------------------- #

def gerar_hash_senha(senha):
    sal = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", senha.encode("utf-8"), sal.encode("utf-8"), 120_000)
    return f"{sal}${digest.hex()}"


def conferir_senha(senha, hash_guardado):
    try:
        sal, esperado = hash_guardado.split("$", 1)
    except (ValueError, AttributeError):
        return False
    digest = hashlib.pbkdf2_hmac("sha256", senha.encode("utf-8"), sal.encode("utf-8"), 120_000)
    return secrets.compare_digest(digest.hex(), esperado)


def definir_senha_gerente(conexao, senha):
    """O gerente geral e unico: a senha dele mora na tabela de configuracoes."""
    gravar_config(conexao, "senha_gerente_hash", gerar_hash_senha(senha))


def validar_senha_gerente(conexao, senha):
    linha = conexao.execute(
        "SELECT valor FROM config WHERE chave = 'senha_gerente_hash'"
    ).fetchone()
    if linha is None:
        return False
    return conferir_senha(senha, linha["valor"])


# --------------------------------------------------------------------------- #
# Gestores locais: usuario automatico e senha
# --------------------------------------------------------------------------- #

def apelido(texto):
    """"José da Silva Neto" -> "jose.da.silva.neto" (sem acento, minusculo)."""
    limpo = unicodedata.normalize("NFKD", str(texto or "")).encode("ascii", "ignore").decode()
    return re.sub(r"[^A-Za-z0-9]+", ".", limpo).strip(".").lower()


def usuario_valido(usuario):
    """Nome de acesso: letra/numero no comeco, 3 a 30 caracteres."""
    return bool(re.fullmatch(r"[a-z0-9][a-z0-9._-]{2,29}", str(usuario or "")))


def gerar_usuario_gestor(conexao, nome, ignorar_id=None):
    """Sugere um usuario livre a partir do nome: "Maria Souza" -> "maria.souza"."""
    partes = [parte for parte in apelido(nome).split(".") if parte]
    if len(partes) >= 2:
        base = f"{partes[0]}.{partes[-1]}"
    elif partes:
        base = partes[0]
    else:
        base = USUARIO_GESTOR_PADRAO
    base = base[:26]
    if len(base) < 3:
        base = (base + USUARIO_GESTOR_PADRAO)[:26]

    candidato = base
    sufixo = 1
    while usuario_em_uso(conexao, candidato, ignorar_id):
        sufixo += 1
        candidato = f"{base}{sufixo}"
    return candidato


def usuario_em_uso(conexao, usuario, ignorar_id=None):
    sql = "SELECT 1 FROM gestores WHERE usuario = ? COLLATE NOCASE"
    parametros = [usuario]
    if ignorar_id:
        sql += " AND id <> ?"
        parametros.append(ignorar_id)
    return conexao.execute(sql, parametros).fetchone() is not None


def definir_senha_gestor(conexao, gestor_id, senha):
    conexao.execute(
        "UPDATE gestores SET senha_hash = ? WHERE id = ?",
        (gerar_hash_senha(senha), gestor_id),
    )


def validar_senha_gestor(gestor, senha):
    hash_guardado = gestor["senha_hash"] if "senha_hash" in gestor.keys() else None
    if not hash_guardado:
        return False
    return conferir_senha(senha, hash_guardado)


def registrar_acesso_gestor(conexao, gestor_id):
    conexao.execute("UPDATE gestores SET ultimo_acesso = ? WHERE id = ?", (agora(), gestor_id))


# --------------------------------------------------------------------------- #
# Professores: matricula automatica e senha
# --------------------------------------------------------------------------- #

def gerar_matricula(conexao):
    """Proxima matricula sequencial (4 a 7 digitos), gerada pelo sistema."""
    linha = conexao.execute(
        "SELECT MAX(CAST(matricula AS INTEGER)) AS maior FROM professores "
        "WHERE matricula GLOB '[0-9]*'"
    ).fetchone()
    proxima = max((linha["maior"] or 0) + 1, MATRICULA_MINIMA)

    # pula eventuais matriculas ja usadas (cadastros antigos, importacoes)
    while conexao.execute(
        "SELECT 1 FROM professores WHERE matricula = ?", (str(proxima),)
    ).fetchone():
        proxima += 1

    if proxima > MATRICULA_MAXIMA:
        raise ValueError("O limite de matrículas de 7 dígitos foi atingido.")
    return str(proxima)


def gerar_senha(tamanho=8):
    """Senha aleatoria legivel, para entregar a quem esta recebendo o acesso."""
    return "".join(secrets.choice(ALFABETO_SENHA) for _ in range(tamanho))


def definir_senha_professor(conexao, professor_id, senha):
    conexao.execute(
        "UPDATE professores SET senha_hash = ? WHERE id = ?",
        (gerar_hash_senha(senha), professor_id),
    )


def validar_senha_professor(professor, senha):
    hash_guardado = professor["senha_hash"] if "senha_hash" in professor.keys() else None
    if not hash_guardado:
        return False
    return conferir_senha(senha, hash_guardado)


# --------------------------------------------------------------------------- #
# Chave de sessao do Flask (persistida para nao derrubar o login a cada restart)
# --------------------------------------------------------------------------- #

def obter_chave_secreta():
    # Na hospedagem a chave vem da variavel de ambiente: assim as sessoes dos
    # professores continuam validas mesmo se o disco for recriado do zero.
    do_ambiente = os.environ.get("SECRET_KEY", "").strip()
    if do_ambiente:
        return do_ambiente
    os.makedirs(PASTA_DADOS, exist_ok=True)
    caminho = os.path.join(PASTA_DADOS, "chave_sessao.txt")
    if os.path.exists(caminho):
        with open(caminho, "r", encoding="utf-8") as arquivo:
            chave = arquivo.read().strip()
            if chave:
                return chave
    chave = secrets.token_hex(32)
    with open(caminho, "w", encoding="utf-8") as arquivo:
        arquivo.write(chave)
    return chave


# --------------------------------------------------------------------------- #
# Inicializacao / dados de exemplo
# --------------------------------------------------------------------------- #

def colunas_de(conexao, tabela):
    return {linha["name"] for linha in conexao.execute(f"PRAGMA table_info({tabela})")}


def migrar(conexao):
    """Adiciona colunas novas em bancos criados por versoes anteriores."""
    colunas = colunas_de(conexao, "professores")
    for coluna, tipo in (("telefone", "TEXT"), ("senha_hash", "TEXT"),
                         ("unidade_id", "INTEGER"), ("foto", "TEXT"),
                         ("grade_visivel", "INTEGER NOT NULL DEFAULT 1")):
        if coluna not in colunas:
            conexao.execute(f"ALTER TABLE professores ADD COLUMN {coluna} {tipo}")

    # a sala de cada aula da grade chegou depois da propria grade
    if "sala_id" not in colunas_de(conexao, "aulas_grade"):
        conexao.execute("ALTER TABLE aulas_grade ADD COLUMN sala_id INTEGER")

    # vigencia (agendar troca de grade para uma data futura) chegou depois
    if "vigencia_inicio" not in colunas_de(conexao, "aulas_grade"):
        conexao.execute(
            "ALTER TABLE aulas_grade ADD COLUMN vigencia_inicio TEXT "
            "NOT NULL DEFAULT '2000-01-01'"
        )
        conexao.execute("ALTER TABLE aulas_grade ADD COLUMN vigencia_fim TEXT")
        # o indice antigo nao tinha vigencia_inicio e bloquearia a segunda versao
        # da mesma celula (dia/horario) quando o gestor agenda uma troca
        conexao.execute("DROP INDEX IF EXISTS idx_aula_grade_unica")
        conexao.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_aula_grade_unica "
            "ON aulas_grade (professor_id, dia_semana, horario_id, vigencia_inicio)"
        )

    if "telefone_fixo" not in colunas_de(conexao, "unidades"):
        conexao.execute("ALTER TABLE unidades ADD COLUMN telefone_fixo TEXT")

    if "unidade_id" not in colunas_de(conexao, "gestores"):
        conexao.execute("ALTER TABLE gestores ADD COLUMN unidade_id INTEGER")
    if "professor_id" not in colunas_de(conexao, "gestores"):
        conexao.execute("ALTER TABLE gestores ADD COLUMN professor_id INTEGER")
    if "unidade_id" not in colunas_de(conexao, "bloqueios"):
        conexao.execute("ALTER TABLE bloqueios ADD COLUMN unidade_id INTEGER")

    # A reserva do intervalo (elaboracao de projetos) chegou depois: o registro
    # de computadores passou a ter duas origens, e o aluno passou a ter matricula.
    if "matricula" not in colunas_de(conexao, "alunos"):
        conexao.execute("ALTER TABLE alunos ADD COLUMN matricula TEXT")

    # A ficha completa do aluno (planilhas da secretaria) chegou depois: veja
    # schema.sql e import_alunos.py. Todas entram vazias nos alunos ja
    # cadastrados, entao nenhuma consulta antiga muda de resultado.
    colunas_aluno = colunas_de(conexao, "alunos")
    for coluna, tipo in COLUNAS_FICHA_ALUNO:
        if coluna not in colunas_aluno:
            conexao.execute(f"ALTER TABLE alunos ADD COLUMN {coluna} {tipo}")
    conexao.execute(
        "CREATE INDEX IF NOT EXISTS idx_aluno_curso ON alunos (unidade_id, curso)"
    )
    conexao.execute(
        "CREATE INDEX IF NOT EXISTS idx_aluno_situacao "
        "ON alunos (unidade_id, situacao)"
    )
    # A view apresenta a tabela com os nomes canonicos (nome_completo,
    # numero_classe): e por ela que relatorio e exportacao leem os alunos.
    conexao.execute("DROP VIEW IF EXISTS vw_alunos")
    conexao.execute(VIEW_ALUNOS)
    if "projeto_id" not in colunas_de(conexao, "sessoes_laboratorio"):
        # sem REFERENCES: o ALTER do SQLite nao aceita chave estrangeira em
        # coluna nova. A tabela recriada do zero (ESQUEMA) ja nasce com ela.
        conexao.execute("ALTER TABLE sessoes_laboratorio ADD COLUMN projeto_id INTEGER")
    # os dois indices sao parciais e falam dessas colunas: por isso ficam aqui,
    # depois do ALTER, e nao no ESQUEMA, que roda antes da migracao
    conexao.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_aluno_matricula "
        "ON alunos (COALESCE(unidade_id, 0), matricula) "
        "WHERE matricula IS NOT NULL AND matricula <> ''"
    )
    conexao.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_sessao_projeto "
        "ON sessoes_laboratorio (projeto_id) WHERE projeto_id IS NOT NULL"
    )
    if "aluno_matricula" not in colunas_de(conexao, "alocacoes_computador"):
        conexao.execute(
            "ALTER TABLE alocacoes_computador ADD COLUMN aluno_matricula TEXT"
        )

    migrar_unidades(conexao)
    migrar_recursos_por_unidade(conexao)


# Tabelas que precisaram perder uma restricao UNIQUE para conviver com varias
# escolas: o nome do laboratorio e a ordem da aula agora repetem entre unidades.
TABELAS_RECRIADAS = {
    "laboratorios": ("""
        CREATE TABLE laboratorios_novo (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            nome         TEXT    NOT NULL,
            tipo         TEXT,
            capacidade   INTEGER NOT NULL DEFAULT 30,
            equipamentos INTEGER NOT NULL DEFAULT 0,
            responsavel  TEXT,
            observacoes  TEXT,
            unidade_id   INTEGER REFERENCES unidades(id) ON DELETE SET NULL,
            ativo        INTEGER NOT NULL DEFAULT 1,
            criado_em    TEXT    NOT NULL
        )""",
        "id, nome, tipo, capacidade, equipamentos, responsavel, observacoes, ativo, criado_em"),
    "horarios": ("""
        CREATE TABLE horarios_novo (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            turno      TEXT    NOT NULL,
            ordem      INTEGER NOT NULL,
            inicio     TEXT    NOT NULL,
            fim        TEXT    NOT NULL,
            unidade_id INTEGER REFERENCES unidades(id) ON DELETE SET NULL
        )""",
        "id, turno, ordem, inicio, fim"),
}


def migrar_recursos_por_unidade(conexao):
    """Da a laboratorios e horarios a coluna `unidade_id`, recriando as tabelas.

    Recriar e necessario porque o esquema antigo tinha `laboratorios.nome UNIQUE`
    e `horarios UNIQUE (turno, ordem)` — restricoes que impediriam duas escolas
    de ter um "Laboratorio de Informatica 1" ou uma "1a aula da manha".
    Segue o passo a passo recomendado pelo proprio SQLite para trocar o esquema
    de uma tabela ja referenciada por outras.
    """
    pendentes = [tabela for tabela in TABELAS_RECRIADAS
                 if "unidade_id" not in colunas_de(conexao, tabela)]
    if not pendentes:
        return

    conexao.commit()
    conexao.execute("PRAGMA foreign_keys = OFF")
    try:
        conexao.execute("BEGIN")
        for tabela in pendentes:
            ddl, campos = TABELAS_RECRIADAS[tabela]
            conexao.execute(ddl)
            conexao.execute(
                f"INSERT INTO {tabela}_novo ({campos}) SELECT {campos} FROM {tabela}"
            )
            conexao.execute(f"DROP TABLE {tabela}")
            conexao.execute(f"ALTER TABLE {tabela}_novo RENAME TO {tabela}")

        problemas = conexao.execute("PRAGMA foreign_key_check").fetchall()
        if problemas:
            raise sqlite3.IntegrityError(f"referências quebradas na migração: {problemas}")
        conexao.commit()
    except Exception:
        conexao.rollback()
        raise
    finally:
        conexao.execute("PRAGMA foreign_keys = ON")


def migrar_unidades(conexao):
    """Transforma o texto livre de `gestores.unidade` em linhas da tabela `unidades`.

    Antes cada gestor guardava o nome da escola digitado a mao; agora a unidade
    e um cadastro proprio, para o gerente geral olhar a rede escola por escola.
    """
    if "unidade" not in colunas_de(conexao, "gestores"):
        return

    pendentes = conexao.execute(
        "SELECT id, unidade FROM gestores "
        "WHERE unidade_id IS NULL AND TRIM(COALESCE(unidade, '')) <> ''"
    ).fetchall()

    for gestor in pendentes:
        nome = gestor["unidade"].strip()
        linha = conexao.execute(
            "SELECT id FROM unidades WHERE nome = ? COLLATE NOCASE", (nome,)
        ).fetchone()
        if linha is None:
            cursor = conexao.execute(
                "INSERT INTO unidades (nome, cidade, endereco, telefone, ativo, criado_em) "
                "VALUES (?, '', '', '', 1, ?)",
                (nome, agora()),
            )
            unidade_id = cursor.lastrowid
        else:
            unidade_id = linha["id"]
        conexao.execute(
            "UPDATE gestores SET unidade_id = ? WHERE id = ?", (unidade_id, gestor["id"])
        )

    # a coluna de texto perdeu a funcao; some quando o SQLite permite
    try:
        conexao.execute("ALTER TABLE gestores DROP COLUMN unidade")
    except sqlite3.OperationalError:
        pass


def unidade_padrao(conexao):
    """Unidade da propria escola, criada a partir do nome configurado."""
    nome = ler_config(conexao, "nome_escola") or "Unidade principal"
    linha = conexao.execute(
        "SELECT id FROM unidades WHERE nome = ? COLLATE NOCASE", (nome,)
    ).fetchone()
    if linha:
        return linha["id"]
    cursor = conexao.execute(
        "INSERT INTO unidades (nome, cidade, endereco, telefone, ativo, criado_em) "
        "VALUES (?, '', '', '', 1, ?)",
        (nome, agora()),
    )
    return cursor.lastrowid


def ligar_soltos_a_unica_unidade(conexao):
    """Bancos de escola unica: tudo que esta solto pertence a essa unica unidade.

    Com mais de uma escola cadastrada nao da para adivinhar, entao o que ficou
    sem vinculo permanece assim e aparece separado na tela do gerente ate
    alguem definir a unidade.
    """
    unidades = conexao.execute("SELECT id FROM unidades").fetchall()
    if len(unidades) != 1:
        return
    unica = unidades[0]["id"]
    for tabela in ("professores", "laboratorios", "horarios", "salas"):
        conexao.execute(
            f"UPDATE {tabela} SET unidade_id = ? WHERE unidade_id IS NULL", (unica,)
        )
    # bloqueio de laboratorio segue o laboratorio; o "da escola toda" vira da unidade
    conexao.execute(
        "UPDATE bloqueios SET unidade_id = ? WHERE unidade_id IS NULL", (unica,)
    )


def criar_primeiro_gestor(conexao):
    """Garante que exista ao menos um gestor local para a escola nao ficar sem acesso.

    Em bancos da versao anterior (que tinham um unico "administrador"), a senha
    do admin vira a senha desse primeiro gestor, para ninguem perder o acesso.
    """
    if conexao.execute("SELECT COUNT(*) c FROM gestores").fetchone()["c"]:
        return

    antiga = conexao.execute(
        "SELECT valor FROM config WHERE chave = 'senha_admin_hash'"
    ).fetchone()
    senha_hash = antiga["valor"] if antiga else gerar_hash_senha(SENHA_GESTOR_PADRAO)

    conexao.execute(
        "INSERT INTO gestores (nome, usuario, email, telefone, unidade_id, senha_hash, "
        "ativo, criado_em) VALUES (?, ?, '', '', ?, ?, 1, ?)",
        ("Gestor Local", USUARIO_GESTOR_PADRAO, unidade_padrao(conexao),
         senha_hash, agora()),
    )
    # a chave antiga nao e mais usada por ninguem
    conexao.execute("DELETE FROM config WHERE chave = 'senha_admin_hash'")


def inicializar(com_exemplos=True):
    """Cria as tabelas (se nao existirem) e popula os dados iniciais."""
    conexao = conectar()
    try:
        conexao.executescript(ESQUEMA)
        migrar(conexao)

        for chave, valor in CONFIG_PADRAO.items():
            existente = conexao.execute(
                "SELECT 1 FROM config WHERE chave = ?", (chave,)
            ).fetchone()
            if existente is None:
                gravar_config(conexao, chave, valor)

        tem_senha_gerente = conexao.execute(
            "SELECT 1 FROM config WHERE chave = 'senha_gerente_hash'"
        ).fetchone()
        if tem_senha_gerente is None:
            definir_senha_gerente(conexao, SENHA_GERENTE_PADRAO)

        criar_primeiro_gestor(conexao)

        if conexao.execute("SELECT COUNT(*) c FROM horarios").fetchone()["c"] == 0:
            unidade = unidade_padrao(conexao)
            conexao.executemany(
                "INSERT INTO horarios (turno, ordem, inicio, fim, unidade_id) "
                "VALUES (?, ?, ?, ?, ?)",
                [(*horario, unidade) for horario in HORARIOS_PADRAO],
            )

        if com_exemplos:
            if conexao.execute("SELECT COUNT(*) c FROM laboratorios").fetchone()["c"] == 0:
                unidade = unidade_padrao(conexao)
                conexao.executemany(
                    "INSERT INTO laboratorios (nome, tipo, capacidade, equipamentos, "
                    "responsavel, observacoes, unidade_id, ativo, criado_em) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)",
                    [(*lab, unidade, agora()) for lab in LABORATORIOS_EXEMPLO],
                )
            if conexao.execute("SELECT COUNT(*) c FROM salas").fetchone()["c"] == 0:
                unidade = unidade_padrao(conexao)
                conexao.executemany(
                    "INSERT INTO salas (nome, capacidade, observacoes, unidade_id, "
                    "ativo, criado_em) VALUES (?, ?, ?, ?, 1, ?)",
                    [(*sala, unidade, agora()) for sala in SALAS_EXEMPLO],
                )
            if conexao.execute("SELECT COUNT(*) c FROM professores").fetchone()["c"] == 0:
                unidade = unidade_padrao(conexao)
                conexao.executemany(
                    "INSERT INTO professores (nome, matricula, email, telefone, "
                    "disciplina, unidade_id, senha_hash, ativo, criado_em) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)",
                    [(*prof, unidade, gerar_hash_senha(SENHA_EXEMPLO), agora())
                     for prof in PROFESSORES_EXEMPLO],
                )

        ligar_soltos_a_unica_unidade(conexao)
        conexao.commit()
    finally:
        conexao.close()


if __name__ == "__main__":
    inicializar()
    print(f"Banco pronto em: {CAMINHO_BANCO}")
