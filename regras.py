"""Motor de regras de reserva (a parte do questionario chamada de "coracao do sistema").

Todas as regras leem seus parametros da tabela `config`, entao o gestor local
consegue mudar o comportamento do sistema sem mexer no codigo.
"""

from datetime import date, datetime, timedelta

import banco

# Status que contam como "o laboratorio foi ocupado por esse professor".
STATUS_OCUPA = ("ativa", "realizada", "falta")
STATUS_VALIDOS = ("ativa", "realizada", "falta", "cancelada")

TIPOS_AULA = ("Prática", "Teórica", "Avaliação", "Apresentação", "Reforço", "Outro")


def para_data(valor):
    """Converte 'AAAA-MM-DD' (ou date/datetime) em objeto date."""
    if isinstance(valor, date) and not isinstance(valor, datetime):
        return valor
    if isinstance(valor, datetime):
        return valor.date()
    return datetime.strptime(str(valor).strip()[:10], "%Y-%m-%d").date()


def formatar_br(valor):
    d = para_data(valor)
    return d.strftime("%d/%m/%Y")


def hora_agora():
    """Hora do relogio no formato "HH:MM", do mesmo jeito que fica em `horarios`."""
    return datetime.now().strftime("%H:%M")


def aula_ja_comecou(horario_inicio, data_alvo, agora=None):
    """A aula ja comecou (ou acabou)? Vale para hoje; ontem e sempre passado.

    Os horarios sao texto "HH:MM" zero a esquerda, entao a comparacao direta de
    texto ja da a ordem certa das horas.
    """
    dia = para_data(data_alvo)
    hoje = date.today()
    if dia != hoje:
        return dia < hoje
    return str(horario_inicio) <= (agora or hora_agora())


# --------------------------------------------------------------------------- #
# Calendario letivo
# --------------------------------------------------------------------------- #

def unidade_do_laboratorio(conexao, laboratorio_id):
    if not laboratorio_id:
        return None
    linha = conexao.execute(
        "SELECT unidade_id FROM laboratorios WHERE id = ?", (laboratorio_id,)
    ).fetchone()
    return linha["unidade_id"] if linha else None


def buscar_bloqueio(conexao, data_alvo, laboratorio_id=None, unidade_id=None):
    """Bloqueio (feriado, recesso ou manutencao) que cobre a data, ou None.

    O recesso de uma escola nao alcanca as outras: bloqueio sem laboratorio
    vale para a unidade dele (ou para a rede toda, quando e antigo e nao tem
    unidade definida).
    """
    texto = para_data(data_alvo).isoformat()
    if unidade_id is None:
        unidade_id = unidade_do_laboratorio(conexao, laboratorio_id)

    linha = conexao.execute(
        """
        SELECT * FROM bloqueios
         WHERE ? BETWEEN data_inicio AND data_fim
           AND (laboratorio_id = ?
                OR (laboratorio_id IS NULL
                    AND (unidade_id IS NULL OR unidade_id = ? OR ? IS NULL)))
         ORDER BY laboratorio_id IS NULL
         LIMIT 1
        """,
        (texto, laboratorio_id, unidade_id, unidade_id),
    ).fetchone()
    return banco.linha_para_dict(linha)


def eh_dia_letivo(conexao, data_alvo, permitir_fds=None, unidade_id=None):
    """Dia letivo = nao e fim de semana (salvo config) e nao esta bloqueado para a escola."""
    d = para_data(data_alvo)
    if permitir_fds is None:
        permitir_fds = banco.ler_config_bool(conexao, "permitir_fim_de_semana")
    if not permitir_fds and d.weekday() >= 5:
        return False
    bloqueio = conexao.execute(
        "SELECT 1 FROM bloqueios WHERE ? BETWEEN data_inicio AND data_fim "
        "AND laboratorio_id IS NULL "
        "AND (unidade_id IS NULL OR unidade_id = ? OR ? IS NULL) LIMIT 1",
        (d.isoformat(), unidade_id, unidade_id),
    ).fetchone()
    return bloqueio is None


def distancia_em_dias(conexao, data_a, data_b, apenas_letivos=False):
    """Distancia entre duas datas: em dias corridos ou contando so dias letivos."""
    inicio, fim = sorted((para_data(data_a), para_data(data_b)))
    if not apenas_letivos:
        return (fim - inicio).days

    permitir_fds = banco.ler_config_bool(conexao, "permitir_fim_de_semana")
    total = 0
    cursor = inicio + timedelta(days=1)
    while cursor <= fim:
        if eh_dia_letivo(conexao, cursor, permitir_fds):
            total += 1
        cursor += timedelta(days=1)
    return total


# --------------------------------------------------------------------------- #
# Choque de horarios
# --------------------------------------------------------------------------- #
#
# A grade pode ter aulas de tamanhos diferentes dentro do mesmo turno (uma de
# 19:00 as 19:45 e outra, "aula dupla", de 19:00 as 21:30). Sao linhas
# diferentes em `horarios`, mas ocupam o mesmo laboratorio no mesmo momento —
# por isso o choque e sempre calculado pelo relogio, nunca pelo id do horario.

def sobrepoe(inicio_a, fim_a, inicio_b, fim_b):
    """Os intervalos se cruzam? Encostar nao conta: 07:50 termina quando o outro comeca."""
    return inicio_a < fim_b and inicio_b < fim_a


def _reserva_no_intervalo(conexao, campo, valor, data_alvo, inicio, fim, ignorar_grupo=None):
    """Primeira reserva viva de um laboratorio (ou professor) que cruza o intervalo."""
    sql = f"""
        SELECT r.id, r.grupo, h.inicio, h.fim,
               p.nome AS professor_nome, l.nome AS laboratorio_nome
          FROM reservas r
          JOIN horarios     h ON h.id = r.horario_id
          JOIN professores  p ON p.id = r.professor_id
          JOIN laboratorios l ON l.id = r.laboratorio_id
         WHERE r.{campo} = ? AND r.data = ? AND r.status <> 'cancelada'
           AND h.inicio < ? AND ? < h.fim
    """
    parametros = [valor, para_data(data_alvo).isoformat(), fim, inicio]
    if ignorar_grupo:
        sql += " AND (r.grupo IS NULL OR r.grupo <> ?)"
        parametros.append(ignorar_grupo)
    sql += " ORDER BY h.inicio LIMIT 1"
    return conexao.execute(sql, parametros).fetchone()


def laboratorio_ocupado(conexao, laboratorio_id, data_alvo, inicio, fim, ignorar_grupo=None):
    return _reserva_no_intervalo(
        conexao, "laboratorio_id", laboratorio_id, data_alvo, inicio, fim, ignorar_grupo
    )


def professor_ocupado(conexao, professor_id, data_alvo, inicio, fim, ignorar_grupo=None):
    return _reserva_no_intervalo(
        conexao, "professor_id", professor_id, data_alvo, inicio, fim, ignorar_grupo
    )


def choque_do_grupo(conexao, grupo):
    """Confere, ja dentro da transacao, se as aulas recem-gravadas cruzam outra reserva.

    Devolve a mensagem do primeiro choque encontrado, ou None se estiver tudo certo.
    """
    novas = conexao.execute(
        """
        SELECT r.laboratorio_id, r.professor_id, r.data, h.inicio, h.fim
          FROM reservas r JOIN horarios h ON h.id = r.horario_id
         WHERE r.grupo = ? AND r.status <> 'cancelada'
        """,
        (grupo,),
    ).fetchall()

    for nova in novas:
        ocupada = laboratorio_ocupado(
            conexao, nova["laboratorio_id"], nova["data"], nova["inicio"], nova["fim"], grupo
        )
        if ocupada:
            return _descrever_choque(nova, ocupada, ocupada["professor_nome"])

        conflito = professor_ocupado(
            conexao, nova["professor_id"], nova["data"], nova["inicio"], nova["fim"], grupo
        )
        if conflito:
            return (f"Você já tem reserva no {conflito['laboratorio_nome']} das "
                    f"{conflito['inicio']} às {conflito['fim']}, que bate com "
                    f"{nova['inicio']}–{nova['fim']}.")
    return None


def _pares(itens):
    """Todas as duplas distintas da lista, para comparar as aulas entre si."""
    for indice, primeiro in enumerate(itens):
        for segundo in itens[indice + 1:]:
            yield primeiro, segundo


def _descrever_choque(horario, ocupada, quem):
    """Mensagem que deixa claro quando o choque e com uma aula de outro tamanho."""
    escolhido = f"{horario['inicio']}–{horario['fim']}"
    ocupado = f"{ocupada['inicio']}–{ocupada['fim']}"
    if escolhido == ocupado:
        return f"O horário {escolhido} já está reservado por {quem}."
    return (f"O horário {escolhido} conflita com a reserva de {ocupado} "
            f"de {quem} — o laboratório já está ocupado nesse intervalo.")


# --------------------------------------------------------------------------- #
# Aulas seguidas: limite geral e as excecoes por professor
# --------------------------------------------------------------------------- #
#
# A escola tem um teto unico de aulas seguidas por dia (`max_aulas_seguidas`).
# O gestor abre excecao nome a nome: aquele professor encadeia ate `max_aulas`
# aulas por dia. Esse teto e conferido na Nova reserva (`validar_reserva`); a
# grade de aulas do professor e gravada sem passar por ele — a grade so
# descreve as aulas que ele ja tem e nao tira laboratorio de ninguem.
#
# O `max_dias` da excecao continua gravado e visivel na aba Regras, mas hoje
# nao e conferido em lugar nenhum: ele so valia para a validacao da grade.

DIAS_DA_SEMANA = ("Segunda", "Terça", "Quarta", "Quinta", "Sexta")


def limite_de_aulas_seguidas(conexao, professor_id):
    """(limite do professor, limite geral da escola, excecao ou None)."""
    geral = banco.ler_config_int(conexao, "max_aulas_seguidas")
    excecao = banco.excecao_de_aulas_seguidas(conexao, professor_id)
    if not excecao:
        return geral, geral, None
    # excecao que ficou abaixo do teto geral nao pode apertar a regra de quem
    # ja podia mais: o professor sempre fica com o maior dos dois
    return max(geral, int(excecao["max_aulas"])), geral, excecao


def resumo_das_excecoes(conexao, onde="1 = 1", parametros=()):
    """Excecoes cadastradas, com o limite geral junto, para a tela do gestor."""
    return {
        "max_aulas_seguidas": banco.ler_config_int(conexao, "max_aulas_seguidas"),
        "opcoes_aulas": list(banco.EXCECAO_AULAS_OPCOES),
        "opcoes_dias": list(banco.EXCECAO_DIAS_OPCOES),
        "excecoes": banco.listar_excecoes_de_aulas_seguidas(conexao, onde, parametros),
    }


# --------------------------------------------------------------------------- #
# Validacao de uma nova reserva
# --------------------------------------------------------------------------- #

def validar_reserva(conexao, professor_id, laboratorio_id, data_texto, horario_ids, qtd_alunos=None):
    """Devolve uma lista de mensagens de erro. Lista vazia = reserva permitida."""
    erros = []

    # --- entidades ---------------------------------------------------------- #
    professor = conexao.execute(
        "SELECT * FROM professores WHERE id = ?", (professor_id,)
    ).fetchone()
    if professor is None or not professor["ativo"]:
        return ["Professor não encontrado ou inativo."]

    laboratorio = conexao.execute(
        "SELECT * FROM laboratorios WHERE id = ?", (laboratorio_id,)
    ).fetchone()
    if laboratorio is None or not laboratorio["ativo"]:
        return ["Laboratório não encontrado ou desativado."]

    # cada escola reserva os proprios laboratorios
    if professor["unidade_id"] != laboratorio["unidade_id"]:
        return ["Este laboratório é de outra unidade."]

    try:
        data_reserva = para_data(data_texto)
    except (ValueError, TypeError):
        return ["Data inválida."]

    if not horario_ids:
        return ["Selecione pelo menos um horário."]

    marcadores = ",".join("?" for _ in horario_ids)
    horarios = conexao.execute(
        f"SELECT * FROM horarios WHERE id IN ({marcadores}) ORDER BY ordem",
        tuple(horario_ids),
    ).fetchall()
    if len(horarios) != len(set(horario_ids)):
        return ["Horário inválido."]
    if any(h["unidade_id"] != laboratorio["unidade_id"] for h in horarios):
        return ["Horário de outra unidade."]

    hoje = date.today()

    # --- 1) janela de datas -------------------------------------------------- #
    if data_reserva < hoje:
        erros.append("Não é possível reservar em uma data que já passou.")
    elif data_reserva == hoje:
        # a aula de hoje que ja comecou nao adianta reservar: o horario esta
        # acontecendo (ou ja acabou) no momento do clique
        agora = hora_agora()
        vencidas = [h for h in horarios if aula_ja_comecou(h["inicio"], data_reserva, agora)]
        if vencidas:
            quais = ", ".join(f"{h['inicio']}–{h['fim']}" for h in vencidas)
            erros.append(
                f"Já passou da hora: {quais} — agora são {agora}. "
                f"Escolha um horário que ainda não começou."
            )

    antecedencia_max = banco.ler_config_int(conexao, "antecedencia_maxima_dias")
    limite = hoje + timedelta(days=antecedencia_max)
    if data_reserva > limite:
        erros.append(
            f"A reserva só pode ser feita com até {antecedencia_max} dias de antecedência "
            f"(no máximo {formatar_br(limite)})."
        )

    # --- 2) calendario ------------------------------------------------------- #
    permitir_fds = banco.ler_config_bool(conexao, "permitir_fim_de_semana")
    if not permitir_fds and data_reserva.weekday() >= 5:
        erros.append("A escola não abre nos fins de semana.")

    bloqueio = buscar_bloqueio(conexao, data_reserva, laboratorio_id)
    if bloqueio:
        escopo = "toda a escola" if bloqueio["laboratorio_id"] is None else "este laboratório"
        erros.append(
            f"Data indisponível para {escopo}: {bloqueio['descricao'] or 'bloqueio no calendário'}."
        )

    # --- 3) turno e aulas seguidas ------------------------------------------- #
    turnos = {h["turno"] for h in horarios}
    if len(turnos) > 1:
        erros.append("Selecione horários de um mesmo turno.")

    ordens = sorted(h["ordem"] for h in horarios)
    if len(ordens) > 1 and ordens != list(range(ordens[0], ordens[0] + len(ordens))):
        erros.append("Os horários selecionados precisam ser seguidos (aulas consecutivas).")

    max_seguidas, _geral, excecao_do_professor = limite_de_aulas_seguidas(
        conexao, professor_id)
    ja_no_dia = conexao.execute(
        """
        SELECT COUNT(*) c FROM reservas
         WHERE professor_id = ? AND laboratorio_id = ? AND data = ?
           AND status <> 'cancelada'
        """,
        (professor_id, laboratorio_id, data_reserva.isoformat()),
    ).fetchone()["c"]
    if len(horarios) + ja_no_dia > max_seguidas:
        ressalva = " (já contando a sua exceção)" if excecao_do_professor else ""
        erros.append(
            f"Limite de {max_seguidas} aula(s) por dia neste laboratório{ressalva} "
            f"(você já tem {ja_no_dia} reservada(s) nesse dia)."
        )

    # --- 4) capacidade ------------------------------------------------------- #
    if qtd_alunos:
        try:
            qtd = int(qtd_alunos)
        except (TypeError, ValueError):
            qtd = 0
        if qtd > laboratorio["capacidade"]:
            erros.append(
                f"O laboratório comporta {laboratorio['capacidade']} alunos "
                f"e você informou {qtd}."
            )

    # --- 5) conflitos de horario --------------------------------------------- #
    # as aulas escolhidas nao podem se cruzar entre si
    for primeira, segunda in _pares(horarios):
        if sobrepoe(primeira["inicio"], primeira["fim"], segunda["inicio"], segunda["fim"]):
            erros.append(
                f"As aulas {primeira['inicio']}–{primeira['fim']} e "
                f"{segunda['inicio']}–{segunda['fim']} acontecem ao mesmo tempo: "
                f"escolha apenas uma delas."
            )

    for horario in horarios:
        ocupada = laboratorio_ocupado(
            conexao, laboratorio_id, data_reserva, horario["inicio"], horario["fim"]
        )
        if ocupada:
            erros.append(_descrever_choque(horario, ocupada, ocupada["professor_nome"]))
            continue

        # o professor nao pode estar em dois laboratorios ao mesmo tempo
        conflito = professor_ocupado(
            conexao, professor_id, data_reserva, horario["inicio"], horario["fim"]
        )
        if conflito:
            erros.append(
                f"Você já tem reserva no {conflito['laboratorio_nome']} das "
                f"{conflito['inicio']} às {conflito['fim']}, que bate com "
                f"{horario['inicio']}–{horario['fim']}."
            )

    # --- 6) carencia (o "X" do questionario) --------------------------------- #
    erro_carencia = verificar_carencia(conexao, professor_id, laboratorio_id, data_reserva)
    if erro_carencia:
        erros.append(erro_carencia)

    return erros


def carencia_dispensada(conexao, professor_id):
    """A carencia nao alcanca quem tem excecao de aulas seguidas.

    A excecao existe justamente para o professor que precisa do laboratorio em
    bloco e com frequencia — cobrar dele o intervalo entre um uso e outro
    desmontaria a folga que o gestor acabou de conceder.
    """
    return banco.excecao_de_aulas_seguidas(conexao, professor_id) is not None


def verificar_carencia(conexao, professor_id, laboratorio_id, data_reserva, ignorar_id=None):
    """Depois de usar o laboratorio, o professor fica X dias sem poder reservar de novo."""
    carencia = banco.ler_config_int(conexao, "carencia_dias")
    if carencia <= 0:
        return None
    if carencia_dispensada(conexao, professor_id):
        return None

    escopo_global = banco.ler_config(conexao, "carencia_escopo") == "global"
    conta_falta = banco.ler_config_bool(conexao, "falta_conta_como_uso")
    apenas_letivos = banco.ler_config_bool(conexao, "carencia_dias_letivos")

    status_uso = ["ativa", "realizada"] + (["falta"] if conta_falta else [])
    marcadores = ",".join("?" for _ in status_uso)

    sql = f"""
        SELECT DISTINCT r.data, l.nome AS lab_nome
          FROM reservas r
          JOIN laboratorios l ON l.id = r.laboratorio_id
         WHERE r.professor_id = ?
           AND r.status IN ({marcadores})
           AND r.data <> ?
    """
    parametros = [professor_id, *status_uso, para_data(data_reserva).isoformat()]
    if not escopo_global:
        sql += " AND r.laboratorio_id = ?"
        parametros.append(laboratorio_id)
    if ignorar_id:
        sql += " AND r.id <> ?"
        parametros.append(ignorar_id)

    unidade = "dia(s) letivo(s)" if apenas_letivos else "dia(s)"
    for linha in conexao.execute(sql, parametros):
        distancia = distancia_em_dias(conexao, linha["data"], data_reserva, apenas_letivos)
        if distancia < carencia:
            alvo = "qualquer laboratório" if escopo_global else linha["lab_nome"]
            return (
                f"Carência de {carencia} {unidade}: você tem uso de {alvo} em "
                f"{formatar_br(linha['data'])}, então precisa respeitar o intervalo "
                f"antes de reservar em {formatar_br(data_reserva)}."
            )
    return None


def proxima_data_liberada(conexao, professor_id, laboratorio_id, a_partir_de=None):
    """Primeira data (ate 120 dias a frente) em que o professor volta a poder reservar."""
    inicio = para_data(a_partir_de) if a_partir_de else date.today()
    for passo in range(0, 121):
        candidata = inicio + timedelta(days=passo)
        if not eh_dia_letivo(conexao, candidata):
            continue
        if buscar_bloqueio(conexao, candidata, laboratorio_id):
            continue
        if verificar_carencia(conexao, professor_id, laboratorio_id, candidata) is None:
            return candidata
    return None


# --------------------------------------------------------------------------- #
# Cancelamento
# --------------------------------------------------------------------------- #

def pode_cancelar(conexao, reserva):
    """Regra de antecedencia minima para cancelar. Retorna (bool, motivo)."""
    if reserva["status"] == "cancelada":
        return False, "Esta reserva já está cancelada."
    if reserva["status"] in ("realizada", "falta"):
        return False, "Esta reserva já foi encerrada pela coordenação."

    horas_minimas = banco.ler_config_int(conexao, "cancelamento_antecedencia_horas")
    hora_inicio = (reserva["inicio"] or "00:00") if "inicio" in reserva.keys() else "00:00"
    inicio_aula = datetime.combine(
        para_data(reserva["data"]),
        datetime.strptime(hora_inicio, "%H:%M").time(),
    )
    faltam = (inicio_aula - datetime.now()).total_seconds() / 3600
    if faltam < horas_minimas:
        return False, (
            f"O cancelamento precisa ser feito com pelo menos {horas_minimas} horas "
            f"de antecedência."
        )
    return True, ""


# --------------------------------------------------------------------------- #
# Reserva do intervalo: elaboracao de projetos
# --------------------------------------------------------------------------- #
#
# O intervalo de uma hora depois da 5a aula nao e uma aula da grade: ele e o vao
# entre o fim de um turno e o comeco do outro. Por isso estas regras trabalham
# direto com o relogio ("12:10"-"13:00") e nao com um `horario_id`.
#
# O que vale aqui e o que ja valia para a aula: a data precisa ser letiva, nao
# pode estar bloqueada e o laboratorio precisa estar livre naquele pedaco do
# dia. O que nao vale e a carencia nem o limite de aulas seguidas — a reserva
# do intervalo nao tira o laboratorio de ninguem, porque naquela hora nao ha
# aula acontecendo.

def projeto_no_intervalo(conexao, campo, valor, data_alvo, turno=None, ignorar_id=None):
    """Reserva de projeto viva do mesmo laboratorio (ou professor) naquele dia.

    Sem `turno`, olha a data inteira. E assim que o laboratorio e conferido: o
    intervalo reservavel e um so por dia, e a segunda reserva na mesma data e
    sempre choque — o caso de o professor ter reservado e o gestor, sem ver a
    agenda, marcar por cima em nome de outro.
    """
    sql = f"""
        SELECT rp.id, rp.projeto, rp.data, rp.turno, rp.inicio, rp.fim,
               p.nome AS professor_nome, l.nome AS laboratorio_nome
          FROM reservas_projeto rp
          JOIN professores  p ON p.id = rp.professor_id
          JOIN laboratorios l ON l.id = rp.laboratorio_id
         WHERE rp.{campo} = ? AND rp.data = ?
           AND rp.status <> 'cancelada'
    """
    parametros = [valor, para_data(data_alvo).isoformat()]
    if turno:
        sql += " AND rp.turno = ?"
        parametros.append(turno)
    if ignorar_id:
        sql += " AND rp.id <> ?"
        parametros.append(ignorar_id)
    return conexao.execute(sql + " LIMIT 1", parametros).fetchone()


def laboratorio_reservado_no_dia(conexao, laboratorio_id, data_alvo, ignorar_id=None):
    """A reserva de projeto que ja ocupa aquele laboratorio naquela data, se houver."""
    return projeto_no_intervalo(
        conexao, "laboratorio_id", laboratorio_id, data_alvo, None, ignorar_id
    )


def aviso_de_laboratorio_ocupado(ocupado):
    """A frase unica do choque de laboratorio — a mesma na tela e na API."""
    return (
        f"Não é possível reservar: o {ocupado['laboratorio_nome']} já está "
        f"reservado em {formatar_br(para_data(ocupado['data']))} para "
        f"“{ocupado['projeto']}”, com {ocupado['professor_nome']} "
        f"({ocupado['inicio']}–{ocupado['fim']})."
    )


def validar_reserva_projeto(conexao, professor_id, laboratorio_id, data_texto,
                            janela, projeto, ignorar_id=None):
    """Devolve uma lista de mensagens de erro. Lista vazia = reserva permitida."""
    erros = []

    professor = conexao.execute(
        "SELECT * FROM professores WHERE id = ?", (professor_id,)
    ).fetchone()
    if professor is None or not professor["ativo"]:
        return ["Professor responsável não encontrado ou inativo."]

    laboratorio = conexao.execute(
        "SELECT * FROM laboratorios WHERE id = ?", (laboratorio_id,)
    ).fetchone()
    if laboratorio is None or not laboratorio["ativo"]:
        return ["Laboratório não encontrado ou desativado."]
    if professor["unidade_id"] != laboratorio["unidade_id"]:
        return ["Este laboratório é de outra unidade."]

    if not str(projeto or "").strip():
        erros.append("Informe o nome do projeto ou evento.")

    try:
        data_reserva = para_data(data_texto)
    except (ValueError, TypeError):
        return ["Data inválida."]

    if janela is None:
        return ["A grade de horários da escola não tem uma 5ª aula: sem ela o "
                "sistema não sabe onde fica o intervalo. Peça ao gestor para "
                "cadastrar os horários."]
    if not janela["cabe"]:
        return [f"O intervalo depois da {janela['aula_referencia']}ª aula tem só "
                f"{janela['livre']} minutos ({janela['inicio']}–"
                f"{janela['fim_intervalo']}), e a reserva precisa de "
                f"{janela['duracao']}. Ajuste os horários da escola."]

    hoje = date.today()

    # --- 1) janela de datas -------------------------------------------------- #
    if data_reserva < hoje:
        erros.append("Não é possível reservar em uma data que já passou.")
    elif data_reserva == hoje and aula_ja_comecou(janela["inicio"], data_reserva):
        erros.append(
            f"Já passou da hora: o intervalo começa às {janela['inicio']} e agora "
            f"são {hora_agora()}."
        )

    antecedencia_max = banco.ler_config_int(conexao, "antecedencia_maxima_dias")
    limite = hoje + timedelta(days=antecedencia_max)
    if data_reserva > limite:
        erros.append(
            f"A reserva só pode ser feita com até {antecedencia_max} dias de "
            f"antecedência (no máximo {formatar_br(limite)})."
        )

    # --- 2) calendario ------------------------------------------------------- #
    if not banco.ler_config_bool(conexao, "permitir_fim_de_semana") \
            and data_reserva.weekday() >= 5:
        erros.append("A escola não abre nos fins de semana.")

    bloqueio = buscar_bloqueio(conexao, data_reserva, laboratorio_id)
    if bloqueio:
        escopo = "toda a escola" if bloqueio["laboratorio_id"] is None else "este laboratório"
        erros.append(
            f"Data indisponível para {escopo}: "
            f"{bloqueio['descricao'] or 'bloqueio no calendário'}."
        )

    # --- 3) o intervalo ja esta tomado? -------------------------------------- #
    # o laboratorio e conferido no dia inteiro, nao so no turno: duas reservas
    # de projeto na mesma data sao o mesmo intervalo tomado duas vezes
    ocupado = laboratorio_reservado_no_dia(
        conexao, laboratorio_id, data_reserva, ignorar_id
    )
    if ocupado:
        erros.append(aviso_de_laboratorio_ocupado(ocupado))

    conflito = projeto_no_intervalo(
        conexao, "professor_id", professor_id, data_reserva, janela["turno"], ignorar_id
    )
    if conflito:
        erros.append(
            f"{professor['nome']} já é responsável por "
            f"\u201c{conflito['projeto']}\u201d no {conflito['laboratorio_nome']} "
            f"nesse mesmo intervalo."
        )

    # Aula comum que invade o intervalo: a grade pode ter uma "aula dupla" que
    # atravessa o vao entre os turnos. O choque e sempre pelo relogio.
    aula = laboratorio_ocupado(
        conexao, laboratorio_id, data_reserva, janela["inicio"], janela["fim"]
    )
    if aula:
        erros.append(
            f"O {laboratorio['nome']} tem aula de {aula['inicio']} às {aula['fim']} "
            f"com {aula['professor_nome']}, que avança sobre o intervalo."
        )

    return erros


def pode_cancelar_projeto(conexao, projeto):
    """Mesma antecedencia minima da aula, contada do comeco dos 50 minutos."""
    if projeto["status"] == "cancelada":
        return False, "Esta reserva já está cancelada."
    if projeto["status"] == "realizada":
        return False, "Esta reserva já foi encerrada."

    horas_minimas = banco.ler_config_int(conexao, "cancelamento_antecedencia_horas")
    comeco = datetime.combine(
        para_data(projeto["data"]),
        datetime.strptime(projeto["inicio"] or "00:00", "%H:%M").time(),
    )
    faltam = (comeco - datetime.now()).total_seconds() / 3600
    if faltam < horas_minimas:
        return False, (
            f"O cancelamento precisa ser feito com pelo menos {horas_minimas} horas "
            f"de antecedência."
        )
    return True, ""
