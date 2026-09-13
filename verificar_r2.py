"""Confere se a conexao com o Cloudflare R2 esta funcionando.

Roda a mesma sequencia que o sistema faz quando esta no ar -- gravar, ler,
listar e apagar -- e traduz os erros da Cloudflare para portugues, porque as
mensagens originais ("SignatureDoesNotMatch") nao dizem o que arrumar.

Uso:

    python verificar_r2.py              confere a conexao (nao mexe nos dados)
    python verificar_r2.py --backup     confere e ainda envia um backup de verdade

As variaveis precisam estar definidas no terminal antes de rodar. No PowerShell:

    $env:R2_ACCOUNT_ID="..."
    $env:R2_ACCESS_KEY_ID="..."
    $env:R2_SECRET_ACCESS_KEY="..."
    $env:R2_BUCKET="sistema-escolar"
    $env:CHAVE_DADOS="..."
    python verificar_r2.py
"""

import argparse
import os
import sys

import armazenamento

OK = "  [ok]   "
FALHA = "  [FALHA]"
AVISO = "  [aviso]"

VARIAVEIS = ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY",
             "R2_BUCKET")


def disfarcar(valor):
    """Mostra o suficiente para conferir o valor sem expor o segredo."""
    if len(valor) <= 8:
        return "*" * len(valor)
    return f"{valor[:4]}{'*' * 8}{valor[-4:]}"


def parece_marcador(valor):
    """True quando o valor ainda tem os sinais de "preencha aqui".

    Copiar `$env:CHAVE="<sua chave>"` junto com os sinais e um erro silencioso:
    a variavel fica definida, tudo parece certo, e o valor esta errado.
    """
    return valor.startswith("<") and valor.endswith(">")


def conferir_variaveis():
    print("1) Variaveis de ambiente")
    faltando = []
    for nome in VARIAVEIS:
        valor = os.environ.get(nome, "").strip()
        if not valor:
            # o endpoint completo substitui o account id, se voce preferir
            if nome == "R2_ACCOUNT_ID" and os.environ.get("R2_ENDPOINT", "").strip():
                print(f"{OK} R2_ENDPOINT no lugar de R2_ACCOUNT_ID")
                continue
            print(f"{FALHA} {nome} nao definida")
            faltando.append(nome)
        elif parece_marcador(valor):
            print(f"{FALHA} {nome} esta com os sinais < > no valor")
            print("           Copie so o conteudo, sem o < e o >.")
            faltando.append(nome)
        elif nome == "R2_BUCKET":
            print(f"{OK} {nome} = {valor}")
        else:
            print(f"{OK} {nome} = {disfarcar(valor)}")

    chave = os.environ.get("CHAVE_DADOS", "").strip()
    if chave and parece_marcador(chave):
        print(f"{FALHA} CHAVE_DADOS esta com os sinais < > no valor")
        print("           Copie so o conteudo, sem o < e o >. Do jeito que")
        print("           esta, ela nao bate com a chave do Railway.")
        faltando.append("CHAVE_DADOS")
    elif chave:
        print(f"{OK} CHAVE_DADOS definida (os backups vao criptografados)")
    else:
        print(f"{AVISO} CHAVE_DADOS nao definida -- os backups iriam SEM")
        print("           criptografia. Defina antes de usar para valer.")

    return faltando


def explicar(erro, etapa=""):
    """Traduz o erro da Cloudflare para uma instrucao do que arrumar."""
    codigo = ""
    if hasattr(erro, "response"):
        codigo = erro.response.get("Error", {}).get("Code", "")
    texto = f"{codigo} {erro}".lower()

    if "invalidaccesskeyid" in texto or "invalid access key" in texto:
        return ("O R2_ACCESS_KEY_ID nao foi reconhecido.",
                "Confira se copiou o Access Key ID inteiro do token R2.")
    if "signaturedoesnotmatch" in texto:
        return ("O R2_SECRET_ACCESS_KEY esta errado.",
                "O Secret aparece uma unica vez na Cloudflare. Se voce nao "
                "guardou, crie um token novo em Manage R2 API Tokens.")
    if "nosuchbucket" in texto or "404" in texto:
        return (f"O bucket '{armazenamento.BUCKET}' nao existe nesta conta.",
                "Confira o nome exato no painel do R2 e o R2_ACCOUNT_ID -- um "
                "account id de outra conta da esse mesmo erro.")
    if "accessdenied" in texto or "403" in texto:
        # se a leitura passou e so a escrita falhou, o diagnostico e exato:
        # o token foi criado como somente-leitura
        if etapa in ("gravar", "apagar"):
            return (f"O token consegue LER, mas nao consegue {etapa.upper()}.",
                    "Ele foi criado como 'Object Read only'. Na Cloudflare: R2 > "
                    "Manage R2 API Tokens > Create API Token, com a permissao "
                    "'Object Read & Write'. O token antigo pode ser apagado.")
        return ("O token nao tem permissao para isto.",
                "Crie o token com 'Object Read & Write'. Se voce restringiu a "
                f"um bucket especifico, veja se e mesmo o '{armazenamento.BUCKET}'.")
    # um account id errado nao da "host nao encontrado": a Cloudflare atende o
    # subdominio e derruba a conexao no SSL. Sem tratar aqui, o erro mais
    # provavel de todos apareceria como "erro inesperado".
    sinais_de_conexao = ("ssl", "endpoint", "could not connect",
                         "name or service", "connection")
    if any(sinal in texto for sinal in sinais_de_conexao):
        return ("Nao consegui alcancar o endereco do R2.",
                "Quase sempre e o R2_ACCOUNT_ID: ele monta o endereco "
                f"{armazenamento._endereco_r2()} . Copie o Account ID do "
                "painel da Cloudflare (canto direito, ou o proprio endpoint "
                "mostrado na pagina do bucket). Se ele estiver certo, confira "
                "a internet.")
    return ("Erro inesperado.", str(erro))


def main():
    analisador = argparse.ArgumentParser(
        description="Confere a conexao com o Cloudflare R2."
    )
    analisador.add_argument("--backup", action="store_true",
                            help="envia tambem um backup de verdade do banco")
    argumentos = analisador.parse_args()

    print()
    print("=" * 64)
    print("  Conferencia da conexao com o Cloudflare R2")
    print("=" * 64)
    print()

    if not armazenamento.BOTO_DISPONIVEL:
        print(f"{FALHA} a biblioteca boto3 nao esta instalada.")
        print("         Rode:  pip install -r requirements.txt")
        return 2

    if conferir_variaveis():
        print()
        print("Defina as variaveis que faltam e rode de novo.")
        return 2

    print()
    print(f"2) Endereco: {armazenamento._endereco_r2()}")
    print(f"   Bucket  : {armazenamento.BUCKET}")
    if armazenamento.PREFIXO:
        print(f"   Pasta   : {armazenamento.PREFIXO}/")
    print()

    print("3) Conversando com o bucket")
    chave_teste = armazenamento._chave("teste-conexao.txt")
    conteudo = b"Sistema de Reserva de Laboratorios -- teste de conexao."
    etapa = "conectar"
    try:
        cliente = armazenamento.cliente()

        cliente.head_bucket(Bucket=armazenamento.BUCKET)
        print(f"{OK} o bucket existe e as chaves foram aceitas")

        etapa = "gravar"
        cliente.put_object(Bucket=armazenamento.BUCKET, Key=chave_teste,
                           Body=conteudo)
        print(f"{OK} gravar (put_object)")

        etapa = "ler"
        lido = cliente.get_object(
            Bucket=armazenamento.BUCKET, Key=chave_teste
        )["Body"].read()
        if lido != conteudo:
            print(f"{FALHA} o que voltou e diferente do que foi gravado")
            return 1
        print(f"{OK} ler (get_object)")

        etapa = "listar"
        cliente.list_objects_v2(Bucket=armazenamento.BUCKET, MaxKeys=1)
        print(f"{OK} listar (list_objects_v2)")

        etapa = "apagar"
        cliente.delete_object(Bucket=armazenamento.BUCKET, Key=chave_teste)
        print(f"{OK} apagar (delete_object)")
    except Exception as erro:  # noqa: BLE001 - a ideia e explicar qualquer falha
        print(f"{FALHA} parou na etapa: {etapa}")
        titulo, ajuda = explicar(erro, etapa)
        print(f"{FALHA} {titulo}")
        print(f"         {ajuda}")
        return 1

    if argumentos.backup:
        print()
        print("4) Backup de verdade")
        nome = armazenamento.enviar_backup()
        if not nome:
            print(f"{FALHA} o backup nao foi enviado (veja a mensagem acima)")
            return 1
        print(f"{OK} enviado: {nome}")
        try:
            dados = armazenamento.baixar_backup(nome)
        except Exception as erro:  # noqa: BLE001
            print(f"{FALHA} o backup subiu mas nao consegui abrir de volta: {erro}")
            return 1
        if not dados.startswith(b"SQLite format 3"):
            print(f"{FALHA} o backup voltou corrompido")
            return 1
        print(f"{OK} baixado e aberto de volta: banco valido, "
              f"{len(dados) // 1024} KB")

    print()
    print("=" * 64)
    print("  Tudo certo. Pode usar estas mesmas variaveis no Railway.")
    print("=" * 64)
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
