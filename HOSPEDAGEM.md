# Colocar o sistema online (Railway + Cloudflare R2)

Este guia deixa o sistema no ar com os dados em três camadas, cada uma
resolvendo um problema diferente:

| Onde | O que guarda | Por quê |
|---|---|---|
| **Volume do Railway** (`/data`) | banco `escola.db`, chave de sessão, cache das fotos e dos calendários em PDF | disco que **sobrevive às atualizações** do sistema |
| **Cloudflare R2** | fotos de perfil + calendário escolar (PDF) de cada escola + backups do banco | cópia externa, caso o volume seja perdido |
| Pasta `dados/` do PC | tudo isso, no seu computador | continua funcionando como sempre, sem mudar nada |

> **A regra que faz tudo funcionar:** o banco fica em `/data`, **fora** da pasta
> do código. Quando você publica uma atualização, o Railway joga fora o
> container antigo e monta um novo — a pasta do código é substituída inteira,
> mas o volume é remontado do jeito que estava. Por isso os dados não se perdem.

---

## Parte 1 — Criar o bucket no Cloudflare R2

1. Entre em <https://dash.cloudflare.com/> → **R2 Object Storage**.
2. **Create bucket**. Nome sugerido: `sistema-escolar`. Região: *Automatic*.
3. **Deixe o bucket privado** (é o padrão). Não ative acesso público: ele guarda
   fotos de professores e backups com dados de alunos — o sistema serve as fotos
   pela rota `/fotos/...`, que já exige login.
4. Ainda no R2, vá em **Manage R2 API Tokens** → **Create API Token**:
   - Permissão: **Object Read & Write**
   - Restrinja ao bucket que você acabou de criar
5. Copie e guarde os três valores que aparecem **uma única vez**:
   - `Access Key ID`
   - `Secret Access Key`
   - o **Account ID** (aparece no endpoint `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`)

---

## Parte 2 — Gerar a chave dos backups

Os backups sobem criptografados. Gere a chave uma vez, no seu PC:

```bash
python -c "import secrets; print(secrets.token_urlsafe(32))"
```

**Guarde essa chave em um gerenciador de senhas.** Sem ela nenhum backup pode
ser aberto — nem por você. Ela vai ser a variável `CHAVE_DADOS`.

Gere também a chave de sessão, do mesmo jeito (vai ser a `SECRET_KEY`):

```bash
python -c "import secrets; print(secrets.token_hex(32))"
```

---

## Parte 3 — Conferir a conexão antes de publicar

Vale testar aqui, no seu PC: um erro de digitação nas chaves aparece agora, com
uma mensagem em português, em vez de virar uma falha silenciosa nos logs do
Railway depois.

Instale as bibliotecas novas e defina as variáveis **no seu terminal**:

```powershell
pip install -r requirements.txt

$env:R2_ACCOUNT_ID="..."
$env:R2_ACCESS_KEY_ID="..."
$env:R2_SECRET_ACCESS_KEY="..."
$env:R2_BUCKET="sistema-escolar"
$env:CHAVE_DADOS="..."

python verificar_r2.py
```

O script grava, lê, lista e apaga um arquivo de teste no bucket:

```
3) Conversando com o bucket
  [ok]    o bucket existe e as chaves foram aceitas
  [ok]    gravar (put_object)
  [ok]    ler (get_object)
  [ok]    listar (list_objects_v2)
  [ok]    apagar (delete_object)
```

Para testar também o ciclo completo de backup — envia um backup de verdade,
baixa de volta e confere se abre como banco válido:

```powershell
python verificar_r2.py --backup
```

Se algo falhar, o script diz qual variável arrumar. Os erros mais comuns:

| Mensagem | O que arrumar |
|---|---|
| Não consegui alcançar o endereço | `R2_ACCOUNT_ID` (é ele que monta o endereço) |
| O `R2_ACCESS_KEY_ID` não foi reconhecido | Access Key ID incompleto ou trocado |
| O `R2_SECRET_ACCESS_KEY` está errado | o Secret aparece uma vez só; se perdeu, crie outro token |
| O bucket não existe nesta conta | nome do bucket, ou account id de outra conta |
| O token não tem permissão | recrie o token com **Object Read & Write** |

> As variáveis definidas com `$env:` valem só naquela janela do PowerShell.
> Fechou, sumiram — o que é bom: suas chaves não ficam gravadas no PC.

---

## Parte 4 — Depositar o banco da escola no R2

Faça isto **antes do primeiro deploy**. O sistema online nasce vazio; este passo
faz ele nascer já com alunos, professores, grade e reservas.

Com as mesmas variáveis ainda definidas no terminal:

```powershell
python enviar_banco.py
```

O script mostra o que vai enviar, para você conferir que é o banco certo:

```
Banco  : ...\dados\escola.db
Tamanho: 456 KB
Destino: bucket sistema-escolar, pasta backups/

Conteudo:
     471  alunos
      31  professores
       8  laboratórios
     540  aulas na grade
      21  reservas

Enviar? [s/N]
```

O banco sobe **criptografado** com a `CHAVE_DADOS` — ele tem dados pessoais de
alunos, e o R2 não é lugar para deixá-los em texto puro.

### Como o sistema online pega esses dados

Quando o servidor sobe e **não encontra banco no volume**, ele procura o backup
mais recente no R2 e restaura sozinho. Nos logs:

```
[armazenamento] nao ha banco no disco -- restaurando escola-....db.enc do R2
[armazenamento] banco restaurado do R2: 456 KB
```

Isso cobre duas situações com o mesmo mecanismo: a primeira subida (é o seu
caso agora) e o volume perdido ou recriado, quando voltar ao backup de algumas
horas atrás é muito melhor do que começar do zero.

> **Com banco no lugar, nada é restaurado.** A verificação é só "existe
> `escola.db` no volume?". Se existe, o sistema não toca nele — os dados em uso
> nunca são sobrescritos por um backup.

### Se o sistema online já subiu e criou um banco vazio

Aí o banco existe, e a restauração automática **não age** — de propósito: ela
nunca sobrescreve dados em uso. Para carregar o banco da escola mesmo assim,
use a restauração forçada.

1. Rode `python enviar_banco.py` e **anote o nome** do arquivo enviado, por
   exemplo `escola-2026-08-30_14-57-04-149f.db.enc`.
2. No Railway, em **Variables**, acrescente:

   ```
   RESTAURAR_FORCADO=escola-2026-08-30_14-57-04-149f.db.enc
   ```

3. O Railway reinicia sozinho. Nos logs:

   ```
   ==============================================================
   RESTAURACAO FORCADA: escola-2026-08-30_14-57-04-149f.db.enc
   o banco que estava no ar foi guardado como escola-....db.enc
   banco substituido pelo backup: 456 KB
   REMOVA a variavel RESTAURAR_FORCADO nas configuracoes do Railway.
   ==============================================================
   ```

4. **Remova a variável** depois.

Três proteções embutidas, porque esta é a única operação que substitui dados em
uso:

- **O banco que sai é guardado no R2 antes**, como um backup novo. Se você
  escolher o arquivo errado, dá para voltar.
- **A variável guarda o nome do backup, não apenas `1`.** Depois de restaurar,
  o nome fica gravado num marcador dentro do volume. Se você esquecer a variável
  ligada, o próximo deploy reconhece que já fez aquilo e não repete — sem isso,
  cada atualização voltaria ao banco antigo e apagaria as reservas da semana em
  silêncio.
- **Se o download falhar** ou o arquivo não vier como um SQLite válido, o banco
  em uso não é tocado.

---

## Parte 5 — Publicar no Railway

1. Suba o projeto para um repositório no GitHub. **Crie o repositório como
   privado** — o Railway funciona igual com repositório privado.

   O `.gitignore` já mantém fora do Git tudo que tem dado pessoal de aluno:
   `dados/escola.db`, `dados/escola.sql` (o banco em texto puro) e a pasta
   `alunos/` com as planilhas da secretaria. Sobem apenas as cópias
   criptografadas (`dados/escola.db.enc`) e o `salt.bin`, que não é segredo.

   Antes do primeiro `git push`, confira você mesmo o que vai subir:

   ```bash
   git add -A
   git status --short
   ```

   Se aparecer qualquer arquivo de `alunos/` ou o `dados/escola.sql` nessa
   lista, **pare** — o `.gitignore` foi alterado. O que entra no Git fica no
   histórico mesmo depois de apagado.
2. Em <https://railway.app/> → **New Project** → **Deploy from GitHub repo**.
3. O Railway detecta o `Dockerfile` sozinho e já começa a construir.

### 5.1 Criar o volume (o passo que não pode ser esquecido)

No serviço criado: aba **Settings** → **Volumes** → **Add Volume**.

- **Mount path:** `/data`

Sem isso o sistema sobe e funciona, mas **perde tudo a cada atualização**.

### 5.2 Definir as variáveis

Aba **Variables** → cole tudo de uma vez em **Raw Editor**:

```
PASTA_DADOS=/data
SECRET_KEY=<a chave de sessão que você gerou>
CHAVE_DADOS=<a chave dos backups que você gerou>

R2_ACCOUNT_ID=<Account ID da Cloudflare>
R2_ACCESS_KEY_ID=<Access Key ID do token R2>
R2_SECRET_ACCESS_KEY=<Secret Access Key do token R2>
R2_BUCKET=sistema-escolar

BACKUP_HORAS=6
BACKUP_MANTER=30
```

> `RESTAURAR_AUTOMATICO=0` desliga a restauração automática, se algum dia você
> quiser que o sistema suba vazio mesmo havendo backups no R2. Sem a variável,
> a restauração fica ligada — que é o que você quer agora.

### 5.3 Gerar o endereço

**Settings** → **Networking** → **Generate Domain**. O Railway devolve algo como
`sistemaescolar2-production.up.railway.app`.

Depois de entrar como gestor, coloque esse endereço em
**Configurações → Endereço do sistema**, para ele aparecer certo nas credenciais
enviadas aos professores.

---

## Parte 6 — Conferir se deu certo

Nos **Deploy Logs** do Railway, logo depois de subir, procure **duas linhas**.

### 1. O volume está mesmo montado

```
[sistema] dados no volume /data (persistente)
```

Se em vez disso aparecer o aviso abaixo, **pare e crie o volume** — o sistema
está funcionando, mas vai perder tudo na próxima atualização:

```
======================================================================
AVISO GRAVE: /data NAO e um volume montado.
O banco, as fotos e a chave de sessao estao dentro do container e
SERAO APAGADOS na proxima atualizacao do sistema.
======================================================================
```

### 2. O R2 foi reconhecido

```
[armazenamento] backup automatico ligado (a cada 6h)
```

Se não aparecer, o R2 não foi reconhecido — confira as quatro variáveis `R2_*`.

Cerca de um minuto depois deve aparecer o primeiro backup:

```
[armazenamento] backup enviado: escola-2026-08-30_11-45-54.db.enc (272 KB)
```

E no painel do R2 o bucket passa a ter duas pastas: `fotos/` e `backups/`. A
terceira, `calendarios/`, só aparece quando um gestor envia o primeiro
calendário escolar em PDF.

### 3. O horário está certo

Entre no sistema e confira se a hora mostrada bate com a de Recife. O
`Dockerfile` instala o pacote `tzdata` e define `TZ=America/Recife` justamente
para isso: sem o pacote, o container roda em UTC e **toda reserva apareceria 3
horas adiantada** — inclusive a conta de antecedência que libera ou barra o
cancelamento.

> **Aviso que não pode ser ignorado:** se o log disser
> `AVISO: CHAVE_DADOS nao configurada`, os backups estão subindo **sem
> criptografia**. Defina a variável e faça o redeploy.

---

## Parte 7 — Restaurar um backup

No seu PC, com as variáveis definidas no terminal:

```bash
# PowerShell
$env:R2_ACCOUNT_ID="..."; $env:R2_ACCESS_KEY_ID="..."
$env:R2_SECRET_ACCESS_KEY="..."; $env:R2_BUCKET="sistema-escolar"
$env:CHAVE_DADOS="..."

python restaurar_backup.py             # lista o que existe
python restaurar_backup.py --ultimo    # restaura o mais recente
```

O script pede confirmação antes de substituir e guarda uma cópia do banco atual
em `escola.db.antes-restauracao-<data>` — se você restaurar o backup errado,
ainda dá para voltar.

Para só dar uma olhada, sem mexer no banco em uso:

```bash
python restaurar_backup.py --ultimo --saida conferir.db
```

---

## O que acontece a cada atualização do sistema

Você altera o código, faz `git push`, e o Railway republica sozinho:

| | |
|---|---|
| Código | substituído inteiro (container novo) |
| `escola.db` | **intacto**, no volume |
| Fotos | **intactas**, no volume e no R2 |
| Chave de sessão | **intacta** (vem da variável `SECRET_KEY`) |
| Tabelas novas | criadas automaticamente por `banco.inicializar()` |
| Colunas novas | criadas por `banco.migrar()` — **veja o aviso abaixo** |

### ⚠️ A regra de ouro ao criar colunas novas

Quando você acrescentar uma coluna a uma tabela que já existe, **não basta
alterar o `ESQUEMA` em `banco.py`**. Num banco que já existe,
`CREATE TABLE IF NOT EXISTS` não faz nada — a coluna nasceria só em bancos
novos, e o sistema online quebraria com `no such column`.

A coluna precisa ser adicionada **também** na função `migrar()`, junto das
outras:

```python
if "minha_coluna" not in colunas_de(conexao, "minha_tabela"):
    conexao.execute("ALTER TABLE minha_tabela ADD COLUMN minha_coluna TEXT")
```

### ⚠️ Nunca rode isto no servidor online

`python descriptografar_dados.py` — ele sobrescreve o banco com o snapshot
antigo que está versionado no Git. É só para restaurar em máquina nova.

---

## Custo

- **Railway:** o volume e o serviço ficam no plano pago (a partir de US$ 5/mês).
- **Cloudflare R2:** os 10 GB gratuitos por mês cobrem este sistema com folga —
  o banco tem menos de 1 MB e as fotos são poucas. E o R2 **não cobra
  transferência de saída**, que é justamente o custo que pesaria ao servir
  imagens.

---

## Rodando no PC da escola, como sempre

Nada muda. Sem as variáveis de ambiente definidas, o sistema usa a pasta
`dados/` do lado do código e ignora o R2 por completo:

```
iniciar.bat
```

O `armazenamento.py` só liga o R2 quando encontra as quatro variáveis `R2_*`.
