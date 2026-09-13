/* =========================================================================
   Funcoes compartilhadas pelas telas do sistema (professor, gestor, gerente):
   chamadas a API, notificacoes, janela modal e utilitarios de formatacao.
   ========================================================================= */

const API = {
    async requisitar(caminho, opcoes = {}) {
        let resposta;
        try {
            resposta = await fetch(caminho, {
                headers: { 'Content-Type': 'application/json' },
                ...opcoes,
            });
        } catch (erro) {
            // O fetch so estoura assim quando o pedido nem chegou ao servidor
            // (janela do sistema fechada, computador reiniciado, Wi-Fi caiu).
            // Sem este aviso a tela mostrava o "Failed to fetch" do navegador.
            const falha = new Error('Sem conexão com o servidor. Confira se a janela '
                + 'do sistema continua aberta no computador da escola e tente de novo.');
            falha.status = 0;
            falha.dados = {};
            throw falha;
        }

        // marca a conversa com o servidor: o vigia de inatividade so renova a
        // sessao quando faz tempo que a tela nao pede nada (veja conferirSessao)
        Sessao.ultimoPedido = Date.now();

        let dados = null;
        try {
            dados = await resposta.json();
        } catch (erro) {
            dados = null;
        }

        if (!resposta.ok) {
            // O servidor derrubou a sessao (ficou parada tempo demais, ou a
            // conta foi desativada). Voltar para o login explicando e melhor do
            // que um "acesso restrito" solto no meio do painel.
            if (dados && dados.sessao_expirada) encerrarPorInatividade(true);
            const falha = new Error((dados && dados.erro) || 'Não foi possível completar a ação.');
            falha.status = resposta.status;
            falha.dados = dados || {};
            throw falha;
        }
        return dados;
    },

    get(caminho) {
        return API.requisitar(caminho);
    },

    post(caminho, corpo) {
        return API.requisitar(caminho, { method: 'POST', body: JSON.stringify(corpo || {}) });
    },

    put(caminho, corpo) {
        return API.requisitar(caminho, { method: 'PUT', body: JSON.stringify(corpo || {}) });
    },

    del(caminho) {
        return API.requisitar(caminho, { method: 'DELETE' });
    },
};

/* ------------------------------------------------------------------ */
/* Utilitarios                                                         */
/* ------------------------------------------------------------------ */

const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun',
               'jul', 'ago', 'set', 'out', 'nov', 'dez'];

const DIAS_SEMANA = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

const ROTULO_TURNO = { manha: 'Manhã', tarde: 'Tarde', noite: 'Noite' };

const ROTULO_STATUS = {
    ativa: 'Ativa',
    realizada: 'Realizada',
    falta: 'Falta',
    cancelada: 'Cancelada',
};

function escapar(texto) {
    if (texto === null || texto === undefined) return '';
    return String(texto)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** 'AAAA-MM-DD' -> objeto Date no fuso local (evita o pulo de um dia do UTC). */
function paraData(iso) {
    const [ano, mes, dia] = String(iso).slice(0, 10).split('-').map(Number);
    return new Date(ano, mes - 1, dia);
}

function paraISO(data) {
    const mes = String(data.getMonth() + 1).padStart(2, '0');
    const dia = String(data.getDate()).padStart(2, '0');
    return `${data.getFullYear()}-${mes}-${dia}`;
}

function hojeISO() {
    return paraISO(new Date());
}

/* ---- Semana da grade de aulas (usada pelo professor e pelo gestor) ---- */

/** Segunda-feira da semana de uma data ISO (a de hoje, sem parametro). */
function segundaDaSemana(iso) {
    const data = iso ? paraData(iso) : new Date();
    data.setDate(data.getDate() - ((data.getDay() + 6) % 7));
    return paraISO(data);
}

/** A mesma semana deslocada em `semanas` (negativo volta no tempo). */
function deslocarSemana(iso, semanas) {
    const data = paraData(iso);
    data.setDate(data.getDate() + semanas * 7);
    return paraISO(data);
}

/**
 * Escreve "Semana de DD/MM a DD/MM" no rótulo da navegação e só mostra o
 * atalho de voltar quando a semana aberta não é a de hoje.
 */
function mostrarRotuloDaSemana(semana, idRotulo, idVoltar) {
    const rotulo = document.getElementById(idRotulo);
    if (!rotulo) return;
    const ehAtual = semana.inicio === segundaDaSemana();
    rotulo.textContent = `${ehAtual ? 'Esta semana' : 'Semana'} de `
        + `${dataBR(semana.inicio).slice(0, 5)} a ${dataBR(semana.fim)}`;
    const voltar = document.getElementById(idVoltar);
    if (voltar) voltar.classList.toggle('oculto', ehAtual);
}

function dataBR(iso) {
    const data = paraData(iso);
    return data.toLocaleDateString('pt-BR');
}

function dataExtenso(iso) {
    const data = paraData(iso);
    return `${DIAS_SEMANA[data.getDay()]}, ${data.getDate()} de ${MESES[data.getMonth()]}`;
}

/**
 * "2026-08-25 14:07:00" -> "25/08/2026 às 14:07".
 *
 * O banco grava data e hora como texto ISO com espaço no meio (o `agora()` do
 * `banco.py`), então a hora sai do próprio texto — sem `new Date`, que trocaria
 * o fuso do servidor pelo do aparelho de quem está olhando.
 */
function dataHoraBR(iso) {
    const texto = String(iso || '');
    if (!texto) return '—';
    const hora = texto.slice(11, 16);
    return hora ? `${dataBR(texto)} às ${hora}` : dataBR(texto);
}

function somarDias(iso, dias) {
    const data = paraData(iso);
    data.setDate(data.getDate() + dias);
    return paraISO(data);
}

/** 2048576 -> "2,0 MB"; abaixo de 1 MB sai em KB (a foto do professor, o PDF). */
function formatarTamanhoArquivo(bytes) {
    const mb = bytes / (1024 * 1024);
    if (mb >= 1) return `${mb.toFixed(1).replace('.', ',')} MB`;
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/* ---- Grade de aulas dia a dia no celular ---- */

/**
 * No celular os cinco dias nao cabem lado a lado: a grade passa a mostrar um
 * dia de cada vez, escolhido no seletor de dias. O limite e o mesmo do CSS,
 * que esconde o seletor e volta a semana inteira a partir de 900px.
 */
const telaMobile = window.matchMedia('(max-width: 899px)');

const DIAS_SEMANA_CURTO = ['DOM', 'SEG', 'TER', 'QUA', 'QUI', 'SEX', 'SÁB'];

/**
 * Os cinco dias uteis da semana que comeca em `inicio` (uma segunda-feira),
 * ja com o nome e a data prontos para o cabecalho e para o seletor de dias.
 */
function diasUteisDaSemana(inicio) {
    return [0, 1, 2, 3, 4].map((indice) => {
        const data = somarDias(inicio, indice);
        return {
            indice,
            data,
            rotulo: DIAS_SEMANA[indice + 1],
            rotulo_curto: DIAS_SEMANA_CURTO[indice + 1],
            dia_mes: dataBR(data).slice(0, 5),
            hoje: data === hojeISO(),
        };
    });
}

/** Dia util em que a grade abre: o de hoje, quando cai na semana escolhida. */
function diaUtilDeHoje(inicio) {
    const hoje = diasUteisDaSemana(inicio).findIndex((dia) => dia.hoje);
    return hoje >= 0 ? hoje : 0;
}

/**
 * Desenha as pastilhas "SEG 24/08" acima da grade. Fora do celular o CSS
 * esconde o seletor — la a grade mostra a semana inteira de uma vez.
 */
function desenharSeletorDias(id, dias, ativo) {
    const area = document.getElementById(id);
    if (!area) return;
    area.classList.toggle('oculto', !dias.length);
    area.innerHTML = dias.map((dia) => `
        <button class="seletor-dias__item${dia.indice === ativo ? ' ativo' : ''}"
                type="button" data-indice="${dia.indice}">
            <strong>${escapar(dia.rotulo_curto)}</strong>
            <span>${escapar(dia.dia_mes)}</span>
        </button>`).join('');
}

/** Liga o clique do seletor; `ao` recebe o indice do dia escolhido (0 a 4). */
function ligarSeletorDias(id, ao) {
    const area = document.getElementById(id);
    if (!area) return;
    area.addEventListener('click', (evento) => {
        const item = evento.target.closest('.seletor-dias__item');
        if (item) ao(Number(item.dataset.indice));
    });
}

/** Os dias que a grade desenha agora: a semana toda, ou so um no celular. */
function diasVisiveisDaGrade(dias, ativo) {
    return telaMobile.matches ? [dias[ativo] || dias[0]] : dias;
}

/* ---- A grade em si: linhas de horario x colunas de dia ---- */

// No banco a `ordem` recomeca a cada turno (a 1a da tarde e a ordem 1), porque
// e assim que a regra de aulas seguidas conta. Para a tela, o que vale e a
// ordem do dia inteiro.
const ORDEM_TURNO = { manha: 1, tarde: 2, noite: 3 };

/**
 * Monta as linhas da tabela a partir de TODOS os horários da escola, não só
 * daqueles em que o professor tem aula — senão a aula vaga some da grade e as
 * outras sobem de linha, dando a impressão de estarem no horário errado.
 *
 * A aula recebe o número corrido do dia (1ª a 9ª, como na planilha da escola);
 * no banco a ordem recomeça a cada turno, por causa da reserva de laboratório.
 */
function linhasDaGrade(celulas, horariosDaEscola) {
    const emOrdem = [...horariosDaEscola].sort((a, b) =>
        (ORDEM_TURNO[a.turno] || 9) - (ORDEM_TURNO[b.turno] || 9) || a.ordem - b.ordem);

    const linhas = emOrdem.map((horario, indice) => ({
        ...horario, numero: indice + 1, dias: {},
    }));
    const porId = new Map(linhas.map((linha) => [linha.id, linha]));
    celulas.forEach((celula) => {
        const linha = porId.get(celula.horario_id);
        if (linha) linha.dias[celula.dia_semana] = celula;
    });
    return linhas;
}

/**
 * Desenha a tabela dia x aula. `dias` são as colunas visíveis — a semana toda
 * no computador, só o dia escolhido no celular (onde cada célula vira um
 * cartão, pelo CSS). `rodape` é a linha de baixo de cada célula.
 *
 * Em `opcoes`, tudo opcional:
 *   titulo/detalhe — o que vai nas duas linhas do meio. O padrão é a turma e a
 *     disciplina, que é o que o professor precisa ver na grade dele. Olhando o
 *     horário de UMA turma, quem manda é o gestor: repetir o nome da turma em
 *     todos os cartões desperdiçaria a linha de cima.
 *   extras — atributos da célula; é por ali que o painel do gestor marca de
 *     quem é a aula, para o toque abrir a grade daquele professor.
 */
function gradeHTML(horarios, dias, rodape, opcoes = {}) {
    const extras = opcoes.extras || (() => '');
    const titulo = opcoes.titulo || ((celula) => celula.turma || '—');
    const detalhe = opcoes.detalhe || ((celula) => celula.disciplina || '');
    let html = `<div class="grade" style="--colunas:${dias.length}">`;
    html += '<div class="grade__hora grade__cabecalho-canto"></div>';
    html += dias.map((dia) => `
        <div class="grade__cabecalho-dia${dia.hoje ? ' hoje' : ''}">
            <strong>${escapar(dia.rotulo)}</strong>
            <span>${escapar(dia.dia_mes)}</span>
        </div>`).join('');

    let turnoAtual = null;
    horarios.forEach((horario) => {
        if (horario.turno !== turnoAtual) {
            turnoAtual = horario.turno;
            html += `<div class="grade__turno">${ROTULO_TURNO[turnoAtual] || turnoAtual}</div>`;
        }
        html += `<div class="grade__hora">
                    <span>${horario.numero}ª aula</span>
                    <span>${escapar(horario.inicio)}</span>
                    <span>${escapar(horario.fim)}</span>
                 </div>`;
        dias.forEach((dia) => {
            const celula = horario.dias[dia.indice];
            const marcaHora = `<span class="celula__hora">${horario.numero}ª · ${escapar(horario.inicio)}–${escapar(horario.fim)}</span>`;
            if (!celula || (!celula.turma && !celula.disciplina)) {
                html += `<div class="celula celula--indisponivel celula--vazia">${marcaHora}
                            <span class="celula__titulo">—</span></div>`;
                return;
            }
            html += `<div class="celula celula--ocupada" ${extras(celula)}>${marcaHora}
                        <span class="celula__titulo">${escapar(titulo(celula))}</span>
                        <span class="celula__detalhe">${escapar(detalhe(celula))}</span>
                        ${rodape(celula)}
                     </div>`;
        });
    });
    return `${html}</div>`;
}

/* ------------------------------------------------------------------ */
/* Notificacoes                                                        */
/* ------------------------------------------------------------------ */

function notificar(mensagem, tipo = 'sucesso') {
    const area = document.getElementById('notificacoes');
    if (!area) return;

    const caixa = document.createElement('div');
    caixa.className = `notificacao notificacao--${tipo}`;
    caixa.textContent = mensagem;
    area.appendChild(caixa);

    setTimeout(() => {
        caixa.style.transition = 'opacity .3s ease';
        caixa.style.opacity = '0';
        setTimeout(() => caixa.remove(), 320);
    }, 3800);
}

function mostrarErro(elemento, mensagem, lista) {
    if (!elemento) return;
    if (!mensagem && !(lista && lista.length)) {
        elemento.classList.add('oculto');
        elemento.innerHTML = '';
        return;
    }
    if (lista && lista.length > 1) {
        elemento.innerHTML = `<div><strong>Não foi possível reservar</strong><ul>` +
            lista.map((item) => `<li>${escapar(item)}</li>`).join('') + '</ul></div>';
    } else {
        elemento.innerHTML = `<div>${escapar(mensagem || lista[0])}</div>`;
    }
    elemento.classList.remove('oculto');
}

/* ------------------------------------------------------------------ */
/* Janela modal                                                        */
/* ------------------------------------------------------------------ */

/* Tecla Esc da janela aberta, guardada para sair junto com ela. */
let escutaEscModal = null;

function soltarEscutaEsc() {
    if (!escutaEscModal) return;
    document.removeEventListener('keydown', escutaEscModal);
    escutaEscModal = null;
}

function fecharModal() {
    const area = document.getElementById('areaModal');
    if (area) area.innerHTML = '';
    document.body.style.overflow = '';
    soltarEscutaEsc();
}

/**
 * abrirModal({ titulo, subtitulo, corpo, textoConfirmar, aoConfirmar, perigo,
 *              travado })
 * `aoConfirmar` recebe o elemento do modal; devolver false mantem a janela aberta.
 * `travado: true` so deixa fechar pelo botao (o X do topo ou o de fechar), para
 * um clique fora sem querer nao jogar fora o que estava sendo preenchido.
 */
function abrirModal(opcoes) {
    const area = document.getElementById('areaModal');
    if (!area) return;

    const fundo = document.createElement('div');
    fundo.className = 'fundo-modal';
    fundo.innerHTML = `
        <div class="modal" role="dialog" aria-modal="true">
            <div class="modal__topo">
                <div>
                    <h2>${escapar(opcoes.titulo || '')}</h2>
                    ${opcoes.subtitulo ? `<p>${escapar(opcoes.subtitulo)}</p>` : ''}
                </div>
                <button class="botao-icone" data-fechar aria-label="Fechar">✕</button>
            </div>
            <div class="modal__corpo">${opcoes.corpo || ''}</div>
            <div class="modal__rodape">
                <button class="botao botao--vazio" data-fechar>
                    ${escapar(opcoes.textoCancelar || 'Fechar')}
                </button>
                ${opcoes.textoConfirmar
                    ? `<button class="botao ${opcoes.perigo ? 'botao--perigo-cheio' : ''}" data-confirmar>
                           ${escapar(opcoes.textoConfirmar)}
                       </button>`
                    : ''}
            </div>
        </div>`;

    area.innerHTML = '';
    area.appendChild(fundo);
    document.body.style.overflow = 'hidden';

    const modal = fundo.querySelector('.modal');
    fundo.querySelectorAll('[data-fechar]').forEach((botao) => {
        botao.addEventListener('click', fecharModal);
    });
    soltarEscutaEsc();
    if (!opcoes.travado) {
        fundo.addEventListener('mousedown', (evento) => {
            if (evento.target === fundo) fecharModal();
        });
        escutaEscModal = (evento) => {
            if (evento.key === 'Escape') fecharModal();
        };
        document.addEventListener('keydown', escutaEscModal);
    }

    const botaoConfirmar = fundo.querySelector('[data-confirmar]');
    if (botaoConfirmar && opcoes.aoConfirmar) {
        botaoConfirmar.addEventListener('click', async () => {
            botaoConfirmar.disabled = true;
            try {
                const resultado = await opcoes.aoConfirmar(modal);
                if (resultado !== false) fecharModal();
            } finally {
                botaoConfirmar.disabled = false;
            }
        });
    }

    const primeiro = modal.querySelector('input, select, textarea');
    if (primeiro) primeiro.focus();
    return modal;
}

/* ------------------------------------------------------------------ */
/* Envio de credenciais (professor e gestor local)                     */
/* ------------------------------------------------------------------ */

/** Senha legível sorteada no navegador (sem caracteres ambíguos). */
function sortearSenha(tamanho = 8) {
    const alfabeto = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
    const bytes = new Uint32Array(tamanho);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (valor) => alfabeto[valor % alfabeto.length]).join('');
}

/**
 * Mostra o acesso recém-criado e oferece os canais de envio.
 *
 * A senha em texto puro só existe neste momento — o banco guarda o hash.
 * Serve para os dois perfis; muda só o rótulo do identificador e o endereço
 * das rotas:
 *   abrirModalCredenciais({ nome, rotulo: 'Matrícula', identificador: '1005',
 *                           senha, base: '/api/gestor/professores/7' })
 */
async function abrirModalCredenciais({ nome, rotulo, identificador, senha, base, papel }) {
    let credenciais = {};
    try {
        credenciais = await API.post(`${base}/credenciais`, { senha });
    } catch (falha) {
        notificar(falha.message, 'erro');
        return;
    }

    const temEmail = Boolean(credenciais.email);
    const temWhatsapp = Boolean(credenciais.whatsapp);
    const alvo = papel || 'professor';

    const modal = abrirModal({
        titulo: `Enviar acesso ao ${alvo}`,
        subtitulo: `${nome} — anote ou envie agora, a senha não aparece de novo.`,
        corpo: `
            <div class="cartao" style="margin:0 0 16px;box-shadow:none">
                <div class="linha-campos linha-campos--2">
                    <div>
                        <span class="rotulo-pequeno">${escapar(rotulo)}</span>
                        <p class="mono" style="font-size:1.3rem;font-weight:700;margin:2px 0 0">
                            ${escapar(identificador)}
                        </p>
                    </div>
                    <div>
                        <span class="rotulo-pequeno">Senha</span>
                        <p class="mono" style="font-size:1.3rem;font-weight:700;margin:2px 0 0">
                            ${escapar(senha)}
                        </p>
                    </div>
                </div>
                <div class="divisor" style="margin:14px 0"></div>
                <span class="rotulo-pequeno">Endereço do sistema</span>
                <p class="texto-suave" style="margin:2px 0 0;font-size:.84rem">
                    ${escapar(credenciais.endereco)}
                </p>
            </div>

            <div class="barra-botoes" style="margin-bottom:14px">
                <button type="button" class="botao" id="botaoEnviarEmail"
                        ${temEmail ? '' : 'disabled'}>
                    Enviar por e-mail
                </button>
                <button type="button" class="botao botao--vazio" id="botaoWhatsapp"
                        ${temWhatsapp ? '' : 'disabled'}
                        style="border-color:#25d366;color:#128c46">
                    Enviar por WhatsApp
                </button>
                <button type="button" class="botao botao--vazio" id="botaoCopiar">
                    Copiar mensagem
                </button>
            </div>

            ${temEmail ? '' : `<div class="aviso aviso--atencao">
                <div>Sem e-mail cadastrado — use o WhatsApp ou entregue os dados
                     pessoalmente.</div></div>`}
            ${temWhatsapp ? '' : `<div class="aviso aviso--atencao">
                <div>Sem telefone cadastrado, o envio por WhatsApp fica indisponível.</div></div>`}

            <div id="resultadoEnvio"></div>

            <span class="rotulo-pequeno">Mensagem que será enviada</span>
            <textarea id="textoCredenciais" rows="9" readonly
                      style="margin-top:6px;font-size:.82rem">${escapar(credenciais.texto)}</textarea>`,
        textoCancelar: 'Fechar',
    });

    if (!modal) return;
    const resultado = modal.querySelector('#resultadoEnvio');

    modal.querySelector('#botaoCopiar').addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(credenciais.texto);
            notificar('Mensagem copiada.');
        } catch (falha) {
            modal.querySelector('#textoCredenciais').select();
            notificar('Selecione o texto e copie com Ctrl+C.', 'erro');
        }
    });

    if (temWhatsapp) {
        modal.querySelector('#botaoWhatsapp').addEventListener('click', () => {
            window.open(credenciais.whatsapp, '_blank', 'noopener');
        });
    }

    if (temEmail) {
        const botaoEmail = modal.querySelector('#botaoEnviarEmail');
        botaoEmail.addEventListener('click', async () => {
            botaoEmail.disabled = true;
            botaoEmail.textContent = 'Enviando…';
            resultado.innerHTML = '';
            try {
                const resposta = await API.post(`${base}/enviar-email`, { senha });
                resultado.innerHTML = `<div class="aviso aviso--sucesso"><div>
                    E-mail enviado para <strong>${escapar(resposta.enviado_para)}</strong>.
                </div></div>`;
                botaoEmail.textContent = 'Enviar novamente';
                notificar('E-mail enviado.');
            } catch (falha) {
                const assunto = encodeURIComponent(credenciais.assunto);
                const corpo = encodeURIComponent(credenciais.texto);
                resultado.innerHTML = `<div class="aviso aviso--erro"><div>
                    ${escapar(falha.message)}
                    <br><a href="mailto:${escapar(credenciais.email)}?subject=${assunto}&body=${corpo}">
                    Abrir no meu programa de e-mail</a>
                </div></div>`;
                botaoEmail.textContent = 'Tentar de novo';
            } finally {
                botaoEmail.disabled = false;
            }
        });
    }
}

/* ------------------------------------------------------------------ */
/* Abas                                                                */
/* ------------------------------------------------------------------ */

function configurarAbas(aoTrocar) {
    montarMenuMais();
    configurarAtalhoDaConta();
    // `[data-aba]` de proposito: o botao "Mais" tambem e um `.navegacao__item`,
    // mas abre a folha do menu em vez de trocar de aba
    document.querySelectorAll('.navegacao__item[data-aba]').forEach((botao) => {
        botao.addEventListener('click', () => {
            const alvo = botao.dataset.aba;
            document.querySelectorAll('.navegacao__item[data-aba]').forEach((item) => {
                item.classList.toggle('ativo', item === botao);
            });
            // aba que mora dentro do "Mais" nao tem lugar na barra do celular:
            // sem isso a barra ficaria sem nenhum item marcado, e o usuario
            // perderia a indicacao de onde esta
            const botaoMais = document.querySelector('.navegacao__item--mais');
            if (botaoMais) {
                botaoMais.classList.toggle('ativo', !botao.hasAttribute('data-principal'));
            }
            document.querySelectorAll('.aba').forEach((secao) => {
                const nome = secao.id.replace('aba', '').toLowerCase();
                secao.classList.toggle('oculto', nome !== alvo.toLowerCase());
            });

            // item dentro de um submenu: o grupo dele abre junto. So importa
            // quando a troca veio de um atalho (o avatar do topo, o botao
            // "Computadores" de uma aula) — clicando no proprio item o grupo
            // ja estava aberto, e marcar de novo nao muda nada.
            const grupo = botao.closest('.navegacao__grupo');
            if (grupo) {
                const gatilho = grupo.querySelector('.navegacao__gatilho');
                if (gatilho) gatilho.checked = true;
            }

            window.scrollTo({ top: 0, behavior: 'smooth' });
            if (typeof aoTrocar === 'function') aoTrocar(alvo);
        });
    });
}

/* ------------------------------------------------------------------ */
/* Menu do celular: barra inferior curta + folha "Mais"                */
/* ------------------------------------------------------------------ */

/**
 * No celular a barra inferior nao comporta os dez itens do gestor: eles se
 * espremiam e os ultimos (Relatorios, Conta) saiam da tela sem nenhum aviso
 * de que existiam. Na barra ficam so os itens marcados com `data-principal`;
 * o resto vai para uma folha que sobe pelo botao "Mais".
 *
 * A folha e montada a cada abertura, e nao uma vez so, porque item de menu
 * pode ser escondido durante o uso (a aba "Outros gestores" some para o
 * gerente geral, a "Reservar" some para quem administra) — remontando,
 * a folha sempre reflete o menu daquele momento.
 */
function montarMenuMais() {
    const menu = document.querySelector('.lateral__menu');
    if (!menu || document.querySelector('.folha-menu')) return;

    // menu curto (o do gerente geral) cabe inteiro na barra: nao precisa da folha
    const guardados = [...menu.querySelectorAll('.navegacao__item')]
        .filter((item) => !item.hasAttribute('data-principal'));
    if (!guardados.length) return;

    const folha = document.createElement('div');
    folha.className = 'folha-menu';
    folha.innerHTML = `
        <div class="folha-menu__fundo" data-fechar-menu></div>
        <div class="folha-menu__painel" role="dialog" aria-modal="true"
             aria-label="Mais seções">
            <div class="folha-menu__alca"></div>
            <p class="folha-menu__titulo">Mais seções</p>
            <div class="folha-menu__itens"></div>
        </div>`;
    document.body.appendChild(folha);
    folha.querySelector('[data-fechar-menu]').addEventListener('click', fecharMenuMais);

    const botaoMais = document.createElement('button');
    botaoMais.type = 'button';
    botaoMais.className = 'navegacao__item navegacao__item--mais';
    botaoMais.setAttribute('aria-expanded', 'false');
    botaoMais.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
            <circle cx="5" cy="12" r="1.7"/>
            <circle cx="12" cy="12" r="1.7"/>
            <circle cx="19" cy="12" r="1.7"/>
        </svg>
        <span class="navegacao__rotulo">Mais</span>
        <span class="navegacao__rotulo-curto">Mais</span>`;
    botaoMais.addEventListener('click', () => {
        if (folha.classList.contains('aberta')) fecharMenuMais();
        else abrirMenuMais();
    });
    menu.appendChild(botaoMais);

    document.addEventListener('keydown', (evento) => {
        if (evento.key === 'Escape') fecharMenuMais();
    });
}

function abrirMenuMais() {
    const folha = document.querySelector('.folha-menu');
    const menu = document.querySelector('.lateral__menu');
    if (!folha || !menu) return;

    const destino = folha.querySelector('.folha-menu__itens');
    destino.innerHTML = '';
    menu.querySelectorAll('.navegacao__item').forEach((original) => {
        if (original.hasAttribute('data-principal')
            || original.classList.contains('navegacao__item--mais')
            || original.classList.contains('oculto')) return;
        const copia = original.cloneNode(true);
        copia.removeAttribute('id');   // id repetido quebraria getElementById
        // a copia nao troca de aba sozinha: ela aciona o botao original, para
        // a troca continuar passando por um caminho so
        copia.addEventListener('click', () => {
            fecharMenuMais();
            original.click();
        });
        destino.appendChild(copia);
    });

    folha.classList.add('aberta');
    document.body.style.overflow = 'hidden';
    const botaoMais = menu.querySelector('.navegacao__item--mais');
    if (botaoMais) botaoMais.setAttribute('aria-expanded', 'true');
}

function fecharMenuMais() {
    const folha = document.querySelector('.folha-menu');
    if (!folha || !folha.classList.contains('aberta')) return;
    folha.classList.remove('aberta');
    document.body.style.overflow = '';
    const botaoMais = document.querySelector('.navegacao__item--mais');
    if (botaoMais) botaoMais.setAttribute('aria-expanded', 'false');
}

function irParaAba(nome) {
    const botao = document.querySelector(`.navegacao__item[data-aba="${nome}"]`);
    if (botao) botao.click();
}

/**
 * O avatar do topo abre a aba Conta.
 *
 * Vale no computador e no celular: aciona o proprio item do menu, que no
 * celular esta escondido dentro do "Mais" mas continua respondendo ao clique
 * — assim a troca de aba segue passando por um caminho so.
 */
function configurarAtalhoDaConta() {
    document.querySelectorAll('[data-ir-para-conta]').forEach((avatar) => {
        avatar.addEventListener('click', () => {
            fecharMenuMais();
            irParaAba('conta');
        });
    });
}

function selo(status) {
    return `<span class="selo selo--${status}">${ROTULO_STATUS[status] || status}</span>`;
}

/* ------------------------------------------------------------------ */
/* Elementos do layout (avatar, data no topo, sair)                    */
/* ------------------------------------------------------------------ */

/** Iniciais para o avatar: "Ana Beatriz Moraes" -> "AM". */
function iniciais(nome) {
    const partes = String(nome || '').trim().split(/\s+/).filter(Boolean);
    if (!partes.length) return '--';
    if (partes.length === 1) return partes[0].slice(0, 2).toUpperCase();
    return (partes[0][0] + partes[partes.length - 1][0]).toUpperCase();
}

/** Conteúdo (innerHTML) de um `.avatar`: a foto, se a pessoa tiver, senão as
 * iniciais do nome — usado em qualquer lugar que hoje só mostra iniciais. */
function avatarHTML(pessoa) {
    if (pessoa && pessoa.foto) {
        return `<img class="avatar__foto" src="/fotos/${escapar(pessoa.foto)}" alt="">`;
    }
    return escapar(iniciais(pessoa && pessoa.nome));
}

/* ------------------------------------------------------------------ */
/* Telefones: celular com DDD (11 números) e fixo com DDD (10)         */
/* ------------------------------------------------------------------ */
//
// Todo campo de telefone aceita só números e mostra a máscara enquanto a
// pessoa digita — "(81)9 8458-7555" no celular e "(81) 3421-5566" no fixo.
// No banco fica sempre só o dígito: quem lê o campo passa por soDigitos().

const TELEFONE_DIGITOS = 11;        // DDD (2) + celular (9)
const TELEFONE_FIXO_DIGITOS = 10;   // DDD (2) + fixo (8)
const TELEFONE_AVISO = 'Informe o WhatsApp com 11 números: DDD + o número '
    + '(ex.: (81)9 8458-7555).';
const TELEFONE_FIXO_AVISO = 'Informe o telefone fixo com 10 números: DDD + o '
    + 'número (ex.: (81) 3421-5566).';

function soDigitos(valor) {
    return String(valor === null || valor === undefined ? '' : valor).replace(/\D/g, '');
}

/** '81984587555' -> '(81)9 8458-7555'. Também formata o que está pela metade. */
function formatarCelular(valor) {
    const numeros = soDigitos(valor).slice(0, TELEFONE_DIGITOS);
    if (!numeros) return '';
    if (numeros.length <= 2) return `(${numeros}`;
    if (numeros.length === 3) return `(${numeros.slice(0, 2)})${numeros.slice(2)}`;
    if (numeros.length <= 7) {
        return `(${numeros.slice(0, 2)})${numeros.slice(2, 3)} ${numeros.slice(3)}`;
    }
    return `(${numeros.slice(0, 2)})${numeros.slice(2, 3)} `
         + `${numeros.slice(3, 7)}-${numeros.slice(7)}`;
}

/** '8134215566' -> '(81) 3421-5566'. Também formata o que está pela metade. */
function formatarFixo(valor) {
    const numeros = soDigitos(valor).slice(0, TELEFONE_FIXO_DIGITOS);
    if (!numeros) return '';
    if (numeros.length <= 2) return `(${numeros}`;
    if (numeros.length <= 6) return `(${numeros.slice(0, 2)}) ${numeros.slice(2)}`;
    return `(${numeros.slice(0, 2)}) ${numeros.slice(2, 6)}-${numeros.slice(6)}`;
}

/** Onde o cursor deve parar: logo depois do n-ésimo dígito do texto. */
function posicaoAposDigitos(texto, quantos) {
    if (quantos <= 0) return 0;
    let contados = 0;
    for (let indice = 0; indice < texto.length; indice += 1) {
        if (texto[indice] >= '0' && texto[indice] <= '9') {
            contados += 1;
            if (contados === quantos) return indice + 1;
        }
    }
    return texto.length;
}

/**
 * Põe a máscara no campo e prende o que for digitado, colado ou já gravado
 * ao formato escolhido: 'celular' (11 números) ou 'fixo' (10).
 */
function limitarCampoTelefone(campo, tipo = 'celular') {
    if (!campo) return;
    const fixo = tipo === 'fixo';
    const formatar = fixo ? formatarFixo : formatarCelular;
    const maximo = fixo ? TELEFONE_FIXO_DIGITOS : TELEFONE_DIGITOS;

    campo.setAttribute('inputmode', 'numeric');
    // a máscara ocupa mais caracteres que os dígitos: "(81)9 8458-7555"
    campo.setAttribute('maxlength', String(formatar('0'.repeat(maximo)).length));
    campo.value = formatar(campo.value);

    campo.addEventListener('input', () => {
        const texto = formatar(campo.value);
        if (texto === campo.value) return;
        // conta os dígitos antes do cursor para ele não pular para o fim
        const antes = soDigitos(campo.value.slice(0, campo.selectionStart || 0)).length;
        campo.value = texto;
        const posicao = posicaoAposDigitos(texto, antes);
        campo.setSelectionRange(posicao, posicao);
    });
}

/** Mensagem de erro do WhatsApp, ou '' quando os 11 números estão lá. */
function erroTelefone(valor) {
    return soDigitos(valor).length === TELEFONE_DIGITOS ? '' : TELEFONE_AVISO;
}

/** Mensagem de erro do telefone fixo, ou '' quando os 10 números estão lá. */
function erroTelefoneFixo(valor) {
    return soDigitos(valor).length === TELEFONE_FIXO_DIGITOS ? '' : TELEFONE_FIXO_AVISO;
}

/** '81984587555' -> '(81)9 8458-7555'; '8134215566' -> '(81) 3421-5566'. */
function formatarTelefone(valor) {
    const digitos = soDigitos(valor);
    if (digitos.length === TELEFONE_DIGITOS) return formatarCelular(digitos);
    if (digitos.length === TELEFONE_FIXO_DIGITOS) return formatarFixo(digitos);
    return String(valor || '');
}

/* ------------------------------------------------------------------ */
/* CEP: mascara e consulta ao ViaCEP                                   */
/* ------------------------------------------------------------------ */
//
// O ViaCEP e publico e nao pede cadastro nem chave. A consulta sai do
// navegador do gestor, e nao do servidor, porque e ele quem esta digitando: a
// escola que roda o sistema numa maquina sem internet continua com o cadastro
// funcionando, so sem o autopreenchimento.

const CEP_DIGITOS = 8;
const CEP_AVISO = 'O CEP precisa ter 8 números (ex.: 55190-002).';
// consulta que demora mais que isso e tratada como "sem internet": o gestor
// preenche na mao em vez de ficar olhando o modal travado
const CEP_ESPERA_MS = 6000;

/** '55190002' -> '55190-002'. Também formata o que está pela metade. */
function formatarCep(valor) {
    const numeros = soDigitos(valor).slice(0, CEP_DIGITOS);
    if (numeros.length <= 5) return numeros;
    return `${numeros.slice(0, 5)}-${numeros.slice(5)}`;
}

/** Deixa o campo aceitar só dígitos e já formatados como CEP. */
function limitarCampoCep(campo) {
    if (!campo) return;
    campo.setAttribute('inputmode', 'numeric');
    campo.setAttribute('maxlength', String(formatarCep('0'.repeat(CEP_DIGITOS)).length));
    campo.value = formatarCep(campo.value);

    campo.addEventListener('input', () => {
        const texto = formatarCep(campo.value);
        if (texto === campo.value) return;
        const antes = soDigitos(campo.value.slice(0, campo.selectionStart || 0)).length;
        campo.value = texto;
        const posicao = posicaoAposDigitos(texto, antes);
        campo.setSelectionRange(posicao, posicao);
    });
}

/**
 * Consulta o CEP no ViaCEP.
 *
 * Devolve `{ logradouro, bairro, cidade, uf, semRua }` ou lança com uma
 * mensagem pronta para a tela. `semRua` marca o CEP geral de cidade pequena —
 * aquele que vale para o município inteiro e volta sem logradouro. Nesse caso
 * quem digita a rua é o gestor.
 */
async function buscarCep(valor) {
    const digitos = soDigitos(valor);
    if (digitos.length !== CEP_DIGITOS) throw new Error(CEP_AVISO);

    const desistir = new AbortController();
    const relogio = setTimeout(() => desistir.abort(), CEP_ESPERA_MS);
    let resposta;
    try {
        resposta = await fetch(`https://viacep.com.br/ws/${digitos}/json/`,
                               { signal: desistir.signal });
    } catch (falha) {
        throw new Error('Não consegui consultar o CEP agora. '
                      + 'Preencha o endereço à mão.');
    } finally {
        clearTimeout(relogio);
    }
    if (!resposta.ok) {
        throw new Error('O serviço de CEP não respondeu. Preencha à mão.');
    }

    const dados = await resposta.json();
    // o ViaCEP devolve 200 com {"erro": true} quando o CEP nao existe
    if (dados.erro) throw new Error('CEP não encontrado. Confira o número.');

    const logradouro = (dados.logradouro || '').trim();
    return {
        logradouro,
        bairro: (dados.bairro || '').trim(),
        cidade: (dados.localidade || '').trim(),
        uf: (dados.uf || '').trim(),
        semRua: !logradouro,
    };
}

/** '11987650001' -> 'https://wa.me/5511987650001' (mesmo DDI que o servidor usa). */
function linkWhatsapp(telefone) {
    const digitos = soDigitos(telefone);
    if (!digitos) return '';
    // 10 = fixo com DDD, 11 = celular com DDD -> falta so o DDI
    return `https://wa.me/${digitos.length === 10 || digitos.length === 11
        ? `55${digitos}` : digitos}`;
}

/** Copia e avisa. Sem permissao da area de transferencia, mostra para copiar a mao. */
async function copiarTexto(texto, aviso) {
    try {
        await navigator.clipboard.writeText(texto);
        notificar(aviso || 'Copiado.');
    } catch (falha) {
        window.prompt('Copie com Ctrl+C:', texto);
    }
}

/**
 * O numero formatado, em roxo, com o atalho "abrir conversa" ao lado.
 *
 * E a celula que a ficha usa em toda linha de WhatsApp — a da pessoa e a de
 * quem responde por ela. Sem numero vira um traco, e nao um link quebrado.
 */
function linhaDeWhatsapp(telefone) {
    const numeros = soDigitos(telefone);
    if (!numeros) return '<strong class="texto-suave">—</strong>';
    return `<a class="contato mono" href="${linkWhatsapp(numeros)}"
              target="_blank" rel="noopener"
              title="Abrir a conversa no WhatsApp">${escapar(formatarTelefone(numeros))}
              <span class="contato__dica">abrir conversa</span></a>`;
}

/* ------------------------------------------------------------------ */
/* Perfil: a ficha da pessoa em modo consulta                          */
/* ------------------------------------------------------------------ */

/**
 * Janela de consulta usada nos dois paineis. Nada se altera por aqui: os
 * contatos sao atalhos (o WhatsApp abre a conversa, o e-mail e copiado) e a
 * edicao, quando a pessoa tem esse direito, sai em um botao proprio.
 *
 * abrirPerfil({
 *   nome, subtitulo, itens: [[rotulo, valor, classe]], telefone, rotuloTelefone,
 *   email (sem a chave, a linha de e-mail nem aparece),
 *   telefonesExtras: [[rotulo, numero]] (outros WhatsApp, ex.: o responsavel),
 *   situacao: '<span class="selo ...">…', aviso: 'html',
 *   editar: { texto, ao }, voltar: { texto, ao },
 * })
 */
function abrirPerfil(opcoes) {
    const linhas = (opcoes.itens || []).map(([rotulo, valor, classe]) => [
        rotulo, `<strong class="${classe || ''}">${escapar(valor)}</strong>`,
    ]);

    linhas.push([opcoes.rotuloTelefone || 'WhatsApp',
                 linhaDeWhatsapp(opcoes.telefone)]);

    // Quem nao tem e-mail nenhum no cadastro (o aluno) simplesmente nao passa a
    // chave, e a linha some. Passar `email` vazio continua mostrando o traco,
    // que e o certo para professor e gestor: ali o campo existe e esta em branco.
    if ('email' in opcoes) {
        linhas.push(['E-mail', opcoes.email
            ? `<button type="button" class="contato"
                  data-copiar="${escapar(opcoes.email)}"
                  title="Copiar o e-mail">${escapar(opcoes.email)}
                  <span class="contato__dica">copiar</span></button>`
            : '<strong class="texto-suave">—</strong>']);
    }

    // Contatos que nao sao da propria pessoa — hoje, o responsavel pelo aluno.
    // Entram depois do e-mail para a ficha ler de dentro para fora: primeiro
    // quem ela e, depois quem responde por ela.
    (opcoes.telefonesExtras || []).forEach(([rotulo, numero]) => {
        linhas.push([rotulo, linhaDeWhatsapp(numero)]);
    });

    if (opcoes.situacao) linhas.push(['Situação', opcoes.situacao]);

    const modal = abrirModal({
        titulo: opcoes.nome,
        subtitulo: opcoes.subtitulo,
        corpo: `
            <div class="ficha">
                ${linhas.map(([rotulo, conteudo]) => `
                    <div class="ficha__item">
                        <span class="rotulo-pequeno">${escapar(rotulo)}</span>
                        ${conteudo}
                    </div>`).join('')}
            </div>
            ${opcoes.aviso || ''}
            ${(opcoes.voltar || opcoes.extra) ? `
            <div class="barra-botoes" style="margin-top:16px">
                ${opcoes.extra ? `
                <button type="button" class="botao botao--vazio botao--pequeno"
                        id="botaoExtraPerfil">${escapar(opcoes.extra.texto)}</button>` : ''}
                ${opcoes.voltar ? `
                <button type="button" class="botao botao--vazio botao--pequeno"
                        id="botaoVoltarPerfil">${escapar(opcoes.voltar.texto)}</button>` : ''}
            </div>` : ''}`,
        textoCancelar: 'Fechar',
        textoConfirmar: opcoes.editar ? opcoes.editar.texto : '',
        aoConfirmar: opcoes.editar
            ? async () => { await opcoes.editar.ao(); return false; }
            : undefined,
    });

    if (!modal) return null;

    modal.querySelectorAll('[data-copiar]').forEach((botao) => {
        botao.addEventListener('click', () => {
            copiarTexto(botao.dataset.copiar, 'E-mail copiado.');
        });
    });

    if (opcoes.voltar) {
        modal.querySelector('#botaoVoltarPerfil')
            .addEventListener('click', () => opcoes.voltar.ao());
    }
    if (opcoes.extra) {
        modal.querySelector('#botaoExtraPerfil')
            .addEventListener('click', () => opcoes.extra.ao());
    }
    return modal;
}

/* ------------------------------------------------------------------ */
/* Olhinho de mostrar/ocultar a senha                                  */
/* ------------------------------------------------------------------ */
//
// Vale para qualquer <input type="password" data-olho>. Trocar o type e
// coisa so do navegador: a senha nao e enviada nem guardada em lugar
// nenhum por causa disso.

const ICONE_MOSTRAR = `
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
         stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
        <circle cx="12" cy="12" r="3"/>
    </svg>`;

const ICONE_OCULTAR = `
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
         stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20C5 20 1 12 1 12a18.45 18.45 0 0 1
                 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16
                 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
        <line x1="1" y1="1" x2="23" y2="23"/>
    </svg>`;

function configurarOlhoDeSenha(raiz = document) {
    raiz.querySelectorAll('input[type="password"][data-olho]').forEach((campo) => {
        if (campo.parentElement.classList.contains('campo-senha')) return;

        const caixa = document.createElement('div');
        caixa.className = 'campo-senha';
        campo.parentNode.insertBefore(caixa, campo);
        caixa.appendChild(campo);

        const botao = document.createElement('button');
        botao.type = 'button';
        botao.className = 'campo-senha__olho';
        botao.tabIndex = -1;  // o Tab vai do campo direto para o botao Entrar
        caixa.appendChild(botao);

        const desenhar = (mostrando) => {
            botao.innerHTML = mostrando ? ICONE_OCULTAR : ICONE_MOSTRAR;
            const rotulo = mostrando ? 'Ocultar a senha' : 'Mostrar a senha';
            botao.setAttribute('aria-label', rotulo);
            botao.setAttribute('aria-pressed', String(mostrando));
            botao.title = rotulo;
        };
        desenhar(false);

        botao.addEventListener('click', () => {
            // ha campo que so e liberado para um perfil (ex.: a senha do gestor
            // fica travada quando o gerente abre o painel da escola)
            if (campo.disabled || campo.readOnly) return;
            const mostrando = campo.type === 'password';
            campo.type = mostrando ? 'text' : 'password';
            desenhar(mostrando);
            // devolve o cursor para o fim do que ja foi digitado
            campo.focus();
            campo.setSelectionRange(campo.value.length, campo.value.length);
        });
    });
}

// o olhinho vale para as tres telas de entrada, entao e ligado aqui mesmo
document.addEventListener('DOMContentLoaded', () => configurarOlhoDeSenha());

function preencherDataDeHoje() {
    const campo = document.getElementById('dataHoje');
    if (!campo) return;
    const hoje = new Date();
    const texto = hoje.toLocaleDateString('pt-BR', {
        weekday: 'long', day: 'numeric', month: 'long',
    });
    campo.textContent = texto.charAt(0).toUpperCase() + texto.slice(1);
}

function configurarSair() {
    document.querySelectorAll('.acao-sair').forEach((botao) => {
        botao.addEventListener('click', async () => {
            pararVigiaDeSessao();
            await API.post('/api/logout');
            window.location.reload();
        });
    });
}

/* ------------------------------------------------------------------ */
/* Saida automatica por inatividade                                    */
/* ------------------------------------------------------------------ */
//
// Depois de 15 minutos sem ninguem mexer, a conta sai sozinha — vale para o
// professor, o gestor local e o gerente geral. Quem realmente derruba e o
// servidor (o cookie da sessao vence nesse mesmo tempo, veja app.py); daqui
// sai o que ele sozinho nao faria:
//
//   * o aviso com a conta regressiva no ultimo minuto, para ninguem perder o
//     que estava preenchendo sem entender o motivo;
//   * a saida na hora certa, recarregando a tela — sem isso o painel ficaria
//     aberto, com os dados da escola a mostra, ate alguem clicar em algo;
//   * a renovacao de quem esta trabalhando sem pedir nada ao servidor (ler um
//     relatorio longo, preencher um cadastro grande): sem ela a sessao venceria
//     no meio do trabalho e o "Salvar" cairia no login.
//
// O relogio da inatividade e compartilhado pelas abas (localStorage): o cookie
// de sessao e um so para o navegador inteiro, entao trabalhar numa aba tem
// mesmo de segurar as outras.

const MINUTOS_INATIVIDADE_PADRAO = 15;
const SEGUNDOS_DE_AVISO = 60;           // conta regressiva antes de sair
const CHECAGEM_MS = 1000;               // de segundo em segundo (a conta anda)
const RENOVAR_APOS_MS = 4 * 60 * 1000;  // folga larga dentro dos 15 minutos
const CHAVE_ATIVIDADE = 'labs:ultima-atividade';
const CHAVE_ENCERRADA = 'labs:sessao-encerrada';

const Sessao = {
    limiteMs: MINUTOS_INATIVIDADE_PADRAO * 60 * 1000,
    vigiando: false,
    saindo: false,
    ultimaAtividade: Date.now(),
    ultimoPedido: Date.now(),
    renovando: false,
    relogio: null,
    aviso: null,
};

/** Ultima mexida em qualquer aba. O localStorage pode estar bloqueado (janela
 * anonima, navegador travado), e ai vale so o que esta na memoria desta aba. */
function lerAtividade() {
    try {
        const guardado = Number(localStorage.getItem(CHAVE_ATIVIDADE));
        if (guardado) return Math.max(guardado, Sessao.ultimaAtividade);
    } catch (erro) { /* sem localStorage: fica so a aba atual */ }
    return Sessao.ultimaAtividade;
}

function guardarAtividade(momento) {
    Sessao.ultimaAtividade = momento;
    try {
        localStorage.setItem(CHAVE_ATIVIDADE, String(momento));
    } catch (erro) { /* idem */ }
}

/**
 * Mexeu no sistema: o relogio volta ao zero e o aviso na tela some.
 *
 * Com a conta regressiva na tela o mouse passeando nao vale mais: ai so conta
 * o que a pessoa faz de proposito (clicar, digitar, rolar). Senao a faixa
 * sumiria antes de ser lida — basta esbarrar na mesa — e ninguem chegaria a
 * clicar no "Continuar conectado".
 */
function registrarAtividade(evento) {
    if (!Sessao.vigiando || Sessao.saindo) return;
    if (Sessao.aviso && evento && evento.type === 'mousemove') return;

    guardarAtividade(Date.now());
    if (Sessao.aviso) {
        // estava a segundos de vencer: refaz o cookie agora, sem esperar a
        // proxima janela de renovacao
        fecharAvisoDeInatividade();
        renovarSessao();
    }
}

/** Minutos combinados no servidor: o app.py escreve o numero no <body>, para
 * o limite da tela e o do cookie nunca discordarem. */
function minutosDeInatividade() {
    const escrito = Number(document.body && document.body.dataset.inatividade);
    return escrito > 0 ? escrito : MINUTOS_INATIVIDADE_PADRAO;
}

/**
 * Liga a contagem. Cada tela chama isto assim que confirma quem entrou —
 * professor, gestor local ou gerente geral.
 */
function iniciarVigiaDeSessao() {
    Sessao.limiteMs = minutosDeInatividade() * 60 * 1000;
    if (Sessao.vigiando) return;

    Sessao.vigiando = true;
    guardarAtividade(Date.now());
    Sessao.ultimoPedido = Date.now();

    // Mexidas que contam como uso. O mousemove entra junto do resto: quem le a
    // tela com a mao no mouse continua usando o sistema.
    ['pointerdown', 'keydown', 'wheel', 'touchstart', 'mousemove', 'scroll']
        .forEach((evento) => {
            document.addEventListener(evento, registrarAtividade,
                                      { passive: true, capture: true });
        });
    // Voltar para a aba nao conta como mexida, mas e a hora de conferir o
    // relogio: o navegador segura os temporizadores das abas escondidas.
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) conferirSessao();
    });

    Sessao.relogio = setInterval(conferirSessao, CHECAGEM_MS);
}

/**
 * Roda de 5 em 5 segundos. Compara com o relogio do sistema em vez de confiar
 * num setTimeout longo: assim o computador que ficou meia hora dormindo acorda
 * ja sabendo que o tempo acabou.
 */
function conferirSessao() {
    if (!Sessao.vigiando || Sessao.saindo) return;

    const parado = Date.now() - lerAtividade();

    if (parado >= Sessao.limiteMs) {
        encerrarPorInatividade();
        return;
    }

    const faltando = Sessao.limiteMs - parado;
    if (faltando <= SEGUNDOS_DE_AVISO * 1000) {
        mostrarAvisoDeInatividade(Math.ceil(faltando / 1000));
        return;
    }

    // Trabalhando na tela sem falar com o servidor: renova o cookie antes de
    // ele vencer no meio do preenchimento.
    if (Date.now() - Sessao.ultimoPedido >= RENOVAR_APOS_MS
        && lerAtividade() > Sessao.ultimoPedido) {
        renovarSessao();
    }
}

async function renovarSessao() {
    if (Sessao.renovando) return;
    Sessao.renovando = true;
    try {
        await API.post('/api/sessao/renovar');
    } catch (falha) {
        // 401 aqui ja foi tratado pelo API.requisitar (volta para o login);
        // queda de rede nao derruba ninguem: na volta a renovacao acontece.
    } finally {
        Sessao.renovando = false;
    }
}

/**
 * Sai de verdade: avisa o servidor, guarda o motivo e recarrega a tela.
 * `jaCaiu` e para quando quem derrubou foi o servidor — nao ha o que deslogar,
 * e o recado no login e mais generico (pode ter sido a conta desativada).
 */
async function encerrarPorInatividade(jaCaiu = false) {
    if (Sessao.saindo) return;
    Sessao.saindo = true;
    pararVigiaDeSessao();
    fecharAvisoDeInatividade();
    try {
        sessionStorage.setItem(CHAVE_ENCERRADA, jaCaiu ? 'servidor' : 'inatividade');
    } catch (erro) { /* sem sessionStorage a tela so volta para o login */ }
    if (!jaCaiu) {
        try {
            await API.post('/api/logout');
        } catch (falha) { /* sem servidor a sessao vence sozinha */ }
    }
    // recarregar joga fora tudo que estava na memoria da tela: nenhum dado da
    // escola fica visivel para quem chegar no computador depois
    window.location.reload();
}

function pararVigiaDeSessao() {
    Sessao.vigiando = false;
    if (Sessao.relogio) clearInterval(Sessao.relogio);
    Sessao.relogio = null;
}

/* Faixa da conta regressiva, no ultimo minuto. */
function mostrarAvisoDeInatividade(segundos) {
    if (!Sessao.aviso) {
        const faixa = document.createElement('div');
        faixa.className = 'aviso-inatividade';
        faixa.setAttribute('role', 'alert');
        faixa.innerHTML = `
            <div class="aviso-inatividade__texto">
                <strong>Sua sessão vai encerrar</strong>
                <span>Ninguém mexeu no sistema nos últimos minutos.
                      Saindo em <b data-conta>${segundos}</b>s.</span>
            </div>
            <button type="button" class="botao botao--pequeno" data-continuar>
                Continuar conectado
            </button>`;
        faixa.querySelector('[data-continuar]').addEventListener('click', () => {
            registrarAtividade();
            renovarSessao();
        });
        document.body.appendChild(faixa);
        Sessao.aviso = faixa;
    }
    const conta = Sessao.aviso.querySelector('[data-conta]');
    if (conta) conta.textContent = String(segundos);
}

function fecharAvisoDeInatividade() {
    if (!Sessao.aviso) return;
    Sessao.aviso.remove();
    Sessao.aviso = null;
}

/**
 * Recado na tela de login depois da saida automatica. Sem ele a pessoa volta
 * para o login sem saber por que foi parar ali.
 */
function avisarSessaoEncerrada() {
    let motivo = null;
    try {
        motivo = sessionStorage.getItem(CHAVE_ENCERRADA);
        sessionStorage.removeItem(CHAVE_ENCERRADA);
    } catch (erro) {
        return;
    }
    if (!motivo) return;

    const formulario = document.getElementById('formLogin');
    if (!formulario) return;

    const texto = motivo === 'inatividade'
        ? `O sistema saiu sozinho depois de ${minutosDeInatividade()} minutos `
          + 'sem uso. Entre de novo para continuar.'
        : 'Sua sessão não vale mais. Entre de novo para continuar.';

    const recado = document.createElement('div');
    recado.className = 'aviso aviso--atencao';
    recado.innerHTML = '<div><strong>Sessão encerrada por segurança</strong>'
        + escapar(texto) + '</div>';
    formulario.insertBefore(recado, document.getElementById('erroLogin'));
    // na primeira tentativa de entrar o recado ja cumpriu o papel: sai da tela
    // para nao ficar empilhado com o erro de senha
    formulario.addEventListener('submit', () => recado.remove(), { once: true });
}

document.addEventListener('DOMContentLoaded', avisarSessaoEncerrada);
