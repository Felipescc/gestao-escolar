"""Lista e restaura os backups do banco guardados no Cloudflare R2.

Um backup que ninguem sabe restaurar nao e backup. Este script fecha o ciclo:
mostra o que existe no R2, baixa o backup escolhido e grava por cima do banco
atual -- sempre pedindo confirmacao antes, porque a gravacao apaga os dados que
estiverem no lugar.

Uso:

    python restaurar_backup.py                 lista os backups disponiveis
    python restaurar_backup.py --ultimo        restaura o mais recente
    python restaurar_backup.py escola-2026-08-30_03-00-00.db.enc
    python restaurar_backup.py --ultimo --saida copia.db   baixa sem substituir

Antes de rodar, as variaveis do R2 (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID,
R2_SECRET_ACCESS_KEY, R2_BUCKET) e a CHAVE_DADOS precisam estar definidas no
terminal -- as mesmas que estao configuradas no Railway.
"""

import argparse
import os
import shutil
import sys
from datetime import datetime

import armazenamento
import banco


def listar():
    nomes = armazenamento.listar_backups()
    if not nomes:
        print("Nenhum backup encontrado no R2.")
        return nomes
    print(f"Backups no bucket {armazenamento.BUCKET} (do mais novo ao mais antigo):")
    print()
    for indice, nome in enumerate(nomes, start=1):
        print(f"  {indice:2d}. {nome}")
    print()
    print(f"Total: {len(nomes)}")
    return nomes


def restaurar(nome, saida):
    print(f"Baixando {nome} ...")
    conteudo = armazenamento.baixar_backup(nome)
    print(f"Recebido: {len(conteudo) // 1024} KB")

    if os.path.exists(saida):
        # a copia de seguranca evita a pior versao do acidente: restaurar o
        # backup errado e nao ter mais como voltar para o banco de agora
        carimbo = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
        reserva = f"{saida}.antes-restauracao-{carimbo}"
        print()
        print(f"ATENCAO: {saida} ja existe e vai ser SUBSTITUIDO.")
        print(f"         O banco atual sera copiado para {reserva}")
        resposta = input("Digite RESTAURAR para confirmar: ").strip()
        if resposta != "RESTAURAR":
            print("Cancelado. Nada foi alterado.")
            return 1
        shutil.copy2(saida, reserva)

    os.makedirs(os.path.dirname(os.path.abspath(saida)), exist_ok=True)
    with open(saida, "wb") as arquivo:
        arquivo.write(conteudo)
    print(f"Pronto: {saida}")
    print()
    print("Reinicie o sistema para ele passar a usar o banco restaurado.")
    return 0


def main():
    analisador = argparse.ArgumentParser(
        description="Restaura um backup do banco a partir do Cloudflare R2."
    )
    analisador.add_argument("nome", nargs="?",
                            help="nome do backup (veja a lista sem argumentos)")
    analisador.add_argument("--ultimo", action="store_true",
                            help="usa o backup mais recente")
    analisador.add_argument("--saida", default=banco.CAMINHO_BANCO,
                            help="onde gravar (padrao: o banco em uso)")
    argumentos = analisador.parse_args()

    if not armazenamento.ativo():
        print("O R2 nao esta configurado neste terminal.")
        print()
        print("Defina as variaveis antes de rodar (as mesmas do Railway):")
        print("  R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,")
        print("  R2_BUCKET e CHAVE_DADOS")
        return 2

    if argumentos.ultimo:
        nomes = armazenamento.listar_backups()
        if not nomes:
            print("Nenhum backup encontrado no R2.")
            return 1
        return restaurar(nomes[0], argumentos.saida)

    if argumentos.nome:
        return restaurar(argumentos.nome, argumentos.saida)

    listar()
    print()
    print("Para restaurar:  python restaurar_backup.py --ultimo")
    return 0


if __name__ == "__main__":
    sys.exit(main())
