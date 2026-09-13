FROM python:3.12-slim

# Fuso de Recife: as reservas gravam data/hora com o relogio do servidor, entao
# sem isto o sistema trabalharia em UTC e as aulas apareceriam 3 horas adiante.
ENV TZ=America/Recife \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

# A variavel TZ acima so tem efeito se o sistema tiver a tabela de fusos, e a
# imagem "slim" vem sem ela. Sem este pacote o servidor rodaria em UTC e toda
# reserva ficaria 3 horas adiantada -- inclusive a conta de antecedencia que
# libera ou barra o cancelamento.
RUN apt-get update \
    && apt-get install -y --no-install-recommends tzdata \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# O banco, as fotos e a chave de sessao ficam AQUI, no volume do Railway --
# fora de /app, que e recriado do zero a cada atualizacao do sistema.
#
# De proposito NAO existe um `VOLUME ["/data"]` aqui: ele faria o Docker criar
# um volume anonimo quando o volume do Railway nao estivesse configurado, e
# /data apareceria como ponto de montagem de verdade. O sistema pareceria certo,
# sobreviveria a um restart, e mesmo assim perderia tudo no proximo deploy.
# Sem essa declaracao, a conferencia em app.preparar_sistema() consegue avisar.
ENV PASTA_DADOS=/data

EXPOSE 8080

# 1 worker: o SQLite mora num arquivo unico no volume, e o backup automatico
# roda numa thread interna. Varios workers duplicariam o backup e brigariam
# pelo arquivo. As 8 threads dao conta de sobra de uma escola.
CMD gunicorn app:app \
    --bind 0.0.0.0:${PORT:-8080} \
    --workers 1 \
    --threads 8 \
    --timeout 120 \
    --access-logfile - \
    --error-logfile -
