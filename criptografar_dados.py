"""Criptografa dados/escola.db e dados/chave_sessao.txt para versionar no Git.

Gera dados/escola.db.enc e dados/chave_sessao.txt.enc (arquivos cifrados,
seguros para commitar) a partir dos arquivos originais (que continuam fora
do Git, veja .gitignore).

Uso:
    python criptografar_dados.py

A chave vem da variavel de ambiente CHAVE_DADOS. Se ela nao existir, uma
nova chave e gerada e exibida uma unica vez -- copie e guarde em um lugar
seguro (gerenciador de senhas), pois sem ela os arquivos .enc nao podem ser
restaurados. Para descriptografar depois, veja descriptografar_dados.py.
"""

import base64
import os
import secrets

from cryptography.fernet import Fernet
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

PASTA_DADOS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dados")
CAMINHO_SALT = os.path.join(PASTA_DADOS, "salt.bin")
ARQUIVOS = ["escola.db", "chave_sessao.txt"]
ITERACOES_PBKDF2 = 600_000  # recomendacao OWASP (2023) para PBKDF2-SHA256


def obter_salt():
    if os.path.exists(CAMINHO_SALT):
        with open(CAMINHO_SALT, "rb") as arquivo:
            return arquivo.read()
    salt = secrets.token_bytes(16)
    with open(CAMINHO_SALT, "wb") as arquivo:
        arquivo.write(salt)
    return salt


def derivar_chave(senha: str, salt: bytes) -> bytes:
    kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=ITERACOES_PBKDF2)
    return base64.urlsafe_b64encode(kdf.derive(senha.encode("utf-8")))


def main():
    os.makedirs(PASTA_DADOS, exist_ok=True)
    senha = os.environ.get("CHAVE_DADOS")
    chave_gerada = False
    if not senha:
        senha = secrets.token_urlsafe(32)
        chave_gerada = True

    fernet = Fernet(derivar_chave(senha, obter_salt()))

    for nome in ARQUIVOS:
        origem = os.path.join(PASTA_DADOS, nome)
        if not os.path.exists(origem):
            print(f"Aviso: {nome} nao encontrado, pulando.")
            continue
        with open(origem, "rb") as arquivo:
            conteudo = arquivo.read()
        destino = origem + ".enc"
        with open(destino, "wb") as arquivo:
            arquivo.write(fernet.encrypt(conteudo))
        print(f"Criptografado: {destino}")

    if chave_gerada:
        print()
        print("=" * 70)
        print("NOVA CHAVE GERADA -- guarde em um lugar seguro (gerenciador de")
        print("senhas). Sem ela, os arquivos .enc nao podem ser restaurados:")
        print()
        print(f"    CHAVE_DADOS={senha}")
        print()
        print("=" * 70)


if __name__ == "__main__":
    main()
