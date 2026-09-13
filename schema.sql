-- ===========================================================================
-- Migracao: cadastro completo de alunos  (SQLite - dados/escola.db)
-- Sistema de Gestao de Laboratorios / ETE Jose Nivaldo Pereira Ramos
-- ===========================================================================
--
-- A tabela `alunos` ja existia no sistema com o essencial para a alocacao dos
-- computadores (nome, turma, numero de chamada e matricula). Esta migracao
-- acrescenta os dados que vem das planilhas oficiais da secretaria
-- ("alunos ADM.xls", "ALUNOS REDES.xls", "ALUNOS SISTEMAS.xls"), para o gestor
-- e o professor verem a ficha do aluno sem abrir planilha.
--
-- Dois nomes de coluna sao mantidos como ja estavam, e nao renomeados:
--
--   nome    e o `nome_completo` do pedido
--   numero  e o `numero_classe`  do pedido
--
-- Renomear quebraria as consultas espalhadas por banco.py e app.py sem ganhar
-- nada. Quem precisa dos nomes canonicos (relatorio, exportacao, integracao)
-- usa a VIEW `vw_alunos`, no fim deste arquivo, que apresenta exatamente os
-- campos pedidos.
--
-- Como rodar:
--
--   py import_alunos.py --migrar-apenas     (recomendado: aplica so o que falta)
--   sqlite3 dados/escola.db < schema.sql    (banco novo, do zero)
--
-- O SQLite nao aceita "ALTER TABLE ... ADD COLUMN IF NOT EXISTS": num banco que
-- ja recebeu esta migracao os ALTER da secao 2 devolvem "duplicate column name"
-- e podem ser ignorados. Por isso o caminho de rotina e o script Python, que
-- confere as colunas antes (banco.migrar tambem aplica isso sozinho ao subir o
-- sistema).
-- ---------------------------------------------------------------------------

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- 1. Banco novo: a tabela ja nasce completa
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS alunos (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,

    -- Identificacao
    nome       TEXT    NOT NULL,          -- nome_completo (VARCHAR 255)
    matricula  TEXT,                      -- unica na escola, quando informada
    turma      TEXT    NOT NULL,          -- "1o A ADM": o mesmo texto de aulas_grade.turma
    numero     INTEGER,                   -- numero_classe (numero de chamada)

    -- Ficha da secretaria (planilhas .xls)
    sexo                          TEXT,   -- 'M' ou 'F', 1 caractere
    data_nascimento               TEXT,   -- AAAA-MM-DD (data em texto, como no resto do banco)
    raca_cor                      TEXT,   -- "Branca", "Parda", "Preta", "Nao declarada"...
    curso                         TEXT,   -- "Tecnico em Administracao" (cabecalho da planilha)
    procedencia_modalidade_curso  TEXT,   -- de onde o aluno veio ("Ensino Fundamental...")
    turma_codigo                  TEXT,   -- codigo da secretaria: "ADM1IN-A", "TRC2IN-U"

    -- Contato. A planilha da secretaria nao traz nada disso, quem preenche e o
    -- gestor, e por isso uma reimportacao nunca apaga estes campos.
    telefone   TEXT,                      -- WhatsApp, so os digitos
    email      TEXT,

    -- Endereco em pedacos, do jeito que o ViaCEP devolve. `endereco` continua
    -- existindo, mas virou texto montado a partir destes campos: e o que as
    -- telas mostram em uma linha so.
    cep             TEXT,                 -- so os 8 digitos
    logradouro      TEXT,
    numero_endereco TEXT,                 -- texto: existe "s/n" e "120-A"
    complemento     TEXT,
    bairro          TEXT,
    cidade          TEXT,
    uf              TEXT,
    endereco        TEXT,                 -- montado por app.py, nao digitado

    -- Quem responde pelo aluno. A escola liga para este numero quando o aluno e
    -- menor de idade, que e o caso da maioria: por isso ele fica na ficha, ao
    -- lado do telefone do proprio aluno, e nao no lugar dele.
    responsavel_nome       TEXT,
    responsavel_parentesco TEXT,          -- "Mae", "Pai", "Avo"...
    responsavel_telefone   TEXT,          -- WhatsApp, so os digitos

    -- Situacao escolar em texto ("ATIVO", "TRANSFERIDO", "DESISTENTE"...).
    -- `ativo` continua sendo o 0/1 que o sistema inteiro filtra, e os dois andam
    -- juntos: situacao <> 'ATIVO' grava ativo = 0.
    situacao   TEXT    NOT NULL DEFAULT 'ATIVO',

    unidade_id INTEGER REFERENCES unidades(id) ON DELETE SET NULL,
    ativo      INTEGER NOT NULL DEFAULT 1,

    criado_em     TEXT NOT NULL,
    atualizado_em TEXT
);

-- ---------------------------------------------------------------------------
-- 2. Banco que ja existe: as colunas novas
--    (num banco ja migrado cada linha destas falha com "duplicate column name",
--     use `py import_alunos.py --migrar-apenas` para pular as que ja existem)
-- ---------------------------------------------------------------------------

ALTER TABLE alunos ADD COLUMN sexo TEXT;
ALTER TABLE alunos ADD COLUMN data_nascimento TEXT;
ALTER TABLE alunos ADD COLUMN raca_cor TEXT;
ALTER TABLE alunos ADD COLUMN curso TEXT;
ALTER TABLE alunos ADD COLUMN procedencia_modalidade_curso TEXT;
ALTER TABLE alunos ADD COLUMN turma_codigo TEXT;
ALTER TABLE alunos ADD COLUMN telefone TEXT;
ALTER TABLE alunos ADD COLUMN endereco TEXT;
ALTER TABLE alunos ADD COLUMN email TEXT;
ALTER TABLE alunos ADD COLUMN cep TEXT;
ALTER TABLE alunos ADD COLUMN logradouro TEXT;
ALTER TABLE alunos ADD COLUMN numero_endereco TEXT;
ALTER TABLE alunos ADD COLUMN complemento TEXT;
ALTER TABLE alunos ADD COLUMN bairro TEXT;
ALTER TABLE alunos ADD COLUMN cidade TEXT;
ALTER TABLE alunos ADD COLUMN uf TEXT;
ALTER TABLE alunos ADD COLUMN responsavel_nome TEXT;
ALTER TABLE alunos ADD COLUMN responsavel_parentesco TEXT;
ALTER TABLE alunos ADD COLUMN responsavel_telefone TEXT;
ALTER TABLE alunos ADD COLUMN situacao TEXT NOT NULL DEFAULT 'ATIVO';
ALTER TABLE alunos ADD COLUMN atualizado_em TEXT;

-- ---------------------------------------------------------------------------
-- 3. Indices
-- ---------------------------------------------------------------------------

-- A lista da turma e a consulta mais usada (o professor abre a alocacao).
CREATE INDEX IF NOT EXISTS idx_aluno_turma ON alunos (unidade_id, turma);

-- O mesmo nome nao entra duas vezes na mesma turma da mesma escola: e o que
-- deixa a importacao ser repetida sem duplicar a lista. COALESCE porque
-- unidade_id NULL nunca colide com NULL num indice unico comum.
CREATE UNIQUE INDEX IF NOT EXISTS idx_aluno_unico
    ON alunos (COALESCE(unidade_id, 0), turma, nome COLLATE NOCASE);

-- Matricula unica na escola, mas so quando existe: aluno sem matricula e comum
-- e nao pode colidir com outro sem matricula (por isso o indice e parcial).
CREATE UNIQUE INDEX IF NOT EXISTS idx_aluno_matricula
    ON alunos (COALESCE(unidade_id, 0), matricula)
 WHERE matricula IS NOT NULL AND matricula <> '';

-- Consulta do gestor por curso/situacao no painel de alunos.
CREATE INDEX IF NOT EXISTS idx_aluno_curso ON alunos (unidade_id, curso);
CREATE INDEX IF NOT EXISTS idx_aluno_situacao ON alunos (unidade_id, situacao);

-- ---------------------------------------------------------------------------
-- 4. VIEW com os nomes canonicos pedidos
--    (SELECT * FROM vw_alunos -> id, matricula, nome_completo, turma,
--     numero_classe, sexo, data_nascimento, raca_cor,
--     procedencia_modalidade_curso, telefone, endereco, situacao,
--     criado_em, atualizado_em)
-- ---------------------------------------------------------------------------

DROP VIEW IF EXISTS vw_alunos;
CREATE VIEW vw_alunos AS
SELECT
    id,
    matricula,
    nome                          AS nome_completo,
    turma,
    numero                        AS numero_classe,
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
  FROM alunos;
