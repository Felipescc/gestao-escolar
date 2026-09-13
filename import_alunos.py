# -*- coding: utf-8 -*-
"""Importa os alunos das planilhas da secretaria para o cadastro do sistema.

As planilhas ficam na pasta ./alunos e sao as que a secretaria exporta:

    alunos ADM.xls        -> 6 turmas de Administracao   (ADM1IN-A ... ADM3IN-B)
    ALUNOS REDES.xls      -> 3 turmas de Redes           (TRC1IN-U ... TRC3IN-U)
    ALUNOS SISTEMAS.xls   -> 3 turmas de Sistemas        (TDS1IN-U ... TDS3IN-U)

Cada aba e uma turma e tem sempre o mesmo formato:

    linha 1  Alunos das Turmas
    linha 2  ESCOLA TECNICA ESTADUAL JOSE NIVALDO PEREIRA RAMOS - 2026
    linha 3  Ensino Medio - Tecnico em Administracao        <- o curso
    linha 4  1ANO - I - ADM1IN-A                            <- a turma
    linha 6  Matricula | Nome | Data de nascimento | No de classe | Sexo |
             Situacao | Raca/Cor | Procedencia modalidade/curso
    linha 8+ os alunos

O codigo da secretaria ("ADM1IN-A") nao e o nome que o sistema usa na turma. A
grade de aulas — importada de "Horarios_ETE_2026_2sem.xlsx" — chama a mesma
turma de "1o A ADM", e e por esse texto que o professor puxa a lista na hora de
distribuir os computadores. Por isso o script traduz o codigo, e avisa quando a
turma traduzida nao existe na grade: um nome fora do padrao cadastraria alunos
que o professor nunca veria.

E seguro rodar de novo. O aluno e reconhecido pela matricula (unica na escola)
e, quando ela falta, pelo nome dentro da turma. Quem ja existe e atualizado —
inclusive se mudou de turma — em vez de entrar duas vezes.

Quem sumiu da planilha nao e apagado: fica marcado como INATIVO, para o
historico das aulas ja registradas continuar de pe. Use --sem-desativar para
nao mexer nesses.

Telefone e endereco a planilha nao traz: quem digita e o gestor, no painel, e
uma reimportacao nunca apaga o que ele preencheu.

Uso:
    py import_alunos.py                 # mostra o resumo e pede confirmacao
    py import_alunos.py --sim           # importa sem perguntar
    py import_alunos.py --simular       # so le e relata, nao grava nada
    py import_alunos.py --migrar-apenas # so cria as colunas novas (schema.sql)
    py import_alunos.py --pasta OUTRA   # le as planilhas de outra pasta
    py import_alunos.py --unidade "..." # outra escola cadastrada no sistema
"""

import argparse
import os
import re
import shutil
import sqlite3

try:
    import xlrd
except ImportError:                                          # pragma: no cover
    raise SystemExit(
        "Falta a biblioteca xlrd (e ela que le o formato .xls antigo).\n"
        "Rode: pip install xlrd"
    )

import banco

NOME_UNIDADE_PADRAO = "ETE José Nivaldo Pereira Ramos"
PASTA_PADRAO = os.path.join(banco.PASTA_BASE, "alunos")

# Limites das colunas, os mesmos que o painel do gestor aplica (app.py).
LIMITE_NOME = 80
LIMITE_TURMA = 40
LIMITE_MATRICULA = 20

# Sigla da secretaria -> sigla que a grade de aulas usa no nome da turma.
SIGLA_DO_CURSO = {
    "ADM": "ADM",    # Tecnico em Administracao
    "TRC": "RED",    # Tecnico em Redes de Computadores
    "TDS": "SIST",   # Tecnico em Desenvolvimento de Sistemas
}

# "1ANO - I - ADM1IN-A" -> ano 1, curso ADM, turma A
CABECALHO_TURMA = re.compile(
    r"^(?P<ano>\d)\s*ANO\b.*?-\s*(?P<curso>[A-Z]{3})\d[A-Z]*-(?P<letra>[A-Z])\s*$"
)

# O que a secretaria escreve quando o aluno esta na escola. Qualquer outra
# situacao ("Transferido", "Desistente") entra em maiuscula e desativa o aluno.
SITUACAO_MATRICULADO = "matriculado"

# Colunas da aba, base 0.
COL_MATRICULA, COL_NOME, COL_NASCIMENTO, COL_NUMERO = 0, 1, 2, 3
COL_SEXO, COL_SITUACAO, COL_RACA, COL_PROCEDENCIA = 4, 5, 6, 7
LINHA_CURSO, LINHA_TURMA = 2, 3


# --------------------------------------------------------------------------- #
# Leitura das planilhas
# --------------------------------------------------------------------------- #

def planilhas_da_pasta(pasta):
    """Os .xls da pasta, em ordem. Ignora ~$ (arquivo aberto no Excel agora)."""
    if not os.path.isdir(pasta):
        raise SystemExit(f"Pasta nao encontrada: {pasta}")
    achados = sorted(
        os.path.join(pasta, nome) for nome in os.listdir(pasta)
        if nome.lower().endswith((".xls", ".xlsx")) and not nome.startswith("~$")
    )
    if not achados:
        raise SystemExit(f"Nenhuma planilha .xls em {pasta}")
    return achados


def texto(celula):
    """Valor da celula como texto limpo. Inteiro nao vira '4018507.0'."""
    if isinstance(celula, float) and celula.is_integer():
        celula = int(celula)
    return " ".join(str(celula if celula is not None else "").split())


def nome_da_turma(cabecalho):
    """"1ANO - I - ADM1IN-A" -> "1o A ADM", o texto que a grade de aulas usa.

    Devolve None quando o cabecalho foge do padrao: a aba e ignorada com aviso,
    em vez de cadastrar alunos numa turma inventada.
    """
    casamento = CABECALHO_TURMA.match(texto(cabecalho).upper())
    if not casamento:
        return None
    sigla = SIGLA_DO_CURSO.get(casamento.group("curso"))
    if not sigla:
        return None
    return f"{casamento.group('ano')}º {casamento.group('letra')} {sigla}"


def codigo_da_turma(cabecalho):
    """"1ANO - I - ADM1IN-A" -> "ADM1IN-A", o codigo cru da secretaria."""
    pedacos = [pedaco.strip() for pedaco in texto(cabecalho).split("-")]
    if len(pedacos) >= 2:
        return f"{pedacos[-2]}-{pedacos[-1]}"
    return texto(cabecalho)


def achar_cabecalho(aba):
    """A linha em que a tabela comeca: a que abre com "Matricula"."""
    for linha in range(min(aba.nrows, 30)):
        if texto(aba.cell_value(linha, COL_MATRICULA)).lower().startswith("matr"):
            return linha
    return None


def para_data_iso(valor, livro):
    """"28/02/2011" -> "2011-02-28". Aceita tambem a data como numero do Excel."""
    if isinstance(valor, float) and valor > 0:
        ano, mes, dia = xlrd.xldate_as_tuple(valor, livro.datemode)[:3]
        return f"{ano:04d}-{mes:02d}-{dia:02d}"
    bruto = texto(valor)
    casamento = re.match(r"^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$", bruto)
    if casamento:
        dia, mes, ano = (int(parte) for parte in casamento.groups())
        return f"{ano:04d}-{mes:02d}-{dia:02d}"
    if re.match(r"^\d{4}-\d{2}-\d{2}$", bruto):        # ja veio no formato certo
        return bruto
    return None


def para_sexo(valor):
    """Uma letra, M ou F. Qualquer outra coisa fica em branco."""
    letra = texto(valor).upper()[:1]
    return letra if letra in ("M", "F") else None


def para_numero(valor):
    """O numero de chamada como inteiro, ou None quando a turma nao usa."""
    bruto = texto(valor)
    return int(bruto) if bruto.isdigit() else None


def ler_aba(livro, aba, origem):
    """Uma aba -> (turma, avisos, lista de fichas)."""
    avisos = []
    cabecalho = texto(aba.cell_value(LINHA_TURMA, 0)) if aba.nrows > LINHA_TURMA else ""
    curso = texto(aba.cell_value(LINHA_CURSO, 0)) if aba.nrows > LINHA_CURSO else ""
    turma = nome_da_turma(cabecalho)

    if turma is None:
        avisos.append(f'{origem} / aba "{aba.name}": nao entendi a turma no '
                      f'cabecalho ("{cabecalho}"). A aba ficou de fora.')
        return None, avisos, []

    inicio = achar_cabecalho(aba)
    if inicio is None:
        avisos.append(f'{origem} / aba "{aba.name}": nao achei a linha '
                      f'"Matricula". A aba ficou de fora.')
        return turma, avisos, []

    fichas = []
    for linha in range(inicio + 1, aba.nrows):
        celulas = [aba.cell_value(linha, coluna) for coluna in range(aba.ncols)]
        celulas += [""] * (8 - len(celulas))

        nome = banco.texto_limpo(celulas[COL_NOME])[:LIMITE_NOME]
        if not nome:
            continue                       # linha em branco entre paginas
        if texto(celulas[COL_MATRICULA]).lower().startswith("matr"):
            continue                       # cabecalho repetido no meio da aba

        situacao = texto(celulas[COL_SITUACAO])
        matriculado = situacao.lower() == SITUACAO_MATRICULADO
        nascimento = para_data_iso(celulas[COL_NASCIMENTO], livro)
        if celulas[COL_NASCIMENTO] and nascimento is None:
            avisos.append(f'{turma}: nao entendi a data de nascimento de {nome} '
                          f'("{texto(celulas[COL_NASCIMENTO])}"); ficou em branco.')

        fichas.append({
            "matricula": banco.so_digitos_ou_texto(
                celulas[COL_MATRICULA])[:LIMITE_MATRICULA],
            "nome": nome,
            "turma": turma[:LIMITE_TURMA],
            "turma_codigo": codigo_da_turma(cabecalho),
            "numero": para_numero(celulas[COL_NUMERO]),
            "sexo": para_sexo(celulas[COL_SEXO]),
            "data_nascimento": nascimento,
            "raca_cor": texto(celulas[COL_RACA]) or None,
            "procedencia_modalidade_curso": texto(celulas[COL_PROCEDENCIA]) or None,
            "curso": curso or None,
            "situacao": (banco.SITUACAO_ATIVA if matriculado
                         else (situacao.upper() or banco.SITUACAO_ATIVA)),
            "ativo": 1 if matriculado else 0,
            "origem": f"{origem} / {aba.name}",
        })

    if not fichas:
        avisos.append(f'{origem} / aba "{aba.name}": nenhum aluno na aba.')
    return turma, avisos, fichas


def ler_planilhas(caminhos):
    """Todas as planilhas -> (fichas, avisos, quantos alunos por turma)."""
    fichas, avisos, por_turma = [], [], {}
    for caminho in caminhos:
        origem = os.path.basename(caminho)
        try:
            livro = xlrd.open_workbook(caminho)
        except Exception as falha:                           # pragma: no cover
            avisos.append(f"{origem}: nao consegui abrir ({falha}).")
            continue
        for nome_aba in livro.sheet_names():
            turma, novos_avisos, lidas = ler_aba(
                livro, livro.sheet_by_name(nome_aba), origem
            )
            avisos.extend(novos_avisos)
            if turma and lidas:
                por_turma[turma] = por_turma.get(turma, 0) + len(lidas)
            fichas.extend(lidas)
    return fichas, avisos, por_turma


def tirar_repetidos(fichas):
    """Tira quem aparece duas vezes nas proprias planilhas.

    Vale a ultima ocorrencia: se a mesma matricula esta em duas abas, o aluno
    fica na turma da aba lida por ultimo — foi transferido e a lista antiga nao
    foi atualizada. Devolve (fichas, avisos).
    """
    por_chave, avisos = {}, []
    for ficha in fichas:
        chave = (("matricula", ficha["matricula"]) if ficha["matricula"]
                 else ("nome", ficha["turma"], banco.chave_de_nome(ficha["nome"])))
        anterior = por_chave.get(chave)
        if anterior is not None:
            avisos.append(f'{ficha["nome"]} aparece duas vezes nas planilhas '
                          f'({anterior["origem"]} e {ficha["origem"]}); '
                          f'ficou na turma {ficha["turma"]}.')
        por_chave[chave] = ficha
    return list(por_chave.values()), avisos


# --------------------------------------------------------------------------- #
# Gravacao no banco
# --------------------------------------------------------------------------- #

def localizar_unidade(conexao, nome):
    """O id da escola pelo nome, comparando sem acento e sem caixa."""
    procurado = banco.chave_de_nome(nome)
    for linha in conexao.execute("SELECT id, nome FROM unidades ORDER BY id"):
        if banco.chave_de_nome(linha["nome"]) == procurado:
            return linha["id"]
    disponiveis = ", ".join(
        f'"{linha["nome"]}"'
        for linha in conexao.execute("SELECT nome FROM unidades ORDER BY id")
    )
    raise SystemExit(f'A escola "{nome}" nao existe no sistema. Ha: {disponiveis}')


def turmas_da_grade(conexao, unidade_id):
    """As turmas que a grade de aulas conhece — o destino valido de uma lista."""
    return {
        linha["turma"] for linha in conexao.execute(
            "SELECT DISTINCT turma FROM aulas_grade "
            "WHERE unidade_id IS ? AND turma IS NOT NULL AND turma <> ''",
            (unidade_id,),
        )
    }


def cadastro_atual(conexao, unidade_id):
    """Os alunos ja cadastrados, indexados por matricula e por turma+nome."""
    linhas = conexao.execute(
        "SELECT * FROM alunos WHERE unidade_id IS ?", (unidade_id,)
    ).fetchall()
    por_matricula, por_nome = {}, {}
    for linha in linhas:
        matricula = banco.so_digitos_ou_texto(linha["matricula"])
        if matricula:
            por_matricula[matricula] = linha
        por_nome[(linha["turma"], banco.chave_de_nome(linha["nome"]))] = linha
    return linhas, por_matricula, por_nome


# As colunas que a planilha preenche, na ordem usada no INSERT e no UPDATE.
# Telefone e endereco ficam de fora de proposito: sao do gestor.
CAMPOS = (
    "nome", "turma", "numero", "matricula", "sexo", "data_nascimento",
    "raca_cor", "curso", "procedencia_modalidade_curso", "turma_codigo",
    "situacao", "ativo",
)


def valor_gravado(ficha, existente, campo):
    """O que vai para a coluna. Matricula em branco nao apaga a que ja existe."""
    novo = ficha[campo]
    if campo == "ativo":
        return novo
    if campo == "matricula" and not novo and existente is not None:
        return existente["matricula"]
    return novo or None


def mudou(linha, ficha):
    """O cadastro ja diz o mesmo que a planilha?"""
    for campo in CAMPOS:
        if campo == "matricula" and not ficha[campo]:
            continue
        atual = linha[campo] if campo in linha.keys() else None
        novo = ficha[campo]
        if campo == "ativo":
            if int(atual or 0) != int(novo):
                return True
            continue
        if (atual or None) != (novo or None):
            return True
    return False


def sincronizar(conexao, fichas, unidade_id, desativar_ausentes=True):
    """Grava as fichas lidas e devolve o relatorio do que mudou."""
    _, por_matricula, por_nome = cadastro_atual(conexao, unidade_id)
    agora = banco.agora()
    relatorio = {"novos": [], "atualizados": [], "iguais": 0,
                 "mudaram_de_turma": [], "desativados": [], "conflitos": [],
                 "renomeados": []}
    vistos = set()

    for ficha in fichas:
        matricula = ficha["matricula"]
        chave_nome = banco.chave_de_nome(ficha["nome"])
        pela_matricula = por_matricula.get(matricula) if matricula else None
        pelo_nome = por_nome.get((ficha["turma"], chave_nome))

        # Os dois casamentos apontam para pessoas diferentes: a planilha diz que
        # a matricula e deste aluno, mas ela ja e de outro que continua na
        # escola. E contradicao, e nao da para adivinhar qual lado esta certo —
        # entao vale o nome (mesma turma, mesma pessoa), a matricula fica como
        # esta e o caso vai para o relatorio, para o gestor conferir na
        # secretaria. Sem isso o UPDATE tentaria dar o mesmo nome a dois alunos
        # da turma e derrubaria a importacao inteira no indice unico.
        if (pela_matricula is not None and pelo_nome is not None
                and pela_matricula["id"] != pelo_nome["id"]):
            relatorio["conflitos"].append(
                f'{ficha["nome"]} ({ficha["turma"]}): a matricula {matricula} '
                f'ja e de {pela_matricula["nome"]}; o aluno ficou com a '
                f'matricula que ja tinha.'
            )
            ficha = dict(ficha, matricula="")
            matricula = ""
            existente = pelo_nome
        else:
            # A matricula e o documento do aluno na escola: quando ela casa, e a
            # mesma pessoa mesmo que o nome esteja escrito diferente — a
            # planilha corrige o cadastro. A troca fica anotada, porque nome
            # trocado em matricula certa tambem e sintoma de erro de digitacao.
            existente = pela_matricula if pela_matricula is not None else pelo_nome
            if (pela_matricula is not None
                    and banco.chave_de_nome(pela_matricula["nome"]) != chave_nome):
                relatorio["renomeados"].append(
                    f'matricula {matricula}: "{pela_matricula["nome"]}" '
                    f'-> "{ficha["nome"]}"'
                )

        if existente is None:
            colunas = ", ".join(CAMPOS)
            marcas = ", ".join("?" * len(CAMPOS))
            # As travas de unicidade do banco sao a ultima palavra: se ainda
            # assim uma linha esbarrar em alguma, ela vai para o relatorio e a
            # importacao segue — 470 alunos nao param por causa de um.
            try:
                cursor = conexao.execute(
                    f"INSERT INTO alunos ({colunas}, unidade_id, criado_em, "
                    f"atualizado_em) VALUES ({marcas}, ?, ?, ?)",
                    (*(valor_gravado(ficha, None, campo) for campo in CAMPOS),
                     unidade_id, agora, agora),
                )
            except sqlite3.IntegrityError as falha:
                relatorio["conflitos"].append(
                    f'{ficha["nome"]} ({ficha["turma"]}) nao entrou: {falha}.'
                )
                continue
            criado = conexao.execute(
                "SELECT * FROM alunos WHERE id = ?", (cursor.lastrowid,)
            ).fetchone()
            if matricula:
                por_matricula[matricula] = criado
            por_nome[(ficha["turma"], chave_nome)] = criado
            vistos.add(cursor.lastrowid)
            relatorio["novos"].append(f'{ficha["turma"]} · {ficha["nome"]}')
            continue

        vistos.add(existente["id"])
        if not mudou(existente, ficha):
            relatorio["iguais"] += 1
            continue

        if existente["turma"] != ficha["turma"]:
            relatorio["mudaram_de_turma"].append(
                f'{ficha["nome"]}: {existente["turma"]} -> {ficha["turma"]}'
            )
        atribuicoes = ", ".join(f"{campo} = ?" for campo in CAMPOS)
        try:
            conexao.execute(
                f"UPDATE alunos SET {atribuicoes}, atualizado_em = ? WHERE id = ?",
                (*(valor_gravado(ficha, existente, campo) for campo in CAMPOS),
                 agora, existente["id"]),
            )
        except sqlite3.IntegrityError as falha:
            relatorio["conflitos"].append(
                f'{ficha["nome"]} ({ficha["turma"]}) nao foi atualizado: {falha}.'
            )
            continue
        # o indice em memoria acompanha a linha que acabou de mudar de turma,
        # senao uma segunda ficha do mesmo aluno no mesmo lote nao a acharia
        por_nome[(ficha["turma"], chave_nome)] = existente
        relatorio["atualizados"].append(f'{ficha["turma"]} · {ficha["nome"]}')

    if desativar_ausentes:
        # so mexe nas turmas que vieram na planilha: turma que nao foi importada
        # agora nao pode ter a lista desligada por tabela
        turmas = {ficha["turma"] for ficha in fichas}
        linhas, _, _ = cadastro_atual(conexao, unidade_id)
        for linha in linhas:
            if (linha["id"] in vistos or linha["turma"] not in turmas
                    or not linha["ativo"]):
                continue
            conexao.execute(
                "UPDATE alunos SET ativo = 0, situacao = 'INATIVO', "
                "atualizado_em = ? WHERE id = ?",
                (agora, linha["id"]),
            )
            relatorio["desativados"].append(f'{linha["turma"]} · {linha["nome"]}')

    return relatorio


# --------------------------------------------------------------------------- #
# Linha de comando
# --------------------------------------------------------------------------- #

def fazer_backup():
    if not os.path.exists(banco.CAMINHO_BANCO):
        return None
    destino = banco.CAMINHO_BANCO + ".antes-import-alunos.bak"
    shutil.copy2(banco.CAMINHO_BANCO, destino)
    return destino


def listar(titulo, itens, limite=12):
    if not itens:
        return
    print(f"\n{titulo} ({len(itens)}):")
    for item in itens[:limite]:
        print(f"  - {item}")
    if len(itens) > limite:
        print(f"  ... e mais {len(itens) - limite}.")


def montar_argumentos():
    analisador = argparse.ArgumentParser(
        description="Importa os alunos das planilhas .xls para o sistema."
    )
    analisador.add_argument("--pasta", default=PASTA_PADRAO,
                            help="pasta com as planilhas (padrao: ./alunos)")
    analisador.add_argument("--unidade", default=NOME_UNIDADE_PADRAO,
                            help="escola que recebe os alunos")
    analisador.add_argument("--sim", action="store_true",
                            help="importa sem pedir confirmacao")
    analisador.add_argument("--simular", action="store_true",
                            help="le e relata, mas nao grava nada")
    analisador.add_argument("--migrar-apenas", action="store_true",
                            help="so cria as colunas novas da ficha e sai")
    analisador.add_argument("--sem-desativar", action="store_true",
                            help="nao marca como inativo quem sumiu da planilha")
    return analisador.parse_args()


def main():
    opcoes = montar_argumentos()
    conexao = banco.conectar()
    try:
        # `banco.migrar` faz o mesmo que schema.sql, pulando o que ja existe
        banco.migrar(conexao)
        conexao.commit()
        if opcoes.migrar_apenas:
            caminho = os.path.relpath(banco.CAMINHO_BANCO, banco.PASTA_BASE)
            print(f"Colunas da ficha do aluno conferidas em {caminho}.")
            return

        caminhos = planilhas_da_pasta(opcoes.pasta)
        fichas, avisos, por_turma = ler_planilhas(caminhos)
        fichas, repetidos = tirar_repetidos(fichas)
        avisos.extend(repetidos)

        print(f"Planilhas em {os.path.relpath(opcoes.pasta, banco.PASTA_BASE)}:")
        for caminho in caminhos:
            print(f"  - {os.path.basename(caminho)}")
        print(f"\n{len(fichas)} aluno(s) em {len(por_turma)} turma(s):")
        for turma in sorted(por_turma):
            print(f"  {turma:<12} {por_turma[turma]:>3} aluno(s)")

        if not fichas:
            raise SystemExit("\nNada para importar.")

        unidade_id = localizar_unidade(conexao, opcoes.unidade)
        conhecidas = turmas_da_grade(conexao, unidade_id)
        fora = sorted(set(por_turma) - conhecidas) if conhecidas else []
        if fora:
            print(f'\nEstas turmas nao aparecem na grade de aulas de '
                  f'"{opcoes.unidade}": {", ".join(fora)}.')
            print("O professor nao acharia a lista delas na alocação dos "
                  "computadores. Confira a grade no painel do gestor (Horários) "
                  "ou importe assim mesmo e ajuste depois.")

        listar("Avisos", avisos)

        if opcoes.simular:
            print("\n--simular: nada foi gravado.")
            return

        print(f'\nOs alunos vao para a escola "{opcoes.unidade}". Quem ja esta '
              f"cadastrado e atualizado, nao duplicado.")
        if not opcoes.sem_desativar:
            print("Aluno da mesma turma que nao aparece mais na planilha fica "
                  "INATIVO (nao e apagado).")

        if not opcoes.sim:
            if input("\nDigite 'sim' para continuar: ").strip().lower() != "sim":
                print("Cancelado.")
                return

        copia = fazer_backup()
        if copia:
            print(f"\n- Backup do banco em {os.path.basename(copia)}")

        relatorio = sincronizar(conexao, fichas, unidade_id,
                                desativar_ausentes=not opcoes.sem_desativar)
        conexao.commit()

        print("\nPronto:")
        print(f"  {len(relatorio['novos'])} cadastrado(s)")
        print(f"  {len(relatorio['atualizados'])} atualizado(s)")
        print(f"  {relatorio['iguais']} ja estava(m) em dia")
        listar("Mudaram de turma", relatorio["mudaram_de_turma"])
        listar("Nome mudou (mesma matrícula)", relatorio["renomeados"])
        listar("Desativados (sumiram da planilha)", relatorio["desativados"])
        listar("Matrículas em conflito (entraram sem matrícula)",
               relatorio["conflitos"])
        print("\nConfira no painel do gestor, aba Alunos. O professor ve a lista "
              "ao distribuir os computadores do laboratório.")
    finally:
        conexao.close()


if __name__ == "__main__":
    main()
