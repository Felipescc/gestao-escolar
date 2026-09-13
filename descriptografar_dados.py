"""Restaura dados/escola.db e dados/chave_sessao.txt a partir dos .enc.

Uso (Windows PowerShell):
    $env:CHAVE_DADOS = "<chave gerada na criptografia>"
    python descriptografar_dados.py

Uso (bash):
    CHAVE_DADOS=<chave> python descriptografar_dados.py
"""

import base64
import os
import sys

from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

PASTA_DADOS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dados")
CAMINHO_SALT = os.path.join(PASTA_DADOS, "salt.bin")
ARQUIVOS = ["escola.db", "chave_sessao.txt"]
ITERACOES_PBKDF2 = 600_000  # precisa bater com criptografar_dados.py


def derivar_chave(senha: str, salt: bytes) -> bytes:
    kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=ITERACOES_PBKDF2)
    return base64.urlsafe_b64encode(kdf.derive(senha.encode("utf-8")))


def main():
    senha = os.environ.get("CHAVE_DADOS")
    if not senha:
        sys.exit("Defina a variavel de ambiente CHAVE_DADOS com a chave gerada na criptografia.")

    if not os.path.exists(CAMINHO_SALT):
        sys.exit(f"Arquivo de salt nao encontrado: {CAMINHO_SALT}")
    with open(CAMINHO_SALT, "rb") as arquivo:
        salt = arquivo.read()

    fernet = Fernet(derivar_chave(senha, salt))

    for nome in ARQUIVOS:
        origem = os.path.join(PASTA_DADOS, nome + ".enc")
        if not os.path.exists(origem):
            print(f"Aviso: {nome}.enc nao encontrado, pulando.")
            continue
        with open(origem, "rb") as arquivo:
            token = arquivo.read()
        try:
            conteudo = fernet.decrypt(token)
        except InvalidToken:
            sys.exit(f"Chave incorreta ou arquivo corrompido: {origem}")
        destino = os.path.join(PASTA_DADOS, nome)
        with open(destino, "wb") as arquivo:
            arquivo.write(conteudo)
        print(f"Restaurado: {destino}")


if __name__ == "__main__":
    main()
