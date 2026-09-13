"""Sistema de Reserva e Gestao de Laboratorios Escolares.

Backend em Python (Flask + SQLite) servindo uma interface web responsiva
em HTML/CSS/JavaScript.

Tres niveis de acesso:
    Gerente Geral (/gerente) -> visao geral da escola e criacao das contas
                                dos gestores locais;
    Gestor Local  (/gestor)  -> cadastros, regras e relatorios do dia a dia
                                (era o antigo "administrador");
    Professor     (/)        -> reserva os laboratorios.

Para rodar:
    python app.py
Depois abra http://localhost:5000 no navegador (do PC ou do celular na
mesma rede, usando o IP mostrado no terminal).
"""

import io
import os
import re
import secrets
import socket
import sqlite3
import struct
import uuid
import zlib
from datetime import date, datetime, timedelta
from functools import wraps

from flask import (Flask, Response, g, jsonify, redirect, render_template,
                   request, send_file, session)

import armazenamento
import banco
import mensagens
import regras

# Conversao de HEIC/HEIF (formato padrao da camera do iPhone) para JPEG. Chrome,
# Firefox e Edge nao exibem HEIC, entao a foto e convertida na hora do envio.
# Sem as bibliotecas instaladas o sistema continua funcionando: apenas recusa o
# arquivo HEIC como antes, avisando o professor.
try:
    import pillow_heif
    from PIL import Image, ImageOps

    pillow_heif.register_heif_opener()
    # EXIF orientation -> giro que deixa a foto em pe (mesma tabela do Pillow)
    GIROS_ORIENTACAO = {
        2: Image.Transpose.FLIP_LEFT_RIGHT,
        3: Image.Transpose.ROTATE_180,
        4: Image.Transpose.FLIP_TOP_BOTTOM,
        5: Image.Transpose.TRANSPOSE,
        6: Image.Transpose.ROTATE_270,
        7: Image.Transpose.TRANSVERSE,
        8: Image.Transpose.ROTATE_90,
    }
    HEIC_DISPONIVEL = True
except ImportError:
    GIROS_ORIENTACAO = {}
    HEIC_DISPONIVEL = False

app = Flask(__name__)
app.config["JSON_SORT_KEYS"] = False
# sem isso o Flask guarda o HTML na memoria e so mostra alteracoes de template
# depois de fechar e abrir o programa de novo
app.config["TEMPLATES_AUTO_RELOAD"] = True
app.secret_key = banco.obter_chave_secreta()
# Sessao: a conta sai sozinha depois de 15 minutos parada, para o professor, o
# gestor local e o gerente geral. Quem manda e o servidor: o cookie assinado
# vale por esse tempo e o Flask o reassina a cada resposta enquanto a sessao e
# permanente, entao o relogio recomeca a cada pedido e so zera de vez quando
# ninguem mexe no sistema. A tela avisa antes e chama /api/logout na hora
# (static/js/api.js) — sem ela o servidor derrubaria do mesmo jeito, so que
# calado, no pedido seguinte.
MINUTOS_DE_INATIVIDADE = 15
app.permanent_session_lifetime = timedelta(minutes=MINUTOS_DE_INATIVIDADE)
app.config["SESSION_REFRESH_EACH_REQUEST"] = True
# limites de upload para nao aceitar arquivos gigantes: a foto de perfil do
# professor e o calendario escolar em PDF — este maior, porque o calendario
# escaneado pela secretaria passa facil dos 10 MB de uma foto
LIMITE_FOTO_MB = 10
LIMITE_FOTO = LIMITE_FOTO_MB * 1024 * 1024
LIMITE_CALENDARIO_MB = 20
LIMITE_CALENDARIO = LIMITE_CALENDARIO_MB * 1024 * 1024
# o teto do Flask vale para o corpo inteiro da requisicao, e o multipart soma
# fronteiras e cabecalhos ao arquivo. Sem essa folga um arquivo de exatos 10 MB
# levaria um 413 em HTML antes de chegar na rota, e quem enviou veria a pagina
# de erro do servidor no lugar do aviso escrito para ele. Cada rota confere o
# proprio limite; o teto e so o do maior deles.
app.config["MAX_CONTENT_LENGTH"] = max(LIMITE_FOTO, LIMITE_CALENDARIO) + 1024 * 1024

DIAS_SEMANA = ["Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado", "Domingo"]
DIAS_SEMANA_CURTO = ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"]

# Logo que aparece na faixa institucional das telas de login. Basta salvar a
# imagem em static/img/ com um destes nomes; sem arquivo, a faixa mostra um
# selo escrito "ETE" no lugar, para a tela nunca ficar quebrada.
ARQUIVOS_BRASAO = ("logomelhorada.png", "logoete.jpg", "logo pe.png", "logo pe.svg",
                   "logo-pe.png", "logo-pe.svg", "brasao-pe.png", "brasao-pe.svg",
                   "brasao-pe.jpg")


_cor_do_brasao = {}


def cor_do_canto(caminho):
    """Cor do primeiro pixel de um PNG, em #rrggbb (ou None se nao der para ler).

    O brasao oficial vem com o fundo azul chapado, entao pintar a faixa com a
    cor do canto da imagem faz as duas se encaixarem sem emenda, qualquer que
    seja o tom de azul do arquivo. So o PNG e lido — para os outros formatos
    vale o azul padrao do CSS.

    Nao precisa desfazer os filtros do PNG: no primeiro pixel da primeira
    linha todos os cinco filtros preveem zero, entao o byte cru ja e a cor.
    """
    try:
        assinatura = os.stat(caminho).st_mtime_ns
        if _cor_do_brasao.get("caminho") == (caminho, assinatura):
            return _cor_do_brasao.get("cor")

        with open(caminho, "rb") as arquivo:
            dados = arquivo.read()

        cor = None
        if dados[:8] == b"\x89PNG\r\n\x1a\n":
            largura, altura, profundidade, tipo = struct.unpack(">IIBB", dados[16:26])
            del largura, altura
            comprimido = b""
            paleta = b""
            posicao = 8
            while posicao + 8 <= len(dados) and len(comprimido) < 8192:
                tamanho = struct.unpack(">I", dados[posicao:posicao + 4])[0]
                marca = dados[posicao + 4:posicao + 8]
                corpo = dados[posicao + 8:posicao + 8 + tamanho]
                if marca == b"PLTE":
                    paleta = corpo
                elif marca == b"IDAT":
                    comprimido += corpo
                elif marca == b"IEND":
                    break
                posicao += tamanho + 12

            if comprimido and profundidade == 8:
                cru = zlib.decompressobj().decompress(comprimido, 64)[1:]  # [0] = filtro
                if tipo in (2, 6) and len(cru) >= 3:
                    cor = tuple(cru[:3])
                elif tipo in (0, 4) and len(cru) >= 1:
                    cor = (cru[0],) * 3
                elif tipo == 3 and cru and len(paleta) >= cru[0] * 3 + 3:
                    inicio = cru[0] * 3
                    cor = tuple(paleta[inicio:inicio + 3])

        resultado = "#%02x%02x%02x" % cor if cor else None
        _cor_do_brasao.update({"caminho": (caminho, assinatura), "cor": resultado})
        return resultado
    except Exception:
        return None


@app.context_processor
def brasao_institucional():
    pasta = os.path.join(app.static_folder, "img")
    for nome in ARQUIVOS_BRASAO:
        caminho = os.path.join(pasta, nome)
        if os.path.exists(caminho):
            return {"brasao_gov": f"img/{nome}", "cor_faixa": cor_do_canto(caminho)}
    return {"brasao_gov": None, "cor_faixa": None}


@app.context_processor
def tempo_de_sessao():
    """O limite de inatividade vai para o <body>, e de la para o api.js.

    Um numero so, escrito num lugar so: mudar MINUTOS_DE_INATIVIDADE muda ao
    mesmo tempo o que o servidor aceita e o que a tela conta.
    """
    return {"minutos_inatividade": MINUTOS_DE_INATIVIDADE}


@app.context_processor
def modo_online():
    """Diz ao template se a pagina esta indo para uma maquina da rede.

    No computador onde o sistema roda os atalhos ficam livres — e de la que
    se mexe no sistema. Para quem entra pela rede, a tela carrega o
    bloqueio.js (Ctrl+U e companhia). Vale lembrar que isso so desencoraja:
    o HTML chega inteiro no navegador de qualquer jeito.
    """
    local = request.remote_addr in ("127.0.0.1", "::1", "localhost")
    return {"bloquear_atalhos": not local}


# --------------------------------------------------------------------------- #
# Conexao por requisicao
# --------------------------------------------------------------------------- #

def db():
    if "conexao" not in g:
        g.conexao = banco.conectar()
    return g.conexao


@app.teardown_appcontext
def fechar_conexao(_erro=None):
    conexao = g.pop("conexao", None)
    if conexao is not None:
        conexao.close()


# --------------------------------------------------------------------------- #
# Autenticacao
# --------------------------------------------------------------------------- #

def sem_ninguem_logado():
    """Nenhum dos tres perfis na sessao — ou nunca entrou, ou o tempo acabou."""
    return not (session.get("professor_id") or session.get("gestor_id")
                or session.get("gerente"))


def barrar(mensagem, codigo):
    """Resposta de acesso negado, avisando se foi a sessao que caiu.

    A tela usa `sessao_expirada` para levar de volta ao login explicando o
    motivo, em vez de mostrar "acesso restrito" para quem so demorou demais.
    """
    return jsonify({"erro": mensagem, "sessao_expirada": sem_ninguem_logado()}), codigo


def requer_professor(funcao):
    @wraps(funcao)
    def interna(*args, **kwargs):
        if not session.get("professor_id"):
            return barrar("Faça login para continuar.", 401)
        return funcao(*args, **kwargs)
    return interna


def requer_acesso(funcao):
    """Libera para o professor logado e para quem administra (gestor/gerente).

    Fica junto de `requer_professor` porque as telas do professor usam os dois:
    o decorador precisa existir antes da primeira rota que o aplica.
    """
    @wraps(funcao)
    def interna(*args, **kwargs):
        if not session.get("professor_id") and not tem_acesso_de_gestao():
            return barrar("Faça login para continuar.", 401)
        return funcao(*args, **kwargs)
    return interna


def gestor_da_sessao():
    """Gestor local logado, conferido no banco a cada pedido.

    Se a conta foi desativada ou excluida enquanto ele estava logado, a sessao
    e limpa na hora — o cookie sozinho nao mantem ninguem dentro do painel.
    """
    gestor_id = session.get("gestor_id")
    if not gestor_id:
        return None
    gestor = db().execute("SELECT * FROM gestores WHERE id = ?", (gestor_id,)).fetchone()
    if gestor is None or not gestor["ativo"]:
        session.pop("gestor_id", None)
        session.pop("gestor_nome", None)
        return None
    return gestor


def tem_acesso_de_gestao():
    """O gerente geral enxerga tudo que o gestor local enxerga."""
    return bool(session.get("gerente")) or gestor_da_sessao() is not None


def requer_gestor(funcao):
    """Painel do gestor local (e tambem liberado para o gerente geral)."""
    @wraps(funcao)
    def interna(*args, **kwargs):
        if not tem_acesso_de_gestao():
            return barrar("Acesso restrito ao gestor local.", 403)
        return funcao(*args, **kwargs)
    return interna


def requer_gerente(funcao):
    """Topo da hierarquia: so o gerente geral."""
    @wraps(funcao)
    def interna(*args, **kwargs):
        if not session.get("gerente"):
            return barrar("Acesso restrito ao gerente geral.", 403)
        return funcao(*args, **kwargs)
    return interna


# --------------------------------------------------------------------------- #
# Unidade em foco: a escola que o painel do gestor esta enxergando
# --------------------------------------------------------------------------- #
#
# O gestor local so alcanca a propria escola: laboratorios, professores,
# horarios, bloqueios e reservas sao sempre filtrados pela unidade dele. O
# gerente geral escolhe qual escola quer olhar (ou todas).

def unidade_em_foco():
    """Id da unidade que limita o que o painel mostra, ou None para "tudo"."""
    gestor = gestor_da_sessao()
    if gestor is not None:
        return gestor["unidade_id"]
    if session.get("gerente"):
        return session.get("unidade_foco")
    return None


def filtro_de_unidade(prefixo=""):
    """Trecho de SQL + parametros para limitar uma consulta a unidade em foco.

    Sem unidade em foco (gerente vendo a rede toda) devolve um filtro neutro.
    """
    unidade_id = unidade_em_foco()
    if unidade_id is None:
        return "1 = 1", []
    return f"{prefixo}unidade_id = ?", [unidade_id]


def pertence_a_unidade(conexao, tabela, item_id):
    """O registro e da unidade em foco? Impede mexer no que e de outra escola."""
    unidade_id = unidade_em_foco()
    if unidade_id is None:
        return True
    linha = conexao.execute(
        f"SELECT unidade_id FROM {tabela} WHERE id = ?", (item_id,)
    ).fetchone()
    return linha is not None and linha["unidade_id"] == unidade_id


ERRO_DE_OUTRA_UNIDADE = {"erro": "Este item pertence a outra unidade."}


@app.post("/api/login/professor")
def login_professor():
    dados = request.get_json(silent=True) or {}
    identificador = str(dados.get("identificador", "")).strip()
    senha = str(dados.get("senha", ""))
    if not identificador:
        return jsonify({"erro": "Informe sua matrícula ou e-mail."}), 400
    if not senha:
        return jsonify({"erro": "Informe sua senha."}), 400

    professor = db().execute(
        "SELECT * FROM professores WHERE ativo = 1 AND "
        "(matricula = ? COLLATE NOCASE OR email = ? COLLATE NOCASE)",
        (identificador, identificador),
    ).fetchone()
    if professor is None:
        return jsonify({"erro": "Matrícula ou e-mail não encontrado. Fale com a coordenação."}), 404

    if not professor["senha_hash"]:
        return jsonify({
            "erro": "Seu acesso ainda não tem senha. Peça à coordenação para gerar a sua."
        }), 403

    if not banco.validar_senha_professor(professor, senha):
        return jsonify({"erro": "Senha incorreta."}), 401

    session.permanent = True
    session["professor_id"] = professor["id"]
    session["professor_nome"] = professor["nome"]
    return jsonify({
        "professor": professor_publico(professor),
        "professor_administra": professor_administra(db(), professor["id"]),
    })


def professor_publico(linha):
    """Dados do professor sem o hash da senha."""
    dados = banco.linha_para_dict(linha)
    if dados:
        dados.pop("senha_hash", None)
    return dados


@app.post("/api/login/gestor")
def login_gestor():
    """Gestor local: entra com o usuario (ou e-mail) e a senha que o gerente criou."""
    conexao = db()
    dados = request.get_json(silent=True) or {}
    identificador = str(dados.get("identificador", "")).strip()
    senha = str(dados.get("senha", ""))
    if not identificador:
        return jsonify({"erro": "Informe seu usuário ou e-mail."}), 400
    if not senha:
        return jsonify({"erro": "Informe sua senha."}), 400

    gestor = conexao.execute(
        "SELECT * FROM gestores WHERE ativo = 1 AND "
        "(usuario = ? COLLATE NOCASE OR email = ? COLLATE NOCASE)",
        (identificador, identificador),
    ).fetchone()
    if gestor is None:
        return jsonify({"erro": "Usuário não encontrado. Fale com o gerente geral."}), 404
    if not gestor["senha_hash"]:
        return jsonify({
            "erro": "Seu acesso ainda não tem senha. Peça ao gerente geral para gerar a sua."
        }), 403
    if not banco.validar_senha_gestor(gestor, senha):
        return jsonify({"erro": "Senha incorreta."}), 401

    banco.registrar_acesso_gestor(conexao, gestor["id"])
    conexao.commit()

    session.permanent = True
    session["gestor_id"] = gestor["id"]
    session["gestor_nome"] = gestor["nome"]
    return jsonify({"gestor": gestor_publico(gestor)})


@app.post("/api/login/gerente")
def login_gerente():
    """Gerente geral: acesso unico, so com senha."""
    dados = request.get_json(silent=True) or {}
    senha = str(dados.get("senha", ""))
    if not banco.validar_senha_gerente(db(), senha):
        return jsonify({"erro": "Senha incorreta."}), 401
    session.permanent = True
    session["gerente"] = True
    return jsonify({"ok": True})


def gestor_publico(linha):
    """Dados do gestor sem o hash da senha."""
    dados = banco.linha_para_dict(linha)
    if dados:
        dados.pop("senha_hash", None)
    return dados


@app.post("/api/logout")
def logout():
    session.clear()
    return jsonify({"ok": True})


@app.post("/api/sessao/renovar")
def renovar_sessao():
    """Segura a sessao de quem esta usando o sistema sem pedir nada ao servidor.

    Preencher um cadastro demorado ou ler um relatorio longo nao gera pedido
    nenhum, e sem isso a sessao morreria no meio do trabalho. A tela so chama
    esta rota quando houve mexida de verdade (teclado, toque, clique) desde o
    ultimo pedido — parado, ninguem renova nada e o tempo corre normalmente.
    """
    if sem_ninguem_logado():
        return jsonify({"ok": False, "sessao_expirada": True}), 401
    session.modified = True     # garante o cookie novo na resposta
    return jsonify({"ok": True})


@app.get("/api/sessao")
def sessao_atual():
    conexao = db()
    professor = None
    if session.get("professor_id"):
        linha = conexao.execute(
            "SELECT * FROM professores WHERE id = ?", (session["professor_id"],)
        ).fetchone()
        professor = professor_publico(linha)
        if professor is None or not professor["ativo"]:
            session.pop("professor_id", None)
            professor = None

    gestor = gestor_publico(gestor_da_sessao())
    foco = unidade_em_foco()
    return jsonify({
        "professor": professor,
        # avisa a tela do professor que ele tambem administra, para ela explicar
        # o bloqueio antes da tentativa de reserva em vez de depois
        "professor_administra": bool(professor)
                                and professor_administra(conexao, professor["id"]),
        "gestor": gestor,
        "gerente": bool(session.get("gerente")),
        "escola": banco.ler_config(conexao, "nome_escola"),
        "unidade": nome_da_unidade(conexao, foco),
        "unidade_id": foco,
    })


def nome_da_unidade(conexao, unidade_id):
    if unidade_id is None:
        return None
    linha = conexao.execute("SELECT nome FROM unidades WHERE id = ?", (unidade_id,)).fetchone()
    return linha["nome"] if linha else None


@app.post("/api/gerente/foco")
@requer_gerente
def escolher_foco():
    """O gerente escolhe qual escola quer ver no painel do gestor (vazio = todas)."""
    conexao = db()
    dados = request.get_json(silent=True) or {}
    unidade_id, erro = _validar_unidade(conexao, dados.get("unidade_id"))
    if erro:
        return jsonify({"erro": erro}), 400

    if unidade_id is None:
        session.pop("unidade_foco", None)
    else:
        session["unidade_foco"] = unidade_id
    return jsonify({"ok": True, "unidade": nome_da_unidade(conexao, unidade_id)})


# --------------------------------------------------------------------------- #
# Paginas
# --------------------------------------------------------------------------- #

@app.get("/")
def pagina_inicial():
    return render_template("index.html", escola=banco.ler_config(db(), "nome_escola"))


@app.get("/gestor")
def pagina_gestor():
    return render_template("gestor.html", escola=banco.ler_config(db(), "nome_escola"))


@app.get("/gerente")
def pagina_gerente():
    return render_template("gerente.html", escola=banco.ler_config(db(), "nome_escola"))


@app.get("/admin")
def pagina_admin():
    """Endereco antigo do administrador — hoje e o gestor local."""
    return redirect("/gestor")


# --------------------------------------------------------------------------- #
# Dados publicos (para quem esta logado como professor)
# --------------------------------------------------------------------------- #

def unidade_do_professor():
    """Escola do professor logado — ele so enxerga o que e dela."""
    if not session.get("professor_id"):
        return None
    linha = db().execute(
        "SELECT unidade_id FROM professores WHERE id = ?", (session["professor_id"],)
    ).fetchone()
    return linha["unidade_id"] if linha else None


def filtro_da_tela(prefixo=""):
    """Filtro de unidade das telas que professor e gestor compartilham."""
    if tem_acesso_de_gestao():
        return filtro_de_unidade(prefixo)
    unidade_id = unidade_do_professor()
    if unidade_id is None:
        return "1 = 1", []
    return f"{prefixo}unidade_id = ?", [unidade_id]


# --------------------------------------------------------------------------- #
# Grade de aulas: o padrao que se repete + as excecoes de cada data
# --------------------------------------------------------------------------- #
#
# `aulas_grade` guarda o padrao da semana, com vigencia — o gestor troca o
# padrao a partir de uma data e as versoes antigas ficam guardadas. Ja
# `aulas_semana` guarda o que muda num dia concreto (a aula que mudou de sala
# so naquela terca, a que nao vai acontecer numa semana de prova).
#
# A grade que aparece na tela e sempre a soma dos dois: o padrao vigente
# naquele dia, com as excecoes daquela data por cima.

DIAS_UTEIS = 5


def segunda_da_semana(referencia=None):
    """Segunda-feira da semana da data informada (a de hoje, sem parametro)."""
    dia = regras.para_data(referencia) if referencia else date.today()
    return dia - timedelta(days=dia.weekday())


def semana_pedida():
    """Semana escolhida na tela (parametro `inicio`), sempre de segunda a sexta.

    Data faltando ou ilegivel cai na semana de hoje, para a tela nunca abrir
    vazia por causa de um endereco digitado errado.
    """
    try:
        inicio = segunda_da_semana(request.args.get("inicio") or None)
    except (ValueError, TypeError):
        inicio = segunda_da_semana()
    return inicio, inicio + timedelta(days=DIAS_UTEIS - 1)


def aulas_da_semana(conexao, inicio, fim, onde_professor="1 = 1", parametros=(),
                    professor_id=None, so_ativos=True, so_visiveis=False,
                    com_excecoes=True):
    """Aulas de cada dia util da semana, com padrao e excecoes ja resolvidos.

    O filtro de unidade vem pronto do chamador com o prefixo `p.` (professores),
    que serve para as duas tabelas. `com_excecoes=False` devolve so o padrao
    vigente — e o que a gravacao compara para saber o que, naquela semana,
    realmente difere do padrao.
    """
    inicio_iso, fim_iso = inicio.isoformat(), fim.isoformat()

    comuns = [onde_professor]
    if so_ativos:
        comuns.append("p.ativo = 1")
    if so_visiveis:
        comuns.append("p.grade_visivel = 1")

    def condicoes(alias):
        partes, valores = list(comuns), list(parametros)
        if professor_id is not None:
            partes.append(f"{alias}.professor_id = ?")
            valores.append(professor_id)
        return " AND ".join(partes), valores

    onde_g, valores_g = condicoes("g")
    modelos = conexao.execute(
        f"""
        SELECT g.professor_id, g.dia_semana, g.horario_id, g.turma, g.disciplina,
               g.sala_id, g.vigencia_inicio, g.vigencia_fim,
               p.nome AS professor, p.matricula AS matricula, s.nome AS sala
          FROM aulas_grade g
          JOIN professores p ON p.id = g.professor_id
     LEFT JOIN salas s       ON s.id = g.sala_id
         WHERE {onde_g}
           AND g.vigencia_inicio <= ?
           AND (g.vigencia_fim IS NULL OR g.vigencia_fim >= ?)
        """,
        (*valores_g, fim_iso, inicio_iso),
    ).fetchall()

    # a vigencia pode virar no meio da semana (troca marcada para uma quarta),
    # entao o padrao e resolvido dia a dia, nao uma vez para a semana toda
    aulas = {}
    for indice in range(DIAS_UTEIS):
        data_iso = (inicio + timedelta(days=indice)).isoformat()
        for linha in modelos:
            if linha["dia_semana"] != indice or linha["vigencia_inicio"] > data_iso:
                continue
            if linha["vigencia_fim"] and linha["vigencia_fim"] < data_iso:
                continue
            aulas[(data_iso, linha["professor_id"], linha["horario_id"])] = {
                "data_aula": data_iso, "dia_semana": indice,
                "horario_id": linha["horario_id"],
                "professor_id": linha["professor_id"],
                "professor": linha["professor"], "matricula": linha["matricula"],
                "turma": linha["turma"], "disciplina": linha["disciplina"],
                "sala_id": linha["sala_id"], "sala": linha["sala"],
                "excecao": False,
            }

    if com_excecoes:
        onde_e, valores_e = condicoes("e")
        for linha in conexao.execute(
            f"""
            SELECT e.data_aula, e.professor_id, e.horario_id, e.turma, e.disciplina,
                   e.sala_id, e.cancelada,
                   p.nome AS professor, p.matricula AS matricula, s.nome AS sala
              FROM aulas_semana e
              JOIN professores p ON p.id = e.professor_id
         LEFT JOIN salas s       ON s.id = e.sala_id
             WHERE {onde_e} AND e.data_aula BETWEEN ? AND ?
            """,
            (*valores_e, inicio_iso, fim_iso),
        ):
            chave = (linha["data_aula"], linha["professor_id"], linha["horario_id"])
            if linha["cancelada"]:
                aulas.pop(chave, None)   # a excecao que apaga a aula do padrao
                continue
            aulas[chave] = {
                "data_aula": linha["data_aula"],
                "dia_semana": regras.para_data(linha["data_aula"]).weekday(),
                "horario_id": linha["horario_id"],
                "professor_id": linha["professor_id"],
                "professor": linha["professor"], "matricula": linha["matricula"],
                "turma": linha["turma"], "disciplina": linha["disciplina"],
                "sala_id": linha["sala_id"], "sala": linha["sala"],
                "excecao": True,
            }

    return sorted(aulas.values(), key=lambda aula: (
        (aula["professor"] or "").casefold(), aula["dia_semana"], aula["horario_id"]))


@app.get("/api/laboratorios")
def listar_laboratorios():
    incluir_inativos = request.args.get("todos") == "1" and tem_acesso_de_gestao()
    onde, parametros = filtro_da_tela()
    sql = f"SELECT * FROM laboratorios WHERE {onde}"
    if not incluir_inativos:
        sql += " AND ativo = 1"
    sql += " ORDER BY nome COLLATE NOCASE"
    return jsonify(banco.linhas_para_lista(db().execute(sql, parametros).fetchall()))


@app.get("/api/horarios")
def listar_horarios():
    onde, parametros = filtro_da_tela()
    linhas = db().execute(
        f"SELECT * FROM horarios WHERE {onde} "
        "ORDER BY CASE turno WHEN 'manha' THEN 1 WHEN 'tarde' THEN 2 ELSE 3 END, ordem",
        parametros,
    ).fetchall()
    return jsonify(banco.linhas_para_lista(linhas))


@app.get("/api/salas")
def listar_salas():
    """Salas de aula da escola — usadas na grade, nao na reserva de laboratorio."""
    incluir_inativas = request.args.get("todas") == "1" and tem_acesso_de_gestao()
    onde, parametros = filtro_da_tela()
    sql = f"SELECT * FROM salas WHERE {onde}"
    if not incluir_inativas:
        sql += " AND ativo = 1"
    sql += " ORDER BY nome COLLATE NOCASE"
    return jsonify(banco.linhas_para_lista(db().execute(sql, parametros).fetchall()))


@app.get("/api/regras")
def listar_regras():
    conexao = db()
    # o teto de aulas seguidas e o da escola, a nao ser que quem esta logado
    # tenha excecao — ai a tela dele ja monta a selecao com o limite maior
    geral = banco.ler_config_int(conexao, "max_aulas_seguidas")
    meu_limite, minha_excecao = geral, None
    minha_carencia_dispensada = False
    if session.get("professor_id"):
        meu_limite, geral, minha_excecao = regras.limite_de_aulas_seguidas(
            conexao, session["professor_id"])
        minha_carencia_dispensada = regras.carencia_dispensada(
            conexao, session["professor_id"])
    return jsonify({
        "antecedencia_maxima_dias": banco.ler_config_int(conexao, "antecedencia_maxima_dias"),
        "max_aulas_seguidas": geral,
        "meu_max_aulas_seguidas": meu_limite,
        "minha_excecao_aulas_seguidas": (
            {"max_aulas": minha_excecao["max_aulas"], "max_dias": minha_excecao["max_dias"]}
            if minha_excecao else None
        ),
        "carencia_dias": banco.ler_config_int(conexao, "carencia_dias"),
        "minha_carencia_dispensada": minha_carencia_dispensada,
        "carencia_escopo": banco.ler_config(conexao, "carencia_escopo"),
        "carencia_dias_letivos": banco.ler_config_bool(conexao, "carencia_dias_letivos"),
        "falta_conta_como_uso": banco.ler_config_bool(conexao, "falta_conta_como_uso"),
        "cancelamento_antecedencia_horas": banco.ler_config_int(
            conexao, "cancelamento_antecedencia_horas"),
        "permitir_fim_de_semana": banco.ler_config_bool(conexao, "permitir_fim_de_semana"),
        "tipos_aula": list(regras.TIPOS_AULA),
        "nome_escola": banco.ler_config(conexao, "nome_escola"),
    })


@app.get("/api/agenda")
def agenda():
    """Grade de um laboratorio: dias x horarios, a partir de uma data inicial."""
    conexao = db()
    try:
        laboratorio_id = int(request.args.get("laboratorio_id", 0))
    except ValueError:
        return jsonify({"erro": "Laboratório inválido."}), 400

    laboratorio = conexao.execute(
        "SELECT * FROM laboratorios WHERE id = ?", (laboratorio_id,)
    ).fetchone()
    if laboratorio is None:
        return jsonify({"erro": "Laboratório não encontrado."}), 404

    try:
        data_inicio = regras.para_data(request.args.get("inicio") or date.today().isoformat())
    except ValueError:
        return jsonify({"erro": "Data inicial inválida."}), 400

    permitir_fds = banco.ler_config_bool(conexao, "permitir_fim_de_semana")
    quantidade = 7 if permitir_fds else 5
    # comeca sempre na segunda-feira da semana escolhida
    inicio_semana = data_inicio - timedelta(days=data_inicio.weekday())

    dias = []
    for indice in range(quantidade):
        dia = inicio_semana + timedelta(days=indice)
        bloqueio = regras.buscar_bloqueio(conexao, dia, laboratorio_id)
        dias.append({
            "data": dia.isoformat(),
            "rotulo": DIAS_SEMANA[dia.weekday()],
            "rotulo_curto": DIAS_SEMANA_CURTO[dia.weekday()],
            "dia_mes": dia.strftime("%d/%m"),
            "hoje": dia == date.today(),
            "passado": dia < date.today(),
            "bloqueio": (bloqueio or {}).get("descricao") if bloqueio else None,
        })

    fim_semana = inicio_semana + timedelta(days=quantidade - 1)
    reservas = conexao.execute(
        """
        SELECT r.*, p.nome AS professor_nome, h.turno, h.ordem, h.inicio, h.fim
          FROM reservas r
          JOIN professores p ON p.id = r.professor_id
          JOIN horarios    h ON h.id = r.horario_id
         WHERE r.laboratorio_id = ? AND r.data BETWEEN ? AND ?
           AND r.status <> 'cancelada'
        """,
        (laboratorio_id, inicio_semana.isoformat(), fim_semana.isoformat()),
    ).fetchall()

    horarios = banco.linhas_para_lista(conexao.execute(
        "SELECT * FROM horarios ORDER BY CASE turno WHEN 'manha' THEN 1 "
        "WHEN 'tarde' THEN 2 ELSE 3 END, ordem"
    ).fetchall())

    def marcar(reserva):
        return {
            "id": reserva["id"],
            "professor": reserva["professor_nome"],
            "professor_id": reserva["professor_id"],
            "disciplina": reserva["disciplina"],
            "tipo_aula": reserva["tipo_aula"],
            "status": reserva["status"],
            "meu": reserva["professor_id"] == session.get("professor_id"),
            # so aparece quando a aula ocupada tem tamanho diferente da linha da grade
            "intervalo": f"{reserva['inicio']}–{reserva['fim']}",
        }

    # a aula reservada ocupa a propria linha da grade e tambem qualquer outra que
    # aconteca ao mesmo tempo (uma aula de 19:00–21:30 cobre a de 19:00–19:45)
    ocupacao = {}
    for reserva in reservas:
        ocupacao[f"{reserva['data']}|{reserva['horario_id']}"] = marcar(reserva)
    for reserva in reservas:
        for horario in horarios:
            if horario["id"] == reserva["horario_id"]:
                continue
            if regras.sobrepoe(horario["inicio"], horario["fim"],
                               reserva["inicio"], reserva["fim"]):
                ocupacao.setdefault(f"{reserva['data']}|{horario['id']}", marcar(reserva))

    return jsonify({
        "laboratorio": banco.linha_para_dict(laboratorio),
        # relogio do servidor: a tela apaga por conta propria as aulas de hoje
        # que ja comecaram, sem depender da hora do computador do professor
        "agora": datetime.now().replace(microsecond=0).isoformat(),
        "inicio_semana": inicio_semana.isoformat(),
        "semana_anterior": (inicio_semana - timedelta(days=7)).isoformat(),
        "semana_seguinte": (inicio_semana + timedelta(days=7)).isoformat(),
        "dias": dias,
        "horarios": horarios,
        "ocupacao": ocupacao,
    })


# --------------------------------------------------------------------------- #
# Reservas (professor)
# --------------------------------------------------------------------------- #
#
# Quem administra a agenda nao reserva nela: gestor local nunca teve como
# reservar (a conta dele nao e de professor) e o professor promovido a gestor
# perde a reserva enquanto o acesso de gestor estiver ativo. Tirando o acesso
# — ou desativando a conta de gestor — ele volta a reservar normalmente.

AVISO_GESTOR_NAO_RESERVA = (
    "Sua conta também administra o sistema, e quem administra a agenda não "
    "reserva laboratório. Para voltar a reservar, é preciso desativar o seu "
    "acesso de gestor."
)


def conta_de_gestor_do_professor(conexao, professor):
    """Conta de gestor ativa que pertence a este professor, ou None.

    O vinculo certo e `gestores.professor_id`, gravado quando alguem promove o
    professor. O e-mail entra como segunda pista, para a conta de gestor que
    foi cadastrada a mao com o mesmo endereco da pessoa — sem isso bastaria
    criar o gestor pelo formulario comum para escapar da regra.
    """
    if professor is None:
        return None
    email = (professor["email"] or "").strip()
    if not email:
        return conexao.execute(
            "SELECT * FROM gestores WHERE ativo = 1 AND professor_id = ?",
            (professor["id"],),
        ).fetchone()
    return conexao.execute(
        "SELECT * FROM gestores WHERE ativo = 1 AND "
        "(professor_id = ? OR (email IS NOT NULL AND email <> '' "
        "                      AND email = ? COLLATE NOCASE))",
        (professor["id"], email),
    ).fetchone()


def professor_administra(conexao, professor_id):
    """O professor logado tambem tem acesso de gestor?"""
    professor = conexao.execute(
        "SELECT * FROM professores WHERE id = ?", (professor_id,)
    ).fetchone()
    return conta_de_gestor_do_professor(conexao, professor) is not None


@app.post("/api/reservas")
@requer_professor
def criar_reserva():
    conexao = db()
    dados = request.get_json(silent=True) or {}
    professor_id = session["professor_id"]

    if professor_administra(conexao, professor_id):
        return jsonify({"erro": AVISO_GESTOR_NAO_RESERVA}), 403

    try:
        laboratorio_id = int(dados.get("laboratorio_id"))
        horario_ids = [int(valor) for valor in dados.get("horario_ids", [])]
    except (TypeError, ValueError):
        return jsonify({
            "erro": "Dados incompletos.",
            "erros": ["Laboratório ou horário inválido."],
        }), 400

    data_texto = str(dados.get("data", "")).strip()
    disciplina = str(dados.get("disciplina", "")).strip()
    tipo_aula = str(dados.get("tipo_aula", "")).strip()
    observacao = str(dados.get("observacao", "")).strip()
    qtd_alunos = dados.get("qtd_alunos") or None

    erros = []
    if not disciplina:
        erros.append("Informe a disciplina que será ministrada.")
    if not tipo_aula:
        erros.append("Informe o tipo de aula.")
    erros += regras.validar_reserva(
        conexao, professor_id, laboratorio_id, data_texto, horario_ids, qtd_alunos
    )
    if erros:
        return jsonify({"erro": erros[0], "erros": erros}), 400

    grupo = uuid.uuid4().hex[:12]
    data_iso = regras.para_data(data_texto).isoformat()
    try:
        for horario_id in horario_ids:
            conexao.execute(
                """
                INSERT INTO reservas (laboratorio_id, professor_id, horario_id, data,
                                      disciplina, tipo_aula, qtd_alunos, observacao,
                                      status, grupo, criado_em)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ativa', ?, ?)
                """,
                (laboratorio_id, professor_id, horario_id, data_iso,
                 disciplina, tipo_aula, qtd_alunos, observacao, grupo, banco.agora()),
            )

        # O indice unico do banco so pega o mesmo horario_id; aulas de tamanhos
        # diferentes que se cruzam passam por ele. Como o INSERT acima ja segurou
        # a trava de escrita, conferir aqui fecha a janela entre dois professores
        # confirmando ao mesmo tempo.
        choque = regras.choque_do_grupo(conexao, grupo)
        if choque:
            conexao.rollback()
            return jsonify({
                "erro": choque,
                "erros": [choque],
            }), 409

        conexao.commit()
    except Exception:
        conexao.rollback()
        return jsonify({
            "erro": "Alguém reservou esse horário agora há pouco. Atualize a agenda.",
            "erros": ["Alguém reservou esse horário agora há pouco. Atualize a agenda."],
        }), 409

    return jsonify({"ok": True, "grupo": grupo, "aulas": len(horario_ids)}), 201


@app.get("/api/minhas-reservas")
@requer_professor
def minhas_reservas():
    linhas = db().execute(
        """
        SELECT r.*, l.nome AS laboratorio_nome, h.inicio, h.fim, h.turno, h.ordem
          FROM reservas r
          JOIN laboratorios l ON l.id = r.laboratorio_id
          JOIN horarios     h ON h.id = r.horario_id
         WHERE r.professor_id = ?
         ORDER BY r.data DESC, h.ordem
        """,
        (session["professor_id"],),
    ).fetchall()
    return jsonify(banco.linhas_para_lista(linhas))


@app.post("/api/reservas/<int:reserva_id>/cancelar")
@requer_professor
def cancelar_reserva(reserva_id):
    conexao = db()
    reserva = conexao.execute(
        """
        SELECT r.*, h.inicio FROM reservas r
          JOIN horarios h ON h.id = r.horario_id
         WHERE r.id = ? AND r.professor_id = ?
        """,
        (reserva_id, session["professor_id"]),
    ).fetchone()
    if reserva is None:
        return jsonify({"erro": "Reserva não encontrada."}), 404

    permitido, motivo = regras.pode_cancelar(conexao, reserva)
    if not permitido:
        return jsonify({"erro": motivo}), 400

    conexao.execute("UPDATE reservas SET status = 'cancelada' WHERE id = ?", (reserva_id,))
    conexao.commit()
    return jsonify({"ok": True})


@app.get("/api/disponibilidade")
@requer_professor
def disponibilidade():
    """Diz ao professor se ele esta em carencia e quando volta a poder reservar."""
    conexao = db()
    try:
        laboratorio_id = int(request.args.get("laboratorio_id", 0))
        data_texto = request.args.get("data") or date.today().isoformat()
        data_alvo = regras.para_data(data_texto)
    except ValueError:
        return jsonify({"erro": "Parâmetros inválidos."}), 400

    motivo = regras.verificar_carencia(
        conexao, session["professor_id"], laboratorio_id, data_alvo
    )
    liberada = None
    if motivo:
        proxima = regras.proxima_data_liberada(
            conexao, session["professor_id"], laboratorio_id, data_alvo
        )
        liberada = proxima.isoformat() if proxima else None
    return jsonify({"em_carencia": bool(motivo), "motivo": motivo, "liberada_em": liberada})


# --------------------------------------------------------------------------- #
# Alocacao de computadores: o professor diz quem sentou em qual maquina
# --------------------------------------------------------------------------- #
#
# A aula acontece assim: o professor reserva o laboratorio (tabela `reservas`),
# da a aula e, no fim, registra a distribuicao da turma pelos computadores. Esse
# registro vira uma linha em `sessoes_laboratorio` mais uma linha por cadeira
# ocupada em `alocacoes_computador` — e e o que o gestor le depois no historico.
#
# Quantas maquinas o laboratorio tem sai de `laboratorios.equipamentos`, que o
# gestor ja cadastra. O professor pode ajustar esse numero na propria aula
# (maquina em manutencao, laboratorio dividido), sem mexer no cadastro.

def _turmas_visiveis(conexao):
    """Turmas conhecidas da escola: as criadas pelo gestor, as que tem aluno e
    as que estao na grade.

    A grade entra porque a turma costuma existir no horario montado pelo gestor
    antes de alguem cadastrar os alunos dela — assim o nome nao precisa ser
    redigitado com outra grafia. `turmas` entra pelo mesmo motivo, um passo
    antes: e a turma que o gestor acabou de abrir e que ainda nao tem nem lista
    nem aula. Serve as duas telas: `filtro_da_tela` ja devolve a escola do
    professor ou a unidade em foco do gestor.
    """
    onde_aluno, valores_aluno = filtro_da_tela()
    turmas = {
        linha["turma"] for linha in conexao.execute(
            f"SELECT DISTINCT turma FROM alunos WHERE {onde_aluno} AND ativo = 1",
            valores_aluno,
        ) if linha["turma"]
    }

    onde_turma, valores_turma = filtro_da_tela()
    turmas.update(
        linha["nome"] for linha in conexao.execute(
            f"SELECT nome FROM turmas WHERE {onde_turma} AND ativo = 1",
            valores_turma,
        ) if linha["nome"]
    )

    onde_grade, valores_grade = filtro_da_tela("p.")
    turmas.update(
        linha["turma"] for linha in conexao.execute(
            f"""
            SELECT DISTINCT g.turma FROM aulas_grade g
              JOIN professores p ON p.id = g.professor_id
             WHERE {onde_grade} AND g.turma IS NOT NULL AND g.turma <> ''
            """,
            valores_grade,
        ) if linha["turma"]
    )
    return sorted(turmas, key=banco.chave_de_nome)


def _computadores_do_laboratorio(laboratorio):
    """Quantas maquinas a aula assume por padrao.

    Vem de `equipamentos`; laboratorio sem equipamento cadastrado (uma quadra,
    a biblioteca) nao propoe nenhuma — o professor digita quantas usou.
    """
    return max(0, min(int(laboratorio["equipamentos"] or 0), banco.MAX_COMPUTADORES))


def _reserva_do_professor(conexao, reserva_id):
    """A reserva pedida, se ela for mesmo do professor logado."""
    return conexao.execute(
        """
        SELECT r.*, l.nome AS laboratorio_nome, l.equipamentos, l.capacidade,
               h.inicio, h.fim, h.turno, h.ordem
          FROM reservas r
          JOIN laboratorios l ON l.id = r.laboratorio_id
          JOIN horarios     h ON h.id = r.horario_id
         WHERE r.id = ? AND r.professor_id = ?
        """,
        (reserva_id, session["professor_id"]),
    ).fetchone()


def _turma_sugerida(conexao, reserva):
    """Turma que o professor tem naquele dia e horario, segundo a grade.

    Poupa a escolha na maioria das aulas: a grade ja sabe que as 07:00 de terca
    aquele professor esta com o 2o A. A excecao daquela data ganha do padrao.
    """
    excecao = conexao.execute(
        """
        SELECT turma FROM aulas_semana
         WHERE data_aula = ? AND professor_id = ? AND horario_id = ? AND cancelada = 0
        """,
        (reserva["data"], reserva["professor_id"], reserva["horario_id"]),
    ).fetchone()
    if excecao and excecao["turma"]:
        return excecao["turma"]

    padrao = conexao.execute(
        """
        SELECT turma FROM aulas_grade
         WHERE professor_id = ? AND dia_semana = ? AND horario_id = ?
           AND vigencia_inicio <= ? AND (vigencia_fim IS NULL OR vigencia_fim >= ?)
         ORDER BY vigencia_inicio DESC LIMIT 1
        """,
        (reserva["professor_id"], regras.para_data(reserva["data"]).weekday(),
         reserva["horario_id"], reserva["data"], reserva["data"]),
    ).fetchone()
    return padrao["turma"] if padrao and padrao["turma"] else ""


def _sessao_publica(conexao, sessao):
    """Uma aula registrada, pronta para a tela: cabecalho + maquinas."""
    dados = banco.linha_para_dict(sessao)
    dados["computadores"] = banco.computadores_da_sessao(
        conexao, sessao["id"], sessao["qtd_computadores"]
    )
    dados["total_alunos"] = sum(len(maquina["alunos"]) for maquina in dados["computadores"])
    dados["computadores_usados"] = sum(
        1 for maquina in dados["computadores"] if maquina["alunos"]
    )
    return dados


def _ler_alocacoes(conexao, dados, qtd_computadores, onde_unidade, parametros):
    """Valida o que a tela mandou e devolve as cadeiras a gravar.

    Devolve `(linhas, erro)`. As regras conferidas aqui — no maximo dois alunos
    por maquina, aluno em um computador so, maquina dentro do numero declarado —
    valem mesmo que alguem monte o pedido por fora da tela.

    O aluno chega identificado de duas formas: pelo `aluno_id` (a tela da aula,
    que parte da lista da turma) ou pela `matricula` (a tela do projeto, onde o
    professor digita a matricula porque o grupo mistura turmas). As duas caem no
    mesmo cadastro e obedecem as mesmas travas.
    """
    enviado = dados.get("alocacoes")
    if not isinstance(enviado, list):
        return None, "Envie a lista de computadores."

    linhas = []
    alunos_usados = {}
    nomes_usados = set()

    for item in enviado:
        if not isinstance(item, dict):
            return None, "Lista de computadores inválida."
        try:
            numero = int(item.get("computador"))
        except (TypeError, ValueError):
            return None, "Número de computador inválido."
        if numero < 1 or numero > qtd_computadores:
            return None, (f"O computador {numero} está fora do laboratório: "
                          f"esta aula tem {qtd_computadores} máquina(s).")

        ocupantes = item.get("alunos")
        if not isinstance(ocupantes, list):
            return None, f"Lista de alunos inválida no computador {numero}."
        if len(ocupantes) > banco.ALUNOS_POR_COMPUTADOR:
            return None, (f"O computador {numero} está com {len(ocupantes)} alunos. "
                          f"Cada máquina comporta no máximo "
                          f"{banco.ALUNOS_POR_COMPUTADOR}.")

        for posicao, ocupante in enumerate(ocupantes, start=1):
            if not isinstance(ocupante, dict):
                return None, f"Aluno inválido no computador {numero}."
            aluno_id = ocupante.get("aluno_id") or ocupante.get("id")
            nome = banco.texto_limpo(ocupante.get("nome"))
            matricula = banco.so_digitos_ou_texto(ocupante.get("matricula"))

            if not aluno_id and matricula:
                achado = banco.aluno_por_matricula(
                    conexao, matricula, onde_unidade, parametros
                )
                if achado is not None:
                    aluno_id = achado["id"]
                elif not nome:
                    return None, (f"Nenhum aluno desta escola tem a matrícula "
                                  f"{matricula} (computador {numero}).")
                # com nome e sem cadastro e o registro antigo de quem saiu da
                # escola: o professor precisa poder corrigir aquela ocorrencia
                # sem perder quem estava la (o mesmo caso tratado logo abaixo)

            if aluno_id:
                aluno = conexao.execute(
                    f"SELECT id, nome, matricula FROM alunos "
                    f"WHERE id = ? AND {onde_unidade}",
                    (aluno_id, *parametros),
                ).fetchone()
                if aluno is None:
                    return None, "Um dos alunos escolhidos não é desta escola."
                aluno_id = aluno["id"]
                nome = aluno["nome"]
                matricula = aluno["matricula"] or matricula
                if aluno_id in alunos_usados:
                    return None, (f"{nome} está em dois computadores "
                                  f"({alunos_usados[aluno_id]} e {numero}).")
                alunos_usados[aluno_id] = numero
            else:
                # Cadeira sem `aluno_id`: e o registro antigo de quem saiu da
                # escola. A ficha foi excluida, mas `aluno_nome` sobreviveu no
                # historico, e o professor precisa poder corrigir aquela aula
                # sem perder o nome de quem estava la.
                aluno_id = None

            if not nome:
                return None, f"Aluno sem nome no computador {numero}."

            chave = banco.chave_de_nome(nome)
            if chave in nomes_usados:
                return None, f"{nome} aparece duas vezes na alocação."
            nomes_usados.add(chave)

            linhas.append((numero, posicao, aluno_id, nome, matricula or None))

    return linhas, None


@app.get("/api/turmas")
@requer_acesso
def listar_turmas():
    """Turmas que a tela do professor oferece na alocação e no projeto.

    Vale também para quem administra: o painel do projeto abre para o gestor em
    leitura, e ele já enxerga o cadastro de alunos inteiro do lado dele.
    """
    return jsonify({"turmas": _turmas_visiveis(db())})


@app.get("/api/alunos")
@requer_acesso
def listar_alunos_da_turma():
    turma = banco.texto_limpo(request.args.get("turma"))
    if not turma:
        return jsonify({"turma": "", "alunos": []})
    onde, parametros = filtro_da_tela()
    return jsonify({
        "turma": turma,
        "alunos": banco.alunos_da_turma(db(), turma, onde, parametros),
    })


@app.get("/api/aulas/<int:reserva_id>/computadores")
@requer_professor
def abrir_alocacao(reserva_id):
    """Tudo que a tela de alocação precisa de uma vez: a aula, as máquinas,
    a turma sugerida pela grade, os alunos dela e o que já foi registrado."""
    conexao = db()
    reserva = _reserva_do_professor(conexao, reserva_id)
    if reserva is None:
        return jsonify({"erro": "Aula não encontrada."}), 404

    sessao = conexao.execute(
        "SELECT * FROM sessoes_laboratorio WHERE reserva_id = ?", (reserva_id,)
    ).fetchone()

    turma = (sessao["turma"] if sessao and sessao["turma"]
             else _turma_sugerida(conexao, reserva))
    onde, parametros = filtro_da_tela()

    if sessao is not None:
        qtd = sessao["qtd_computadores"]
        computadores = banco.computadores_da_sessao(conexao, sessao["id"], qtd)
    else:
        qtd = _computadores_do_laboratorio(reserva)
        computadores = [{"numero": numero, "alunos": []}
                        for numero in range(1, qtd + 1)]

    return jsonify({
        "reserva": banco.linha_para_dict(reserva),
        "sessao": banco.linha_para_dict(sessao),
        "qtd_computadores": qtd,
        "max_computadores": banco.MAX_COMPUTADORES,
        "alunos_por_computador": banco.ALUNOS_POR_COMPUTADOR,
        "computadores": computadores,
        "turma": turma,
        "turmas": _turmas_visiveis(conexao),
        "alunos": banco.alunos_da_turma(conexao, turma, onde, parametros) if turma else [],
    })


@app.post("/api/aulas/<int:reserva_id>/computadores")
@requer_professor
def salvar_alocacao(reserva_id):
    """Grava (ou corrige) o registro de uso dos computadores de uma aula."""
    conexao = db()
    reserva = _reserva_do_professor(conexao, reserva_id)
    if reserva is None:
        return jsonify({"erro": "Aula não encontrada."}), 404
    if reserva["status"] == "cancelada":
        return jsonify({"erro": "Esta aula foi cancelada — não há uso a registrar."}), 400

    dados = request.get_json(silent=True) or {}
    qtd = _inteiro(dados, "qtd_computadores", _computadores_do_laboratorio(reserva))
    if qtd < 1 or qtd > banco.MAX_COMPUTADORES:
        return jsonify({
            "erro": f"Informe de 1 a {banco.MAX_COMPUTADORES} computadores."
        }), 400

    onde, parametros = filtro_da_tela()
    linhas, erro = _ler_alocacoes(conexao, dados, qtd, onde, parametros)
    if erro:
        return jsonify({"erro": erro}), 400
    if not linhas:
        return jsonify({"erro": "Aloque pelo menos um aluno antes de salvar."}), 400

    turma = banco.texto_limpo(dados.get("turma")) or _turma_sugerida(conexao, reserva)
    disciplina = banco.texto_limpo(dados.get("disciplina")) or reserva["disciplina"] or ""
    observacao = _texto(dados, "observacao")[:400]
    unidade_id = unidade_do_professor()

    sessao = conexao.execute(
        "SELECT id FROM sessoes_laboratorio WHERE reserva_id = ?", (reserva_id,)
    ).fetchone()

    if sessao is None:
        cursor = conexao.execute(
            """
            INSERT INTO sessoes_laboratorio
                   (reserva_id, laboratorio_id, professor_id, horario_id, data_aula,
                    turma, disciplina, observacao, qtd_computadores, unidade_id,
                    registrado_em)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (reserva_id, reserva["laboratorio_id"], reserva["professor_id"],
             reserva["horario_id"], reserva["data"], turma, disciplina, observacao,
             qtd, unidade_id, banco.agora()),
        )
        sessao_id = cursor.lastrowid
        novo = True
    else:
        sessao_id = sessao["id"]
        conexao.execute(
            """
            UPDATE sessoes_laboratorio
               SET turma = ?, disciplina = ?, observacao = ?, qtd_computadores = ?,
                   atualizado_em = ?
             WHERE id = ?
            """,
            (turma, disciplina, observacao, qtd, banco.agora(), sessao_id),
        )
        conexao.execute("DELETE FROM alocacoes_computador WHERE sessao_id = ?", (sessao_id,))
        novo = False

    conexao.executemany(
        """
        INSERT INTO alocacoes_computador
               (sessao_id, computador, posicao, aluno_id, aluno_nome, aluno_matricula)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        [(sessao_id, *linha) for linha in linhas],
    )

    # registrar o uso e a forma natural de dizer "esta aula aconteceu": a
    # reserva sai de "ativa" para "realizada" sozinha. Aula futura fica como
    # esta — o professor pode montar a dupla antes e o dia ainda nao chegou.
    if reserva["status"] == "ativa" and reserva["data"] <= date.today().isoformat():
        conexao.execute(
            "UPDATE reservas SET status = 'realizada' WHERE id = ?", (reserva_id,)
        )

    conexao.commit()
    return jsonify({
        "ok": True, "sessao_id": sessao_id, "alunos": len(linhas), "novo": novo
    }), (201 if novo else 200)


@app.delete("/api/aulas/<int:reserva_id>/computadores")
@requer_professor
def apagar_alocacao(reserva_id):
    """Desfaz o registro de uma aula (as cadeiras somem junto, por cascata)."""
    conexao = db()
    if _reserva_do_professor(conexao, reserva_id) is None:
        return jsonify({"erro": "Aula não encontrada."}), 404
    apagadas = conexao.execute(
        "DELETE FROM sessoes_laboratorio WHERE reserva_id = ?", (reserva_id,)
    ).rowcount
    conexao.commit()
    return jsonify({"ok": True, "apagadas": apagadas})


@app.get("/api/meus-registros-computadores")
@requer_professor
def meus_registros_computadores():
    """Ids das reservas que o professor já registrou, para marcar na lista."""
    linhas = db().execute(
        """
        SELECT reserva_id, id AS sessao_id, qtd_computadores,
               (SELECT COUNT(*) FROM alocacoes_computador a WHERE a.sessao_id = s.id)
                   AS total_alunos
          FROM sessoes_laboratorio s
         WHERE professor_id = ? AND reserva_id IS NOT NULL
        """,
        (session["professor_id"],),
    ).fetchall()
    return jsonify({linha["reserva_id"]: dict(linha) for linha in linhas})



# --------------------------------------------------------------------------- #
# Reserva do intervalo: elaboracao de projetos
# --------------------------------------------------------------------------- #
#
# A escola tem um intervalo de uma hora depois da 5a aula, e nele cabe uma
# reserva de 50 minutos. Como o intervalo nao e uma aula da grade, esta reserva
# nao passa por `reservas`/`horarios`: ela guarda a propria hora e mora em
# `reservas_projeto`.
#
# Quem reserva e quem registra:
#   - o professor reserva para si e registra os computadores da sua reserva;
#   - o gestor reserva para qualquer professor da escola (e quem organiza a
#     agenda dos projetos) e enxerga tudo.
# As duas telas conversam com os mesmos endpoints; o que muda e o alcance.

LIMITE_NOME_PROJETO = 120


def _unidade_da_tela():
    """A escola que a tela enxerga: a do professor ou a que o gestor tem em foco."""
    if tem_acesso_de_gestao():
        return unidade_em_foco()
    return unidade_do_professor()


def _janelas_da_tela(conexao):
    return banco.janelas_de_intervalo(conexao, _unidade_da_tela())


def _projeto_com_detalhes(conexao, projeto_id):
    """A reserva do intervalo com o nome do laboratorio, do professor e do registro."""
    return conexao.execute(
        """
        SELECT rp.*, l.nome AS laboratorio_nome, l.equipamentos, l.capacidade,
               p.nome AS professor_nome, p.matricula AS professor_matricula,
               s.id AS sessao_id,
               (SELECT COUNT(*) FROM alocacoes_computador a WHERE a.sessao_id = s.id)
                   AS total_alunos,
               (SELECT COUNT(DISTINCT a.computador) FROM alocacoes_computador a
                 WHERE a.sessao_id = s.id) AS computadores_usados
          FROM reservas_projeto rp
          JOIN laboratorios l ON l.id = rp.laboratorio_id
          JOIN professores  p ON p.id = rp.professor_id
     LEFT JOIN sessoes_laboratorio s ON s.projeto_id = rp.id
         WHERE rp.id = ?
        """,
        (projeto_id,),
    ).fetchone()


def _pode_mexer_no_projeto(projeto):
    """Gestor mexe em qualquer reserva da escola; professor, so na dele."""
    if tem_acesso_de_gestao():
        return True
    return projeto["professor_id"] == session.get("professor_id")


def _projeto_ou_erro(conexao, projeto_id, exigir_dono=True):
    """Devolve `(projeto, resposta_de_erro)` — so um dos dois vem preenchido."""
    projeto = _projeto_com_detalhes(conexao, projeto_id)
    if projeto is None:
        return None, (jsonify({"erro": "Reserva não encontrada."}), 404)

    unidade = _unidade_da_tela()
    if unidade is not None and projeto["unidade_id"] != unidade:
        return None, (jsonify(ERRO_DE_OUTRA_UNIDADE), 403)
    if exigir_dono and not _pode_mexer_no_projeto(projeto):
        return None, (jsonify({
            "erro": "Só o professor responsável ou a gestão pode mexer nesta reserva."
        }), 403)
    return projeto, None


def _professor_responsavel(conexao, dados):
    """Quem responde pela reserva: o gestor escolhe; o professor e sempre ele mesmo.

    Devolve `(professor_id, erro)`.
    """
    if not tem_acesso_de_gestao():
        return session["professor_id"], None

    try:
        professor_id = int(dados.get("professor_id") or 0)
    except (TypeError, ValueError):
        return None, "Escolha o professor responsável."
    if not professor_id:
        return None, "Escolha o professor responsável."

    onde, parametros = filtro_de_unidade()
    professor = conexao.execute(
        f"SELECT id FROM professores WHERE id = ? AND ativo = 1 AND {onde}",
        (professor_id, *parametros),
    ).fetchone()
    if professor is None:
        return None, "Professor responsável não encontrado nesta escola."
    return professor["id"], None


@app.get("/api/projetos/janela")
@requer_acesso
def janela_de_projetos():
    """Tudo que o formulário precisa saber sobre o intervalo antes de reservar."""
    conexao = db()
    return jsonify({
        "janelas": _janelas_da_tela(conexao),
        "nome_padrao": banco.ler_config(conexao, "projeto_nome_padrao")
                       or banco.NOME_PROJETO_PADRAO,
        "aula_referencia": banco.ler_config_int(conexao, "projeto_aula_referencia"),
        "duracao": banco.ler_config_int(conexao, "projeto_duracao_min"),
        "intervalo": banco.ler_config_int(conexao, "projeto_intervalo_min"),
        "antecedencia_maxima_dias": banco.ler_config_int(
            conexao, "antecedencia_maxima_dias"),
        "sou_gestor": tem_acesso_de_gestao(),
        "meu_professor_id": session.get("professor_id"),
    })


@app.get("/api/projetos/ocupacao")
@requer_acesso
def ocupacao_do_intervalo():
    """Se aquele laboratório já tem projeto naquela data — antes de tentar salvar.

    A tela pergunta assim que o gestor escolhe laboratório e data, para o choque
    aparecer enquanto ele ainda está montando a reserva, e não depois de clicar
    em Reservar. A recusa de verdade continua sendo a do POST/PUT: isto aqui é
    só o aviso adiantado, com a mesma frase.
    """
    try:
        laboratorio_id = int(request.args.get("laboratorio_id") or 0)
    except (TypeError, ValueError):
        laboratorio_id = 0
    data_texto = str(request.args.get("data", "")).strip()
    if not laboratorio_id or not data_texto:
        return jsonify({"ocupado": None})

    try:
        ignorar_id = int(request.args.get("ignorar_id") or 0) or None
    except (TypeError, ValueError):
        ignorar_id = None

    try:
        regras.para_data(data_texto)
    except (ValueError, TypeError):
        return jsonify({"ocupado": None})

    conexao = db()
    onde, parametros = filtro_da_tela()
    laboratorio = conexao.execute(
        f"SELECT id FROM laboratorios WHERE id = ? AND {onde}",
        (laboratorio_id, *parametros),
    ).fetchone()
    if laboratorio is None:
        return jsonify({"ocupado": None})

    ocupado = regras.laboratorio_reservado_no_dia(
        conexao, laboratorio_id, data_texto, ignorar_id
    )
    if ocupado is None:
        return jsonify({"ocupado": None})
    return jsonify({
        "ocupado": banco.linha_para_dict(ocupado),
        "mensagem": regras.aviso_de_laboratorio_ocupado(ocupado),
    })


@app.get("/api/projetos")
@requer_acesso
def listar_projetos():
    """As reservas do intervalo da escola, da mais recente para a mais antiga.

    Todo mundo enxerga a agenda inteira — e assim que o professor descobre que o
    laboratorio ja esta tomado naquele dia. Mexer, so na propria (ou na gestao).
    """
    conexao = db()
    onde, parametros = filtro_da_tela("rp.")
    filtros = [onde]

    if request.args.get("de"):
        filtros.append("rp.data >= ?")
        parametros.append(request.args["de"])
    if request.args.get("ate"):
        filtros.append("rp.data <= ?")
        parametros.append(request.args["ate"])
    if request.args.get("laboratorio_id"):
        filtros.append("rp.laboratorio_id = ?")
        parametros.append(request.args["laboratorio_id"])
    if request.args.get("professor_id"):
        filtros.append("rp.professor_id = ?")
        parametros.append(request.args["professor_id"])
    if request.args.get("status"):
        filtros.append("rp.status = ?")
        parametros.append(request.args["status"])
    if request.args.get("meus") == "1" and session.get("professor_id"):
        filtros.append("rp.professor_id = ?")
        parametros.append(session["professor_id"])

    linhas = conexao.execute(
        f"""
        SELECT rp.*, l.nome AS laboratorio_nome, l.equipamentos,
               p.nome AS professor_nome, p.matricula AS professor_matricula,
               s.id AS sessao_id,
               (SELECT COUNT(*) FROM alocacoes_computador a WHERE a.sessao_id = s.id)
                   AS total_alunos,
               (SELECT COUNT(DISTINCT a.computador) FROM alocacoes_computador a
                 WHERE a.sessao_id = s.id) AS computadores_usados
          FROM reservas_projeto rp
          JOIN laboratorios l ON l.id = rp.laboratorio_id
          JOIN professores  p ON p.id = rp.professor_id
     LEFT JOIN sessoes_laboratorio s ON s.projeto_id = rp.id
         WHERE {' AND '.join(filtros)}
         ORDER BY rp.data DESC, rp.inicio DESC
         LIMIT 400
        """,
        parametros,
    ).fetchall()

    projetos = banco.linhas_para_lista(linhas)
    meu_id = session.get("professor_id")
    for projeto in projetos:
        projeto["meu"] = bool(meu_id) and projeto["professor_id"] == meu_id
        projeto["posso_editar"] = tem_acesso_de_gestao() or projeto["meu"]

    return jsonify({
        "projetos": projetos,
        "resumo": {
            "reservas": len(projetos),
            "ativas": sum(1 for p in projetos if p["status"] == "ativa"),
            "registradas": sum(1 for p in projetos if p["sessao_id"]),
            "alunos": sum(p["total_alunos"] or 0 for p in projetos),
        },
    })


@app.post("/api/projetos")
@requer_acesso
def criar_projeto():
    """Reserva o laboratório no intervalo: 50 minutos, um projeto, um responsável."""
    conexao = db()
    dados = request.get_json(silent=True) or {}

    professor_id, erro = _professor_responsavel(conexao, dados)
    if erro:
        return jsonify({"erro": erro, "erros": [erro]}), 400

    try:
        laboratorio_id = int(dados.get("laboratorio_id") or 0)
    except (TypeError, ValueError):
        laboratorio_id = 0
    if not laboratorio_id:
        aviso = "Escolha o laboratório."
        return jsonify({"erro": aviso, "erros": [aviso]}), 400

    data_texto = str(dados.get("data", "")).strip()
    projeto = (banco.texto_limpo(dados.get("projeto"))[:LIMITE_NOME_PROJETO]
               or banco.ler_config(conexao, "projeto_nome_padrao")
               or banco.NOME_PROJETO_PADRAO)
    observacao = str(dados.get("observacao", "")).strip()[:400]

    janelas = _janelas_da_tela(conexao)
    turno = str(dados.get("turno", "")).strip()
    janela = (next((j for j in janelas if j["turno"] == turno), None) if turno
              else next((j for j in janelas if j["cabe"]), None))
    if janela is None and janelas:
        aviso = "Esse turno não tem intervalo depois da 5ª aula."
        return jsonify({"erro": aviso, "erros": [aviso]}), 400

    erros = regras.validar_reserva_projeto(
        conexao, professor_id, laboratorio_id, data_texto, janela, projeto
    )
    if erros:
        return jsonify({"erro": erros[0], "erros": erros}), 400

    data_iso = regras.para_data(data_texto).isoformat()
    unidade_id = regras.unidade_do_laboratorio(conexao, laboratorio_id)
    try:
        cursor = conexao.execute(
            """
            INSERT INTO reservas_projeto (laboratorio_id, professor_id, data, turno,
                                          inicio, fim, projeto, observacao, status,
                                          unidade_id, criado_por, criado_em)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ativa', ?, ?, ?)
            """,
            (laboratorio_id, professor_id, data_iso, janela["turno"],
             janela["inicio"], janela["fim"], projeto, observacao, unidade_id,
             "gestor" if tem_acesso_de_gestao() else "professor", banco.agora()),
        )
        conexao.commit()
    except sqlite3.IntegrityError:
        # o indice unico e a trava contra dois pedidos ao mesmo tempo
        conexao.rollback()
        aviso = "Alguém reservou esse intervalo agora há pouco. Atualize a lista."
        return jsonify({"erro": aviso, "erros": [aviso]}), 409

    return jsonify({"ok": True, "id": cursor.lastrowid,
                    "inicio": janela["inicio"], "fim": janela["fim"]}), 201


@app.put("/api/projetos/<int:projeto_id>")
@requer_acesso
def atualizar_projeto(projeto_id):
    """Troca o nome do projeto, o laboratório, o responsável ou a data."""
    conexao = db()
    projeto, erro = _projeto_ou_erro(conexao, projeto_id)
    if erro:
        return erro
    if projeto["status"] == "cancelada":
        return jsonify({"erro": "Esta reserva está cancelada."}), 400

    dados = request.get_json(silent=True) or {}

    # o professor nao passa a reserva para outro: so a gestao remaneja
    if tem_acesso_de_gestao() and "professor_id" in dados:
        professor_id, aviso = _professor_responsavel(conexao, dados)
        if aviso:
            return jsonify({"erro": aviso, "erros": [aviso]}), 400
    else:
        professor_id = projeto["professor_id"]

    try:
        laboratorio_id = int(dados.get("laboratorio_id") or projeto["laboratorio_id"])
    except (TypeError, ValueError):
        laboratorio_id = projeto["laboratorio_id"]

    data_texto = str(dados.get("data") or projeto["data"]).strip()
    nome = (banco.texto_limpo(dados.get("projeto"))[:LIMITE_NOME_PROJETO]
            or projeto["projeto"])
    observacao = (str(dados.get("observacao") or "").strip()[:400]
                  if dados.get("observacao") is not None else projeto["observacao"])

    turno = str(dados.get("turno") or projeto["turno"]).strip()
    janela = next((j for j in _janelas_da_tela(conexao) if j["turno"] == turno), None)
    if janela is None:
        return jsonify({"erro": "Esse turno não tem intervalo depois da 5ª aula."}), 400

    erros = regras.validar_reserva_projeto(
        conexao, professor_id, laboratorio_id, data_texto, janela, nome,
        ignorar_id=projeto_id,
    )
    if erros:
        return jsonify({"erro": erros[0], "erros": erros}), 400

    try:
        conexao.execute(
            """
            UPDATE reservas_projeto
               SET laboratorio_id = ?, professor_id = ?, data = ?, turno = ?,
                   inicio = ?, fim = ?, projeto = ?, observacao = ?,
                   unidade_id = ?, atualizado_em = ?
             WHERE id = ?
            """,
            (laboratorio_id, professor_id, regras.para_data(data_texto).isoformat(),
             janela["turno"], janela["inicio"], janela["fim"], nome, observacao,
             regras.unidade_do_laboratorio(conexao, laboratorio_id), banco.agora(),
             projeto_id),
        )
        conexao.commit()
    except sqlite3.IntegrityError:
        conexao.rollback()
        return jsonify({
            "erro": "Esse laboratório já está reservado nesse intervalo."
        }), 409

    return jsonify({"ok": True})


@app.post("/api/projetos/<int:projeto_id>/status")
@requer_acesso
def mudar_status_projeto(projeto_id):
    """Cancelar (professor ou gestão) e marcar realizada/falta (só a gestão)."""
    conexao = db()
    projeto, erro = _projeto_ou_erro(conexao, projeto_id)
    if erro:
        return erro

    status = str((request.get_json(silent=True) or {}).get("status", "")).strip()
    if status not in regras.STATUS_VALIDOS:
        return jsonify({"erro": "Situação inválida."}), 400
    if status != "cancelada" and not tem_acesso_de_gestao():
        return jsonify({"erro": "Só a gestão muda a situação da reserva."}), 403

    # o professor respeita a antecedencia minima de cancelamento; a gestao
    # resolve o imprevisto de ultima hora, entao passa direto
    if status == "cancelada" and not tem_acesso_de_gestao():
        pode, motivo = regras.pode_cancelar_projeto(conexao, projeto)
        if not pode:
            return jsonify({"erro": motivo}), 400

    conexao.execute(
        "UPDATE reservas_projeto SET status = ?, atualizado_em = ? WHERE id = ?",
        (status, banco.agora(), projeto_id),
    )
    conexao.commit()
    return jsonify({"ok": True, "status": status})


@app.delete("/api/projetos/<int:projeto_id>")
@requer_gestor
def excluir_projeto(projeto_id):
    """Apaga a reserva e, por cascata, o registro de computadores dela."""
    conexao = db()
    _projeto, erro = _projeto_ou_erro(conexao, projeto_id)
    if erro:
        return erro
    conexao.execute("DELETE FROM reservas_projeto WHERE id = ?", (projeto_id,))
    conexao.commit()
    return jsonify({"ok": True})


# ---- Alunos por matricula: como o aluno entra no computador do projeto ---- #

@app.get("/api/alunos/matricula")
@requer_acesso
def buscar_aluno_por_matricula():
    """O aluno de uma matrícula exata — o que o professor digita no laboratório."""
    onde, parametros = filtro_da_tela()
    aluno = banco.aluno_por_matricula(
        db(), request.args.get("matricula"), onde, parametros
    )
    if aluno is None:
        return jsonify({"erro": "Nenhum aluno com essa matrícula nesta escola."}), 404
    return jsonify(banco.linha_para_dict(aluno))


@app.get("/api/alunos/buscar")
@requer_acesso
def procurar_alunos():
    """Sugestões enquanto o professor digita: casa por matrícula ou por nome."""
    termo = banco.texto_limpo(request.args.get("q"))
    if len(termo) < 2:
        return jsonify({"alunos": []})

    onde, parametros = filtro_da_tela()
    like = f"%{termo}%"
    linhas = db().execute(
        f"""
        SELECT id, nome, turma, numero, matricula, curso, data_nascimento
          FROM alunos
         WHERE {onde} AND ativo = 1
           AND (matricula LIKE ? OR nome LIKE ?)
         ORDER BY CASE WHEN matricula LIKE ? THEN 0 ELSE 1 END,
                  nome COLLATE NOCASE
         LIMIT 12
        """,
        (*parametros, like, like, f"{termo}%"),
    ).fetchall()
    return jsonify({"alunos": banco.linhas_para_lista(linhas)})


# ---- Registro dos computadores do projeto ---- #

@app.get("/api/projetos/<int:projeto_id>/computadores")
@requer_acesso
def abrir_computadores_do_projeto(projeto_id):
    """O painel de execução da reserva: as máquinas e quem já está sentado."""
    conexao = db()
    projeto, erro = _projeto_ou_erro(conexao, projeto_id, exigir_dono=False)
    if erro:
        return erro

    sessao = conexao.execute(
        "SELECT * FROM sessoes_laboratorio WHERE projeto_id = ?", (projeto_id,)
    ).fetchone()

    if sessao is not None:
        qtd = sessao["qtd_computadores"]
        computadores = banco.computadores_da_sessao(conexao, sessao["id"], qtd)
    else:
        qtd = _computadores_do_laboratorio(projeto)
        computadores = [{"numero": numero, "alunos": []}
                        for numero in range(1, qtd + 1)]

    return jsonify({
        "projeto": banco.linha_para_dict(projeto),
        "sessao": banco.linha_para_dict(sessao),
        "qtd_computadores": qtd,
        "max_computadores": banco.MAX_COMPUTADORES,
        "alunos_por_computador": banco.ALUNOS_POR_COMPUTADOR,
        "computadores": computadores,
        "posso_registrar": _pode_mexer_no_projeto(projeto),
    })


@app.post("/api/projetos/<int:projeto_id>/computadores")
@requer_acesso
def salvar_computadores_do_projeto(projeto_id):
    """Grava (ou corrige) quem usou cada computador durante o projeto."""
    conexao = db()
    projeto, erro = _projeto_ou_erro(conexao, projeto_id)
    if erro:
        return erro
    if projeto["status"] == "cancelada":
        return jsonify({
            "erro": "Esta reserva foi cancelada — não há uso a registrar."
        }), 400

    dados = request.get_json(silent=True) or {}
    qtd = _inteiro(dados, "qtd_computadores", _computadores_do_laboratorio(projeto))
    if qtd < 1 or qtd > banco.MAX_COMPUTADORES:
        return jsonify({
            "erro": f"Informe de 1 a {banco.MAX_COMPUTADORES} computadores."
        }), 400

    onde, parametros = filtro_da_tela()
    linhas, aviso = _ler_alocacoes(conexao, dados, qtd, onde, parametros)
    if aviso:
        return jsonify({"erro": aviso}), 400
    if not linhas:
        return jsonify({
            "erro": "Coloque pelo menos um aluno em um computador antes de salvar."
        }), 400

    observacao = _texto(dados, "observacao")[:400]
    sessao = conexao.execute(
        "SELECT id FROM sessoes_laboratorio WHERE projeto_id = ?", (projeto_id,)
    ).fetchone()

    if sessao is None:
        cursor = conexao.execute(
            """
            INSERT INTO sessoes_laboratorio
                   (projeto_id, laboratorio_id, professor_id, data_aula,
                    disciplina, observacao, qtd_computadores, unidade_id,
                    registrado_em)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (projeto_id, projeto["laboratorio_id"], projeto["professor_id"],
             projeto["data"], projeto["projeto"], observacao, qtd,
             projeto["unidade_id"], banco.agora()),
        )
        sessao_id = cursor.lastrowid
        novo = True
    else:
        sessao_id = sessao["id"]
        conexao.execute(
            """
            UPDATE sessoes_laboratorio
               SET disciplina = ?, observacao = ?, qtd_computadores = ?,
                   atualizado_em = ?
             WHERE id = ?
            """,
            (projeto["projeto"], observacao, qtd, banco.agora(), sessao_id),
        )
        conexao.execute(
            "DELETE FROM alocacoes_computador WHERE sessao_id = ?", (sessao_id,)
        )
        novo = False

    conexao.executemany(
        """
        INSERT INTO alocacoes_computador
               (sessao_id, computador, posicao, aluno_id, aluno_nome, aluno_matricula)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        [(sessao_id, *linha) for linha in linhas],
    )

    # registrar o uso e a forma natural de dizer "isto aconteceu" — igual a aula
    if projeto["status"] == "ativa" and projeto["data"] <= date.today().isoformat():
        conexao.execute(
            "UPDATE reservas_projeto SET status = 'realizada' WHERE id = ?",
            (projeto_id,),
        )

    conexao.commit()
    return jsonify({
        "ok": True, "sessao_id": sessao_id, "alunos": len(linhas), "novo": novo
    }), (201 if novo else 200)


@app.delete("/api/projetos/<int:projeto_id>/computadores")
@requer_acesso
def apagar_computadores_do_projeto(projeto_id):
    """Desfaz o registro (as cadeiras somem junto, por cascata)."""
    conexao = db()
    _projeto, erro = _projeto_ou_erro(conexao, projeto_id)
    if erro:
        return erro
    apagadas = conexao.execute(
        "DELETE FROM sessoes_laboratorio WHERE projeto_id = ?", (projeto_id,)
    ).rowcount
    conexao.commit()
    return jsonify({"ok": True, "apagadas": apagadas})

# --------------------------------------------------------------------------- #
# Relatorio do professor - o retrato do uso dele
# --------------------------------------------------------------------------- #

# Duracao da aula em minutos. Os horarios sao gravados como texto "HH:MM",
# entao a conta sai do proprio texto (SQLite nao tem tipo de hora).
MINUTOS_DA_AULA = (
    "(CAST(substr(h.fim, 1, 2) AS INTEGER) * 60 + CAST(substr(h.fim, 4, 2) AS INTEGER)) - "
    "(CAST(substr(h.inicio, 1, 2) AS INTEGER) * 60 + CAST(substr(h.inicio, 4, 2) AS INTEGER))"
)


@app.get("/api/meu-relatorio")
@requer_professor
def meu_relatorio():
    """Numeros do proprio professor: onde, quando e quanto ele usou os laboratorios.

    E o relatorio do gestor visto de dentro: aqui cada professor so enxerga as
    proprias aulas — dos colegas sai apenas a media da escola, para comparar.
    """
    conexao = db()
    hoje = date.today()
    de = request.args.get("de") or (hoje - timedelta(days=60)).isoformat()
    ate = request.args.get("ate") or (hoje + timedelta(days=60)).isoformat()
    try:
        if regras.para_data(de) > regras.para_data(ate):
            de, ate = ate, de
    except ValueError:
        return jsonify({"erro": "Período inválido."}), 400

    professor_id = session["professor_id"]
    meu_periodo = (professor_id, de, ate)

    totais = conexao.execute(
        f"""
        SELECT COUNT(*) AS total,
               SUM(CASE WHEN r.status = 'ativa'     THEN 1 ELSE 0 END) AS ativas,
               SUM(CASE WHEN r.status = 'realizada' THEN 1 ELSE 0 END) AS realizadas,
               SUM(CASE WHEN r.status = 'falta'     THEN 1 ELSE 0 END) AS faltas,
               SUM(CASE WHEN r.status = 'cancelada' THEN 1 ELSE 0 END) AS canceladas,
               -- so as que ainda vao acontecer; as antigas ficam com o gestor
               SUM(CASE WHEN r.status = 'ativa' AND r.data >= ? THEN 1 ELSE 0 END) AS proximas,
               SUM(CASE WHEN r.status <> 'cancelada' THEN {MINUTOS_DA_AULA} ELSE 0 END)
                   AS minutos,
               COUNT(DISTINCT CASE WHEN r.status <> 'cancelada' THEN r.data END) AS dias
          FROM reservas r JOIN horarios h ON h.id = r.horario_id
         WHERE r.professor_id = ? AND r.data BETWEEN ? AND ?
        """,
        (hoje.isoformat(), *meu_periodo),
    ).fetchone()

    por_laboratorio = conexao.execute(
        """
        SELECT l.nome, COUNT(r.id) AS aulas,
               SUM(CASE WHEN r.status = 'falta' THEN 1 ELSE 0 END) AS faltas,
               MAX(r.data) AS ultima
          FROM reservas r JOIN laboratorios l ON l.id = r.laboratorio_id
         WHERE r.professor_id = ? AND r.status <> 'cancelada'
           AND r.data BETWEEN ? AND ?
         GROUP BY l.id ORDER BY aulas DESC, l.nome COLLATE NOCASE
        """,
        meu_periodo,
    ).fetchall()

    por_turno = conexao.execute(
        """
        SELECT h.turno, COUNT(r.id) AS aulas
          FROM reservas r JOIN horarios h ON h.id = r.horario_id
         WHERE r.professor_id = ? AND r.status <> 'cancelada'
           AND r.data BETWEEN ? AND ?
         GROUP BY h.turno
        """,
        meu_periodo,
    ).fetchall()

    por_tipo = conexao.execute(
        """
        SELECT COALESCE(NULLIF(TRIM(r.tipo_aula), ''), 'Não informado') AS tipo,
               COUNT(r.id) AS aulas
          FROM reservas r
         WHERE r.professor_id = ? AND r.status <> 'cancelada'
           AND r.data BETWEEN ? AND ?
         GROUP BY tipo ORDER BY aulas DESC
        """,
        meu_periodo,
    ).fetchall()

    por_mes = conexao.execute(
        """
        SELECT substr(r.data, 1, 7) AS mes, COUNT(r.id) AS aulas
          FROM reservas r
         WHERE r.professor_id = ? AND r.status <> 'cancelada'
           AND r.data BETWEEN ? AND ?
         GROUP BY mes ORDER BY mes
        """,
        meu_periodo,
    ).fetchall()

    # Uso de todo mundo na escola, para o rodizio ficar a vista de todos: quem
    # reserva os laboratorios ja aparece pelo nome na agenda da semana, entao
    # aqui a mesma informacao so vem somada. Faltas e cancelamentos de cada um
    # continuam sendo assunto do gestor.
    unidade_id = unidade_do_professor()
    onde_unidade = "p.unidade_id = ?" if unidade_id is not None else "1 = 1"
    par_unidade = [unidade_id] if unidade_id is not None else []
    ranking = conexao.execute(
        f"""
        SELECT p.id AS professor_id, p.nome, p.disciplina, COUNT(r.id) AS aulas
          FROM professores p
          LEFT JOIN reservas r ON r.professor_id = p.id
               AND r.status <> 'cancelada' AND r.data BETWEEN ? AND ?
         WHERE p.ativo = 1 AND {onde_unidade}
         GROUP BY p.id ORDER BY aulas DESC, p.nome COLLATE NOCASE
        """,
        (de, ate, *par_unidade),
    ).fetchall()

    minhas_aulas = (totais["total"] or 0) - (totais["canceladas"] or 0)
    colegas = len(ranking)
    media = round(sum(linha["aulas"] for linha in ranking) / colegas, 1) if colegas else 0.0
    # posicao = quantos professores usaram mais do que eu, +1
    posicao = 1 + sum(
        1 for linha in ranking
        if linha["professor_id"] != professor_id and linha["aulas"] > minhas_aulas
    )

    por_professor = []
    for linha in ranking:
        item = banco.linha_para_dict(linha)
        item["sou_eu"] = linha["professor_id"] == professor_id
        item.pop("professor_id")
        por_professor.append(item)

    return jsonify({
        "periodo": {
            "de": de,
            "ate": ate,
            "dias_letivos": contar_dias_letivos(conexao, de, ate, unidade_id),
        },
        "totais": banco.linha_para_dict(totais),
        "aulas": minhas_aulas,
        "escola": {"media_por_professor": media, "professores": colegas, "posicao": posicao},
        "por_laboratorio": banco.linhas_para_lista(por_laboratorio),
        "por_professor": por_professor,
        "por_turno": banco.linhas_para_lista(por_turno),
        "por_tipo": banco.linhas_para_lista(por_tipo),
        "por_mes": banco.linhas_para_lista(por_mes),
    })


# --------------------------------------------------------------------------- #
# Leitura dos campos enviados pela tela
# --------------------------------------------------------------------------- #

def _texto(dados, campo, padrao=""):
    return str(dados.get(campo, padrao) or "").strip()


def _inteiro(dados, campo, padrao=0):
    try:
        return int(dados.get(campo) or padrao)
    except (TypeError, ValueError):
        return padrao


# Telefone e guardado so com numeros: DDD (2) + celular (9) = 11 digitos, ou
# DDD (2) + fixo (8) = 10. A tela ja mostra a mascara e impede letras; aqui a
# conferencia vale para qualquer chamada.
TELEFONE_DIGITOS = 11
TELEFONE_FIXO_DIGITOS = 10
TELEFONE_AVISO = ("Informe o WhatsApp com 11 números: DDD + o número "
                  "(ex.: (81)9 8458-7555).")
TELEFONE_FIXO_AVISO = ("Informe o telefone fixo com 10 números: DDD + o número "
                       "(ex.: (81) 3421-5566).")


def _so_digitos(valor):
    return "".join(c for c in str(valor or "") if c.isdigit())


def _telefone(dados, campo="telefone"):
    """Le o WhatsApp deixando so os digitos (aceita mascara antiga)."""
    return _so_digitos(dados.get(campo))


def _erro_telefone(telefone):
    """Mensagem de recusa, ou None quando os 11 numeros estao la."""
    return None if len(telefone) == TELEFONE_DIGITOS else TELEFONE_AVISO


def _telefone_em_uso(conexao, tabela, telefone, ignorar_id=None):
    """Diz se outro cadastro da mesma tabela ja usa esse WhatsApp.

    A comparacao e so entre digitos: um cadastro antigo gravado com mascara
    ("11 98765-0001") passaria como se fosse outro numero. `tabela` vem
    sempre de uma constante do codigo, nunca da tela.
    """
    sql = f"SELECT id, telefone FROM {tabela} WHERE telefone IS NOT NULL AND telefone <> ''"
    parametros = []
    if ignorar_id:
        sql += " AND id <> ?"
        parametros.append(ignorar_id)
    return any(_so_digitos(linha["telefone"]) == telefone
               for linha in conexao.execute(sql, parametros))


# --------------------------------------------------------------------------- #
# Conta do professor (o que ele mesmo pode mudar)
# --------------------------------------------------------------------------- #
#
# A matricula fica a cargo do gestor local: e definitiva e vale como registro
# escolar. O professor cuida do proprio nome, contato, foto e senha.

@app.get("/api/minha-conta")
@requer_professor
def minha_conta():
    conexao = db()
    professor = conexao.execute(
        "SELECT * FROM professores WHERE id = ?", (session["professor_id"],)
    ).fetchone()
    if professor is None:
        return jsonify({"erro": "Conta não encontrada."}), 404

    reservas = conexao.execute(
        """
        SELECT COUNT(*) AS total,
               SUM(CASE WHEN status = 'ativa' AND data >= ? THEN 1 ELSE 0 END) AS proximas
          FROM reservas WHERE professor_id = ? AND status <> 'cancelada'
        """,
        (date.today().isoformat(), session["professor_id"]),
    ).fetchone()

    dados = professor_publico(professor)
    dados["total_reservas"] = reservas["total"] or 0
    dados["proximas_reservas"] = reservas["proximas"] or 0
    return jsonify(dados)


@app.put("/api/minha-conta")
@requer_professor
def salvar_minha_conta():
    """Atualiza o nome e o contato: nome, e-mail e telefone."""
    conexao = db()
    dados = request.get_json(silent=True) or {}
    professor_id = session["professor_id"]

    nome = _texto(dados, "nome")
    email = _texto(dados, "email")
    telefone = _telefone(dados)

    if not nome:
        return jsonify({"erro": "Informe o nome."}), 400
    if email and "@" not in email:
        return jsonify({"erro": "Informe um e-mail válido."}), 400
    aviso = _erro_telefone(telefone)
    if aviso:
        return jsonify({"erro": aviso}), 400
    if _telefone_em_uso(conexao, "professores", telefone, professor_id):
        return jsonify({"erro": "Já existe outro professor com esse WhatsApp."}), 409
    if email and conexao.execute(
        "SELECT 1 FROM professores WHERE email = ? COLLATE NOCASE AND id <> ?",
        (email, professor_id),
    ).fetchone():
        return jsonify({"erro": "Já existe outro professor com esse e-mail."}), 409

    conexao.execute(
        "UPDATE professores SET nome = ?, email = ?, telefone = ? WHERE id = ?",
        (nome, email, telefone, professor_id),
    )
    conexao.commit()

    professor = conexao.execute(
        "SELECT * FROM professores WHERE id = ?", (professor_id,)
    ).fetchone()
    return jsonify({"ok": True, "professor": professor_publico(professor)})


EXTENSOES_FOTO = {
    b"\xff\xd8\xff": "jpg",
    b"\x89PNG\r\n\x1a\n": "png",
}


# Marcas que aparecem no cabecalho "ftyp" das fotos HEIC/HEIF do iPhone.
# Mesma lista que o decodificador (pillow-heif) aceita, para nao prometer
# suporte a um formato que a conversao vai recusar depois.
MARCAS_HEIC = {
    b"heic", b"heix", b"heim", b"heis",
    b"hevc", b"hevx", b"hevm", b"hevs",
    b"mif1", b"msf1",
}


def _extensao_da_foto(conteudo):
    """Confere a assinatura de bytes do arquivo (nao confia so na extensao
    enviada pelo navegador). Aceita JPEG, PNG e WEBP."""
    for assinatura, extensao in EXTENSOES_FOTO.items():
        if conteudo.startswith(assinatura):
            return extensao
    if conteudo[:4] == b"RIFF" and conteudo[8:12] == b"WEBP":
        return "webp"
    return None


def _e_heic(conteudo):
    """HEIC/HEIF sao caixas ISO-BMFF: os bytes 4 a 8 trazem 'ftyp' e logo
    depois vem a marca do formato."""
    return conteudo[4:8] == b"ftyp" and conteudo[8:12] in MARCAS_HEIC


def _heic_para_jpeg(conteudo):
    """Converte a foto do iPhone em JPEG. Respeita a orientacao gravada no
    EXIF (senao a foto tirada em pe aparece deitada) e vai baixando a
    qualidade enquanto o resultado passar do limite de tamanho. Devolve None
    quando nao da para converter."""
    if not HEIC_DISPONIVEL:
        return None
    try:
        imagem = Image.open(io.BytesIO(conteudo))
        # o pillow-heif nao gira os pixels: ele zera a tag de orientacao do
        # EXIF e devolve o valor original aqui, entao o giro fica por nossa
        # conta. Sem isso a selfie tirada em pe vira avatar deitado.
        giro = GIROS_ORIENTACAO.get(imagem.info.get("original_orientation"))
        imagem = imagem.transpose(giro) if giro else ImageOps.exif_transpose(imagem)
        imagem = imagem.convert("RGB")
        for qualidade in (88, 75, 60):
            saida = io.BytesIO()
            imagem.save(saida, format="JPEG", quality=qualidade, optimize=True)
            if saida.tell() <= LIMITE_FOTO:
                break
        return saida.getvalue()
    except Exception:
        # arquivo corrompido, HEIC exotico, imagem gigante demais para a
        # memoria: em qualquer caso o professor recebe o aviso para enviar
        # a foto em outro formato
        return None


def _apagar_foto_antiga(nome_arquivo):
    """Remove a foto do disco e tambem do R2, quando ele esta configurado."""
    armazenamento.apagar_foto(nome_arquivo)


@app.errorhandler(413)
def arquivo_grande_demais(_erro):
    """Rede de seguranca do teto do Flask. O navegador ja barra o arquivo grande
    antes de enviar, mas quem burlar a validacao (ou deixar uma aba antiga
    aberta) recebe o mesmo aviso em JSON, e nao a pagina de erro do servidor."""
    if request.path.startswith("/api/gestor/calendario-escolar"):
        return jsonify(
            {"erro": f"O PDF precisa ter até {LIMITE_CALENDARIO_MB} MB."}
        ), 413
    return jsonify(
        {"erro": f"A imagem precisa ter até {LIMITE_FOTO_MB} MB."}
    ), 413


@app.post("/api/minha-conta/foto")
@requer_professor
def enviar_minha_foto():
    arquivo = request.files.get("foto")
    if arquivo is None or not arquivo.filename:
        return jsonify({"erro": "Escolha uma imagem."}), 400

    conteudo = arquivo.read(LIMITE_FOTO + 1)
    if len(conteudo) > LIMITE_FOTO:
        return jsonify(
            {"erro": f"A imagem precisa ter até {LIMITE_FOTO_MB} MB."}
        ), 400

    extensao = _extensao_da_foto(conteudo)
    if extensao is None and _e_heic(conteudo):
        convertido = _heic_para_jpeg(conteudo)
        if convertido is None:
            return jsonify({
                "erro": "Não foi possível converter essa foto do iPhone. "
                        "Salve como JPEG e envie de novo."
            }), 400
        conteudo = convertido
        extensao = "jpg"
    if extensao is None:
        return jsonify(
            {"erro": "Envie uma imagem JPEG, PNG, WEBP ou HEIC."}
        ), 400

    conexao = db()
    professor_id = session["professor_id"]
    professor = conexao.execute(
        "SELECT foto FROM professores WHERE id = ?", (professor_id,)
    ).fetchone()
    if professor is None:
        return jsonify({"erro": "Conta não encontrada."}), 404

    nome_arquivo = f"prof-{professor_id}-{secrets.token_hex(8)}.{extensao}"
    armazenamento.salvar_foto(nome_arquivo, conteudo)

    _apagar_foto_antiga(professor["foto"])
    conexao.execute(
        "UPDATE professores SET foto = ? WHERE id = ?", (nome_arquivo, professor_id)
    )
    conexao.commit()
    return jsonify({"ok": True, "foto": nome_arquivo})


@app.delete("/api/minha-conta/foto")
@requer_professor
def remover_minha_foto():
    conexao = db()
    professor_id = session["professor_id"]
    professor = conexao.execute(
        "SELECT foto FROM professores WHERE id = ?", (professor_id,)
    ).fetchone()
    if professor is None:
        return jsonify({"erro": "Conta não encontrada."}), 404

    _apagar_foto_antiga(professor["foto"])
    conexao.execute(
        "UPDATE professores SET foto = NULL WHERE id = ?", (professor_id,)
    )
    conexao.commit()
    return jsonify({"ok": True})


@app.get("/fotos/<path:nome_arquivo>")
def servir_foto(nome_arquivo):
    # nome_arquivo vem do banco (gerado por enviar_minha_foto), mas a rota e
    # publica: qualquer um pode digitar o que quiser na URL. Sem esta conferencia
    # um "../../dados/escola.db" leria arquivos de fora da pasta das fotos.
    if nome_arquivo != os.path.basename(nome_arquivo) or nome_arquivo.startswith("."):
        return jsonify({"erro": "Foto não encontrada."}), 404

    conteudo = armazenamento.abrir_foto(nome_arquivo)
    if conteudo is None:
        return jsonify({"erro": "Foto não encontrada."}), 404
    return Response(
        conteudo,
        mimetype=armazenamento._tipo_da_imagem(nome_arquivo),
        headers={"Cache-Control": "private, max-age=300"},
    )


# --------------------------------------------------------------------------- #
# Calendario escolar em PDF
# --------------------------------------------------------------------------- #
#
# Um PDF por escola. O gestor local envia e substitui; professores e gestores
# da unidade leem e baixam. O arquivo mora no disco e no R2, como as fotos, e o
# banco guarda o nome sorteado com que ele foi gravado — nome que muda a cada
# envio e por isso serve de ETag: o celular so baixa o PDF de novo quando o
# calendario muda, e nunca fica mostrando o antigo depois de uma substituicao.

AVISO_ESCOLHER_UNIDADE = ("Escolha uma unidade no topo da tela: cada escola tem o "
                          "seu próprio calendário.")
LIMITE_NOME_CALENDARIO = 150


def _unidade_do_calendario():
    """(unidade_id, precisa_escolher) da escola cujo calendario a tela ve.

    So o gerente geral olhando "Todas as unidades" fica sem resposta: nao existe
    um calendario da rede, entao ele precisa escolher a escola antes. Quem nao
    tem unidade (gestor ou professor solto) usa o calendario "sem unidade", do
    mesmo jeito que o resto do sistema trata os cadastros sem vinculo.
    """
    if session.get("gerente") and gestor_da_sessao() is None and unidade_em_foco() is None:
        return None, True
    return _unidade_da_tela(), False


def _calendario_da_unidade(conexao, unidade_id):
    return conexao.execute(
        "SELECT * FROM calendarios_escolares WHERE COALESCE(unidade_id, 0) = ?",
        (unidade_id or 0,),
    ).fetchone()


def _calendario_publico(linha):
    """O que a tela precisa para mostrar o arquivo ativo."""
    if linha is None:
        return None
    return {
        "nome": linha["nome_original"],
        "tamanho": linha["tamanho"],
        "enviado_em": linha["enviado_em"],
        "enviado_por": linha["enviado_por"],
        # vai na URL do PDF: substituido o calendario, a URL muda junto
        "versao": linha["arquivo"].rsplit(".", 1)[0].rsplit("-", 1)[-1],
    }


def _nome_do_pdf(nome_enviado):
    """Nome do arquivo como estava no computador de quem enviou, limpo.

    Serve so para mostrar e para batizar o download: o arquivo e gravado com um
    nome sorteado. Tira a pasta (alguns navegadores mandam o caminho inteiro) e
    caracteres de controle, que quebrariam o cabecalho do download.
    """
    nome = os.path.basename(str(nome_enviado or "").replace("\\", "/"))
    nome = re.sub(r"[\x00-\x1f\x7f]", "", nome)
    nome = re.sub(r"\s+", " ", nome).strip()
    if not nome.lower().endswith(".pdf"):
        nome = f"{nome}.pdf" if nome else "calendario-escolar.pdf"
    if len(nome) > LIMITE_NOME_CALENDARIO:
        nome = nome[:LIMITE_NOME_CALENDARIO - 4].rstrip() + ".pdf"
    return nome


@app.get("/api/calendario-escolar")
@requer_acesso
def ver_calendario_escolar():
    unidade_id, precisa_escolher = _unidade_do_calendario()
    if precisa_escolher:
        return jsonify({"calendario": None, "escolher_unidade": True,
                        "aviso": AVISO_ESCOLHER_UNIDADE,
                        "limite_mb": LIMITE_CALENDARIO_MB})
    conexao = db()
    return jsonify({
        "calendario": _calendario_publico(_calendario_da_unidade(conexao, unidade_id)),
        "escolher_unidade": False,
        "unidade": nome_da_unidade(conexao, unidade_id),
        "limite_mb": LIMITE_CALENDARIO_MB,
    })


@app.get("/api/calendario-escolar/pdf")
@requer_acesso
def abrir_calendario_escolar():
    """O PDF em si. `?baixar=1` pede o download em vez de abrir no navegador."""
    unidade_id, precisa_escolher = _unidade_do_calendario()
    if precisa_escolher:
        return jsonify({"erro": AVISO_ESCOLHER_UNIDADE}), 400
    calendario = _calendario_da_unidade(db(), unidade_id)
    if calendario is None:
        return jsonify({"erro": "O calendário escolar ainda não foi enviado."}), 404

    conteudo = armazenamento.abrir_calendario(calendario["arquivo"])
    if conteudo is None:
        return jsonify({
            "erro": "O arquivo do calendário não foi encontrado. Peça à gestão "
                    "para enviar o PDF de novo."
        }), 404

    resposta = send_file(
        io.BytesIO(conteudo),
        mimetype="application/pdf",
        as_attachment=request.args.get("baixar") == "1",
        download_name=calendario["nome_original"],
        etag=calendario["arquivo"],
        conditional=True,
    )
    # sem max-age: o navegador sempre confere a ETag, e ela so muda quando o
    # gestor substitui o arquivo. `private` porque o PDF so sai com login.
    resposta.cache_control.no_cache = True
    resposta.cache_control.private = True
    resposta.headers["X-Content-Type-Options"] = "nosniff"
    return resposta


@app.post("/api/gestor/calendario-escolar")
@requer_gestor
def enviar_calendario_escolar():
    """Envia o calendario da escola, ou substitui o que ja estava no ar."""
    unidade_id, precisa_escolher = _unidade_do_calendario()
    if precisa_escolher:
        return jsonify({"erro": AVISO_ESCOLHER_UNIDADE}), 400

    arquivo = request.files.get("arquivo")
    if arquivo is None or not arquivo.filename:
        return jsonify({"erro": "Escolha o arquivo PDF do calendário."}), 400

    conteudo = arquivo.read(LIMITE_CALENDARIO + 1)
    if len(conteudo) > LIMITE_CALENDARIO:
        return jsonify(
            {"erro": f"O PDF precisa ter até {LIMITE_CALENDARIO_MB} MB."}
        ), 400
    if not conteudo:
        return jsonify({"erro": "Esse arquivo está vazio. Escolha outro PDF."}), 400
    # confere a assinatura de bytes, nao a extensao: uma imagem renomeada para
    # .pdf nao passa. A especificacao aceita o "%PDF-" em qualquer ponto dos
    # primeiros 1024 bytes, e ha geradores que escrevem lixo antes dele.
    if b"%PDF-" not in conteudo[:1024]:
        return jsonify({"erro": "Envie o calendário em PDF."}), 400

    conexao = db()
    anterior = _calendario_da_unidade(conexao, unidade_id)
    nome_arquivo = f"calendario-{unidade_id or 0}-{secrets.token_hex(8)}.pdf"
    armazenamento.salvar_calendario(nome_arquivo, conteudo)

    gestor = gestor_da_sessao()
    conexao.execute(
        "INSERT INTO calendarios_escolares (unidade_id, arquivo, nome_original, "
        "tamanho, enviado_por, enviado_em) VALUES (?, ?, ?, ?, ?, ?) "
        "ON CONFLICT (COALESCE(unidade_id, 0)) DO UPDATE SET "
        "arquivo = excluded.arquivo, nome_original = excluded.nome_original, "
        "tamanho = excluded.tamanho, enviado_por = excluded.enviado_por, "
        "enviado_em = excluded.enviado_em",
        (unidade_id, nome_arquivo, _nome_do_pdf(arquivo.filename), len(conteudo),
         gestor["nome"] if gestor else "Gerente Geral", banco.agora()),
    )
    conexao.commit()
    # o arquivo antigo so sai depois de o banco apontar para o novo: se algo
    # falhar no meio do caminho, o calendario que estava no ar continua abrindo
    if anterior is not None:
        armazenamento.apagar_calendario(anterior["arquivo"])

    return jsonify({
        "ok": True,
        "substituido": anterior is not None,
        "calendario": _calendario_publico(_calendario_da_unidade(conexao, unidade_id)),
    })


@app.delete("/api/gestor/calendario-escolar")
@requer_gestor
def remover_calendario_escolar():
    unidade_id, precisa_escolher = _unidade_do_calendario()
    if precisa_escolher:
        return jsonify({"erro": AVISO_ESCOLHER_UNIDADE}), 400
    conexao = db()
    calendario = _calendario_da_unidade(conexao, unidade_id)
    if calendario is None:
        return jsonify({"erro": "Esta escola não tem calendário enviado."}), 404

    conexao.execute("DELETE FROM calendarios_escolares WHERE id = ?", (calendario["id"],))
    conexao.commit()
    armazenamento.apagar_calendario(calendario["arquivo"])
    return jsonify({"ok": True})


@app.get("/api/minha-conta/grade")
@requer_professor
def minha_grade():
    """Grade semanal vigente do professor, so para consulta.

    Quando o gestor ja agendou uma troca futura, `proxima_mudanca` avisa a
    data sem entregar o conteudo da nova grade antes da hora.
    """
    conexao = db()
    professor_id = session["professor_id"]
    inicio, fim = semana_pedida()
    celulas = aulas_da_semana(conexao, inicio, fim, professor_id=professor_id,
                              so_ativos=False)

    hoje = date.today().isoformat()
    proxima = conexao.execute(
        "SELECT MIN(vigencia_inicio) AS data FROM aulas_grade "
        "WHERE professor_id = ? AND vigencia_inicio > ?",
        (professor_id, hoje),
    ).fetchone()

    return jsonify({
        "semana": {"inicio": inicio.isoformat(), "fim": fim.isoformat()},
        "celulas": celulas,
        "proxima_mudanca": proxima["data"] if proxima else None,
    })


@app.get("/api/grade-escola")
@requer_professor
def grade_da_escola():
    """Grade de todos os professores — so quando o gestor deixa visivel.

    Duas chaves controlam o que aparece: a geral (`grade_visivel_todos`, na aba
    Horarios do gestor) e a de cada professor (`professores.grade_visivel`), que
    tira alguem da grade publica sem desligar a chave geral. Quem esta oculto
    continua enxergando a propria grade em "Minha grade de aulas".
    """
    conexao = db()
    if not banco.ler_config_bool(conexao, "grade_visivel_todos"):
        return jsonify({"liberada": False, "horarios": [], "aulas": []})

    inicio, fim = semana_pedida()
    onde, parametros = filtro_da_tela()
    horarios = conexao.execute(
        f"SELECT id, turno, ordem, inicio, fim FROM horarios WHERE {onde} "
        "ORDER BY CASE turno WHEN 'manha' THEN 1 WHEN 'tarde' THEN 2 ELSE 3 END, ordem",
        parametros,
    ).fetchall()

    onde_professor, parametros_professor = filtro_da_tela("p.")
    aulas = aulas_da_semana(conexao, inicio, fim, onde_professor,
                            parametros_professor, so_visiveis=True)

    return jsonify({
        "liberada": True,
        "semana": {"inicio": inicio.isoformat(), "fim": fim.isoformat()},
        "horarios": banco.linhas_para_lista(horarios),
        "aulas": aulas,
    })


@app.post("/api/minha-conta/senha")
@requer_professor
def trocar_minha_senha():
    conexao = db()
    dados = request.get_json(silent=True) or {}
    professor = conexao.execute(
        "SELECT * FROM professores WHERE id = ?", (session["professor_id"],)
    ).fetchone()
    if professor is None:
        return jsonify({"erro": "Conta não encontrada."}), 404

    atual = str(dados.get("senha_atual", ""))
    nova = str(dados.get("nova_senha", "")).strip()

    if not banco.validar_senha_professor(professor, atual):
        return jsonify({"erro": "A senha atual está incorreta."}), 401
    if len(nova) < 6:
        return jsonify({"erro": "A nova senha precisa ter pelo menos 6 caracteres."}), 400
    if nova == atual:
        return jsonify({"erro": "A nova senha precisa ser diferente da atual."}), 400

    banco.definir_senha_professor(conexao, professor["id"], nova)
    conexao.commit()
    return jsonify({"ok": True})


# --------------------------------------------------------------------------- #
# Gestor local - laboratorios
# --------------------------------------------------------------------------- #

@app.post("/api/gestor/laboratorios")
@requer_gestor
def criar_laboratorio():
    conexao = db()
    dados = request.get_json(silent=True) or {}
    nome = _texto(dados, "nome")
    if not nome:
        return jsonify({"erro": "Informe o nome do laboratório."}), 400

    unidade_id = unidade_em_foco()
    onde, parametros = filtro_de_unidade()
    if conexao.execute(
        f"SELECT 1 FROM laboratorios WHERE nome = ? COLLATE NOCASE AND {onde}",
        (nome, *parametros),
    ).fetchone():
        return jsonify({"erro": "Já existe um laboratório com esse nome nesta unidade."}), 409

    conexao.execute(
        "INSERT INTO laboratorios (nome, tipo, capacidade, equipamentos, responsavel, "
        "observacoes, unidade_id, ativo, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)",
        (nome, _texto(dados, "tipo"), _inteiro(dados, "capacidade", 30),
         _inteiro(dados, "equipamentos", 0), _texto(dados, "responsavel"),
         _texto(dados, "observacoes"), unidade_id, banco.agora()),
    )
    conexao.commit()
    return jsonify({"ok": True}), 201


@app.put("/api/gestor/laboratorios/<int:laboratorio_id>")
@requer_gestor
def atualizar_laboratorio(laboratorio_id):
    conexao = db()
    dados = request.get_json(silent=True) or {}
    if conexao.execute("SELECT 1 FROM laboratorios WHERE id = ?",
                       (laboratorio_id,)).fetchone() is None:
        return jsonify({"erro": "Laboratório não encontrado."}), 404
    if not pertence_a_unidade(conexao, "laboratorios", laboratorio_id):
        return jsonify(ERRO_DE_OUTRA_UNIDADE), 403

    nome = _texto(dados, "nome")
    if not nome:
        return jsonify({"erro": "Informe o nome do laboratório."}), 400
    onde, parametros = filtro_de_unidade()
    duplicado = conexao.execute(
        f"SELECT 1 FROM laboratorios WHERE nome = ? COLLATE NOCASE AND id <> ? AND {onde}",
        (nome, laboratorio_id, *parametros),
    ).fetchone()
    if duplicado:
        return jsonify({"erro": "Já existe outro laboratório com esse nome nesta unidade."}), 409

    conexao.execute(
        "UPDATE laboratorios SET nome = ?, tipo = ?, capacidade = ?, equipamentos = ?, "
        "responsavel = ?, observacoes = ?, ativo = ? WHERE id = ?",
        (nome, _texto(dados, "tipo"), _inteiro(dados, "capacidade", 30),
         _inteiro(dados, "equipamentos", 0), _texto(dados, "responsavel"),
         _texto(dados, "observacoes"), 1 if dados.get("ativo", True) else 0, laboratorio_id),
    )
    conexao.commit()
    return jsonify({"ok": True})


@app.delete("/api/gestor/laboratorios/<int:laboratorio_id>")
@requer_gestor
def excluir_laboratorio(laboratorio_id):
    """Exclui de vez. Se houver reservas futuras, exige confirmacao (?forcar=1)."""
    conexao = db()
    laboratorio = conexao.execute(
        "SELECT * FROM laboratorios WHERE id = ?", (laboratorio_id,)
    ).fetchone()
    if laboratorio is None:
        return jsonify({"erro": "Laboratório não encontrado."}), 404
    if not pertence_a_unidade(conexao, "laboratorios", laboratorio_id):
        return jsonify(ERRO_DE_OUTRA_UNIDADE), 403

    futuras = conexao.execute(
        "SELECT COUNT(*) c FROM reservas WHERE laboratorio_id = ? AND status = 'ativa' "
        "AND data >= ?",
        (laboratorio_id, date.today().isoformat()),
    ).fetchone()["c"]

    if futuras and request.args.get("forcar") != "1":
        return jsonify({
            "erro": f"Este laboratório tem {futuras} reserva(s) futura(s).",
            "confirmar": True,
            "reservas_futuras": futuras,
        }), 409

    conexao.execute("DELETE FROM reservas WHERE laboratorio_id = ?", (laboratorio_id,))
    conexao.execute("DELETE FROM bloqueios WHERE laboratorio_id = ?", (laboratorio_id,))
    conexao.execute("DELETE FROM laboratorios WHERE id = ?", (laboratorio_id,))
    conexao.commit()
    return jsonify({"ok": True, "reservas_removidas": futuras})


# --------------------------------------------------------------------------- #
# Gestor local - salas de aula
# --------------------------------------------------------------------------- #
#
# Sala e onde a turma tem aula todo dia; laboratorio e o que o professor reserva
# aula a aula. Sao cadastros separados: mexer em sala nao afeta reserva nenhuma.

@app.post("/api/gestor/salas")
@requer_gestor
def criar_sala():
    conexao = db()
    dados = request.get_json(silent=True) or {}
    nome = _texto(dados, "nome")
    if not nome:
        return jsonify({"erro": "Informe o nome da sala."}), 400

    onde, parametros = filtro_de_unidade()
    if conexao.execute(
        f"SELECT 1 FROM salas WHERE nome = ? COLLATE NOCASE AND {onde}",
        (nome, *parametros),
    ).fetchone():
        return jsonify({"erro": "Já existe uma sala com esse nome nesta unidade."}), 409

    conexao.execute(
        "INSERT INTO salas (nome, capacidade, observacoes, unidade_id, ativo, criado_em) "
        "VALUES (?, ?, ?, ?, 1, ?)",
        (nome, _inteiro(dados, "capacidade", 35), _texto(dados, "observacoes"),
         unidade_em_foco(), banco.agora()),
    )
    conexao.commit()
    return jsonify({"ok": True}), 201


@app.put("/api/gestor/salas/<int:sala_id>")
@requer_gestor
def atualizar_sala(sala_id):
    conexao = db()
    dados = request.get_json(silent=True) or {}
    if conexao.execute("SELECT 1 FROM salas WHERE id = ?", (sala_id,)).fetchone() is None:
        return jsonify({"erro": "Sala não encontrada."}), 404
    if not pertence_a_unidade(conexao, "salas", sala_id):
        return jsonify(ERRO_DE_OUTRA_UNIDADE), 403

    nome = _texto(dados, "nome")
    if not nome:
        return jsonify({"erro": "Informe o nome da sala."}), 400
    onde, parametros = filtro_de_unidade()
    if conexao.execute(
        f"SELECT 1 FROM salas WHERE nome = ? COLLATE NOCASE AND id <> ? AND {onde}",
        (nome, sala_id, *parametros),
    ).fetchone():
        return jsonify({"erro": "Já existe outra sala com esse nome nesta unidade."}), 409

    conexao.execute(
        "UPDATE salas SET nome = ?, capacidade = ?, observacoes = ?, ativo = ? WHERE id = ?",
        (nome, _inteiro(dados, "capacidade", 35), _texto(dados, "observacoes"),
         1 if dados.get("ativo", True) else 0, sala_id),
    )
    conexao.commit()
    return jsonify({"ok": True})


@app.delete("/api/gestor/salas/<int:sala_id>")
@requer_gestor
def excluir_sala(sala_id):
    """Exclui a sala. As aulas que estavam nela ficam sem sala (nao somem)."""
    conexao = db()
    if conexao.execute("SELECT 1 FROM salas WHERE id = ?", (sala_id,)).fetchone() is None:
        return jsonify({"erro": "Sala não encontrada."}), 404
    if not pertence_a_unidade(conexao, "salas", sala_id):
        return jsonify(ERRO_DE_OUTRA_UNIDADE), 403

    aulas = conexao.execute(
        "SELECT (SELECT COUNT(*) FROM aulas_grade  WHERE sala_id = ?) "
        "     + (SELECT COUNT(*) FROM aulas_semana WHERE sala_id = ?) AS c",
        (sala_id, sala_id),
    ).fetchone()["c"]
    if aulas and request.args.get("forcar") != "1":
        return jsonify({
            "erro": f"Esta sala está em {aulas} aula(s) da grade. "
                    f"Excluir deixa essas aulas sem sala.",
            "confirmar": True,
            "aulas": aulas,
        }), 409

    conexao.execute("UPDATE aulas_grade  SET sala_id = NULL WHERE sala_id = ?", (sala_id,))
    conexao.execute("UPDATE aulas_semana SET sala_id = NULL WHERE sala_id = ?", (sala_id,))
    conexao.execute("DELETE FROM salas WHERE id = ?", (sala_id,))
    conexao.commit()
    return jsonify({"ok": True, "aulas_sem_sala": aulas})


# --------------------------------------------------------------------------- #
# Gestor local - professores
# --------------------------------------------------------------------------- #

@app.get("/api/gestor/professores")
@requer_gestor
def listar_professores():
    onde, parametros = filtro_de_unidade("p.")
    hoje = date.today().isoformat()
    linhas = db().execute(
        f"""
        SELECT p.id, p.nome, p.matricula, p.email, p.telefone, p.disciplina,
               p.foto, p.ativo, p.grade_visivel, p.criado_em,
               CASE WHEN p.senha_hash IS NULL OR p.senha_hash = '' THEN 0 ELSE 1 END
                    AS tem_senha,
               (SELECT COUNT(*) FROM reservas r
                 WHERE r.professor_id = p.id AND r.status <> 'cancelada') AS total_reservas,
               -- so a versao do padrao que esta valendo hoje: as versoes
               -- antigas continuam guardadas e somariam aulas que ja passaram
               (SELECT COUNT(*) FROM aulas_grade g
                 WHERE g.professor_id = p.id AND g.vigencia_inicio <= ?
                   AND (g.vigencia_fim IS NULL OR g.vigencia_fim >= ?)) AS total_aulas
          FROM professores p
         WHERE {onde}
         ORDER BY p.nome COLLATE NOCASE
        """,
        (hoje, hoje, *parametros),
    ).fetchall()
    return jsonify(banco.linhas_para_lista(linhas))


@app.post("/api/gestor/professores")
@requer_gestor
def criar_professor():
    """Cadastra o professor: a matricula e gerada pelo sistema e a senha vem do gestor."""
    conexao = db()
    dados = request.get_json(silent=True) or {}
    nome = _texto(dados, "nome")
    senha = str(dados.get("senha", "")).strip()

    if not nome:
        return jsonify({"erro": "Informe o nome do professor."}), 400
    if len(senha) < 4:
        return jsonify({"erro": "A senha precisa ter pelo menos 4 caracteres."}), 400

    telefone = _telefone(dados)
    aviso = _erro_telefone(telefone)
    if aviso:
        return jsonify({"erro": aviso}), 400
    if _telefone_em_uso(conexao, "professores", telefone):
        return jsonify({"erro": "Já existe um professor com esse WhatsApp."}), 409

    email = _texto(dados, "email")
    if email and conexao.execute(
        "SELECT 1 FROM professores WHERE email = ? COLLATE NOCASE", (email,)
    ).fetchone():
        return jsonify({"erro": "Já existe um professor com esse e-mail."}), 409

    try:
        matricula = banco.gerar_matricula(conexao)
    except ValueError as erro:
        return jsonify({"erro": str(erro)}), 409

    # o professor entra na mesma escola do gestor que o cadastrou
    gestor = gestor_da_sessao()
    unidade_id = gestor["unidade_id"] if gestor else None

    cursor = conexao.execute(
        "INSERT INTO professores (nome, matricula, email, telefone, disciplina, "
        "unidade_id, senha_hash, ativo, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)",
        (nome, matricula, email, telefone, _texto(dados, "disciplina"),
         unidade_id, banco.gerar_hash_senha(senha), banco.agora()),
    )
    conexao.commit()

    return jsonify({
        "ok": True,
        "professor": {
            "id": cursor.lastrowid,
            "nome": nome,
            "matricula": matricula,
            "email": email,
            "telefone": telefone,
        },
    }), 201


@app.put("/api/gestor/professores/<int:professor_id>")
@requer_gestor
def atualizar_professor(professor_id):
    """Edita os dados do professor. A matricula é definitiva e não muda."""
    conexao = db()
    dados = request.get_json(silent=True) or {}
    atual = conexao.execute(
        "SELECT * FROM professores WHERE id = ?", (professor_id,)
    ).fetchone()
    if atual is None:
        return jsonify({"erro": "Professor não encontrado."}), 404
    if not pertence_a_unidade(conexao, "professores", professor_id):
        return jsonify(ERRO_DE_OUTRA_UNIDADE), 403

    nome = _texto(dados, "nome")
    if not nome:
        return jsonify({"erro": "Informe o nome do professor."}), 400

    telefone = _telefone(dados)
    aviso = _erro_telefone(telefone)
    if aviso:
        return jsonify({"erro": aviso}), 400
    if _telefone_em_uso(conexao, "professores", telefone, professor_id):
        return jsonify({"erro": "Já existe outro professor com esse WhatsApp."}), 409

    email = _texto(dados, "email")
    if email:
        duplicado = conexao.execute(
            "SELECT 1 FROM professores WHERE email = ? COLLATE NOCASE AND id <> ?",
            (email, professor_id),
        ).fetchone()
        if duplicado:
            return jsonify({"erro": "Já existe outro professor com esse e-mail."}), 409

    # o formulario de cadastro nao traz esse campo (ele fica na tela da grade),
    # entao sem ele a visibilidade continua como esta
    visivel = dados.get("grade_visivel", atual["grade_visivel"])

    conexao.execute(
        "UPDATE professores SET nome = ?, email = ?, telefone = ?, disciplina = ?, "
        "ativo = ?, grade_visivel = ? WHERE id = ?",
        (nome, email, telefone, _texto(dados, "disciplina"),
         1 if dados.get("ativo", True) else 0,
         1 if visivel else 0, professor_id),
    )
    conexao.commit()
    return jsonify({"ok": True})


@app.post("/api/gestor/professores/<int:professor_id>/visibilidade")
@requer_gestor
def alternar_visibilidade_professor(professor_id):
    """Tira ou devolve o professor a grade que os colegas enxergam.

    Nao mexe no acesso dele: oculto na grade publica, o professor continua
    vendo a propria grade normalmente.
    """
    conexao = db()
    if conexao.execute("SELECT 1 FROM professores WHERE id = ?",
                       (professor_id,)).fetchone() is None:
        return jsonify({"erro": "Professor não encontrado."}), 404
    if not pertence_a_unidade(conexao, "professores", professor_id):
        return jsonify(ERRO_DE_OUTRA_UNIDADE), 403

    dados = request.get_json(silent=True) or {}
    visivel = 1 if dados.get("grade_visivel", True) else 0
    conexao.execute(
        "UPDATE professores SET grade_visivel = ? WHERE id = ?", (visivel, professor_id))
    conexao.commit()
    return jsonify({"ok": True, "grade_visivel": visivel})


@app.post("/api/gestor/professores/<int:professor_id>/senha")
@requer_gestor
def redefinir_senha_professor(professor_id):
    """Define uma nova senha (informada ou sorteada) e devolve em texto puro.

    É a única hora em que a senha aparece: no banco fica apenas o hash.
    """
    conexao = db()
    dados = request.get_json(silent=True) or {}
    professor = conexao.execute(
        "SELECT * FROM professores WHERE id = ?", (professor_id,)
    ).fetchone()
    if professor is None:
        return jsonify({"erro": "Professor não encontrado."}), 404
    if not pertence_a_unidade(conexao, "professores", professor_id):
        return jsonify(ERRO_DE_OUTRA_UNIDADE), 403

    senha = str(dados.get("senha", "")).strip() or banco.gerar_senha()
    if len(senha) < 4:
        return jsonify({"erro": "A senha precisa ter pelo menos 4 caracteres."}), 400

    banco.definir_senha_professor(conexao, professor_id, senha)
    conexao.commit()
    return jsonify({"ok": True, "senha": senha, "matricula": professor["matricula"]})


# Endereco de maquina da propria rede: IP numerico ou localhost, com ou sem
# porta. Esses respondem em http; qualquer outro nome e site publicado, e hoje
# site publicado e https.
ENDERECO_LOCAL = re.compile(r"^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?(/|$)", re.I)


def completar_endereco(endereco):
    """Deixa o endereco digitado na aba Regras pronto para virar link.

    O campo e preenchido a mao, e quase ninguem escreve o "https://" na frente.
    Sem ele o e-mail sai com <a href="escola.up.railway.app">, que e um endereco
    *relativo*: o clique tenta abrir aquilo dentro do proprio site do e-mail e
    da em pagina nao encontrada. (O endereco de verdade nao mora aqui: e o campo
    "Endereco do sistema para os professores", na aba Regras do gestor.)

    A correcao acontece na leitura, e nao na hora de salvar, para o endereco ja
    guardado passar a funcionar sem ninguem precisar reeditar o campo.
    """
    limpo = str(endereco or "").strip().rstrip("/")
    if not limpo or "://" in limpo:
        return limpo
    return ("http://" if ENDERECO_LOCAL.match(limpo) else "https://") + limpo


def endereco_do_sistema(conexao):
    """Endereço que vai na mensagem: o configurado ou o IP da rede local."""
    configurado = banco.ler_config(conexao, "endereco_sistema")
    if configurado:
        return completar_endereco(configurado)
    return f"http://{ip_da_rede()}:5000"


ASSUNTO_CREDENCIAIS = "Seu acesso ao sistema de reserva de laboratórios"


def _dados_da_mensagem(conexao, nome, identificador, senha, caminho="", **estilo):
    """Texto e HTML das credenciais.

    `caminho` e a pagina de login do perfil ("/gestor"); `estilo` sao os
    rotulos da mensagem (rotulo/perfil/suporte, ver mensagens.py).

    Sem caminho o link e a raiz, e vai com a barra no fim
    ("https://escola.up.railway.app/"): e endereco de site, nao de arquivo.
    A barra entra aqui, e nao no endereco guardado, porque a base precisa
    ficar sem ela para "/gestor" nao virar "//gestor".
    """
    escola = banco.ler_config(conexao, "nome_escola")
    endereco = endereco_do_sistema(conexao) + (caminho or "/")
    texto = mensagens.montar_texto(nome, escola, endereco, identificador, senha, **estilo)
    html = mensagens.montar_html(nome, escola, endereco, identificador, senha, **estilo)
    return escola, endereco, texto, html


@app.post("/api/gestor/professores/<int:professor_id>/credenciais")
@requer_gestor
def credenciais_professor(professor_id):
    """Monta a mensagem de acesso e o link do WhatsApp já preenchido."""
    conexao = db()
    dados = request.get_json(silent=True) or {}
    senha = str(dados.get("senha", "")).strip()
    if not senha:
        return jsonify({"erro": "Gere uma senha antes de enviar as credenciais."}), 400

    professor = conexao.execute(
        "SELECT * FROM professores WHERE id = ?", (professor_id,)
    ).fetchone()
    if professor is None:
        return jsonify({"erro": "Professor não encontrado."}), 404
    if not pertence_a_unidade(conexao, "professores", professor_id):
        return jsonify(ERRO_DE_OUTRA_UNIDADE), 403

    _escola, endereco, texto, _html = _dados_da_mensagem(
        conexao, professor["nome"], professor["matricula"], senha
    )
    smtp = banco.config_smtp(conexao)

    return jsonify({
        "texto": texto,
        "endereco": endereco,
        "email": professor["email"] or "",
        "telefone": professor["telefone"] or "",
        "whatsapp": mensagens.link_whatsapp(professor["telefone"], texto),
        "assunto": ASSUNTO_CREDENCIAIS,
        "email_configurado": mensagens.configuracao_completa(smtp),
    })


@app.post("/api/gestor/professores/<int:professor_id>/enviar-email")
@requer_gestor
def enviar_credenciais_por_email(professor_id):
    conexao = db()
    dados = request.get_json(silent=True) or {}
    senha = str(dados.get("senha", "")).strip()
    if not senha:
        return jsonify({"erro": "Gere uma senha antes de enviar as credenciais."}), 400

    professor = conexao.execute(
        "SELECT * FROM professores WHERE id = ?", (professor_id,)
    ).fetchone()
    if professor is None:
        return jsonify({"erro": "Professor não encontrado."}), 404
    if not pertence_a_unidade(conexao, "professores", professor_id):
        return jsonify(ERRO_DE_OUTRA_UNIDADE), 403
    if not professor["email"]:
        return jsonify({"erro": "Este professor não tem e-mail cadastrado."}), 400

    _escola, _endereco, texto, html = _dados_da_mensagem(
        conexao, professor["nome"], professor["matricula"], senha
    )
    smtp = banco.config_smtp(conexao)

    try:
        mensagens.enviar_email(smtp, professor["email"], ASSUNTO_CREDENCIAIS, texto, html)
    except mensagens.ErroDeEnvio as erro:
        return jsonify({
            "erro": str(erro),
            "email_configurado": mensagens.configuracao_completa(smtp),
        }), 502

    return jsonify({"ok": True, "enviado_para": professor["email"]})


@app.delete("/api/gestor/professores/<int:professor_id>")
@requer_gestor
def excluir_professor(professor_id):
    conexao = db()
    if conexao.execute("SELECT 1 FROM professores WHERE id = ?",
                       (professor_id,)).fetchone() is None:
        return jsonify({"erro": "Professor não encontrado."}), 404
    if not pertence_a_unidade(conexao, "professores", professor_id):
        return jsonify(ERRO_DE_OUTRA_UNIDADE), 403

    futuras = conexao.execute(
        "SELECT COUNT(*) c FROM reservas WHERE professor_id = ? AND status = 'ativa' "
        "AND data >= ?",
        (professor_id, date.today().isoformat()),
    ).fetchone()["c"]
    if futuras and request.args.get("forcar") != "1":
        return jsonify({
            "erro": f"Este professor tem {futuras} reserva(s) futura(s).",
            "confirmar": True,
            "reservas_futuras": futuras,
        }), 409

    conexao.execute("DELETE FROM reservas WHERE professor_id = ?", (professor_id,))
    conexao.execute("DELETE FROM professores WHERE id = ?", (professor_id,))
    conexao.commit()
    return jsonify({"ok": True, "reservas_removidas": futuras})


# --------------------------------------------------------------------------- #
# Gestor local - grade de aulas do professor (turma/disciplina por dia e aula)
# --------------------------------------------------------------------------- #
#
# Independente da reserva de laboratorio: usa a tabela `horarios` so para
# saber os horarios das aulas (aula 1 a 9), nao mexe em laboratorio nenhum.

@app.get("/api/gestor/professores/<int:professor_id>/grade")
@requer_gestor
def obter_grade_professor(professor_id):
    conexao = db()
    if conexao.execute("SELECT 1 FROM professores WHERE id = ?",
                       (professor_id,)).fetchone() is None:
        return jsonify({"erro": "Professor não encontrado."}), 404
    if not pertence_a_unidade(conexao, "professores", professor_id):
        return jsonify(ERRO_DE_OUTRA_UNIDADE), 403

    inicio, fim = semana_pedida()
    onde, parametros = filtro_de_unidade()
    horarios = conexao.execute(
        f"SELECT id, turno, ordem, inicio, fim FROM horarios WHERE {onde} "
        "ORDER BY CASE turno WHEN 'manha' THEN 1 WHEN 'tarde' THEN 2 ELSE 3 END, ordem",
        parametros,
    ).fetchall()
    salas = conexao.execute(
        f"SELECT id, nome FROM salas WHERE ativo = 1 AND {onde} ORDER BY nome COLLATE NOCASE",
        parametros,
    ).fetchall()

    # a grade desta semana ja resolvida: as celulas do professor e, para o gestor
    # nao chocar duas turmas na mesma sala, as salas que os colegas ocupam
    onde_p, parametros_p = filtro_de_unidade("p.")
    todas = aulas_da_semana(conexao, inicio, fim, onde_p, parametros_p, so_ativos=False)
    celulas = [aula for aula in todas if aula["professor_id"] == professor_id]
    ocupadas = [aula for aula in todas
                if aula["professor_id"] != professor_id and aula["sala_id"]]

    # aulas canceladas nao aparecem em `celulas` (a excecao apaga a do padrao),
    # entao o total de excecoes vem da tabela, para a tela avisar que a semana
    # tem alteracoes proprias mesmo quando a alteracao foi apagar uma aula
    excecoes = conexao.execute(
        "SELECT COUNT(*) c FROM aulas_semana WHERE professor_id = ? "
        "AND data_aula BETWEEN ? AND ?",
        (professor_id, inicio.isoformat(), fim.isoformat()),
    ).fetchone()["c"]

    hoje = date.today().isoformat()
    agendada = conexao.execute(
        "SELECT MIN(vigencia_inicio) AS data FROM aulas_grade "
        "WHERE professor_id = ? AND vigencia_inicio > ?",
        (professor_id, hoje),
    ).fetchone()

    return jsonify({
        "semana": {"inicio": inicio.isoformat(), "fim": fim.isoformat()},
        "horarios": banco.linhas_para_lista(horarios),
        "salas": banco.linhas_para_lista(salas),
        "celulas": celulas,
        "ocupadas": ocupadas,
        "excecoes": excecoes,
        "proxima_mudanca": agendada["data"] if agendada else None,
    })


@app.get("/api/gestor/grade-escola")
@requer_gestor
def grade_da_escola_gestor():
    """Visao consolidada: todas as aulas da semana, de todos os professores,
    para o gestor ver a escola inteira sem abrir professor por professor."""
    conexao = db()
    inicio, fim = semana_pedida()
    onde, parametros = filtro_de_unidade()
    horarios = conexao.execute(
        f"SELECT id, turno, ordem, inicio, fim FROM horarios WHERE {onde} "
        "ORDER BY CASE turno WHEN 'manha' THEN 1 WHEN 'tarde' THEN 2 ELSE 3 END, ordem",
        parametros,
    ).fetchall()

    onde_p, parametros_p = filtro_de_unidade("p.")
    aulas = aulas_da_semana(conexao, inicio, fim, onde_p, parametros_p)
    return jsonify({
        "semana": {"inicio": inicio.isoformat(), "fim": fim.isoformat()},
        "horarios": banco.linhas_para_lista(horarios),
        "aulas": aulas,
    })


DIAS_DA_SEMANA = regras.DIAS_DA_SEMANA


def conflitos_da_grade(a_gravar, aulas_dos_colegas):
    """Choques da grade nova com a dos outros professores naquela semana.

    Duas aulas no mesmo dia e horario nao podem dividir a mesma sala nem a mesma
    turma: a turma estaria em dois lugares ao mesmo tempo e a sala com duas
    aulas dentro. E so um aviso — o gestor confirma e grava assim mesmo.
    """
    ocupadas = {}
    for aula in aulas_dos_colegas:
        ocupadas.setdefault((aula["dia_semana"], aula["horario_id"]), []).append(aula)

    achados = []
    for dia_semana, horario_id, turma, _disciplina, sala_id in a_gravar:
        dia = DIAS_DA_SEMANA[dia_semana]
        for outra in ocupadas.get((dia_semana, horario_id), []):
            if sala_id and outra["sala_id"] == sala_id:
                achados.append(f"{dia}: a sala {outra['sala']} já tem a aula "
                               f"de {outra['professor']}")
            if turma and outra["turma"] and turma.casefold() == outra["turma"].casefold():
                achados.append(f"{dia}: a turma {turma} já tem aula "
                               f"com {outra['professor']}")
    return achados


def gravar_versao_do_padrao(conexao, professor_id, unidade_id, a_gravar, inicio_iso):
    """Grava uma versao do padrao que passa a valer em `inicio_iso`.

    Costura a linha do tempo das versoes: fecha a que estava valendo na vespera
    e herda o fim da versao seguinte, para que as versoes nunca se sobreponham
    nem deixem buraco entre uma e outra.
    """
    versoes = [linha["vigencia_inicio"] for linha in conexao.execute(
        "SELECT DISTINCT vigencia_inicio FROM aulas_grade WHERE professor_id = ? "
        "ORDER BY vigencia_inicio", (professor_id,))]

    if inicio_iso in versoes:
        # ja existe uma versao comecando nesse dia: e ela que esta sendo reescrita
        linha = conexao.execute(
            "SELECT vigencia_fim FROM aulas_grade WHERE professor_id = ? "
            "AND vigencia_inicio = ? LIMIT 1", (professor_id, inicio_iso),
        ).fetchone()
        fim_novo = linha["vigencia_fim"] if linha else None
        conexao.execute(
            "DELETE FROM aulas_grade WHERE professor_id = ? AND vigencia_inicio = ?",
            (professor_id, inicio_iso),
        )
    else:
        seguinte = next((versao for versao in versoes if versao > inicio_iso), None)
        fim_novo = ((regras.para_data(seguinte) - timedelta(days=1)).isoformat()
                    if seguinte else None)
        vespera = (regras.para_data(inicio_iso) - timedelta(days=1)).isoformat()
        conexao.execute(
            "UPDATE aulas_grade SET vigencia_fim = ? WHERE professor_id = ? "
            "AND vigencia_inicio < ? AND (vigencia_fim IS NULL OR vigencia_fim > ?)",
            (vespera, professor_id, inicio_iso, vespera),
        )

    for dia_semana, horario_id, turma, disciplina, sala_id in a_gravar:
        conexao.execute(
            "INSERT INTO aulas_grade (professor_id, dia_semana, horario_id, turma, "
            "disciplina, sala_id, unidade_id, vigencia_inicio, vigencia_fim, criado_em) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (professor_id, dia_semana, horario_id, turma, disciplina, sala_id,
             unidade_id, inicio_iso, fim_novo, banco.agora()),
        )


def gravar_excecoes_da_semana(conexao, professor_id, unidade_id, a_gravar,
                              padrao, inicio):
    """Grava, para os cinco dias da semana, so o que difere do padrao.

    O que continua igual ao padrao nao vira linha nenhuma — assim uma mudanca
    posterior no padrao ainda alcanca as celulas que o gestor nao mexeu naquela
    semana. Celula que o padrao tem e o gestor esvaziou vira `cancelada`.
    """
    conexao.execute(
        "DELETE FROM aulas_semana WHERE professor_id = ? AND data_aula BETWEEN ? AND ?",
        (professor_id, inicio.isoformat(),
         (inicio + timedelta(days=DIAS_UTEIS - 1)).isoformat()),
    )

    submetidas = {(dia, horario): (turma, disciplina, sala_id)
                  for dia, horario, turma, disciplina, sala_id in a_gravar}
    do_padrao = {(aula["dia_semana"], aula["horario_id"]):
                 (aula["turma"] or "", aula["disciplina"] or "", aula["sala_id"])
                 for aula in padrao}

    gravadas = 0
    for chave in set(submetidas) | set(do_padrao):
        dia_semana, horario_id = chave
        desejada, base = submetidas.get(chave), do_padrao.get(chave)
        if desejada == base:
            continue

        data_aula = (inicio + timedelta(days=dia_semana)).isoformat()
        if desejada is None:
            conexao.execute(
                "INSERT INTO aulas_semana (data_aula, professor_id, horario_id, "
                "cancelada, unidade_id, criado_em) VALUES (?, ?, ?, 1, ?, ?)",
                (data_aula, professor_id, horario_id, unidade_id, banco.agora()),
            )
        else:
            turma, disciplina, sala_id = desejada
            conexao.execute(
                "INSERT INTO aulas_semana (data_aula, professor_id, horario_id, turma, "
                "disciplina, sala_id, cancelada, unidade_id, criado_em) "
                "VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)",
                (data_aula, professor_id, horario_id, turma, disciplina, sala_id,
                 unidade_id, banco.agora()),
            )
        gravadas += 1
    return gravadas


@app.put("/api/gestor/professores/<int:professor_id>/grade")
@requer_gestor
def salvar_grade_professor(professor_id):
    conexao = db()
    if conexao.execute("SELECT 1 FROM professores WHERE id = ?",
                       (professor_id,)).fetchone() is None:
        return jsonify({"erro": "Professor não encontrado."}), 404
    if not pertence_a_unidade(conexao, "professores", professor_id):
        return jsonify(ERRO_DE_OUTRA_UNIDADE), 403

    dados = request.get_json(silent=True) or {}
    celulas = dados.get("celulas")
    if not isinstance(celulas, list):
        return jsonify({"erro": "Formato inválido."}), 400

    escopo = dados.get("escopo") or "semana"
    if escopo not in ("semana", "padrao"):
        return jsonify({"erro": "Escopo inválido."}), 400
    try:
        inicio = segunda_da_semana(dados.get("inicio") or None)
    except (ValueError, TypeError):
        return jsonify({"erro": "Semana inválida."}), 400
    fim = inicio + timedelta(days=DIAS_UTEIS - 1)

    onde, parametros = filtro_de_unidade()
    horarios_da_unidade = {
        linha["id"] for linha in
        conexao.execute(f"SELECT id FROM horarios WHERE {onde}", parametros)
    }
    salas_da_unidade = {
        linha["id"] for linha in
        conexao.execute(f"SELECT id FROM salas WHERE {onde}", parametros)
    }

    a_gravar = []
    for celula in celulas:
        if not isinstance(celula, dict):
            continue
        turma = _texto(celula, "turma")
        disciplina = _texto(celula, "disciplina")
        sala_id = celula.get("sala_id") or None
        if not turma and not disciplina:
            continue
        try:
            dia_semana = int(celula.get("dia_semana"))
            horario_id = int(celula.get("horario_id"))
            sala_id = int(sala_id) if sala_id else None
        except (TypeError, ValueError):
            return jsonify({"erro": "Célula da grade inválida."}), 400
        if dia_semana < 0 or dia_semana > 4:
            return jsonify({"erro": "Dia da semana inválido."}), 400
        if horario_id not in horarios_da_unidade:
            return jsonify({"erro": "Horário inválido."}), 400
        if sala_id is not None and sala_id not in salas_da_unidade:
            return jsonify({"erro": "Sala inválida."}), 400
        a_gravar.append((dia_semana, horario_id, turma, disciplina, sala_id))

    # o limite de aulas seguidas nao e conferido aqui: a grade so descreve as
    # aulas que o professor ja tem e nao tira laboratorio de ninguem. Esse
    # limite vale na Nova reserva (regras.validar_reserva).

    # sala ou turma em dois lugares ao mesmo tempo: avisa e deixa o gestor decidir
    onde_p, parametros_p = filtro_de_unidade("p.")
    if request.args.get("forcar") != "1":
        colegas = [aula for aula in
                   aulas_da_semana(conexao, inicio, fim, onde_p, parametros_p)
                   if aula["professor_id"] != professor_id]
        choques = conflitos_da_grade(a_gravar, colegas)
        if choques:
            return jsonify({
                "erro": "Esta grade se choca com a de outro professor:\n• "
                        + "\n• ".join(sorted(set(choques))),
                "confirmar": True,
                "conflitos": sorted(set(choques)),
            }), 409

    unidade_id = unidade_em_foco()
    if escopo == "padrao":
        # o padrao passa a valer da semana escolhida em diante; para a semana de
        # hoje (ou uma ja passada) e a versao que ja esta valendo que e corrigida,
        # senao a mudanca so pegaria da proxima segunda
        hoje = date.today()
        if inicio <= hoje:
            atual = conexao.execute(
                "SELECT vigencia_inicio FROM aulas_grade WHERE professor_id = ? "
                "AND vigencia_inicio <= ? AND (vigencia_fim IS NULL OR vigencia_fim >= ?) "
                "ORDER BY vigencia_inicio DESC LIMIT 1",
                (professor_id, hoje.isoformat(), hoje.isoformat()),
            ).fetchone()
            alvo = atual["vigencia_inicio"] if atual else inicio.isoformat()
        else:
            alvo = inicio.isoformat()

        gravar_versao_do_padrao(conexao, professor_id, unidade_id, a_gravar, alvo)
        # a semana editada agora e igual ao padrao: as excecoes dela perderam a razao
        conexao.execute(
            "DELETE FROM aulas_semana WHERE professor_id = ? AND data_aula BETWEEN ? AND ?",
            (professor_id, inicio.isoformat(), fim.isoformat()),
        )
        conexao.commit()
        return jsonify({"ok": True, "escopo": "padrao", "total": len(a_gravar),
                        "vigencia_inicio": alvo})

    padrao = aulas_da_semana(conexao, inicio, fim, professor_id=professor_id,
                             so_ativos=False, com_excecoes=False)
    excecoes = gravar_excecoes_da_semana(conexao, professor_id, unidade_id,
                                         a_gravar, padrao, inicio)
    conexao.commit()
    return jsonify({"ok": True, "escopo": "semana", "total": len(a_gravar),
                    "excecoes": excecoes})


@app.delete("/api/gestor/professores/<int:professor_id>/grade/agendada")
@requer_gestor
def cancelar_grade_agendada(professor_id):
    """Cancela a troca de grade agendada para o futuro, mantendo a vigente hoje.

    A versao vigente tinha sido fechada (vigencia_fim = vespera da agendada)
    para dar lugar a essa troca — cancelar sem reabrir essa versao faria a
    grade atual sumir sozinha na data em que a troca cancelada comecaria.
    """
    conexao = db()
    if conexao.execute("SELECT 1 FROM professores WHERE id = ?",
                       (professor_id,)).fetchone() is None:
        return jsonify({"erro": "Professor não encontrado."}), 404
    if not pertence_a_unidade(conexao, "professores", professor_id):
        return jsonify(ERRO_DE_OUTRA_UNIDADE), 403

    hoje = date.today().isoformat()
    futura = conexao.execute(
        "SELECT vigencia_inicio, vigencia_fim FROM aulas_grade WHERE professor_id = ? "
        "AND vigencia_inicio > ? ORDER BY vigencia_inicio LIMIT 1",
        (professor_id, hoje),
    ).fetchone()
    if futura is None:
        return jsonify({"ok": True, "removidas": 0})

    # a versao anterior herda o periodo da cancelada, para nao ficar buraco
    dia_anterior = (regras.para_data(futura["vigencia_inicio"])
                    - timedelta(days=1)).isoformat()
    conexao.execute(
        "UPDATE aulas_grade SET vigencia_fim = ? WHERE professor_id = ? AND vigencia_fim = ?",
        (futura["vigencia_fim"], professor_id, dia_anterior),
    )
    removidas = conexao.execute(
        "DELETE FROM aulas_grade WHERE professor_id = ? AND vigencia_inicio = ?",
        (professor_id, futura["vigencia_inicio"]),
    ).rowcount
    conexao.commit()
    return jsonify({"ok": True, "removidas": removidas})


@app.delete("/api/gestor/professores/<int:professor_id>/grade/semana")
@requer_gestor
def limpar_excecoes_da_semana(professor_id):
    """Devolve uma semana ao padrao, apagando as alteracoes proprias dela."""
    conexao = db()
    if conexao.execute("SELECT 1 FROM professores WHERE id = ?",
                       (professor_id,)).fetchone() is None:
        return jsonify({"erro": "Professor não encontrado."}), 404
    if not pertence_a_unidade(conexao, "professores", professor_id):
        return jsonify(ERRO_DE_OUTRA_UNIDADE), 403

    inicio, fim = semana_pedida()
    removidas = conexao.execute(
        "DELETE FROM aulas_semana WHERE professor_id = ? AND data_aula BETWEEN ? AND ?",
        (professor_id, inicio.isoformat(), fim.isoformat()),
    ).rowcount
    conexao.commit()
    return jsonify({"ok": True, "removidas": removidas,
                    "semana": {"inicio": inicio.isoformat(), "fim": fim.isoformat()}})


# --------------------------------------------------------------------------- #
# Gestor local - outros gestores da mesma escola
# --------------------------------------------------------------------------- #
#
# O gestor local pode trazer outro gestor para ajudar a administrar a mesma
# escola, inclusive promovendo um professor (a tela ja preenche nome/e-mail a
# partir do cadastro dele). A conta fica sempre presa a propria unidade — so
# o gerente geral, em /gerente, cria ou move gestores entre escolas.

@app.get("/api/gestor/gestores")
@requer_gestor
def listar_gestores_da_escola():
    onde, parametros = filtro_de_unidade("g.")
    linhas = db().execute(
        f"""
        SELECT g.id, g.nome, g.usuario, g.email, g.telefone, g.unidade_id,
               g.ativo, g.ultimo_acesso, g.criado_em,
               CASE WHEN g.senha_hash IS NULL OR g.senha_hash = '' THEN 0 ELSE 1 END
                    AS tem_senha
          FROM gestores g
         WHERE {onde}
         ORDER BY g.nome COLLATE NOCASE
        """,
        parametros,
    ).fetchall()
    return jsonify(banco.linhas_para_lista(linhas))


@app.get("/api/gestor/usuario-sugerido")
@requer_gestor
def usuario_sugerido_gestor():
    """Mesma sugestao que o gerente tem, liberada aqui para o formulario de gestor."""
    nome = request.args.get("nome", "")
    return jsonify({"usuario": banco.gerar_usuario_gestor(db(), nome)})


def _gestor_da_escola_ou_erro(conexao, gestor_id):
    gestor = conexao.execute("SELECT * FROM gestores WHERE id = ?", (gestor_id,)).fetchone()
    if gestor is None:
        return None, (jsonify({"erro": "Gestor não encontrado."}), 404)
    if not pertence_a_unidade(conexao, "gestores", gestor_id):
        return None, (jsonify(ERRO_DE_OUTRA_UNIDADE), 403)
    return gestor, None


def eh_ultimo_gestor_ativo_da_escola(conexao, unidade_id, gestor_id):
    """Evita deixar a escola sem nenhum gestor local ativo (conta so a mesma unidade)."""
    ativos = conexao.execute(
        "SELECT COUNT(*) c FROM gestores WHERE ativo = 1 AND unidade_id = ? AND id <> ?",
        (unidade_id, gestor_id),
    ).fetchone()["c"]
    atual = conexao.execute(
        "SELECT ativo FROM gestores WHERE id = ?", (gestor_id,)
    ).fetchone()
    return ativos == 0 and atual is not None and bool(atual["ativo"])


@app.post("/api/gestor/gestores")
@requer_gestor
def criar_gestor_da_escola():
    """Cria outro gestor para a mesma escola — a unidade nao vem da tela."""
    conexao = db()
    unidade_id = unidade_em_foco()
    if unidade_id is None:
        return jsonify({
            "erro": "Sua conta ainda não está vinculada a uma escola. Peça ao gerente "
                    "geral para associar uma unidade antes de criar outro gestor."
        }), 409

    dados = request.get_json(silent=True) or {}
    nome = _texto(dados, "nome")
    senha = str(dados.get("senha", "")).strip()

    if not nome:
        return jsonify({"erro": "Informe o nome do gestor."}), 400
    if len(senha) < 4:
        return jsonify({"erro": "A senha precisa ter pelo menos 4 caracteres."}), 400

    telefone = _telefone(dados)
    aviso = _erro_telefone(telefone)
    if aviso:
        return jsonify({"erro": aviso}), 400
    if _telefone_em_uso(conexao, "gestores", telefone):
        return jsonify({"erro": "Já existe um gestor com esse WhatsApp."}), 409

    email = _texto(dados, "email")
    if email and conexao.execute(
        "SELECT 1 FROM gestores WHERE email = ? COLLATE NOCASE", (email,)
    ).fetchone():
        return jsonify({"erro": "Já existe um gestor com esse e-mail."}), 409

    usuario, erro = _validar_usuario(conexao, dados.get("usuario"), nome)
    if erro:
        return jsonify({"erro": erro}), 409

    # promocao: o vinculo com o professor fica gravado, e e ele que tira a
    # pessoa da fila de reservas enquanto o acesso de gestor estiver ativo
    professor_id = _inteiro(dados, "professor_id", 0) or None
    if professor_id is not None:
        promovido = conexao.execute(
            "SELECT id FROM professores WHERE id = ?", (professor_id,)
        ).fetchone()
        if promovido is None:
            return jsonify({"erro": "Professor não encontrado."}), 404
        if not pertence_a_unidade(conexao, "professores", professor_id):
            return jsonify(ERRO_DE_OUTRA_UNIDADE), 403
        if conexao.execute(
            "SELECT 1 FROM gestores WHERE professor_id = ?", (professor_id,)
        ).fetchone():
            return jsonify({"erro": "Este professor já tem uma conta de gestor."}), 409

    cursor = conexao.execute(
        "INSERT INTO gestores (nome, usuario, email, telefone, unidade_id, professor_id, "
        "senha_hash, ativo, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)",
        (nome, usuario, email, telefone, unidade_id, professor_id,
         banco.gerar_hash_senha(senha), banco.agora()),
    )
    conexao.commit()

    return jsonify({
        "ok": True,
        "gestor": {
            "id": cursor.lastrowid,
            "nome": nome,
            "usuario": usuario,
            "email": email,
            "telefone": telefone,
        },
    }), 201


@app.put("/api/gestor/gestores/<int:gestor_id>")
@requer_gestor
def atualizar_gestor_da_escola(gestor_id):
    conexao = db()
    atual, erro = _gestor_da_escola_ou_erro(conexao, gestor_id)
    if erro:
        return erro

    dados = request.get_json(silent=True) or {}
    nome = _texto(dados, "nome")
    if not nome:
        return jsonify({"erro": "Informe o nome do gestor."}), 400

    telefone = _telefone(dados)
    aviso = _erro_telefone(telefone)
    if aviso:
        return jsonify({"erro": aviso}), 400
    if _telefone_em_uso(conexao, "gestores", telefone, gestor_id):
        return jsonify({"erro": "Já existe outro gestor com esse WhatsApp."}), 409

    email = _texto(dados, "email")
    if email and conexao.execute(
        "SELECT 1 FROM gestores WHERE email = ? COLLATE NOCASE AND id <> ?",
        (email, gestor_id),
    ).fetchone():
        return jsonify({"erro": "Já existe outro gestor com esse e-mail."}), 409

    usuario, erro = _validar_usuario(conexao, dados.get("usuario") or atual["usuario"],
                                     nome, gestor_id)
    if erro:
        return jsonify({"erro": erro}), 409

    ativo = 1 if dados.get("ativo", True) else 0
    if not ativo and eh_ultimo_gestor_ativo_da_escola(conexao, atual["unidade_id"], gestor_id):
        return jsonify({
            "erro": "Este é o único gestor ativo desta escola. Crie ou ative outro antes "
                    "de desativá-lo, senão a escola fica sem quem administre o sistema."
        }), 409

    conexao.execute(
        "UPDATE gestores SET nome = ?, usuario = ?, email = ?, telefone = ?, ativo = ? "
        "WHERE id = ?",
        (nome, usuario, email, telefone, ativo, gestor_id),
    )
    conexao.commit()
    return jsonify({"ok": True, "usuario": usuario})


@app.post("/api/gestor/gestores/<int:gestor_id>/senha")
@requer_gestor
def redefinir_senha_gestor_da_escola(gestor_id):
    """Nova senha (informada ou sorteada), devolvida em texto puro uma única vez."""
    conexao = db()
    gestor, erro = _gestor_da_escola_ou_erro(conexao, gestor_id)
    if erro:
        return erro

    dados = request.get_json(silent=True) or {}
    senha = str(dados.get("senha", "")).strip() or banco.gerar_senha()
    if len(senha) < 4:
        return jsonify({"erro": "A senha precisa ter pelo menos 4 caracteres."}), 400

    banco.definir_senha_gestor(conexao, gestor_id, senha)
    conexao.commit()
    return jsonify({"ok": True, "senha": senha, "usuario": gestor["usuario"]})


@app.post("/api/gestor/gestores/<int:gestor_id>/credenciais")
@requer_gestor
def credenciais_gestor_da_escola(gestor_id):
    conexao = db()
    dados = request.get_json(silent=True) or {}
    senha = str(dados.get("senha", "")).strip()
    if not senha:
        return jsonify({"erro": "Gere uma senha antes de enviar as credenciais."}), 400

    gestor, erro = _gestor_da_escola_ou_erro(conexao, gestor_id)
    if erro:
        return erro

    _escola, endereco, texto, _html = _dados_da_mensagem(
        conexao, gestor["nome"], gestor["usuario"], senha, "/gestor", **ESTILO_GESTOR
    )
    smtp = banco.config_smtp(conexao)

    return jsonify({
        "texto": texto,
        "endereco": endereco,
        "email": gestor["email"] or "",
        "telefone": gestor["telefone"] or "",
        "whatsapp": mensagens.link_whatsapp(gestor["telefone"], texto),
        "assunto": ASSUNTO_CREDENCIAIS,
        "email_configurado": mensagens.configuracao_completa(smtp),
    })


@app.post("/api/gestor/gestores/<int:gestor_id>/enviar-email")
@requer_gestor
def enviar_credenciais_gestor_da_escola(gestor_id):
    conexao = db()
    dados = request.get_json(silent=True) or {}
    senha = str(dados.get("senha", "")).strip()
    if not senha:
        return jsonify({"erro": "Gere uma senha antes de enviar as credenciais."}), 400

    gestor, erro = _gestor_da_escola_ou_erro(conexao, gestor_id)
    if erro:
        return erro
    if not gestor["email"]:
        return jsonify({"erro": "Este gestor não tem e-mail cadastrado."}), 400

    _escola, _endereco, texto, html = _dados_da_mensagem(
        conexao, gestor["nome"], gestor["usuario"], senha, "/gestor", **ESTILO_GESTOR
    )
    smtp = banco.config_smtp(conexao)

    try:
        mensagens.enviar_email(smtp, gestor["email"], ASSUNTO_CREDENCIAIS, texto, html)
    except mensagens.ErroDeEnvio as erro_envio:
        return jsonify({
            "erro": str(erro_envio),
            "email_configurado": mensagens.configuracao_completa(smtp),
        }), 502

    return jsonify({"ok": True, "enviado_para": gestor["email"]})


@app.delete("/api/gestor/gestores/<int:gestor_id>")
@requer_gestor
def excluir_gestor_da_escola(gestor_id):
    conexao = db()
    gestor, erro = _gestor_da_escola_ou_erro(conexao, gestor_id)
    if erro:
        return erro

    gestor_logado = gestor_da_sessao()
    if gestor_logado is not None and gestor_logado["id"] == gestor_id:
        return jsonify({"erro": "Você não pode excluir a própria conta por aqui."}), 409
    if eh_ultimo_gestor_ativo_da_escola(conexao, gestor["unidade_id"], gestor_id):
        return jsonify({
            "erro": "Este é o único gestor ativo desta escola. Crie outro antes de "
                    "excluí-lo, senão a escola fica sem quem administre o sistema."
        }), 409

    conexao.execute("DELETE FROM gestores WHERE id = ?", (gestor_id,))
    conexao.commit()
    return jsonify({"ok": True})


# --------------------------------------------------------------------------- #
# Gestor local - horarios, bloqueios, configuracoes
# --------------------------------------------------------------------------- #

@app.post("/api/gestor/horarios")
@requer_gestor
def criar_horario():
    conexao = db()
    dados = request.get_json(silent=True) or {}
    turno = _texto(dados, "turno")
    inicio = _texto(dados, "inicio")
    fim = _texto(dados, "fim")
    if turno not in banco.TURNOS:
        return jsonify({"erro": "Turno inválido."}), 400
    if not inicio or not fim:
        return jsonify({"erro": "Informe o horário de início e fim."}), 400
    if inicio >= fim:
        return jsonify({"erro": "O horário de início deve ser antes do fim."}), 400

    # Aulas de tamanhos diferentes podem conviver na grade (uma dupla de 19:00 às
    # 21:30 ao lado das de 45 min), mas quem reservar uma bloqueia as outras —
    # entao o gestor confirma antes, para nao criar sobreposicao sem perceber.
    onde, parametros = filtro_de_unidade()
    cruzadas = [
        linha for linha in conexao.execute(
            f"SELECT * FROM horarios WHERE turno = ? AND {onde}", (turno, *parametros))
        if regras.sobrepoe(inicio, fim, linha["inicio"], linha["fim"])
    ]
    if cruzadas and request.args.get("forcar") != "1":
        lista = ", ".join(f"{linha['inicio']}–{linha['fim']}" for linha in cruzadas)
        return jsonify({
            "erro": f"Esta aula acontece ao mesmo tempo que {lista}. Reservar uma delas "
                    f"deixa as outras indisponíveis no mesmo laboratório.",
            "confirmar": True,
            "sobrepostos": lista,
        }), 409

    proxima_ordem = conexao.execute(
        f"SELECT COALESCE(MAX(ordem), 0) + 1 AS proxima FROM horarios "
        f"WHERE turno = ? AND {onde}",
        (turno, *parametros),
    ).fetchone()["proxima"]
    conexao.execute(
        "INSERT INTO horarios (turno, ordem, inicio, fim, unidade_id) VALUES (?, ?, ?, ?, ?)",
        (turno, proxima_ordem, inicio, fim, unidade_em_foco()),
    )
    conexao.commit()
    return jsonify({"ok": True}), 201


@app.put("/api/gestor/horarios/<int:horario_id>")
@requer_gestor
def atualizar_horario(horario_id):
    """Muda o inicio/fim (e o turno) de uma aula da escola.

    A grade de aulas acompanha sozinha: ela aponta para o horario, entao mudar
    aqui muda o horario de todo mundo que da aula nele. As reservas de
    laboratorio ja feitas tambem passam a valer no horario novo.
    """
    conexao = db()
    atual = conexao.execute(
        "SELECT * FROM horarios WHERE id = ?", (horario_id,)
    ).fetchone()
    if atual is None:
        return jsonify({"erro": "Horário não encontrado."}), 404
    if not pertence_a_unidade(conexao, "horarios", horario_id):
        return jsonify(ERRO_DE_OUTRA_UNIDADE), 403

    dados = request.get_json(silent=True) or {}
    turno = _texto(dados, "turno") or atual["turno"]
    inicio = _texto(dados, "inicio") or atual["inicio"]
    fim = _texto(dados, "fim") or atual["fim"]
    if turno not in banco.TURNOS:
        return jsonify({"erro": "Turno inválido."}), 400
    if inicio >= fim:
        return jsonify({"erro": "O horário de início deve ser antes do fim."}), 400

    onde, parametros = filtro_de_unidade()
    cruzadas = [
        linha for linha in conexao.execute(
            f"SELECT * FROM horarios WHERE turno = ? AND id <> ? AND {onde}",
            (turno, horario_id, *parametros))
        if regras.sobrepoe(inicio, fim, linha["inicio"], linha["fim"])
    ]
    if cruzadas and request.args.get("forcar") != "1":
        lista = ", ".join(f"{linha['inicio']}–{linha['fim']}" for linha in cruzadas)
        return jsonify({
            "erro": f"Esta aula passaria a acontecer ao mesmo tempo que {lista}. "
                    f"Reservar uma delas deixa as outras indisponíveis no mesmo laboratório.",
            "confirmar": True,
            "sobrepostos": lista,
        }), 409

    ordem = atual["ordem"]
    if turno != atual["turno"]:
        # mudou de turno: entra no fim da fila do turno novo
        ordem = conexao.execute(
            f"SELECT COALESCE(MAX(ordem), 0) + 1 AS proxima FROM horarios "
            f"WHERE turno = ? AND id <> ? AND {onde}",
            (turno, horario_id, *parametros),
        ).fetchone()["proxima"]

    conexao.execute(
        "UPDATE horarios SET turno = ?, ordem = ?, inicio = ?, fim = ? WHERE id = ?",
        (turno, ordem, inicio, fim, horario_id),
    )
    conexao.commit()
    return jsonify({"ok": True})


@app.delete("/api/gestor/horarios/<int:horario_id>")
@requer_gestor
def excluir_horario(horario_id):
    conexao = db()
    if not pertence_a_unidade(conexao, "horarios", horario_id):
        return jsonify(ERRO_DE_OUTRA_UNIDADE), 403
    usos = conexao.execute(
        "SELECT COUNT(*) c FROM reservas WHERE horario_id = ? AND status = 'ativa' AND data >= ?",
        (horario_id, date.today().isoformat()),
    ).fetchone()["c"]
    # a grade de aulas tambem aponta para o horario e cai junto (ON DELETE CASCADE)
    aulas = conexao.execute(
        "SELECT (SELECT COUNT(*) FROM aulas_grade  WHERE horario_id = ?) "
        "     + (SELECT COUNT(*) FROM aulas_semana WHERE horario_id = ?) AS c",
        (horario_id, horario_id),
    ).fetchone()["c"]

    if (usos or aulas) and request.args.get("forcar") != "1":
        partes = []
        if usos:
            partes.append(f"{usos} reserva(s) futura(s) de laboratório")
        if aulas:
            partes.append(f"{aulas} aula(s) na grade dos professores")
        return jsonify({
            "erro": f"Esse horário tem {' e '.join(partes)}. Excluir apaga tudo isso.",
            "confirmar": True,
            "aulas": aulas,
        }), 409
    conexao.execute("DELETE FROM reservas WHERE horario_id = ?", (horario_id,))
    conexao.execute("DELETE FROM horarios WHERE id = ?", (horario_id,))
    conexao.commit()
    return jsonify({"ok": True, "aulas_removidas": aulas})


@app.get("/api/bloqueios")
def listar_bloqueios():
    onde, parametros = filtro_da_tela("b.")
    linhas = db().execute(
        f"""
        SELECT b.*, l.nome AS laboratorio_nome
          FROM bloqueios b
          LEFT JOIN laboratorios l ON l.id = b.laboratorio_id
         WHERE {onde}
         ORDER BY b.data_inicio
        """,
        parametros,
    ).fetchall()
    return jsonify(banco.linhas_para_lista(linhas))


@app.post("/api/gestor/bloqueios")
@requer_gestor
def criar_bloqueio():
    conexao = db()
    dados = request.get_json(silent=True) or {}
    try:
        inicio = regras.para_data(dados.get("data_inicio"))
        fim = regras.para_data(dados.get("data_fim") or dados.get("data_inicio"))
    except (ValueError, TypeError):
        return jsonify({"erro": "Datas inválidas."}), 400
    if fim < inicio:
        return jsonify({"erro": "A data final não pode ser antes da inicial."}), 400

    laboratorio_id = dados.get("laboratorio_id") or None
    if laboratorio_id and not pertence_a_unidade(conexao, "laboratorios", int(laboratorio_id)):
        return jsonify(ERRO_DE_OUTRA_UNIDADE), 403

    conexao.execute(
        "INSERT INTO bloqueios (data_inicio, data_fim, descricao, laboratorio_id, unidade_id) "
        "VALUES (?, ?, ?, ?, ?)",
        (inicio.isoformat(), fim.isoformat(), _texto(dados, "descricao"),
         int(laboratorio_id) if laboratorio_id else None, unidade_em_foco()),
    )
    conexao.commit()
    return jsonify({"ok": True}), 201


@app.delete("/api/gestor/bloqueios/<int:bloqueio_id>")
@requer_gestor
def excluir_bloqueio(bloqueio_id):
    conexao = db()
    if not pertence_a_unidade(conexao, "bloqueios", bloqueio_id):
        return jsonify(ERRO_DE_OUTRA_UNIDADE), 403
    conexao.execute("DELETE FROM bloqueios WHERE id = ?", (bloqueio_id,))
    conexao.commit()
    return jsonify({"ok": True})


# --------------------------------------------------------------------------- #
# Conta do gestor local (o que ele mesmo pode mudar)
# --------------------------------------------------------------------------- #
#
# Nome, usuario e a escola vinculada sao do gerente geral: o gestor confere os
# dados e cuida so do proprio contato, como o professor faz na tela dele.

ERRO_SEM_CONTA_DE_GESTOR = {
    "erro": "Esta tela é da conta do gestor local. O gerente geral altera os "
            "dados dele no painel do gerente."
}


def _escola_do_gestor(conexao, gestor):
    """Dados da escola vinculada ao gestor, com o nome de config como reserva."""
    unidade = None
    if gestor["unidade_id"]:
        unidade = conexao.execute(
            "SELECT * FROM unidades WHERE id = ?", (gestor["unidade_id"],)
        ).fetchone()
    if unidade is None:
        return {
            "nome": banco.ler_config(conexao, "nome_escola"),
            "cidade": "",
            "endereco": "",
            "telefone": "",
        }
    return {
        "nome": unidade["nome"],
        "cidade": unidade["cidade"] or "",
        "endereco": unidade["endereco"] or "",
        "telefone": unidade["telefone"] or "",
    }


@app.get("/api/gestor/minha-conta")
@requer_gestor
def minha_conta_gestor():
    conexao = db()
    gestor = gestor_da_sessao()
    if gestor is None:
        return jsonify(ERRO_SEM_CONTA_DE_GESTOR), 400
    return jsonify({
        "nome": gestor["nome"],
        "usuario": gestor["usuario"],
        "email": gestor["email"] or "",
        "telefone": gestor["telefone"] or "",
        "ultimo_acesso": gestor["ultimo_acesso"],
        "escola": _escola_do_gestor(conexao, gestor),
    })


@app.put("/api/gestor/minha-conta")
@requer_gestor
def salvar_minha_conta_gestor():
    """Atualiza apenas o contato: e-mail e telefone."""
    conexao = db()
    gestor = gestor_da_sessao()
    if gestor is None:
        return jsonify(ERRO_SEM_CONTA_DE_GESTOR), 400

    dados = request.get_json(silent=True) or {}
    email = _texto(dados, "email")
    telefone = _telefone(dados)

    if email and "@" not in email:
        return jsonify({"erro": "Informe um e-mail válido."}), 400
    aviso = _erro_telefone(telefone)
    if aviso:
        return jsonify({"erro": aviso}), 400
    if _telefone_em_uso(conexao, "gestores", telefone, gestor["id"]):
        return jsonify({"erro": "Já existe outro gestor com esse WhatsApp."}), 409
    if email and conexao.execute(
        "SELECT 1 FROM gestores WHERE email = ? COLLATE NOCASE AND id <> ?",
        (email, gestor["id"]),
    ).fetchone():
        return jsonify({"erro": "Já existe outro gestor com esse e-mail."}), 409

    conexao.execute(
        "UPDATE gestores SET email = ?, telefone = ? WHERE id = ?",
        (email, telefone, gestor["id"]),
    )
    conexao.commit()
    return jsonify({"ok": True, "email": email, "telefone": telefone})


@app.post("/api/gestor/minha-conta/senha")
@requer_gestor
def trocar_minha_senha_gestor():
    """Troca da propria senha, conferindo a atual — como o professor faz."""
    conexao = db()
    gestor = gestor_da_sessao()
    if gestor is None:
        return jsonify(ERRO_SEM_CONTA_DE_GESTOR), 400

    dados = request.get_json(silent=True) or {}
    atual = str(dados.get("senha_atual", ""))
    nova = str(dados.get("nova_senha", "")).strip()

    if not banco.validar_senha_gestor(gestor, atual):
        return jsonify({"erro": "A senha atual está incorreta."}), 401
    if len(nova) < 6:
        return jsonify({"erro": "A nova senha precisa ter pelo menos 6 caracteres."}), 400
    if nova == atual:
        return jsonify({"erro": "A nova senha precisa ser diferente da atual."}), 400

    banco.definir_senha_gestor(conexao, gestor["id"], nova)
    conexao.commit()
    return jsonify({"ok": True})


@app.get("/api/gestor/config")
@requer_gestor
def obter_configuracoes():
    conexao = db()
    configs = banco.todas_configs(conexao)
    configs["endereco_detectado"] = f"http://{ip_da_rede()}:5000"
    configs["smtp_senha_definida"] = bool(banco.config_smtp(conexao)["senha"])
    return jsonify(configs)


@app.put("/api/gestor/config")
@requer_gestor
def salvar_configuracoes():
    conexao = db()
    dados = request.get_json(silent=True) or {}
    permitidas = set(banco.CONFIG_PADRAO.keys())
    for chave, valor in dados.items():
        if chave in permitidas:
            banco.gravar_config(conexao, chave, valor)

    # a senha do SMTP so e gravada quando o gestor digita uma nova
    smtp_senha = str(dados.get("smtp_senha", "")).strip()
    if smtp_senha:
        banco.gravar_config(conexao, "smtp_senha", smtp_senha)

    # a senha do proprio gestor mudou de lugar: agora fica na aba Conta, que
    # pede a senha atual antes de trocar (/api/gestor/minha-conta/senha)

    conexao.commit()
    return jsonify({"ok": True})


# --------------------------------------------------------------------------- #
# Gestor local - excecao de aulas seguidas por professor
# --------------------------------------------------------------------------- #
#
# O teto de aulas seguidas e um so para a escola. Quando um professor precisa
# encadear mais aulas, o gestor marca o nome dele aqui em vez de afrouxar a
# regra para todo mundo — e ainda diz em quantos dias seguidos da semana essa
# folga pode ser usada.

@app.get("/api/gestor/excecoes-aulas-seguidas")
@requer_gestor
def listar_excecoes_aulas_seguidas():
    conexao = db()
    onde, parametros = filtro_de_unidade()
    professores = conexao.execute(
        f"SELECT id, nome, matricula, disciplina FROM professores "
        f"WHERE ativo = 1 AND {onde} ORDER BY nome COLLATE NOCASE",
        parametros,
    ).fetchall()

    onde_p, parametros_p = filtro_de_unidade("p.")
    resumo = regras.resumo_das_excecoes(conexao, onde_p, parametros_p)
    resumo["professores"] = banco.linhas_para_lista(professores)
    return jsonify(resumo)


@app.put("/api/gestor/excecoes-aulas-seguidas")
@requer_gestor
def salvar_excecoes_aulas_seguidas():
    """Grava a excecao para os professores marcados e tira de quem saiu da lista.

    A tela manda a lista inteira dos marcados, entao quem nao vem no pedido
    volta a seguir a regra geral da escola.
    """
    conexao = db()
    dados = request.get_json(silent=True) or {}

    try:
        max_aulas = int(dados.get("max_aulas"))
        max_dias = int(dados.get("max_dias"))
    except (TypeError, ValueError):
        return jsonify({"erro": "Escolha a quantidade de aulas e de dias."}), 400
    if max_aulas not in banco.EXCECAO_AULAS_OPCOES:
        return jsonify({"erro": "Quantidade de aulas seguidas inválida."}), 400
    if max_dias not in banco.EXCECAO_DIAS_OPCOES:
        return jsonify({"erro": "Quantidade de dias seguidos inválida."}), 400

    enviados = dados.get("professores")
    if not isinstance(enviados, list):
        return jsonify({"erro": "Formato inválido."}), 400
    try:
        escolhidos = {int(item) for item in enviados}
    except (TypeError, ValueError):
        return jsonify({"erro": "Professor inválido."}), 400

    onde, parametros = filtro_de_unidade()
    da_escola = {
        linha["id"] for linha in
        conexao.execute(f"SELECT id FROM professores WHERE {onde}", parametros)
    }
    fora = escolhidos - da_escola
    if fora:
        return jsonify(ERRO_DE_OUTRA_UNIDADE), 403

    unidade_id = unidade_em_foco()
    for professor_id in sorted(escolhidos):
        banco.gravar_excecao_de_aulas_seguidas(
            conexao, professor_id, max_aulas, max_dias, unidade_id)

    # quem estava na lista e foi desmarcado volta ao teto geral (a consulta e
    # lida inteira antes de apagar, para nao mexer na tabela com o cursor aberto)
    cadastrados = [linha["professor_id"] for linha in
                   conexao.execute("SELECT professor_id FROM excecoes_aulas_seguidas")]
    removidos = 0
    for professor_id in cadastrados:
        if professor_id in da_escola and professor_id not in escolhidos:
            removidos += banco.remover_excecao_de_aulas_seguidas(conexao, professor_id)

    conexao.commit()
    return jsonify({"ok": True, "total": len(escolhidos), "removidos": removidos})


# --------------------------------------------------------------------------- #
# Gestor local - reservas e relatorios
# --------------------------------------------------------------------------- #

@app.get("/api/gestor/reservas")
@requer_gestor
def listar_reservas_gestor():
    conexao = db()
    onde, parametros = filtro_de_unidade("l.")
    filtros = [onde]

    if request.args.get("laboratorio_id"):
        filtros.append("r.laboratorio_id = ?")
        parametros.append(request.args["laboratorio_id"])
    if request.args.get("professor_id"):
        filtros.append("r.professor_id = ?")
        parametros.append(request.args["professor_id"])
    if request.args.get("status"):
        filtros.append("r.status = ?")
        parametros.append(request.args["status"])
    if request.args.get("de"):
        filtros.append("r.data >= ?")
        parametros.append(request.args["de"])
    if request.args.get("ate"):
        filtros.append("r.data <= ?")
        parametros.append(request.args["ate"])

    linhas = conexao.execute(
        f"""
        SELECT r.*, l.nome AS laboratorio_nome, p.nome AS professor_nome,
               h.inicio, h.fim, h.turno, h.ordem
          FROM reservas r
          JOIN laboratorios l ON l.id = r.laboratorio_id
          JOIN professores  p ON p.id = r.professor_id
          JOIN horarios     h ON h.id = r.horario_id
         WHERE {' AND '.join(filtros)}
         ORDER BY r.data DESC, h.ordem
         LIMIT 500
        """,
        parametros,
    ).fetchall()
    return jsonify(banco.linhas_para_lista(linhas))


@app.post("/api/gestor/reservas/<int:reserva_id>/status")
@requer_gestor
def mudar_status_reserva(reserva_id):
    conexao = db()
    dados = request.get_json(silent=True) or {}
    novo = _texto(dados, "status")
    if novo not in regras.STATUS_VALIDOS:
        return jsonify({"erro": "Status inválido."}), 400
    reserva = conexao.execute(
        "SELECT laboratorio_id FROM reservas WHERE id = ?", (reserva_id,)
    ).fetchone()
    if reserva is None:
        return jsonify({"erro": "Reserva não encontrada."}), 404
    if not pertence_a_unidade(conexao, "laboratorios", reserva["laboratorio_id"]):
        return jsonify(ERRO_DE_OUTRA_UNIDADE), 403

    if novo != "cancelada":
        # tirar do cancelamento so vale se ninguem tiver ocupado o intervalo
        atual = conexao.execute(
            "SELECT r.*, h.inicio, h.fim FROM reservas r "
            "JOIN horarios h ON h.id = r.horario_id WHERE r.id = ?",
            (reserva_id,),
        ).fetchone()
        ocupada = regras.laboratorio_ocupado(
            conexao, atual["laboratorio_id"], atual["data"], atual["inicio"], atual["fim"]
        )
        if ocupada and ocupada["id"] != reserva_id:
            return jsonify({
                "erro": f"O intervalo {atual['inicio']}–{atual['fim']} já está ocupado pela "
                        f"reserva de {ocupada['professor_nome']} "
                        f"({ocupada['inicio']}–{ocupada['fim']})."
            }), 409

    conexao.execute("UPDATE reservas SET status = ? WHERE id = ?", (novo, reserva_id))
    conexao.commit()
    return jsonify({"ok": True})


# --------------------------------------------------------------------------- #
# Gestor local - alunos por turma
# --------------------------------------------------------------------------- #
#
# O cadastro existe para uma coisa so: dar ao professor a lista pronta da turma
# na hora de distribuir os computadores. Por isso e enxuto (nome, turma e o
# numero de chamada) e aceita colar a turma inteira de uma vez.

LIMITE_NOME_ALUNO = 80
LIMITE_TURMA = 40
LIMITE_MATRICULA = 20
LIMITE_IMPORTACAO = 300


def _aluno_da_unidade(conexao, aluno_id):
    onde, parametros = filtro_de_unidade()
    return conexao.execute(
        f"SELECT * FROM alunos WHERE id = ? AND {onde}", (aluno_id, *parametros)
    ).fetchone()


def _nome_repetido(conexao, turma, nome, ignorar_id=None):
    """Ja existe alguem com esse nome nessa turma?

    A comparacao ignora acento e caixa (o indice do banco so ignora a caixa),
    entao "José Silva" nao entra de novo como "JOSE SILVA".
    """
    onde, parametros = filtro_de_unidade()
    chave = banco.chave_de_nome(nome)
    for linha in conexao.execute(
        f"SELECT id, nome FROM alunos WHERE {onde} AND turma = ?", (*parametros, turma)
    ):
        if linha["id"] != ignorar_id and banco.chave_de_nome(linha["nome"]) == chave:
            return True
    return False


LIMITE_TELEFONE = 20
LIMITE_ENDERECO = 200
LIMITE_RACA = 50
LIMITE_CURSO = 100
LIMITE_SITUACAO = 20
LIMITE_EMAIL = 120
LIMITE_RESPONSAVEL = 80

# Os graus de parentesco que a tela oferece. O servidor so aceita um destes ou
# vazio: assim a coluna nao vira texto livre e o relatorio por parentesco, se um
# dia existir, agrupa sozinho.
PARENTESCOS = ("Mãe", "Pai", "Avó", "Avô", "Tia / Tio", "Irmã / Irmão",
               "Prima / Primo", "Outro")
EMAIL_AVISO = "Informe um e-mail válido (com @) ou deixe o campo em branco."
CEP_DIGITOS = 8


def _data_ou_vazio(valor):
    """"2011-02-27" -> a mesma data; qualquer outra coisa -> vazio.

    A data chega do <input type="date">, que ja manda AAAA-MM-DD, mas a
    conferencia fica aqui porque a tela nao e a unica porta do endpoint.
    """
    texto = banco.texto_limpo(valor)
    if not re.match(r"^\d{4}-\d{2}-\d{2}$", texto):
        return ""
    try:
        datetime.strptime(texto, "%Y-%m-%d")
    except ValueError:
        return ""
    return texto


def _erro_telefone_do_aluno(telefone):
    """O WhatsApp do aluno e opcional, mas quando vem tem de vir inteiro.

    Sem isso um numero pela metade viraria um link de conversa quebrado na
    ficha — pior do que nao ter telefone nenhum.
    """
    return _erro_telefone(telefone) if telefone else None


def _erro_contato_do_aluno(ficha):
    """A primeira recusa do bloco de contato, ou None quando esta tudo certo.

    Nenhum destes campos e obrigatorio — o aluno pode nao ter telefone nem
    e-mail. A conferencia so pega o que foi preenchido pela metade, que viraria
    um link quebrado na ficha ou um endereco que ninguem acha depois.

    O e-mail nao precisa ser unico de proposito: irmaos costumam dar o mesmo
    e-mail do responsavel, e recusar isso so faria o gestor inventar endereco.
    """
    return (_erro_telefone_do_aluno(ficha["telefone"])
            or (EMAIL_AVISO if ficha["email"] and "@" not in ficha["email"] else None)
            or _erro_endereco(ficha)
            or _erro_responsavel(ficha))


def _erro_responsavel(ficha):
    """As recusas do bloco do responsavel, ou None.

    Nada ali e obrigatorio, mas parentesco e telefone soltos, sem nome, sao
    dado que ninguem consegue usar depois: a escola precisa saber para quem
    esta ligando.
    """
    if not ficha["responsavel_nome"]:
        if ficha["responsavel_parentesco"] or ficha["responsavel_telefone"]:
            return "Informe o nome do responsável."
        return None
    telefone = ficha["responsavel_telefone"]
    if telefone and _erro_telefone(telefone):
        return ("Informe o WhatsApp do responsável com 11 números: DDD + o "
                "número (ex.: (81)9 8458-7555).")
    return None


# Os pedacos do endereco, com o limite de cada um. `endereco` nao entra aqui:
# ele nao e digitado, e montado a partir destes campos por `_endereco_em_linha`.
CAMPOS_ENDERECO = (
    ("logradouro", 120),
    ("numero_endereco", 10),
    ("complemento", 60),
    ("bairro", 60),
    ("cidade", 60),
)


def _endereco_em_linha(partes):
    """Os pedacos viram a linha unica que as telas mostram.

    "Rua Santa Tereza, 120, Apto 102 - Centro, Santa Cruz do Capibaribe/PE,
    CEP 55190-002". Cada trecho so aparece se estiver preenchido, entao endereco
    pela metade nao sai cheio de virgula solta.
    """
    rua = ", ".join(parte for parte in (
        partes["logradouro"], partes["numero_endereco"], partes["complemento"]
    ) if parte)
    cidade_uf = "/".join(parte for parte in (partes["cidade"], partes["uf"]) if parte)
    cep = f"CEP {_formatar_cep(partes['cep'])}" if partes["cep"] else ""
    return " - ".join(parte for parte in (
        rua, partes["bairro"], cidade_uf, cep
    ) if parte)[:LIMITE_ENDERECO] or None


def _formatar_cep(digitos):
    """'55190002' -> '55190-002'."""
    return f"{digitos[:5]}-{digitos[5:]}" if len(digitos) == CEP_DIGITOS else digitos


def _endereco_do_aluno(dados):
    """O endereco vindo da tela: os pedacos normalizados mais a linha montada."""
    partes = {campo: banco.texto_limpo(dados.get(campo))[:limite] or None
              for campo, limite in CAMPOS_ENDERECO}
    partes["cep"] = _so_digitos(dados.get("cep"))[:CEP_DIGITOS] or None
    partes["uf"] = banco.texto_limpo(dados.get("uf")).upper()[:2] or None
    partes["endereco"] = _endereco_em_linha(partes)
    return partes


def _erro_endereco(partes):
    """Recusa o que nao daria para achar depois, ou None quando esta de pe."""
    if partes["cep"] and len(partes["cep"]) != CEP_DIGITOS:
        return "O CEP precisa ter 8 números (ex.: 55190-002)."
    if partes["numero_endereco"] and not partes["logradouro"]:
        return "Informe a rua antes do número."
    return None


# As colunas que `_ficha_do_aluno` devolve, na ordem em que INSERT e UPDATE as
# gravam. `ativo` fica de fora porque os dois ja o tratam a parte.
COLUNAS_FICHA = (
    "sexo", "data_nascimento", "raca_cor", "curso", "telefone", "email",
    "cep", "logradouro", "numero_endereco", "complemento", "bairro", "cidade",
    "uf", "endereco", "responsavel_nome", "responsavel_parentesco",
    "responsavel_telefone", "situacao",
)


def _ficha_do_aluno(dados, ativo):
    """Os campos da ficha escolar que o gestor edita, ja normalizados.

    `situacao` e `ativo` andam juntos: situacao diferente de ATIVO tira o aluno
    das listas do professor, e desmarcar "aluno ativo" grava INATIVO. Sem isso
    a lista da turma e a ficha diriam coisas diferentes sobre o mesmo aluno.
    """
    sexo = banco.texto_limpo(dados.get("sexo")).upper()[:1]
    situacao = banco.texto_limpo(
        dados.get("situacao") or banco.SITUACAO_ATIVA).upper()[:LIMITE_SITUACAO]
    if not ativo and situacao == banco.SITUACAO_ATIVA:
        situacao = "INATIVO"
    if situacao != banco.SITUACAO_ATIVA:
        ativo = 0
    endereco = _endereco_do_aluno(dados)
    parentesco = banco.texto_limpo(dados.get("responsavel_parentesco"))
    return {
        "responsavel_nome": banco.texto_limpo(
            dados.get("responsavel_nome"))[:LIMITE_RESPONSAVEL] or None,
        # so o que a tela oferece: parentesco digitado a mao viraria "mae",
        # "MÃE" e "mãe " na mesma coluna
        "responsavel_parentesco": parentesco if parentesco in PARENTESCOS else None,
        "responsavel_telefone": _telefone(dados, "responsavel_telefone")
                                [:LIMITE_TELEFONE] or None,
        "sexo": sexo if sexo in ("M", "F") else None,
        "data_nascimento": _data_ou_vazio(dados.get("data_nascimento")) or None,
        "raca_cor": banco.texto_limpo(dados.get("raca_cor"))[:LIMITE_RACA] or None,
        "curso": banco.texto_limpo(dados.get("curso"))[:LIMITE_CURSO] or None,
        # so os digitos, como no cadastro de professor: o link do WhatsApp e
        # montado a partir daqui, entao mascara gravada atrapalharia
        "telefone": _telefone(dados)[:LIMITE_TELEFONE] or None,
        "email": banco.texto_limpo(dados.get("email"))[:LIMITE_EMAIL] or None,
        **endereco,
        "situacao": situacao,
        "ativo": 1 if ativo else 0,
    }


def _matricula_repetida(conexao, matricula, ignorar_id=None):
    """Outro aluno da escola ja usa essa matricula?

    O indice unico do banco tambem segura, mas a conferencia aqui e o que
    permite dizer de quem e a matricula em vez de estourar um erro seco.
    """
    if not matricula:
        return None
    onde, parametros = filtro_de_unidade()
    linha = conexao.execute(
        f"""
        SELECT id, nome, turma FROM alunos
         WHERE {onde} AND UPPER(TRIM(matricula)) = ? AND id <> ?
         LIMIT 1
        """,
        (*parametros, matricula, ignorar_id or 0),
    ).fetchone()
    return linha


@app.get("/api/gestor/alunos")
@requer_gestor
def listar_alunos_gestor():
    conexao = db()
    onde, parametros = filtro_de_unidade()
    filtros = [onde]
    if request.args.get("turma"):
        filtros.append("turma = ?")
        parametros.append(banco.texto_limpo(request.args["turma"]))

    linhas = conexao.execute(
        f"""
        SELECT id, nome, turma, numero, matricula, ativo, criado_em,
               sexo, data_nascimento, raca_cor, curso,
               procedencia_modalidade_curso, turma_codigo, telefone, email,
               cep, logradouro, numero_endereco, complemento, bairro, cidade,
               uf, endereco, responsavel_nome, responsavel_parentesco,
               responsavel_telefone, situacao, atualizado_em
          FROM alunos
         WHERE {' AND '.join(filtros)}
         ORDER BY turma COLLATE NOCASE,
                  CASE WHEN numero IS NULL THEN 1 ELSE 0 END, numero,
                  nome COLLATE NOCASE
        """,
        parametros,
    ).fetchall()

    onde_turma, valores_turma = filtro_de_unidade()
    turmas = conexao.execute(
        f"""
        SELECT turma, COUNT(*) AS total,
               SUM(CASE WHEN ativo = 1 THEN 1 ELSE 0 END) AS ativos
          FROM alunos WHERE {onde_turma}
         GROUP BY turma ORDER BY turma COLLATE NOCASE
        """,
        valores_turma,
    ).fetchall()

    return jsonify({
        "alunos": banco.linhas_para_lista(linhas),
        "turmas": banco.linhas_para_lista(turmas),
        "turmas_conhecidas": _turmas_visiveis(conexao),
    })


@app.post("/api/gestor/alunos")
@requer_gestor
def criar_aluno():
    conexao = db()
    dados = request.get_json(silent=True) or {}
    nome = banco.texto_limpo(dados.get("nome"))[:LIMITE_NOME_ALUNO]
    turma = banco.texto_limpo(dados.get("turma"))[:LIMITE_TURMA]
    numero = _inteiro(dados, "numero", 0) or None
    matricula = banco.so_digitos_ou_texto(dados.get("matricula"))[:LIMITE_MATRICULA]

    if not nome:
        return jsonify({"erro": "Informe o nome do aluno."}), 400
    if not turma:
        return jsonify({"erro": "Informe a turma do aluno."}), 400
    if _nome_repetido(conexao, turma, nome):
        return jsonify({"erro": f"{nome} já está cadastrado na turma {turma}."}), 409
    repetida = _matricula_repetida(conexao, matricula)
    if repetida:
        return jsonify({
            "erro": f"A matrícula {matricula} já é de {repetida['nome']} "
                    f"({repetida['turma']})."
        }), 409

    ficha = _ficha_do_aluno(dados, dados.get("ativo", True))
    erro_contato = _erro_contato_do_aluno(ficha)
    if erro_contato:
        return jsonify({"erro": erro_contato}), 400

    agora = banco.agora()
    cursor = conexao.execute(
        f"INSERT INTO alunos (nome, turma, numero, matricula, "
        f"{', '.join(COLUNAS_FICHA)}, unidade_id, ativo, criado_em, "
        f"atualizado_em) VALUES (?, ?, ?, ?, "
        f"{', '.join('?' * len(COLUNAS_FICHA))}, ?, ?, ?, ?)",
        (nome, turma, numero, matricula or None,
         *(ficha[coluna] for coluna in COLUNAS_FICHA),
         unidade_em_foco(), ficha["ativo"], agora, agora),
    )
    conexao.commit()
    return jsonify({"ok": True, "id": cursor.lastrowid}), 201


@app.put("/api/gestor/alunos/<int:aluno_id>")
@requer_gestor
def atualizar_aluno(aluno_id):
    conexao = db()
    if _aluno_da_unidade(conexao, aluno_id) is None:
        return jsonify({"erro": "Aluno não encontrado."}), 404

    dados = request.get_json(silent=True) or {}
    nome = banco.texto_limpo(dados.get("nome"))[:LIMITE_NOME_ALUNO]
    turma = banco.texto_limpo(dados.get("turma"))[:LIMITE_TURMA]
    numero = _inteiro(dados, "numero", 0) or None
    matricula = banco.so_digitos_ou_texto(dados.get("matricula"))[:LIMITE_MATRICULA]
    ativo = 1 if dados.get("ativo", 1) else 0

    if not nome:
        return jsonify({"erro": "Informe o nome do aluno."}), 400
    if not turma:
        return jsonify({"erro": "Informe a turma do aluno."}), 400
    if _nome_repetido(conexao, turma, nome, ignorar_id=aluno_id):
        return jsonify({"erro": f"{nome} já está cadastrado na turma {turma}."}), 409
    repetida = _matricula_repetida(conexao, matricula, ignorar_id=aluno_id)
    if repetida:
        return jsonify({
            "erro": f"A matrícula {matricula} já é de {repetida['nome']} "
                    f"({repetida['turma']})."
        }), 409

    ficha = _ficha_do_aluno(dados, ativo)
    erro_contato = _erro_contato_do_aluno(ficha)
    if erro_contato:
        return jsonify({"erro": erro_contato}), 400

    conexao.execute(
        f"UPDATE alunos SET nome = ?, turma = ?, numero = ?, matricula = ?, "
        f"{', '.join(f'{coluna} = ?' for coluna in COLUNAS_FICHA)}, "
        f"ativo = ?, atualizado_em = ? WHERE id = ?",
        (nome, turma, numero, matricula or None,
         *(ficha[coluna] for coluna in COLUNAS_FICHA),
         ficha["ativo"], banco.agora(), aluno_id),
    )
    conexao.commit()
    return jsonify({"ok": True})


@app.delete("/api/gestor/alunos/<int:aluno_id>")
@requer_gestor
def excluir_aluno(aluno_id):
    """Tira o aluno do cadastro.

    O historico ja gravado nao muda: `alocacoes_computador` guarda uma copia do
    nome, e a coluna `aluno_id` daquelas linhas so vira NULL.
    """
    conexao = db()
    if _aluno_da_unidade(conexao, aluno_id) is None:
        return jsonify({"erro": "Aluno não encontrado."}), 404
    conexao.execute("DELETE FROM alunos WHERE id = ?", (aluno_id,))
    conexao.commit()
    return jsonify({"ok": True})


def _nome_e_matricula(bruta):
    """Uma linha colada -> (nome com o numero de chamada, matricula).

    A matricula vem depois de `;` ou de uma tabulacao, que e o que a planilha
    cola. Cada pedaco e normalizado depois da divisao, e nao antes: `texto_limpo`
    troca tabulacao por espaco e apagaria a divisao das colunas.
    """
    corpo, _, matricula = (bruta.partition(";") if ";" in bruta
                           else bruta.partition("	"))
    return (banco.texto_limpo(corpo),
            banco.so_digitos_ou_texto(matricula)[:LIMITE_MATRICULA])


@app.post("/api/gestor/alunos/importar")
@requer_gestor
def importar_alunos():
    """Cadastra uma turma inteira a partir da lista colada pelo gestor.

    Aceita um nome por linha, com ou sem o numero de chamada na frente
    ("12 - Ana Souza", "12. Ana Souza", "12 Ana Souza" ou so "Ana Souza"), que e
    como as listas costumam sair do diario. Quem ja esta na turma e apenas
    contado como repetido — importar a mesma lista de novo nao duplica ninguem.

    A matricula entra depois do nome, separada por `;` ou por tabulacao — que e
    como a lista sai colada de uma planilha ("12 - Ana Souza;20260012"). Sem ela
    o aluno e cadastrado do mesmo jeito: o professor so nao vai conseguir chama-lo
    pela matricula no laboratorio de projetos ate alguem preencher.
    """
    conexao = db()
    dados = request.get_json(silent=True) or {}
    turma = banco.texto_limpo(dados.get("turma"))[:LIMITE_TURMA]
    texto = str(dados.get("texto") or "")

    if not turma:
        return jsonify({"erro": "Escolha ou digite a turma antes de importar."}), 400

    linhas = [partes for partes in (_nome_e_matricula(bruta)
                                    for bruta in texto.splitlines()) if partes[0]]
    if not linhas:
        return jsonify({"erro": "Cole a lista de alunos, um nome por linha."}), 400
    if len(linhas) > LIMITE_IMPORTACAO:
        return jsonify({
            "erro": f"São {len(linhas)} linhas: importe no máximo "
                    f"{LIMITE_IMPORTACAO} de cada vez."
        }), 400

    onde, parametros = filtro_de_unidade()
    existentes = {
        banco.chave_de_nome(linha["nome"]) for linha in conexao.execute(
            f"SELECT nome FROM alunos WHERE {onde} AND turma = ?", (*parametros, turma)
        )
    }
    # a matricula nao se repete na escola inteira, e nao so na turma
    matriculas = {
        banco.so_digitos_ou_texto(linha["matricula"]) for linha in conexao.execute(
            f"SELECT matricula FROM alunos WHERE {onde} AND matricula IS NOT NULL",
            parametros,
        )
    }
    matriculas.discard("")

    unidade_id = unidade_em_foco()
    agora = banco.agora()
    novos, repetidos, invalidos = [], [], []
    sem_matricula, matriculas_repetidas = 0, []

    for corpo, matricula in linhas:
        casamento = re.match(r"^(\d{1,3})\s*[-.)]?\s+(.*)$", corpo)
        numero = int(casamento.group(1)) if casamento else None
        nome = banco.texto_limpo(casamento.group(2) if casamento else corpo)
        nome = nome[:LIMITE_NOME_ALUNO]

        if len(banco.chave_de_nome(nome)) < 2:
            invalidos.append(corpo)
            continue
        chave = banco.chave_de_nome(nome)
        if chave in existentes:
            repetidos.append(nome)
            continue
        if matricula and matricula in matriculas:
            # a matricula ja e de outro aluno: cadastra sem ela e avisa, para o
            # gestor arrumar depois sem perder a importacao inteira
            matriculas_repetidas.append(f"{nome} ({matricula})")
            matricula = ""
        if matricula:
            matriculas.add(matricula)
        else:
            sem_matricula += 1

        existentes.add(chave)
        novos.append((nome, turma, numero, matricula or None, unidade_id, agora))

    if novos:
        conexao.executemany(
            "INSERT INTO alunos (nome, turma, numero, matricula, unidade_id, ativo, "
            "criado_em) VALUES (?, ?, ?, ?, ?, 1, ?)",
            novos,
        )
        conexao.commit()

    return jsonify({
        "ok": True, "turma": turma, "importados": len(novos),
        "repetidos": repetidos, "invalidos": invalidos,
        "sem_matricula": sem_matricula,
        "matriculas_repetidas": matriculas_repetidas,
    })


# --------------------------------------------------------------------------- #
# Gestor local - turmas
# --------------------------------------------------------------------------- #
#
# Criar a turma e so registrar o nome dela antes de existir aluno ou aula: e
# esse nome que "Novo aluno", "Importar turma" e a grade passam a oferecer
# pronto, em vez de cada tela depender de alguem digitar a mesma turma de novo.
# Nada aponta para `turmas.id` — a ligacao continua sendo o texto.

LIMITE_CURSO = 100


def _turma_ja_existe(conexao, nome):
    """A turma ja existe na escola — cadastrada, com aluno ou com aula na grade?

    A comparacao e por `chave_de_nome` — sem acento e sem caixa — porque o nome
    da turma e texto livre: "1o A ADM" e "1º a adm" sao a mesma turma, e deixar
    as duas entrarem criaria duas listas para uma sala so. `_turmas_visiveis` ja
    junta as tres origens, entao basta uma passada por ela.
    """
    chave = banco.chave_de_nome(nome)
    return any(banco.chave_de_nome(turma) == chave
               for turma in _turmas_visiveis(conexao))


@app.get("/api/gestor/turmas")
@requer_gestor
def listar_turmas_gestor():
    """As turmas cadastradas, cada uma com quantos alunos ativos ja tem."""
    conexao = db()
    onde, parametros = filtro_de_unidade("t.")
    onde_aluno, valores_aluno = filtro_de_unidade("a.")
    linhas = conexao.execute(
        f"""
        SELECT t.id, t.nome, t.curso, t.turno, t.ativo, t.criado_em,
               (SELECT COUNT(*) FROM alunos a
                 WHERE {onde_aluno} AND a.ativo = 1
                   AND a.turma = t.nome COLLATE NOCASE) AS alunos
          FROM turmas t
         WHERE {onde}
         ORDER BY t.nome COLLATE NOCASE
        """,
        (*valores_aluno, *parametros),
    ).fetchall()
    return jsonify({"turmas": banco.linhas_para_lista(linhas)})


@app.post("/api/gestor/turmas")
@requer_gestor
def criar_turma():
    conexao = db()
    dados = request.get_json(silent=True) or {}
    nome = banco.texto_limpo(dados.get("nome"))[:LIMITE_TURMA]
    curso = banco.texto_limpo(dados.get("curso"))[:LIMITE_CURSO]
    turno = banco.texto_limpo(dados.get("turno")).lower()

    if not nome:
        return jsonify({"erro": "Informe o nome da turma."}), 400
    if turno and turno not in banco.TURNOS:
        return jsonify({"erro": "Turno inválido."}), 400
    if _turma_ja_existe(conexao, nome):
        return jsonify({"erro": f"A turma {nome} já existe nesta escola."}), 409

    agora = banco.agora()
    cursor = conexao.execute(
        "INSERT INTO turmas (nome, curso, turno, unidade_id, ativo, criado_em, "
        "atualizado_em) VALUES (?, ?, ?, ?, 1, ?, ?)",
        (nome, curso or None, turno or None, unidade_em_foco(), agora, agora),
    )
    conexao.commit()
    return jsonify({"ok": True, "id": cursor.lastrowid, "nome": nome}), 201


@app.delete("/api/gestor/turmas/<int:turma_id>")
@requer_gestor
def excluir_turma(turma_id):
    """Tira a turma do cadastro, sem mexer nos alunos nem na grade.

    A turma sempre foi texto livre: `alunos.turma`, `aulas_grade.turma` e o
    historico de uso guardam o NOME, nao o id. A linha em `turmas` e so o
    cadastro que faz a turma aparecer nas listas antes de ter o primeiro aluno
    — apagar essa linha nao deixa nada orfao.

    Por isso a turma continua no filtro enquanto tiver aluno: quem manda ali e
    a lista de alunos, e nao este cadastro. Serve para limpar uma turma criada
    por engano, ou o cadastro de uma turma que ja acabou.
    """
    conexao = db()
    onde, parametros = filtro_de_unidade()
    turma = conexao.execute(
        f"SELECT * FROM turmas WHERE id = ? AND {onde}", (turma_id, *parametros)
    ).fetchone()
    if turma is None:
        return jsonify({"erro": "Turma não encontrada."}), 404

    conexao.execute("DELETE FROM turmas WHERE id = ?", (turma_id,))
    conexao.commit()
    return jsonify({"ok": True, "nome": turma["nome"]})


# --------------------------------------------------------------------------- #
# Gestor local - historico de uso dos computadores
# --------------------------------------------------------------------------- #

@app.get("/api/gestor/uso-computadores")
@requer_gestor
def listar_uso_computadores():
    """Aulas registradas pelos professores, da mais recente para a mais antiga.

    Cada linha ja vem com quantas maquinas foram ocupadas e quantos alunos
    sentaram, para a tabela do gestor nao precisar de um pedido por aula.
    """
    conexao = db()
    onde, parametros = filtro_de_unidade("l.")
    filtros = [onde]

    if request.args.get("professor_id"):
        filtros.append("s.professor_id = ?")
        parametros.append(request.args["professor_id"])
    if request.args.get("laboratorio_id"):
        filtros.append("s.laboratorio_id = ?")
        parametros.append(request.args["laboratorio_id"])
    if request.args.get("turma"):
        filtros.append("s.turma = ?")
        parametros.append(banco.texto_limpo(request.args["turma"]))
    if request.args.get("de"):
        filtros.append("s.data_aula >= ?")
        parametros.append(request.args["de"])
    if request.args.get("ate"):
        filtros.append("s.data_aula <= ?")
        parametros.append(request.args["ate"])
    # aula da grade ou reserva do intervalo: as duas moram na mesma tabela
    if request.args.get("origem") == "projeto":
        filtros.append("s.projeto_id IS NOT NULL")
    elif request.args.get("origem") == "aula":
        filtros.append("s.projeto_id IS NULL")

    linhas = conexao.execute(
        f"""
        SELECT s.*, l.nome AS laboratorio_nome, p.nome AS professor_nome,
               p.matricula AS professor_matricula,
               COALESCE(h.inicio, rp.inicio) AS inicio,
               COALESCE(h.fim,    rp.fim)    AS fim,
               COALESCE(h.turno,  rp.turno)  AS turno,
               h.ordem, rp.projeto,
               (SELECT COUNT(*) FROM alocacoes_computador a WHERE a.sessao_id = s.id)
                   AS total_alunos,
               (SELECT COUNT(DISTINCT a.computador) FROM alocacoes_computador a
                 WHERE a.sessao_id = s.id) AS computadores_usados
          FROM sessoes_laboratorio s
          JOIN laboratorios l ON l.id = s.laboratorio_id
          JOIN professores  p ON p.id = s.professor_id
     LEFT JOIN horarios         h  ON h.id  = s.horario_id
     LEFT JOIN reservas_projeto rp ON rp.id = s.projeto_id
         WHERE {' AND '.join(filtros)}
         ORDER BY s.data_aula DESC, h.ordem, s.registrado_em DESC
         LIMIT 500
        """,
        parametros,
    ).fetchall()

    registros = banco.linhas_para_lista(linhas)
    return jsonify({
        "registros": registros,
        "resumo": {
            "aulas": len(registros),
            "alunos": sum(linha["total_alunos"] for linha in registros),
            "computadores": sum(linha["computadores_usados"] for linha in registros),
            "turmas": len({linha["turma"] for linha in registros if linha["turma"]}),
        },
        "turmas": sorted(
            {linha["turma"] for linha in registros if linha["turma"]},
            key=banco.chave_de_nome,
        ),
    })


@app.get("/api/gestor/uso-computadores/<int:sessao_id>")
@requer_gestor
def detalhar_uso_computadores(sessao_id):
    """A aula computador a computador, para a janela de detalhe do gestor."""
    conexao = db()
    sessao = conexao.execute(
        """
        SELECT s.*, l.nome AS laboratorio_nome, p.nome AS professor_nome,
               p.matricula AS professor_matricula,
               COALESCE(h.inicio, rp.inicio) AS inicio,
               COALESCE(h.fim,    rp.fim)    AS fim,
               COALESCE(h.turno,  rp.turno)  AS turno,
               h.ordem, rp.projeto
          FROM sessoes_laboratorio s
          JOIN laboratorios l ON l.id = s.laboratorio_id
          JOIN professores  p ON p.id = s.professor_id
     LEFT JOIN horarios         h  ON h.id  = s.horario_id
     LEFT JOIN reservas_projeto rp ON rp.id = s.projeto_id
         WHERE s.id = ?
        """,
        (sessao_id,),
    ).fetchone()
    if sessao is None:
        return jsonify({"erro": "Registro não encontrado."}), 404
    if not pertence_a_unidade(conexao, "laboratorios", sessao["laboratorio_id"]):
        return jsonify(ERRO_DE_OUTRA_UNIDADE), 403
    return jsonify(_sessao_publica(conexao, sessao))


@app.delete("/api/gestor/uso-computadores/<int:sessao_id>")
@requer_gestor
def excluir_uso_computadores(sessao_id):
    conexao = db()
    sessao = conexao.execute(
        "SELECT laboratorio_id FROM sessoes_laboratorio WHERE id = ?", (sessao_id,)
    ).fetchone()
    if sessao is None:
        return jsonify({"erro": "Registro não encontrado."}), 404
    if not pertence_a_unidade(conexao, "laboratorios", sessao["laboratorio_id"]):
        return jsonify(ERRO_DE_OUTRA_UNIDADE), 403
    conexao.execute("DELETE FROM sessoes_laboratorio WHERE id = ?", (sessao_id,))
    conexao.commit()
    return jsonify({"ok": True})


def contar_dias_letivos(conexao, de, ate, unidade_id=None):
    """Dias uteis do periodo, ja descontando fins de semana e bloqueios."""
    dias = 0
    cursor = regras.para_data(de)
    limite = regras.para_data(ate)
    while cursor <= limite and dias < 400:
        if regras.eh_dia_letivo(conexao, cursor, unidade_id=unidade_id):
            dias += 1
        cursor += timedelta(days=1)
    return dias


@app.get("/api/gestor/relatorio")
@requer_gestor
def relatorio():
    """Numeros da unidade em foco (o gerente sem foco ve a rede inteira)."""
    conexao = db()
    de = request.args.get("de") or (date.today() - timedelta(days=60)).isoformat()
    ate = request.args.get("ate") or (date.today() + timedelta(days=60)).isoformat()
    onde_lab, par_lab = filtro_de_unidade("l.")
    onde_prof, par_prof = filtro_de_unidade("p.")
    onde_nu, par_nu = filtro_de_unidade()

    por_professor = conexao.execute(
        f"""
        SELECT p.nome, p.disciplina, COUNT(r.id) AS aulas,
               SUM(CASE WHEN r.status = 'falta' THEN 1 ELSE 0 END) AS faltas
          FROM reservas r JOIN professores p ON p.id = r.professor_id
         WHERE r.status <> 'cancelada' AND r.data BETWEEN ? AND ? AND {onde_prof}
         GROUP BY p.id ORDER BY aulas DESC
        """,
        (de, ate, *par_prof),
    ).fetchall()

    por_laboratorio = conexao.execute(
        f"""
        SELECT l.nome, COUNT(r.id) AS aulas,
               SUM(CASE WHEN h.turno = 'manha' THEN 1 ELSE 0 END) AS manha,
               SUM(CASE WHEN h.turno = 'tarde' THEN 1 ELSE 0 END) AS tarde,
               SUM(CASE WHEN h.turno = 'noite' THEN 1 ELSE 0 END) AS noite
          FROM laboratorios l
          LEFT JOIN reservas r ON r.laboratorio_id = l.id
               AND r.status <> 'cancelada' AND r.data BETWEEN ? AND ?
          LEFT JOIN horarios h ON h.id = r.horario_id
         WHERE {onde_lab}
         GROUP BY l.id ORDER BY aulas DESC
        """,
        (de, ate, *par_lab),
    ).fetchall()

    totais = conexao.execute(
        f"""
        SELECT COUNT(*) AS total,
               SUM(CASE WHEN r.status = 'ativa'     THEN 1 ELSE 0 END) AS ativas,
               SUM(CASE WHEN r.status = 'realizada' THEN 1 ELSE 0 END) AS realizadas,
               SUM(CASE WHEN r.status = 'falta'     THEN 1 ELSE 0 END) AS faltas,
               SUM(CASE WHEN r.status = 'cancelada' THEN 1 ELSE 0 END) AS canceladas
          FROM reservas r JOIN laboratorios l ON l.id = r.laboratorio_id
         WHERE r.data BETWEEN ? AND ? AND {onde_lab}
        """,
        (de, ate, *par_lab),
    ).fetchone()

    # taxa de ocupacao = aulas reservadas / (labs x horarios x dias letivos do periodo)
    qtd_horarios = conexao.execute(
        f"SELECT COUNT(*) c FROM horarios WHERE {onde_nu}", par_nu).fetchone()["c"]
    qtd_labs = conexao.execute(
        f"SELECT COUNT(*) c FROM laboratorios WHERE ativo = 1 AND {onde_nu}",
        par_nu).fetchone()["c"]
    dias_letivos = contar_dias_letivos(conexao, de, ate, unidade_em_foco())

    capacidade = qtd_horarios * qtd_labs * dias_letivos
    ocupados = (totais["total"] or 0) - (totais["canceladas"] or 0)
    taxa = round(100 * ocupados / capacidade, 1) if capacidade else 0.0

    return jsonify({
        "periodo": {"de": de, "ate": ate, "dias_letivos": dias_letivos},
        "totais": banco.linha_para_dict(totais),
        "taxa_ocupacao": taxa,
        "por_professor": banco.linhas_para_lista(por_professor),
        "por_laboratorio": banco.linhas_para_lista(por_laboratorio),
    })


# --------------------------------------------------------------------------- #
# Gerente geral - visao geral da escola
# --------------------------------------------------------------------------- #

@app.get("/api/gerente/visao-geral")
@requer_gerente
def visao_geral():
    """Painel de abertura do gerente: o retrato da escola em um pedido só."""
    conexao = db()
    hoje = date.today()
    de = request.args.get("de") or (hoje - timedelta(days=30)).isoformat()
    ate = request.args.get("ate") or (hoje + timedelta(days=30)).isoformat()

    def contar(sql, parametros=()):
        return conexao.execute(sql, parametros).fetchone()["c"]

    totais = {
        "gestores": contar("SELECT COUNT(*) c FROM gestores"),
        "gestores_ativos": contar("SELECT COUNT(*) c FROM gestores WHERE ativo = 1"),
        "professores": contar("SELECT COUNT(*) c FROM professores"),
        "professores_ativos": contar("SELECT COUNT(*) c FROM professores WHERE ativo = 1"),
        "laboratorios": contar("SELECT COUNT(*) c FROM laboratorios"),
        "laboratorios_ativos": contar("SELECT COUNT(*) c FROM laboratorios WHERE ativo = 1"),
        "reservas_hoje": contar(
            "SELECT COUNT(*) c FROM reservas WHERE data = ? AND status <> 'cancelada'",
            (hoje.isoformat(),),
        ),
        "reservas_futuras": contar(
            "SELECT COUNT(*) c FROM reservas WHERE data > ? AND status = 'ativa'",
            (hoje.isoformat(),),
        ),
    }

    reservas = conexao.execute(
        """
        SELECT COUNT(*) AS total,
               SUM(CASE WHEN status = 'ativa'     THEN 1 ELSE 0 END) AS ativas,
               SUM(CASE WHEN status = 'realizada' THEN 1 ELSE 0 END) AS realizadas,
               SUM(CASE WHEN status = 'falta'     THEN 1 ELSE 0 END) AS faltas,
               SUM(CASE WHEN status = 'cancelada' THEN 1 ELSE 0 END) AS canceladas
          FROM reservas WHERE data BETWEEN ? AND ?
        """,
        (de, ate),
    ).fetchone()

    por_laboratorio = conexao.execute(
        """
        SELECT l.nome, l.ativo, COUNT(r.id) AS aulas
          FROM laboratorios l
          LEFT JOIN reservas r ON r.laboratorio_id = l.id
               AND r.status <> 'cancelada' AND r.data BETWEEN ? AND ?
         GROUP BY l.id ORDER BY aulas DESC, l.nome COLLATE NOCASE
        """,
        (de, ate),
    ).fetchall()

    por_professor = conexao.execute(
        """
        SELECT p.nome, p.disciplina, COUNT(r.id) AS aulas,
               SUM(CASE WHEN r.status = 'falta' THEN 1 ELSE 0 END) AS faltas
          FROM reservas r JOIN professores p ON p.id = r.professor_id
         WHERE r.status <> 'cancelada' AND r.data BETWEEN ? AND ?
         GROUP BY p.id ORDER BY aulas DESC LIMIT 8
        """,
        (de, ate),
    ).fetchall()

    por_turno = conexao.execute(
        """
        SELECT h.turno, COUNT(r.id) AS aulas
          FROM reservas r JOIN horarios h ON h.id = r.horario_id
         WHERE r.status <> 'cancelada' AND r.data BETWEEN ? AND ?
         GROUP BY h.turno
        """,
        (de, ate),
    ).fetchall()

    proximas = conexao.execute(
        """
        SELECT r.data, r.status, r.disciplina, l.nome AS laboratorio_nome,
               p.nome AS professor_nome, h.inicio, h.fim, h.turno
          FROM reservas r
          JOIN laboratorios l ON l.id = r.laboratorio_id
          JOIN professores  p ON p.id = r.professor_id
          JOIN horarios     h ON h.id = r.horario_id
         WHERE r.status = 'ativa' AND r.data >= ?
         ORDER BY r.data, h.ordem LIMIT 8
        """,
        (hoje.isoformat(),),
    ).fetchall()

    dias_letivos = contar_dias_letivos(conexao, de, ate)
    qtd_horarios = contar("SELECT COUNT(*) c FROM horarios")
    capacidade = qtd_horarios * totais["laboratorios_ativos"] * dias_letivos
    ocupados = (reservas["total"] or 0) - (reservas["canceladas"] or 0)

    return jsonify({
        "escola": banco.ler_config(conexao, "nome_escola"),
        "periodo": {"de": de, "ate": ate, "dias_letivos": dias_letivos},
        "totais": totais,
        "reservas": banco.linha_para_dict(reservas),
        "taxa_ocupacao": round(100 * ocupados / capacidade, 1) if capacidade else 0.0,
        "por_laboratorio": banco.linhas_para_lista(por_laboratorio),
        "por_professor": banco.linhas_para_lista(por_professor),
        "por_turno": {linha["turno"]: linha["aulas"] for linha in por_turno},
        "proximas_reservas": banco.linhas_para_lista(proximas),
    })


# --------------------------------------------------------------------------- #
# Gerente geral - unidades / escolas da rede
# --------------------------------------------------------------------------- #
#
# A unidade organiza as PESSOAS da rede: cada gestor local responde por uma
# escola e os professores herdam a unidade de quem os cadastrou. Laboratorios,
# horarios e reservas continuam compartilhados — separa-los por unidade seria
# outra mudanca, bem maior.

def _validar_unidade(conexao, valor):
    """Devolve (unidade_id, erro). Vazio quer dizer "sem unidade definida"."""
    if valor in (None, "", 0, "0"):
        return None, None
    try:
        unidade_id = int(valor)
    except (TypeError, ValueError):
        return None, "Unidade inválida."
    existe = conexao.execute("SELECT 1 FROM unidades WHERE id = ?", (unidade_id,)).fetchone()
    if not existe:
        return None, "Unidade não encontrada."
    return unidade_id, None


@app.get("/api/gerente/unidades")
@requer_gerente
def listar_unidades():
    linhas = db().execute(
        """
        SELECT u.*,
               (SELECT COUNT(*) FROM gestores g WHERE g.unidade_id = u.id) AS gestores,
               (SELECT COUNT(*) FROM gestores g
                 WHERE g.unidade_id = u.id AND g.ativo = 1)                AS gestores_ativos,
               (SELECT COUNT(*) FROM professores p WHERE p.unidade_id = u.id) AS professores,
               (SELECT COUNT(*) FROM professores p
                 WHERE p.unidade_id = u.id AND p.ativo = 1)                AS professores_ativos
          FROM unidades u
         ORDER BY u.nome COLLATE NOCASE
        """
    ).fetchall()
    unidades = banco.linhas_para_lista(linhas)

    # quem ficou sem vinculo aparece junto, para nao sumir da tela do gerente
    soltos = db().execute(
        """
        SELECT (SELECT COUNT(*) FROM gestores WHERE unidade_id IS NULL)    AS gestores,
               (SELECT COUNT(*) FROM professores WHERE unidade_id IS NULL) AS professores
        """
    ).fetchone()
    return jsonify({
        "unidades": unidades,
        "sem_unidade": banco.linha_para_dict(soltos),
    })


@app.get("/api/gerente/unidades/<int:unidade_id>")
@requer_gerente
def detalhar_unidade(unidade_id):
    """Dados da escola e as pessoas ligadas a ela."""
    conexao = db()
    unidade = conexao.execute("SELECT * FROM unidades WHERE id = ?", (unidade_id,)).fetchone()
    if unidade is None:
        return jsonify({"erro": "Unidade não encontrada."}), 404
    return jsonify(_pessoas_da_unidade(conexao, unidade_id, banco.linha_para_dict(unidade)))


@app.get("/api/gerente/unidades/sem-vinculo")
@requer_gerente
def detalhar_sem_unidade():
    """Gestores e professores que ainda nao foram atribuidos a nenhuma escola."""
    return jsonify(_pessoas_da_unidade(db(), None, {
        "id": None,
        "nome": "Sem unidade definida",
        "cidade": "",
        "endereco": "",
        "telefone": "",
        "telefone_fixo": "",
        "ativo": 1,
    }))


def _pessoas_da_unidade(conexao, unidade_id, unidade):
    """Monta o detalhe com gestores, professores e o uso dos laboratorios."""
    filtro = "unidade_id IS NULL" if unidade_id is None else "unidade_id = ?"
    parametros = () if unidade_id is None else (unidade_id,)

    gestores = conexao.execute(
        f"""
        SELECT id, nome, usuario, email, telefone, ativo, ultimo_acesso,
               CASE WHEN senha_hash IS NULL OR senha_hash = '' THEN 0 ELSE 1 END AS tem_senha
          FROM gestores WHERE {filtro} ORDER BY nome COLLATE NOCASE
        """,
        parametros,
    ).fetchall()

    professores = conexao.execute(
        f"""
        SELECT p.id, p.nome, p.matricula, p.email, p.telefone, p.disciplina, p.ativo,
               CASE WHEN p.senha_hash IS NULL OR p.senha_hash = '' THEN 0 ELSE 1 END
                    AS tem_senha,
               (SELECT COUNT(*) FROM reservas r
                 WHERE r.professor_id = p.id AND r.status <> 'cancelada') AS total_reservas
          FROM professores p WHERE p.{filtro} ORDER BY p.nome COLLATE NOCASE
        """,
        parametros,
    ).fetchall()

    hoje = date.today().isoformat()
    reservas = conexao.execute(
        f"""
        SELECT COUNT(*) AS total,
               SUM(CASE WHEN r.status = 'ativa' AND r.data >= ? THEN 1 ELSE 0 END) AS futuras
          FROM reservas r JOIN professores p ON p.id = r.professor_id
         WHERE r.status <> 'cancelada' AND p.{filtro}
        """,
        (hoje, *parametros),
    ).fetchone()

    unidade["gestores"] = banco.linhas_para_lista(gestores)
    unidade["professores"] = banco.linhas_para_lista(professores)
    unidade["reservas"] = banco.linha_para_dict(reservas)
    return unidade


def _telefones_da_unidade(dados):
    """Le os dois telefones da escola: os dois sao opcionais, mas se vierem
    precisam estar completos (celular com 11 numeros, fixo com 10)."""
    celular = _telefone(dados)
    fixo = _telefone(dados, "telefone_fixo")
    if celular and _erro_telefone(celular):
        return None, None, _erro_telefone(celular)
    if fixo and len(fixo) != TELEFONE_FIXO_DIGITOS:
        return None, None, TELEFONE_FIXO_AVISO
    return celular, fixo, None


@app.post("/api/gerente/unidades")
@requer_gerente
def criar_unidade():
    conexao = db()
    dados = request.get_json(silent=True) or {}
    nome = _texto(dados, "nome")
    if not nome:
        return jsonify({"erro": "Informe o nome da unidade."}), 400
    if conexao.execute("SELECT 1 FROM unidades WHERE nome = ? COLLATE NOCASE",
                       (nome,)).fetchone():
        return jsonify({"erro": "Já existe uma unidade com esse nome."}), 409

    celular, fixo, erro = _telefones_da_unidade(dados)
    if erro:
        return jsonify({"erro": erro}), 400

    cursor = conexao.execute(
        "INSERT INTO unidades (nome, cidade, endereco, telefone, telefone_fixo, "
        "ativo, criado_em) VALUES (?, ?, ?, ?, ?, 1, ?)",
        (nome, _texto(dados, "cidade"), _texto(dados, "endereco"),
         celular, fixo, banco.agora()),
    )
    conexao.commit()
    return jsonify({"ok": True, "id": cursor.lastrowid}), 201


@app.put("/api/gerente/unidades/<int:unidade_id>")
@requer_gerente
def atualizar_unidade(unidade_id):
    conexao = db()
    dados = request.get_json(silent=True) or {}
    if conexao.execute("SELECT 1 FROM unidades WHERE id = ?", (unidade_id,)).fetchone() is None:
        return jsonify({"erro": "Unidade não encontrada."}), 404

    nome = _texto(dados, "nome")
    if not nome:
        return jsonify({"erro": "Informe o nome da unidade."}), 400
    if conexao.execute("SELECT 1 FROM unidades WHERE nome = ? COLLATE NOCASE AND id <> ?",
                       (nome, unidade_id)).fetchone():
        return jsonify({"erro": "Já existe outra unidade com esse nome."}), 409

    celular, fixo, erro = _telefones_da_unidade(dados)
    if erro:
        return jsonify({"erro": erro}), 400

    conexao.execute(
        "UPDATE unidades SET nome = ?, cidade = ?, endereco = ?, telefone = ?, "
        "telefone_fixo = ?, ativo = ? WHERE id = ?",
        (nome, _texto(dados, "cidade"), _texto(dados, "endereco"), celular, fixo,
         1 if dados.get("ativo", True) else 0, unidade_id),
    )
    conexao.commit()
    return jsonify({"ok": True})


@app.delete("/api/gerente/unidades/<int:unidade_id>")
@requer_gerente
def excluir_unidade(unidade_id):
    """Exclui a escola. Quem estava nela fica sem unidade — ninguem perde o acesso."""
    conexao = db()
    if conexao.execute("SELECT 1 FROM unidades WHERE id = ?", (unidade_id,)).fetchone() is None:
        return jsonify({"erro": "Unidade não encontrada."}), 404

    pessoas = conexao.execute(
        "SELECT (SELECT COUNT(*) FROM gestores WHERE unidade_id = ?) + "
        "(SELECT COUNT(*) FROM professores WHERE unidade_id = ?) AS c",
        (unidade_id, unidade_id),
    ).fetchone()["c"]

    if pessoas and request.args.get("forcar") != "1":
        return jsonify({
            "erro": f"Esta unidade tem {pessoas} pessoa(s) vinculada(s). "
                    f"Elas continuam no sistema, mas ficam sem unidade.",
            "confirmar": True,
            "pessoas": pessoas,
        }), 409

    # o calendario da escola sai junto com ela (ON DELETE CASCADE); o PDF, que
    # nao mora no banco, precisa ser apagado a mao depois do commit
    calendario = _calendario_da_unidade(conexao, unidade_id)

    conexao.execute("UPDATE gestores SET unidade_id = NULL WHERE unidade_id = ?", (unidade_id,))
    conexao.execute("UPDATE professores SET unidade_id = NULL WHERE unidade_id = ?",
                    (unidade_id,))
    conexao.execute("DELETE FROM unidades WHERE id = ?", (unidade_id,))
    conexao.commit()
    if calendario is not None:
        armazenamento.apagar_calendario(calendario["arquivo"])
    return jsonify({"ok": True, "desvinculadas": pessoas})


# --------------------------------------------------------------------------- #
# Gerente geral - contas dos gestores locais
# --------------------------------------------------------------------------- #

@app.get("/api/gerente/gestores")
@requer_gerente
def listar_gestores():
    linhas = db().execute(
        """
        SELECT g.id, g.nome, g.usuario, g.email, g.telefone, g.unidade_id,
               g.ativo, g.ultimo_acesso, g.criado_em,
               u.nome AS unidade,
               CASE WHEN g.senha_hash IS NULL OR g.senha_hash = '' THEN 0 ELSE 1 END AS tem_senha
          FROM gestores g
          LEFT JOIN unidades u ON u.id = g.unidade_id
         ORDER BY g.nome COLLATE NOCASE
        """
    ).fetchall()
    return jsonify(banco.linhas_para_lista(linhas))


@app.get("/api/gerente/usuario-sugerido")
@requer_gerente
def usuario_sugerido():
    """Sugere um nome de acesso livre enquanto o gerente digita o nome."""
    nome = request.args.get("nome", "")
    return jsonify({"usuario": banco.gerar_usuario_gestor(db(), nome)})


def _validar_usuario(conexao, usuario, nome, ignorar_id=None):
    """Devolve (usuario, erro). Em branco, o sistema sugere um a partir do nome."""
    usuario = str(usuario or "").strip().lower()
    if not usuario:
        return banco.gerar_usuario_gestor(conexao, nome, ignorar_id), None
    if not banco.usuario_valido(usuario):
        return None, ("O usuário deve ter de 3 a 30 caracteres, começar com letra ou "
                      "número e usar apenas letras, números, ponto, hífen ou "
                      "sublinhado — sem espaços nem acentos.")
    if banco.usuario_em_uso(conexao, usuario, ignorar_id):
        return None, "Já existe um gestor com esse usuário."
    return usuario, None


@app.post("/api/gerente/gestores")
@requer_gerente
def criar_gestor():
    """Cria a conta do gestor local — o mesmo fluxo que ele usa com os professores."""
    conexao = db()
    dados = request.get_json(silent=True) or {}
    nome = _texto(dados, "nome")
    senha = str(dados.get("senha", "")).strip()

    if not nome:
        return jsonify({"erro": "Informe o nome do gestor."}), 400
    if len(senha) < 4:
        return jsonify({"erro": "A senha precisa ter pelo menos 4 caracteres."}), 400

    telefone = _telefone(dados)
    aviso = _erro_telefone(telefone)
    if aviso:
        return jsonify({"erro": aviso}), 400
    if _telefone_em_uso(conexao, "gestores", telefone):
        return jsonify({"erro": "Já existe um gestor com esse WhatsApp."}), 409

    email = _texto(dados, "email")
    if email and conexao.execute(
        "SELECT 1 FROM gestores WHERE email = ? COLLATE NOCASE", (email,)
    ).fetchone():
        return jsonify({"erro": "Já existe um gestor com esse e-mail."}), 409

    usuario, erro = _validar_usuario(conexao, dados.get("usuario"), nome)
    if erro:
        return jsonify({"erro": erro}), 409

    unidade_id, erro = _validar_unidade(conexao, dados.get("unidade_id"))
    if erro:
        return jsonify({"erro": erro}), 400

    cursor = conexao.execute(
        "INSERT INTO gestores (nome, usuario, email, telefone, unidade_id, senha_hash, "
        "ativo, criado_em) VALUES (?, ?, ?, ?, ?, ?, 1, ?)",
        (nome, usuario, email, telefone, unidade_id,
         banco.gerar_hash_senha(senha), banco.agora()),
    )
    conexao.commit()

    return jsonify({
        "ok": True,
        "gestor": {
            "id": cursor.lastrowid,
            "nome": nome,
            "usuario": usuario,
            "email": email,
            "telefone": telefone,
        },
    }), 201


@app.put("/api/gerente/gestores/<int:gestor_id>")
@requer_gerente
def atualizar_gestor(gestor_id):
    conexao = db()
    dados = request.get_json(silent=True) or {}
    atual = conexao.execute("SELECT * FROM gestores WHERE id = ?", (gestor_id,)).fetchone()
    if atual is None:
        return jsonify({"erro": "Gestor não encontrado."}), 404

    nome = _texto(dados, "nome")
    if not nome:
        return jsonify({"erro": "Informe o nome do gestor."}), 400

    telefone = _telefone(dados)
    aviso = _erro_telefone(telefone)
    if aviso:
        return jsonify({"erro": aviso}), 400
    if _telefone_em_uso(conexao, "gestores", telefone, gestor_id):
        return jsonify({"erro": "Já existe outro gestor com esse WhatsApp."}), 409

    email = _texto(dados, "email")
    if email and conexao.execute(
        "SELECT 1 FROM gestores WHERE email = ? COLLATE NOCASE AND id <> ?",
        (email, gestor_id),
    ).fetchone():
        return jsonify({"erro": "Já existe outro gestor com esse e-mail."}), 409

    usuario, erro = _validar_usuario(conexao, dados.get("usuario") or atual["usuario"],
                                     nome, gestor_id)
    if erro:
        return jsonify({"erro": erro}), 409

    unidade_id, erro = _validar_unidade(conexao, dados.get("unidade_id"))
    if erro:
        return jsonify({"erro": erro}), 400

    ativo = 1 if dados.get("ativo", True) else 0
    if not ativo and eh_ultimo_gestor_ativo(conexao, gestor_id):
        return jsonify({
            "erro": "Este é o único gestor local ativo. Crie ou ative outro antes de "
                    "desativá-lo, senão a escola fica sem quem administre o sistema."
        }), 409

    conexao.execute(
        "UPDATE gestores SET nome = ?, usuario = ?, email = ?, telefone = ?, "
        "unidade_id = ?, ativo = ? WHERE id = ?",
        (nome, usuario, email, telefone, unidade_id, ativo, gestor_id),
    )
    conexao.commit()
    return jsonify({"ok": True, "usuario": usuario})


def eh_ultimo_gestor_ativo(conexao, gestor_id):
    """Evita deixar a escola sem nenhum gestor local ativo."""
    ativos = conexao.execute(
        "SELECT COUNT(*) c FROM gestores WHERE ativo = 1 AND id <> ?", (gestor_id,)
    ).fetchone()["c"]
    atual = conexao.execute(
        "SELECT ativo FROM gestores WHERE id = ?", (gestor_id,)
    ).fetchone()
    return ativos == 0 and atual is not None and bool(atual["ativo"])


@app.post("/api/gerente/gestores/<int:gestor_id>/senha")
@requer_gerente
def redefinir_senha_gestor(gestor_id):
    """Nova senha (informada ou sorteada), devolvida em texto puro uma única vez."""
    conexao = db()
    dados = request.get_json(silent=True) or {}
    gestor = conexao.execute("SELECT * FROM gestores WHERE id = ?", (gestor_id,)).fetchone()
    if gestor is None:
        return jsonify({"erro": "Gestor não encontrado."}), 404

    senha = str(dados.get("senha", "")).strip() or banco.gerar_senha()
    if len(senha) < 4:
        return jsonify({"erro": "A senha precisa ter pelo menos 4 caracteres."}), 400

    banco.definir_senha_gestor(conexao, gestor_id, senha)
    conexao.commit()
    return jsonify({"ok": True, "senha": senha, "usuario": gestor["usuario"]})


def _gestor_ou_erro(conexao, gestor_id):
    gestor = conexao.execute("SELECT * FROM gestores WHERE id = ?", (gestor_id,)).fetchone()
    if gestor is None:
        return None, (jsonify({"erro": "Gestor não encontrado."}), 404)
    return gestor, None


ESTILO_GESTOR = {"rotulo": "Usuário", "perfil": "Gestor Local",
                 "suporte": "o gerente geral"}


@app.post("/api/gerente/gestores/<int:gestor_id>/credenciais")
@requer_gerente
def credenciais_gestor(gestor_id):
    conexao = db()
    dados = request.get_json(silent=True) or {}
    senha = str(dados.get("senha", "")).strip()
    if not senha:
        return jsonify({"erro": "Gere uma senha antes de enviar as credenciais."}), 400

    gestor, erro = _gestor_ou_erro(conexao, gestor_id)
    if erro:
        return erro

    _escola, endereco, texto, _html = _dados_da_mensagem(
        conexao, gestor["nome"], gestor["usuario"], senha, "/gestor", **ESTILO_GESTOR
    )
    smtp = banco.config_smtp(conexao)

    return jsonify({
        "texto": texto,
        "endereco": endereco,
        "email": gestor["email"] or "",
        "telefone": gestor["telefone"] or "",
        "whatsapp": mensagens.link_whatsapp(gestor["telefone"], texto),
        "assunto": ASSUNTO_CREDENCIAIS,
        "email_configurado": mensagens.configuracao_completa(smtp),
    })


@app.post("/api/gerente/gestores/<int:gestor_id>/enviar-email")
@requer_gerente
def enviar_credenciais_gestor(gestor_id):
    conexao = db()
    dados = request.get_json(silent=True) or {}
    senha = str(dados.get("senha", "")).strip()
    if not senha:
        return jsonify({"erro": "Gere uma senha antes de enviar as credenciais."}), 400

    gestor, erro = _gestor_ou_erro(conexao, gestor_id)
    if erro:
        return erro
    if not gestor["email"]:
        return jsonify({"erro": "Este gestor não tem e-mail cadastrado."}), 400

    _escola, _endereco, texto, html = _dados_da_mensagem(
        conexao, gestor["nome"], gestor["usuario"], senha, "/gestor", **ESTILO_GESTOR
    )
    smtp = banco.config_smtp(conexao)

    try:
        mensagens.enviar_email(smtp, gestor["email"], ASSUNTO_CREDENCIAIS, texto, html)
    except mensagens.ErroDeEnvio as erro_envio:
        return jsonify({
            "erro": str(erro_envio),
            "email_configurado": mensagens.configuracao_completa(smtp),
        }), 502

    return jsonify({"ok": True, "enviado_para": gestor["email"]})


@app.delete("/api/gerente/gestores/<int:gestor_id>")
@requer_gerente
def excluir_gestor(gestor_id):
    conexao = db()
    if conexao.execute("SELECT 1 FROM gestores WHERE id = ?", (gestor_id,)).fetchone() is None:
        return jsonify({"erro": "Gestor não encontrado."}), 404
    if eh_ultimo_gestor_ativo(conexao, gestor_id):
        return jsonify({
            "erro": "Este é o único gestor local ativo. Crie outro antes de excluí-lo, "
                    "senão a escola fica sem quem administre o sistema."
        }), 409

    conexao.execute("DELETE FROM gestores WHERE id = ?", (gestor_id,))
    conexao.commit()
    return jsonify({"ok": True})


@app.post("/api/gerente/senha")
@requer_gerente
def trocar_senha_gerente():
    conexao = db()
    dados = request.get_json(silent=True) or {}
    atual = str(dados.get("senha_atual", ""))
    nova = str(dados.get("nova_senha", "")).strip()

    if not banco.validar_senha_gerente(conexao, atual):
        return jsonify({"erro": "A senha atual está incorreta."}), 401
    if len(nova) < 6:
        return jsonify({"erro": "A nova senha precisa ter pelo menos 6 caracteres."}), 400

    banco.definir_senha_gerente(conexao, nova)
    conexao.commit()
    return jsonify({"ok": True})


# --------------------------------------------------------------------------- #
# Inicializacao
# --------------------------------------------------------------------------- #

def ip_da_rede():
    """Descobre o IP local para acessar o sistema pelo celular na mesma rede."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("8.8.8.8", 80))
            return sock.getsockname()[0]
    except OSError:
        return "127.0.0.1"


def conferir_disco_persistente():
    """Avisa, no log, se os dados estao numa pasta que o proximo deploy apaga.

    O erro mais caro da hospedagem e publicar sem criar o volume: o sistema sobe,
    funciona o dia inteiro e perde tudo na atualizacao seguinte. Aqui isso vira
    um aviso visivel nos logs, em vez de uma surpresa semanas depois.

    So vale quando PASTA_DADOS aponta para fora da pasta do codigo (ou seja, na
    hospedagem). No PC da escola nao ha volume nenhum e esta conferencia nao faz
    sentido.
    """
    pasta_local = os.path.join(banco.PASTA_BASE, "dados")
    if os.path.abspath(banco.PASTA_DADOS) == os.path.abspath(pasta_local):
        return  # rodando no PC, com a pasta dados/ do lado do codigo

    try:
        with open("/proc/mounts", encoding="utf-8") as arquivo:
            montagens = arquivo.read()
    except OSError:
        return  # fora do Linux nao da para conferir; nao e motivo de alarme

    destino = os.path.abspath(banco.PASTA_DADOS)
    if any(linha.split()[1] == destino
           for linha in montagens.splitlines() if len(linha.split()) > 1):
        print(f"[sistema] dados no volume {destino} (persistente)", flush=True)
        return

    print("=" * 70, flush=True)
    print(f"AVISO GRAVE: {destino} NAO e um volume montado.", flush=True)
    print("O banco, as fotos e a chave de sessao estao dentro do container e", flush=True)
    print("SERAO APAGADOS na proxima atualizacao do sistema.", flush=True)
    print("", flush=True)
    print("No Railway: Settings > Volumes > Add Volume, com Mount path /data.", flush=True)
    print("Veja HOSPEDAGEM.md, parte 5.1.", flush=True)
    print("=" * 70, flush=True)


def preparar_sistema():
    """Deixa o banco e os arquivos prontos para atender.

    Precisa rodar na importacao do modulo, e nao dentro do bloco `__main__`:
    na hospedagem quem sobe o sistema e o gunicorn, que importa `app` daqui e
    nunca executa aquele bloco. Sem isto o servidor online subiria sem criar as
    tabelas. Tudo aqui e repetivel -- rodar de novo num banco cheio nao apaga
    nada (veja banco.inicializar).
    """
    conferir_disco_persistente()
    # antes de inicializar: `banco.inicializar()` criaria um banco vazio, e o
    # restaurador so age quando nao existe banco nenhum
    armazenamento.restaurar_do_r2()
    banco.inicializar()
    armazenamento.sincronizar_fotos_do_r2()
    armazenamento.iniciar_backup_automatico()


preparar_sistema()


if __name__ == "__main__":
    endereco = ip_da_rede()
    print("=" * 62)
    print("  Sistema de Reserva de Laboratórios")
    print("=" * 62)
    print("  Professor     : http://localhost:5000")
    print(f"  Celular       : http://{endereco}:5000  (mesma rede Wi-Fi)")
    print("  Gestor local  : http://localhost:5000/gestor")
    print(f"     usuário {banco.USUARIO_GESTOR_PADRAO} / senha {banco.SENHA_GESTOR_PADRAO}"
          "  (ou a senha de administrador que já era usada)")
    print("  Gerente geral : http://localhost:5000/gerente")
    print(f"     senha {banco.SENHA_GERENTE_PADRAO}")
    print("=" * 62)
    app.run(host="0.0.0.0", port=5000, debug=False)
