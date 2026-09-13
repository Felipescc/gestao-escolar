"""Importa os horarios e a grade de aulas da ETE Jose Nivaldo Pereira Ramos a
partir da planilha "Horarios_ETE_2026_2sem.xlsx".

A planilha e a fonte da verdade. Sao lidas duas abas:

  - "Horario por Professor" -> a lista de professores (inclusive quem esta sem
    aula nenhuma no semestre, como FERNANDO);
  - "Lista de Aulas"        -> uma linha por aula, com professor, dia, numero da
    aula, horario, turno, turma e disciplina.

Os 9 horarios da escola (5 de manha, 4 a tarde) nao ficam escritos aqui: sao
deduzidos das proprias colunas "Aula"/"Horario"/"Turno" da planilha.

"LACUNA QUIMICA" nao e professor — e uma vaga de Quimica ainda sem docente no
documento original — entao as aulas dela ficam de fora da grade.

O que o script faz na unidade "ETE Jose Nivaldo Pereira Ramos":

  1. Recria os horarios da escola conforme a planilha (isso apaga em cascata as
     reservas de laboratorio feitas nos horarios antigos).
  2. Desativa os professores de exemplo que vem prontos no sistema.
  3. Cadastra os professores da planilha (sem e-mail/senha — ficam com a
     etiqueta "Sem senha" ate o gestor liberar o acesso de cada um) e preenche a
     disciplina de quem ainda nao tem, com a que ele mais leciona.
  4. Apaga a grade de aulas da unidade e importa a da planilha.
  5. Garante uma sala de aula cadastrada para cada turma. A planilha nao diz em
     que sala cada aula acontece, entao as aulas entram sem sala e o gestor
     distribui pelo painel (Horarios > Salas).

Nada disso mexe no sistema de reserva de laboratorio: laboratorios, regras e
reservas continuam como estao.

E seguro rodar de novo: professores sao identificados pelo nome e a grade e
sempre reconstruida do zero.

Uso:
    py importar_horario_2026.py            # pede confirmacao
    py importar_horario_2026.py --sim      # sem perguntar
"""

import os
import re
import shutil
import sys
import unicodedata
from collections import Counter

try:
    import openpyxl
except ImportError:                                          # pragma: no cover
    raise SystemExit("Falta a biblioteca openpyxl. Rode: pip install openpyxl")

import banco

NOME_UNIDADE = "ETE José Nivaldo Pereira Ramos"
CAMINHO_PLANILHA = os.path.join(banco.PASTA_BASE, "Horarios_ETE_2026_2sem.xlsx")

ABA_PROFESSORES = "Horário por Professor"
ABA_AULAS = "Lista de Aulas"

PROFESSORES_EXEMPLO_A_DESATIVAR = [
    "Ana Beatriz Moraes", "Carlos Henrique Lima", "Daniela Prado", "Eduardo Ramos",
]

# Vagas sem docente que aparecem na planilha como se fossem professor.
NAO_SAO_PROFESSORES = {"lacuna quimica"}

DIAS = {"segunda": 0, "terca": 1, "quarta": 2, "quinta": 3, "sexta": 4}
TURNOS = {"manha": "manha", "tarde": "tarde", "noite": "noite"}


def sem_acento(texto):
    """"JOÃO PAULO" -> "joao paulo" (para comparar nomes vindos de fontes diferentes)."""
    limpo = unicodedata.normalize("NFKD", str(texto or "")).encode("ascii", "ignore").decode()
    return re.sub(r"\s+", " ", limpo).strip().lower()


def nome_de_exibicao(nome):
    """"PAULO SÉRGIO" -> "Paulo Sérgio" (a planilha vem toda em maiuscula)."""
    return re.sub(r"\s+", " ", str(nome or "").strip()).title()


# --------------------------------------------------------------------------- #
# Leitura da planilha
# --------------------------------------------------------------------------- #

def abrir_planilha():
    if not os.path.exists(CAMINHO_PLANILHA):
        raise SystemExit(f"Planilha não encontrada: {CAMINHO_PLANILHA}")
    return openpyxl.load_workbook(CAMINHO_PLANILHA, data_only=True)


def aba(planilha, titulo):
    """Acha a aba pelo nome ignorando acento e caixa (o Excel guarda o titulo cru)."""
    alvo = sem_acento(titulo)
    for nome in planilha.sheetnames:
        if sem_acento(nome) == alvo:
            return planilha[nome]
    raise SystemExit(f'Aba "{titulo}" não encontrada. Abas: {planilha.sheetnames}')


def ler_professores(planilha):
    """Nomes da aba "Horario por Professor", na ordem em que aparecem."""
    nomes = []
    for linha in aba(planilha, ABA_PROFESSORES).iter_rows(values_only=True):
        primeira = linha[0]
        if not isinstance(primeira, str) or not primeira.startswith("Professor(a):"):
            continue
        nome = primeira.split(":", 1)[1].strip()
        if nome and sem_acento(nome) not in NAO_SAO_PROFESSORES:
            nomes.append(nome)
    if not nomes:
        raise SystemExit(f'Nenhum professor lido na aba "{ABA_PROFESSORES}".')
    return nomes


def ler_aulas(planilha):
    """Aulas da aba "Lista de Aulas" + os horarios deduzidos dela.

    Devolve (aulas, horarios, ignoradas):
      aulas    - lista de dicts {professor, dia_semana, aula, turma, disciplina}
      horarios - {numero da aula: (turno, ordem, inicio, fim)}
      ignoradas- quantas linhas eram de vaga sem docente
    """
    linhas = aba(planilha, ABA_AULAS).iter_rows(min_row=2, values_only=True)
    aulas = []
    horarios = {}
    ignoradas = 0

    for numero_linha, linha in enumerate(linhas, start=2):
        professor, dia, aula, faixa, turno, turma, disciplina = (list(linha) + [None] * 7)[:7]
        if not professor:
            continue
        if sem_acento(professor) in NAO_SAO_PROFESSORES:
            ignoradas += 1
            continue

        dia_semana = DIAS.get(sem_acento(dia))
        if dia_semana is None:
            raise SystemExit(f"Linha {numero_linha} da aba \"{ABA_AULAS}\": "
                             f"dia da semana desconhecido ({dia!r}).")
        try:
            aula = int(aula)
        except (TypeError, ValueError):
            raise SystemExit(f"Linha {numero_linha} da aba \"{ABA_AULAS}\": "
                             f"número da aula inválido ({aula!r}).")

        casamento = re.fullmatch(r"\s*(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})\s*",
                                 str(faixa or ""))
        if not casamento:
            raise SystemExit(f"Linha {numero_linha} da aba \"{ABA_AULAS}\": "
                             f"horário inválido ({faixa!r}).")
        inicio, fim = casamento.group(1), casamento.group(2)

        chave_turno = TURNOS.get(sem_acento(turno))
        if chave_turno is None:
            raise SystemExit(f"Linha {numero_linha} da aba \"{ABA_AULAS}\": "
                             f"turno desconhecido ({turno!r}).")

        anterior = horarios.get(aula)
        if anterior is None:
            horarios[aula] = (chave_turno, inicio, fim)
        elif anterior != (chave_turno, inicio, fim):
            raise SystemExit(f"Linha {numero_linha} da aba \"{ABA_AULAS}\": a aula {aula} "
                             f"aparece como {anterior} e como "
                             f"{(chave_turno, inicio, fim)} na planilha.")

        aulas.append({
            "professor": str(professor).strip(),
            "dia_semana": dia_semana,
            "aula": aula,
            "turma": str(turma or "").strip(),
            "disciplina": str(disciplina or "").strip(),
        })

    if not aulas:
        raise SystemExit(f'Nenhuma aula lida na aba "{ABA_AULAS}".')

    # a ordem dentro do turno vem da sequencia das aulas (1..5 manha, 6..9 tarde)
    numerados = {}
    contador = Counter()
    for numero in sorted(horarios):
        turno, inicio, fim = horarios[numero]
        contador[turno] += 1
        numerados[numero] = (turno, contador[turno], inicio, fim)

    return aulas, numerados, ignoradas


# --------------------------------------------------------------------------- #
# Gravacao no banco
# --------------------------------------------------------------------------- #

def localizar_unidade(conexao):
    linha = conexao.execute(
        "SELECT id FROM unidades WHERE nome = ?", (NOME_UNIDADE,)
    ).fetchone()
    if linha is None:
        raise SystemExit(f'Unidade "{NOME_UNIDADE}" não encontrada no banco.')
    return linha["id"]


def substituir_horarios(conexao, unidade_id, horarios):
    """Recria os horarios da unidade. Reservas nos horarios antigos vao junto."""
    antigos = conexao.execute(
        "SELECT id FROM horarios WHERE unidade_id = ?", (unidade_id,)
    ).fetchall()
    reservas = conexao.execute(
        "SELECT COUNT(*) c FROM reservas WHERE horario_id IN "
        "(SELECT id FROM horarios WHERE unidade_id = ?)", (unidade_id,)
    ).fetchone()["c"]
    # a grade e as reservas apontam para `horarios`, entao caem em cascata junto
    grade = conexao.execute(
        "SELECT COUNT(*) c FROM aulas_grade WHERE horario_id IN "
        "(SELECT id FROM horarios WHERE unidade_id = ?)", (unidade_id,)
    ).fetchone()["c"]

    print(f"- Apagando {len(antigos)} horário(s) antigo(s) — junto vão "
          f"{reservas} reserva(s) e {grade} aula(s) da grade anterior.")
    conexao.execute("DELETE FROM horarios WHERE unidade_id = ?", (unidade_id,))

    ids_por_aula = {}
    for numero in sorted(horarios):
        turno, ordem, inicio, fim = horarios[numero]
        cursor = conexao.execute(
            "INSERT INTO horarios (turno, ordem, inicio, fim, unidade_id) "
            "VALUES (?, ?, ?, ?, ?)",
            (turno, ordem, inicio, fim, unidade_id),
        )
        ids_por_aula[numero] = cursor.lastrowid

    resumo = Counter(turno for turno, _, _, _ in horarios.values())
    detalhe = ", ".join(f"{quantidade} de {banco.ROTULO_TURNO.get(turno, turno).lower()}"
                        for turno, quantidade in resumo.most_common())
    print(f"- Criados {len(horarios)} horários da planilha ({detalhe}).")
    return ids_por_aula


def desativar_exemplos(conexao, unidade_id):
    total = 0
    for nome in PROFESSORES_EXEMPLO_A_DESATIVAR:
        total += conexao.execute(
            "UPDATE professores SET ativo = 0 WHERE nome = ? AND unidade_id = ?",
            (nome, unidade_id),
        ).rowcount
    print(f"- Desativados {total} professor(es) de exemplo.")


def sincronizar_professores(conexao, unidade_id, nomes):
    """Cadastra quem falta e devolve {nome normalizado: id}."""
    existentes = {
        sem_acento(linha["nome"]): linha["id"]
        for linha in conexao.execute(
            "SELECT id, nome FROM professores WHERE unidade_id = ?", (unidade_id,))
    }

    ids = {}
    novos = 0
    for nome in nomes:
        chave = sem_acento(nome)
        if chave in existentes:
            ids[chave] = existentes[chave]
            # quem estava desativado por engano volta a ativo: esta na planilha
            conexao.execute("UPDATE professores SET ativo = 1 WHERE id = ?", (ids[chave],))
            continue
        cursor = conexao.execute(
            "INSERT INTO professores (nome, matricula, unidade_id, ativo, criado_em) "
            "VALUES (?, ?, ?, 1, ?)",
            (nome_de_exibicao(nome), banco.gerar_matricula(conexao), unidade_id, banco.agora()),
        )
        ids[chave] = cursor.lastrowid
        novos += 1

    print(f"- {novos} professor(es) novo(s) cadastrado(s) "
          f"({len(nomes) - novos} já existiam).")
    return ids


def importar_grade(conexao, unidade_id, aulas, ids_por_aula, ids_professor):
    """Apaga a grade da unidade e regrava a da planilha. Sala fica para o gestor."""
    # a troca de horarios ja levou a grade em cascata; isto limpa o que por acaso
    # tenha sobrado apontando para horario de outra unidade
    conexao.execute(
        "DELETE FROM aulas_grade WHERE unidade_id = ? OR professor_id IN "
        "(SELECT id FROM professores WHERE unidade_id = ?)",
        (unidade_id, unidade_id),
    )

    gravadas = 0
    for item in aulas:
        professor_id = ids_professor[sem_acento(item["professor"])]
        conexao.execute(
            "INSERT INTO aulas_grade (professor_id, dia_semana, horario_id, turma, "
            "disciplina, sala_id, unidade_id, criado_em) "
            "VALUES (?, ?, ?, ?, ?, NULL, ?, ?)",
            (professor_id, item["dia_semana"], ids_por_aula[item["aula"]],
             item["turma"], item["disciplina"], unidade_id, banco.agora()),
        )
        gravadas += 1
    print(f"- {gravadas} aula(s) importada(s) na grade.")


def preencher_disciplinas(conexao, aulas, ids_professor):
    """Quem esta sem disciplina no cadastro recebe a que mais leciona na grade."""
    por_professor = {}
    for item in aulas:
        if item["disciplina"]:
            por_professor.setdefault(sem_acento(item["professor"]), Counter())[
                item["disciplina"]] += 1

    total = 0
    for chave, contagem in por_professor.items():
        professor_id = ids_professor[chave]
        atual = conexao.execute(
            "SELECT disciplina FROM professores WHERE id = ?", (professor_id,)
        ).fetchone()["disciplina"]
        if (atual or "").strip():
            continue
        conexao.execute(
            "UPDATE professores SET disciplina = ? WHERE id = ?",
            (contagem.most_common(1)[0][0], professor_id),
        )
        total += 1
    print(f"- Disciplina preenchida em {total} cadastro(s) que estavam sem.")


def garantir_salas(conexao, unidade_id, quantidade):
    """Uma sala de aula por turma, para o gestor ter o que distribuir na grade."""
    ja_tem = conexao.execute(
        "SELECT COUNT(*) c FROM salas WHERE unidade_id = ?", (unidade_id,)
    ).fetchone()["c"]
    if ja_tem >= quantidade:
        print(f"- {ja_tem} sala(s) de aula já cadastrada(s); nenhuma criada.")
        return

    nomes = {
        linha["nome"] for linha in
        conexao.execute("SELECT nome FROM salas WHERE unidade_id = ?", (unidade_id,))
    }
    criadas = 0
    numero = 1
    while ja_tem + criadas < quantidade:
        nome = f"Sala {numero:02d}"
        numero += 1
        if nome in nomes:
            continue
        conexao.execute(
            "INSERT INTO salas (nome, capacidade, observacoes, unidade_id, ativo, criado_em) "
            "VALUES (?, 35, '', ?, 1, ?)",
            (nome, unidade_id, banco.agora()),
        )
        criadas += 1
    print(f"- {criadas} sala(s) de aula criada(s) (total {quantidade}, uma por turma).")


def fazer_backup():
    if not os.path.exists(banco.CAMINHO_BANCO):
        return None
    destino = banco.CAMINHO_BANCO + ".antes-importacao.bak"
    shutil.copy2(banco.CAMINHO_BANCO, destino)
    return destino


def main():
    planilha = abrir_planilha()
    nomes = ler_professores(planilha)
    aulas, horarios, ignoradas = ler_aulas(planilha)
    turmas = {item["turma"] for item in aulas if item["turma"]}

    print(f'Planilha: {os.path.basename(CAMINHO_PLANILHA)}')
    print(f"  {len(nomes)} professores, {len(horarios)} horários, "
          f"{len(aulas)} aulas, {len(turmas)} turmas.")
    if ignoradas:
        print(f"  {ignoradas} aula(s) de vaga sem docente ficaram de fora "
              f"({', '.join(sorted(NAO_SAO_PROFESSORES))}).")

    print(f'\nIsso vai substituir os dados da unidade "{NOME_UNIDADE}":')
    print("  1. Recriar os horários da escola (as reservas de laboratório feitas "
          "nos horários antigos são apagadas junto).")
    print(f"  2. Desativar os professores de exemplo: "
          f"{', '.join(PROFESSORES_EXEMPLO_A_DESATIVAR)}.")
    print("  3. Cadastrar os professores da planilha que ainda não existem.")
    print("  4. Apagar a grade de aulas atual e importar a da planilha.")
    print("  5. Cadastrar salas de aula (uma por turma), sem distribuir as aulas.")
    print("\nLaboratórios, regras e reservas futuras em horários mantidos não são tocados.")

    if "--sim" not in sys.argv:
        if input("\nDigite 'sim' para continuar: ").strip().lower() != "sim":
            print("Cancelado.")
            return

    copia = fazer_backup()
    if copia:
        print(f"\n- Backup do banco em {os.path.basename(copia)}")

    conexao = banco.conectar()
    try:
        unidade_id = localizar_unidade(conexao)
        ids_por_aula = substituir_horarios(conexao, unidade_id, horarios)
        desativar_exemplos(conexao, unidade_id)
        ids_professor = sincronizar_professores(conexao, unidade_id, nomes)
        importar_grade(conexao, unidade_id, aulas, ids_por_aula, ids_professor)
        preencher_disciplinas(conexao, aulas, ids_professor)
        garantir_salas(conexao, unidade_id, len(turmas))
        conexao.commit()
        print("\nPronto. Confira no painel do gestor (Professores, Horários e Salas).")
    finally:
        conexao.close()


if __name__ == "__main__":
    main()
