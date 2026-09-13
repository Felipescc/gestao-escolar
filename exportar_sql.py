"""Exporta dados/escola.db para dados/escola.sql, em texto legivel.

Diferente do dados/escola.db.enc (copia cifrada, para restaurar o sistema),
este arquivo existe para ser lido: da para abrir tabela por tabela e conferir
o que esta gravado sem precisar de um leitor de SQLite.

ATENCAO -- este arquivo NAO vai para o Git (veja o .gitignore). Ele traz nome
completo, data de nascimento, raca/cor, endereco, telefone, e-mail e
responsavel de cada aluno. Sao dados pessoais de menores, e o que entra num
repositorio fica no historico para sempre. Ele e para uso local.

Uso:
    python exportar_sql.py

O que NAO entra: as senhas. `professores.senha_hash`, `gestores.senha_hash` e
a chave `senha_gerente_hash` da tabela `config` saem como NULL, porque um
arquivo aberto no Git nao e lugar para hash de senha — mesmo sendo hash, ele
serve de ponto de partida para quebra fora do sistema. Qualquer chave de
`config` com "senha" no nome tambem e omitida, o que cobre a senha do SMTP
quando a escola configurar o envio de e-mail.

Por isso, restaurar a escola a partir deste arquivo deixa todo mundo sem
senha: as contas precisam de senha nova (o gestor faz isso em "Senha e
envio"). Para uma copia completa, use o escola.db.enc — veja
criptografar_dados.py e descriptografar_dados.py.
"""

import os
import sqlite3

PASTA_DADOS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dados")
CAMINHO_BANCO = os.path.join(PASTA_DADOS, "escola.db")
CAMINHO_SQL = os.path.join(PASTA_DADOS, "escola.sql")

# Colunas que saem como NULL no arquivo aberto.
COLUNAS_OMITIDAS = {
    ("professores", "senha_hash"),
    ("gestores", "senha_hash"),
}

# Linhas de `config` cuja chave tem isto no nome saem com o valor omitido.
CHAVES_OMITIDAS = ("senha",)

AVISO = """-- Exportado por exportar_sql.py — NAO edite a mao.
--
-- Copia legivel do banco, para consulta e para o diff do Git mostrar o que
-- mudou. As senhas nao estao aqui (veja o cabecalho de exportar_sql.py):
-- restaurar a escola so com este arquivo deixa as contas sem senha.
--
-- Para uma copia completa, use dados/escola.db.enc.
"""


def como_sql(valor):
    """Valor Python no formato que o SQLite entende dentro de um INSERT."""
    if valor is None:
        return "NULL"
    if isinstance(valor, bool):
        return "1" if valor else "0"
    if isinstance(valor, (int, float)):
        return repr(valor)
    if isinstance(valor, bytes):
        return "X'" + valor.hex() + "'"
    return "'" + str(valor).replace("'", "''") + "'"


def valor_da_linha(tabela, coluna, linha, obrigatorias):
    """O valor que vai para o arquivo, ja aplicando as omissoes.

    Coluna omitida vira NULL, menos quando ela e NOT NULL — ai vai string
    vazia, senao o arquivo nao voltaria para dentro de um banco novo.
    """
    omitir = (tabela, coluna) in COLUNAS_OMITIDAS
    if not omitir and tabela == "config" and coluna == "valor":
        chave = str(linha["chave"]).lower()
        omitir = any(pedaco in chave for pedaco in CHAVES_OMITIDAS)

    if omitir:
        return "" if coluna in obrigatorias else None
    return linha[coluna]


def exportar():
    if not os.path.exists(CAMINHO_BANCO):
        raise SystemExit(f"Banco nao encontrado: {CAMINHO_BANCO}")

    conexao = sqlite3.connect(CAMINHO_BANCO)
    conexao.row_factory = sqlite3.Row
    partes = [AVISO, "\nBEGIN TRANSACTION;\n"]

    objetos = conexao.execute(
        "SELECT name, type, sql FROM sqlite_master "
        "WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL "
        "ORDER BY CASE type WHEN 'table' THEN 1 ELSE 2 END, name"
    ).fetchall()

    tabelas = [obj["name"] for obj in objetos if obj["type"] == "table"]
    for tabela in tabelas:
        criacao = next(o["sql"] for o in objetos if o["name"] == tabela)
        info = conexao.execute(f'PRAGMA table_info("{tabela}")').fetchall()
        colunas = [c["name"] for c in info]
        obrigatorias = {c["name"] for c in info if c["notnull"]}
        linhas = conexao.execute(
            f'SELECT * FROM "{tabela}" ORDER BY rowid'   # ordem fixa: diff limpo
        ).fetchall()

        partes.append(f"\n-- {tabela}: {len(linhas)} linha(s)\n")
        partes.append(criacao.strip() + ";\n")
        for linha in linhas:
            valores = ", ".join(
                como_sql(valor_da_linha(tabela, coluna, linha, obrigatorias))
                for coluna in colunas
            )
            nomes = ", ".join(f'"{coluna}"' for coluna in colunas)
            partes.append(f'INSERT INTO "{tabela}" ({nomes}) VALUES ({valores});\n')

    # indices e gatilhos depois das tabelas, senao apontam para o que nao existe
    for obj in objetos:
        if obj["type"] != "table":
            partes.append(obj["sql"].strip() + ";\n")

    partes.append("\nCOMMIT;\n")
    conexao.close()

    with open(CAMINHO_SQL, "w", encoding="utf-8", newline="\n") as arquivo:
        arquivo.write("".join(partes))

    total = sum(1 for parte in partes if parte.startswith("INSERT"))
    print(f"Exportado: {CAMINHO_SQL}")
    print(f"  {len(tabelas)} tabela(s), {total} linha(s)")
    print("  senhas omitidas (veja o cabecalho do arquivo)")


if __name__ == "__main__":
    exportar()
