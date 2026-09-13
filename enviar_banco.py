"""Envia o banco deste PC para o Cloudflare R2, para o sistema online nascer
ja com os dados da escola.

Como funciona: o banco sobe criptografado, como um backup comum. Quando o
sistema no Railway subir e nao encontrar banco nenhum no volume, ele procura o
backup mais recente no R2 e restaura -- e a escola aparece la completa, com
alunos, professores, grade e reservas.

Uso:
    python enviar_banco.py            mostra o que sera enviado e pede confirmacao
    python enviar_banco.py --sim      envia sem perguntar

O melhor momento e ANTES do primeiro deploy. Se o sistema online ja subiu e
criou um banco vazio, ele NAO sera sobrescrito -- veja o final do HOSPEDAGEM.md
para o caminho nesse caso.

As variaveis do R2 e a CHAVE_DADOS precisam estar definidas no terminal, as
mesmas que vao para o Railway. No PowerShell:

    $env:R2_ACCOUNT_ID="..."
    $env:R2_ACCESS_KEY_ID="..."
    $env:R2_SECRET_ACCESS_KEY="..."
    $env:R2_BUCKET="sistema-escolar"
    $env:CHAVE_DADOS="..."
    python enviar_banco.py
"""

import argparse
import os
import sqlite3
import sys

import armazenamento
import banco

# o que contar para voce conferir, antes de enviar, se e o banco certo
CONTAGENS = (
    ("alunos", "alunos"),
    ("professores", "professores"),
    ("laboratorios", "laboratórios"),
    ("salas", "salas"),
    ("aulas_grade", "aulas na grade"),
    ("reservas", "reservas"),
)


def resumo_do_banco():
    """Conta as linhas das tabelas principais, para conferencia visual."""
    conexao = sqlite3.connect(banco.CAMINHO_BANCO)
    try:
        linhas = []
        for tabela, rotulo in CONTAGENS:
            try:
                total = conexao.execute(
                    f"SELECT COUNT(*) FROM {tabela}"
                ).fetchone()[0]
            except sqlite3.Error:
                continue  # tabela ainda nao existe neste banco
            linhas.append((rotulo, total))
        return linhas
    finally:
        conexao.close()


def main():
    analisador = argparse.ArgumentParser(
        description="Envia o banco deste PC para o R2."
    )
    analisador.add_argument("--sim", action="store_true",
                            help="envia sem pedir confirmacao")
    argumentos = analisador.parse_args()

    print()
    print("=" * 64)
    print("  Enviar o banco deste PC para o Cloudflare R2")
    print("=" * 64)
    print()

    if not os.path.exists(banco.CAMINHO_BANCO):
        print(f"Nao encontrei o banco em {banco.CAMINHO_BANCO}")
        return 1

    if not armazenamento.ativo():
        print("O R2 nao esta configurado neste terminal.")
        print()
        print("Defina antes de rodar (as mesmas variaveis do Railway):")
        print("  R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,")
        print("  R2_BUCKET e CHAVE_DADOS")
        return 2

    chave = os.environ.get("CHAVE_DADOS", "").strip()
    if chave.startswith("<") and chave.endswith(">"):
        print("CHAVE_DADOS esta com os sinais < > no valor.")
        print()
        print("Os sinais eram so marcadores de 'preencha aqui'. Do jeito que")
        print("esta, a chave nao bate com a do Railway e o servidor nao vai")
        print("conseguir abrir o backup. Defina sem o < e o > e rode de novo.")
        return 2

    if not chave:
        print("CHAVE_DADOS nao definida.")
        print()
        print("Sem ela o banco subiria SEM criptografia, e ele tem os dados")
        print("pessoais dos alunos. Defina a mesma chave que vai para o")
        print("Railway e rode de novo.")
        return 2

    tamanho = os.path.getsize(banco.CAMINHO_BANCO)
    print(f"Banco  : {banco.CAMINHO_BANCO}")
    print(f"Tamanho: {tamanho // 1024} KB")
    print(f"Destino: bucket {armazenamento.BUCKET}, pasta backups/")
    print()
    print("Conteudo:")
    for rotulo, total in resumo_do_banco():
        print(f"  {total:6d}  {rotulo}")
    print()

    if not argumentos.sim:
        print("O arquivo sobe criptografado com a CHAVE_DADOS.")
        resposta = input("Enviar? [s/N] ").strip().lower()
        if resposta not in ("s", "sim"):
            print("Cancelado. Nada foi enviado.")
            return 1
        print()

    nome = armazenamento.enviar_backup()
    if not nome:
        print("Falhou. Rode 'python verificar_r2.py' para ver o motivo.")
        return 1

    print()
    print("=" * 64)
    print(f"  Enviado: {nome}")
    print("=" * 64)
    print()
    print("Quando o sistema subir no Railway sem banco no volume, ele vai")
    print("restaurar este arquivo sozinho. Procure nos logs:")
    print()
    print("    [armazenamento] nao ha banco no disco -- restaurando ... do R2")
    print("    [armazenamento] banco restaurado do R2: ... KB")
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
