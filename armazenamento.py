"""Armazenamento de arquivos no Cloudflare R2, com disco local como reserva.

Guarda tres tipos de arquivo:

    fotos        - a foto de perfil de cada professor;
    calendarios  - o calendario escolar em PDF de cada escola;
    backups      - copias do banco (dados/escola.db), enviadas de tempos em tempos.

Por que o R2 e nao so o disco do servidor: na hospedagem o disco e um volume
unico, sem copia. Se ele for perdido ou o servico for recriado, tudo vai junto.
O R2 fica sendo a fonte da verdade, e o disco local funciona como cache -- a
foto e lida do disco quando ja esta la e baixada do R2 quando nao esta.

Sem as variaveis de ambiente do R2 configuradas (o caso do PC da escola), tudo
continua funcionando exatamente como antes, direto na pasta dados/fotos.

Variaveis de ambiente:

    R2_ACCOUNT_ID          id da conta Cloudflare (monta o endereco do R2)
    R2_ENDPOINT            alternativa: o endereco completo, se preferir
    R2_ACCESS_KEY_ID       do token de API R2
    R2_SECRET_ACCESS_KEY   do token de API R2
    R2_BUCKET              nome do bucket
    R2_PREFIX              pasta dentro do bucket (padrao: vazio)
    CHAVE_DADOS            senha que criptografa os backups (a mesma do
                           criptografar_dados.py). Sem ela o backup sobe
                           sem criptografia e o sistema avisa no log.
    BACKUP_HORAS           de quantas em quantas horas salvar (padrao: 6)
    BACKUP_MANTER          quantos backups guardar no R2 (padrao: 30)
"""

import base64
import os
import secrets
import sqlite3
import tempfile
import threading
import time
from datetime import datetime

import banco

# boto3 so e necessario na hospedagem. No PC da escola o sistema roda sem ele.
try:
    import boto3
    from botocore.config import Config
    from botocore.exceptions import BotoCoreError, ClientError

    BOTO_DISPONIVEL = True
except ImportError:
    BOTO_DISPONIVEL = False

    # para o `except ERROS_R2` la embaixo continuar valido sem o boto3
    class BotoCoreError(Exception):
        pass

    class ClientError(Exception):
        pass


ERROS_R2 = (BotoCoreError, ClientError, OSError, ValueError)

PREFIXO = os.environ.get("R2_PREFIX", "").strip().strip("/")
BUCKET = os.environ.get("R2_BUCKET", "").strip()

_cliente = None
_trava_cliente = threading.Lock()


def _log(mensagem):
    print(f"[armazenamento] {mensagem}", flush=True)


def _endereco_r2():
    endpoint = os.environ.get("R2_ENDPOINT", "").strip()
    if endpoint:
        return endpoint
    conta = os.environ.get("R2_ACCOUNT_ID", "").strip()
    if conta:
        return f"https://{conta}.r2.cloudflarestorage.com"
    return ""


def ativo():
    """True quando o R2 esta configurado e utilizavel."""
    return bool(
        BOTO_DISPONIVEL
        and BUCKET
        and _endereco_r2()
        and os.environ.get("R2_ACCESS_KEY_ID")
        and os.environ.get("R2_SECRET_ACCESS_KEY")
    )


def cliente():
    """Cria (uma vez so) o cliente S3 apontado para o R2."""
    global _cliente
    if _cliente is None:
        with _trava_cliente:
            if _cliente is None:
                _cliente = boto3.client(
                    "s3",
                    endpoint_url=_endereco_r2(),
                    aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
                    aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
                    # o R2 nao usa regiao, mas a biblioteca exige uma
                    region_name="auto",
                    config=Config(
                        signature_version="s3v4",
                        retries={"max_attempts": 3, "mode": "standard"},
                    ),
                )
    return _cliente


def _chave(*partes):
    """Monta o caminho do objeto dentro do bucket, respeitando o R2_PREFIX."""
    caminho = "/".join(parte.strip("/") for parte in partes if parte)
    return f"{PREFIXO}/{caminho}" if PREFIXO else caminho


# --------------------------------------------------------------------------- #
# Arquivos enviados pelas telas (fotos e calendarios)
# --------------------------------------------------------------------------- #
#
# Fotos e calendarios seguem o mesmo caminho: o disco local e o cache, o R2 e a
# fonte da verdade. `pasta` e a pasta no disco e `grupo` o nome da pasta dentro
# do bucket ("fotos", "calendarios").

def _gravar_arquivo(pasta, grupo, nome_arquivo, conteudo, tipo):
    """Grava no disco local e, quando configurado, no R2."""
    os.makedirs(pasta, exist_ok=True)
    with open(os.path.join(pasta, nome_arquivo), "wb") as saida:
        saida.write(conteudo)

    if not ativo():
        return
    try:
        cliente().put_object(
            Bucket=BUCKET,
            Key=_chave(grupo, nome_arquivo),
            Body=conteudo,
            ContentType=tipo,
        )
    except ERROS_R2 as erro:
        # o arquivo ja esta no disco; quem enviou nao precisa ver um erro por
        # causa do envio para a nuvem, mas o log registra para investigar
        _log(f"falha ao enviar {grupo}/{nome_arquivo} para o R2: {erro}")


def _abrir_arquivo(pasta, grupo, nome_arquivo):
    """Devolve os bytes do arquivo, ou None se ele nao existir em lugar nenhum.

    Procura primeiro no disco (rapido). Se nao achar e o R2 estiver ligado,
    baixa de la e deixa a copia no disco para as proximas vezes.
    """
    caminho = os.path.join(pasta, nome_arquivo)
    if os.path.exists(caminho):
        with open(caminho, "rb") as arquivo:
            return arquivo.read()

    if not ativo():
        return None
    try:
        resposta = cliente().get_object(
            Bucket=BUCKET, Key=_chave(grupo, nome_arquivo)
        )
        conteudo = resposta["Body"].read()
    except ERROS_R2:
        return None

    try:
        os.makedirs(pasta, exist_ok=True)
        with open(caminho, "wb") as saida:
            saida.write(conteudo)
    except OSError:
        pass  # sem cache o sistema so fica um pouco mais lento
    return conteudo


def _apagar_arquivo(pasta, grupo, nome_arquivo):
    """Remove o arquivo do disco e do R2."""
    if not nome_arquivo:
        return
    caminho = os.path.join(pasta, nome_arquivo)
    if os.path.exists(caminho):
        try:
            os.remove(caminho)
        except OSError:
            pass

    if not ativo():
        return
    try:
        cliente().delete_object(Bucket=BUCKET, Key=_chave(grupo, nome_arquivo))
    except ERROS_R2 as erro:
        _log(f"falha ao apagar {grupo}/{nome_arquivo} no R2: {erro}")


# --------------------------------------------------------------------------- #
# Fotos de perfil
# --------------------------------------------------------------------------- #

TIPOS_IMAGEM = {"jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png",
                "webp": "image/webp", "gif": "image/gif"}


def _tipo_da_imagem(nome_arquivo):
    extensao = nome_arquivo.rsplit(".", 1)[-1].lower()
    return TIPOS_IMAGEM.get(extensao, "application/octet-stream")


def salvar_foto(nome_arquivo, conteudo):
    """Grava a foto no R2 (quando configurado) e no disco local como cache."""
    _gravar_arquivo(banco.PASTA_FOTOS, "fotos", nome_arquivo, conteudo,
                    _tipo_da_imagem(nome_arquivo))


def abrir_foto(nome_arquivo):
    """Devolve os bytes da foto, ou None se ela nao existir em lugar nenhum."""
    return _abrir_arquivo(banco.PASTA_FOTOS, "fotos", nome_arquivo)


def apagar_foto(nome_arquivo):
    """Remove a foto do disco e do R2."""
    _apagar_arquivo(banco.PASTA_FOTOS, "fotos", nome_arquivo)


# --------------------------------------------------------------------------- #
# Calendario escolar (PDF)
# --------------------------------------------------------------------------- #
#
# Nao entra na sincronizacao da subida, como as fotos: e um arquivo por escola,
# e a primeira pessoa que abrir o calendario num volume novo ja traz a copia.

def salvar_calendario(nome_arquivo, conteudo):
    _gravar_arquivo(banco.PASTA_CALENDARIOS, "calendarios", nome_arquivo,
                    conteudo, "application/pdf")


def abrir_calendario(nome_arquivo):
    return _abrir_arquivo(banco.PASTA_CALENDARIOS, "calendarios", nome_arquivo)


def apagar_calendario(nome_arquivo):
    _apagar_arquivo(banco.PASTA_CALENDARIOS, "calendarios", nome_arquivo)


def sincronizar_fotos_do_r2():
    """Baixa para o disco as fotos que estao no R2 e faltam localmente.

    Roda na subida do servidor. Cobre o caso do volume novo (ou recriado):
    sem isso, a primeira visita a cada perfil pagaria a ida ao R2.
    """
    if not ativo():
        return
    prefixo = _chave("fotos") + "/"
    os.makedirs(banco.PASTA_FOTOS, exist_ok=True)
    baixadas = 0
    try:
        paginas = cliente().get_paginator("list_objects_v2").paginate(
            Bucket=BUCKET, Prefix=prefixo
        )
        for pagina in paginas:
            for objeto in pagina.get("Contents", []):
                nome = objeto["Key"].rsplit("/", 1)[-1]
                if not nome or os.path.exists(
                    os.path.join(banco.PASTA_FOTOS, nome)
                ):
                    continue
                if abrir_foto(nome) is not None:
                    baixadas += 1
    except ERROS_R2 as erro:
        _log(f"falha ao sincronizar as fotos do R2: {erro}")
        return
    if baixadas:
        _log(f"{baixadas} foto(s) baixada(s) do R2")


# --------------------------------------------------------------------------- #
# Backup do banco
# --------------------------------------------------------------------------- #

ITERACOES_PBKDF2 = 600_000  # o mesmo do criptografar_dados.py


def _derivar_chave(senha, salt):
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

    kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt,
                     iterations=ITERACOES_PBKDF2)
    return base64.urlsafe_b64encode(kdf.derive(senha.encode("utf-8")))


def _salt():
    """Le (ou cria) o salt usado para derivar a chave dos backups.

    A ordem importa. O salt e metade da chave: com um salt diferente, a mesma
    CHAVE_DADOS gera outra chave e nenhum backup antigo abre mais. Num volume
    novo do Railway o arquivo local nao existe, entao antes de gerar um salt
    novo e preciso perguntar ao R2 se ja existe um -- senao o primeiro backup do
    servidor sobrescreveria o salt original e tornaria todos os backups
    anteriores impossiveis de abrir, de forma permanente.
    """
    caminho = os.path.join(banco.PASTA_DADOS, "salt.bin")

    # 1) o R2 manda. E o unico lugar que o seu PC e o servidor enxergam em
    #    comum, entao usar o salt de la garante que os dois derivem a mesma
    #    chave. Tambem conserta sozinho um volume que ficou com salt errado.
    if ativo():
        try:
            salt = cliente().get_object(
                Bucket=BUCKET, Key=_chave("backups", "salt.bin")
            )["Body"].read()
            if salt:
                if not os.path.exists(caminho):
                    # guarda so quando nao ha arquivo local: em dados/salt.bin
                    # mora o salt do criptografar_dados.py, que e outro assunto
                    # e nao pode ser trocado por este
                    os.makedirs(banco.PASTA_DADOS, exist_ok=True)
                    with open(caminho, "wb") as arquivo:
                        arquivo.write(salt)
                return salt
        except ERROS_R2:
            pass

    # 2) sem R2 (ou bucket ainda sem salt), vale o arquivo local
    if os.path.exists(caminho):
        with open(caminho, "rb") as arquivo:
            return arquivo.read()

    # 3) primeira vez de todas: cria um, que sobe junto no proximo backup
    salt = secrets.token_bytes(16)
    os.makedirs(banco.PASTA_DADOS, exist_ok=True)
    with open(caminho, "wb") as arquivo:
        arquivo.write(salt)
    return salt


def _copia_consistente():
    """Copia o banco usando a API de backup do SQLite.

    Copiar o arquivo .db com o sistema no ar pode capturar uma gravacao pela
    metade e gerar um backup corrompido. A API de backup do proprio SQLite faz
    a copia respeitando as transacoes em andamento.
    """
    destino = os.path.join(tempfile.gettempdir(),
                           f"escola-backup-{os.getpid()}.db")
    origem = sqlite3.connect(banco.CAMINHO_BANCO, timeout=30)
    try:
        copia = sqlite3.connect(destino)
        try:
            origem.backup(copia)
        finally:
            copia.close()
    finally:
        origem.close()

    with open(destino, "rb") as arquivo:
        conteudo = arquivo.read()
    try:
        os.remove(destino)
    except OSError:
        pass
    return conteudo


def enviar_backup():
    """Envia uma copia do banco para o R2. Devolve o nome do objeto, ou None."""
    if not ativo():
        return None
    if not os.path.exists(banco.CAMINHO_BANCO):
        return None

    try:
        conteudo = _copia_consistente()
    except (sqlite3.Error, OSError) as erro:
        _log(f"falha ao copiar o banco para backup: {erro}")
        return None

    senha = os.environ.get("CHAVE_DADOS", "").strip()
    if senha:
        from cryptography.fernet import Fernet

        salt = _salt()
        conteudo = Fernet(_derivar_chave(senha, salt)).encrypt(conteudo)
        extensao = "db.enc"
    else:
        _log("AVISO: CHAVE_DADOS nao configurada -- o backup vai para o R2 sem "
             "criptografia. Defina CHAVE_DADOS nas variaveis do Railway.")
        salt = None
        extensao = "db"

    # o sufixo aleatorio evita que dois backups do mesmo segundo (o seu envio
    # do PC e o primeiro backup do servidor, por exemplo) recebam o mesmo nome
    # e um apague o outro sem aviso
    carimbo = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    nome = f"escola-{carimbo}-{secrets.token_hex(2)}.{extensao}"
    try:
        cliente().put_object(Bucket=BUCKET, Key=_chave("backups", nome),
                             Body=conteudo)
        if salt is not None:
            # sem o salt a chave nao pode ser derivada de novo, e o backup vira
            # um arquivo ilegivel. Ele sobe junto, uma vez so.
            cliente().put_object(Bucket=BUCKET,
                                 Key=_chave("backups", "salt.bin"), Body=salt)
    except ERROS_R2 as erro:
        _log(f"falha ao enviar o backup para o R2: {erro}")
        return None

    _log(f"backup enviado: {nome} ({len(conteudo) // 1024} KB)")
    _limpar_backups_antigos()
    return nome


def listar_backups():
    """Nomes dos backups no R2, do mais novo para o mais antigo."""
    if not ativo():
        return []
    prefixo = _chave("backups") + "/"
    try:
        paginas = cliente().get_paginator("list_objects_v2").paginate(
            Bucket=BUCKET, Prefix=prefixo
        )
        nomes = [
            objeto["Key"].rsplit("/", 1)[-1]
            for pagina in paginas
            for objeto in pagina.get("Contents", [])
            if objeto["Key"].rsplit("/", 1)[-1].startswith("escola-")
        ]
    except ERROS_R2 as erro:
        _log(f"falha ao listar os backups: {erro}")
        return []
    return sorted(nomes, reverse=True)


def baixar_backup(nome):
    """Baixa um backup do R2 e devolve os bytes ja descriptografados."""
    if not ativo():
        raise RuntimeError("O R2 nao esta configurado nesta maquina.")
    resposta = cliente().get_object(Bucket=BUCKET, Key=_chave("backups", nome))
    conteudo = resposta["Body"].read()

    if not nome.endswith(".enc"):
        return conteudo

    senha = os.environ.get("CHAVE_DADOS", "").strip()
    if not senha:
        raise RuntimeError(
            "Este backup esta criptografado. Defina CHAVE_DADOS com a mesma "
            "chave usada pelo servidor para conseguir abrir."
        )
    from cryptography.fernet import Fernet

    salt = cliente().get_object(
        Bucket=BUCKET, Key=_chave("backups", "salt.bin")
    )["Body"].read()
    return Fernet(_derivar_chave(senha, salt)).decrypt(conteudo)


MARCADOR_FORCADO = ".restauracao-forcada"


def restaurar_do_r2():
    """Decide se o banco deve vir do R2 nesta subida, e traz se for o caso."""
    forcado = os.environ.get("RESTAURAR_FORCADO", "").strip()
    if forcado:
        return _restaurar_forcado(forcado)
    return restaurar_se_vazio()


def _restaurar_forcado(nome):
    """Substitui o banco em uso pelo backup `nome`, uma unica vez.

    Serve para o caso de o sistema online ja ter subido e criado um banco vazio
    antes de voce depositar o banco da escola: a restauracao automatica nao age
    com banco no lugar, e apagar o volume no Railway e trabalhoso e arriscado.

    A variavel guarda o NOME do backup, nao apenas "1", de proposito. Depois de
    restaurar, o nome fica gravado num marcador dentro do volume; se a variavel
    continuar definida no proximo deploy, a funcao reconhece que ja fez aquilo e
    nao repete. Sem isso, esquecer a variavel ligada faria o sistema voltar ao
    backup antigo a cada atualizacao, apagando semanas de reservas em silencio.
    """
    if not ativo():
        _log("RESTAURAR_FORCADO definido, mas o R2 nao esta configurado")
        return False

    marcador = os.path.join(banco.PASTA_DADOS, MARCADOR_FORCADO)
    if os.path.exists(marcador):
        with open(marcador, encoding="utf-8") as arquivo:
            if arquivo.read().strip() == nome:
                _log(f"RESTAURAR_FORCADO={nome} ja foi aplicado antes; ignorando.")
                _log("Pode remover a variavel nas configuracoes do Railway.")
                return False

    _log("=" * 62)
    _log(f"RESTAURACAO FORCADA: {nome}")

    try:
        conteudo = baixar_backup(nome)
    except Exception as erro:  # noqa: BLE001 - qualquer falha aqui e informativa
        _log(f"FALHA ao baixar {nome}: {erro}")
        _log("o banco atual NAO foi tocado.")
        _log("=" * 62)
        return False

    if not conteudo.startswith(b"SQLite format 3"):
        _log(f"FALHA: {nome} nao voltou como um banco SQLite valido.")
        _log("o banco atual NAO foi tocado.")
        _log("=" * 62)
        return False

    # o banco que esta saindo vai para o R2 antes de ser substituido: se o
    # backup escolhido for o errado, ainda da para voltar
    if os.path.exists(banco.CAMINHO_BANCO):
        anterior = enviar_backup()
        if anterior:
            _log(f"o banco que estava no ar foi guardado como {anterior}")

    os.makedirs(banco.PASTA_DADOS, exist_ok=True)
    with open(banco.CAMINHO_BANCO, "wb") as arquivo:
        arquivo.write(conteudo)
    # o WAL antigo pertence ao banco que acabou de sair; deixa-lo para tras
    # misturaria as duas versoes na primeira abertura
    for sufixo in ("-wal", "-shm"):
        resto = banco.CAMINHO_BANCO + sufixo
        if os.path.exists(resto):
            try:
                os.remove(resto)
            except OSError:
                pass

    with open(marcador, "w", encoding="utf-8") as arquivo:
        arquivo.write(nome)

    _log(f"banco substituido pelo backup: {len(conteudo) // 1024} KB")
    _log("REMOVA a variavel RESTAURAR_FORCADO nas configuracoes do Railway.")
    _log("=" * 62)
    return True


def restaurar_se_vazio():
    """Traz o banco do R2 quando o sistema sobe sem banco nenhum.

    Serve para duas situacoes, que na pratica sao a mesma:

    - a primeira subida do sistema, para ele nascer ja com os dados da escola
      (voce envia o banco do seu PC com `python enviar_banco.py`);
    - o volume perdido ou recriado, quando comecar do zero seria bem pior do
      que voltar para o backup de algumas horas atras.

    So age quando NAO existe banco. Com o banco no lugar, esta funcao nao toca
    em nada -- nunca sobrescreve dados em uso.

    Para desligar, defina RESTAURAR_AUTOMATICO=0.
    """
    if os.path.exists(banco.CAMINHO_BANCO):
        return False
    if not ativo():
        return False
    if os.environ.get("RESTAURAR_AUTOMATICO", "1") != "1":
        _log("nao ha banco, mas RESTAURAR_AUTOMATICO=0: comecando vazio")
        return False

    backups = listar_backups()
    if not backups:
        _log("nao ha banco nem backup no R2: comecando um banco novo")
        return False

    nome = backups[0]
    _log(f"nao ha banco no disco -- restaurando {nome} do R2")
    try:
        conteudo = baixar_backup(nome)
    except Exception as erro:  # noqa: BLE001 - qualquer falha aqui e informativa
        _log(f"FALHA ao restaurar: {erro}")
        _log("o sistema vai subir com um banco vazio. NAO cadastre nada antes "
             "de resolver isto, ou os dados antigos serao perdidos.")
        return False

    # um arquivo truncado ou com a chave errada viraria um banco corrompido:
    # melhor recusar e subir vazio, com aviso, do que gravar lixo por cima
    if not conteudo.startswith(b"SQLite format 3"):
        _log("FALHA: o backup nao voltou como um banco SQLite valido.")
        return False

    os.makedirs(banco.PASTA_DADOS, exist_ok=True)
    with open(banco.CAMINHO_BANCO, "wb") as arquivo:
        arquivo.write(conteudo)
    _log(f"banco restaurado do R2: {len(conteudo) // 1024} KB")
    return True


def _limpar_backups_antigos():
    """Apaga os backups que passaram do limite de BACKUP_MANTER."""
    try:
        manter = int(os.environ.get("BACKUP_MANTER", "30"))
    except ValueError:
        manter = 30
    if manter <= 0:
        return

    antigos = listar_backups()[manter:]
    if not antigos:
        return
    try:
        cliente().delete_objects(
            Bucket=BUCKET,
            Delete={"Objects": [{"Key": _chave("backups", nome)}
                                for nome in antigos]},
        )
        _log(f"{len(antigos)} backup(s) antigo(s) removido(s)")
    except ERROS_R2 as erro:
        _log(f"falha ao limpar backups antigos: {erro}")


_backup_iniciado = False


def iniciar_backup_automatico():
    """Liga o backup periodico em segundo plano (so uma vez por processo)."""
    global _backup_iniciado
    if _backup_iniciado or not ativo():
        return
    try:
        horas = float(os.environ.get("BACKUP_HORAS", "6"))
    except ValueError:
        horas = 6
    if horas <= 0:
        return
    _backup_iniciado = True

    def rotina():
        # espera um pouco para nao competir com a subida do servidor
        time.sleep(60)
        while True:
            enviar_backup()
            time.sleep(horas * 3600)

    threading.Thread(target=rotina, name="backup-r2", daemon=True).start()
    _log(f"backup automatico ligado (a cada {horas:g}h)")
