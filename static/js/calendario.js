/* =========================================================================
   Calendario escolar em PDF — compartilhado pela tela do professor e pelo
   painel do gestor local.

   - Leitor: o PDF desenhado pagina a pagina pelo PDF.js, com zoom pelos
     botoes, pela pinca de dois dedos e pelo Ctrl + roda do mouse, e rolagem
     por toque. No celular o leitor embutido nunca e a unica saida: "Abrir em
     tela cheia" e "Baixar PDF" ficam no alto da aba.
   - Envio (so no painel do gestor): area de soltar o arquivo, que no celular
     vira um botao grande de escolher, com barra de progresso.

   O PDF.js vem do CDN e so e buscado quando a aba abre. Sem internet (o PC da
   escola numa rede fechada) o leitor cai para o visualizador do proprio
   navegador, e os dois botoes do alto continuam funcionando — eles falam so
   com o servidor da escola.
   ========================================================================= */

const CALENDARIO_URL = '/api/calendario-escolar';
const CALENDARIO_ENVIO_URL = '/api/gestor/calendario-escolar';

// Precisa bater com LIMITE_CALENDARIO_MB no app.py; o servidor devolve o valor
// dele em `limite_mb`, e este so vale ate a primeira resposta chegar.
const LIMITE_CALENDARIO_MB_PADRAO = 20;

// A build "legacy" roda nos celulares mais antigos da escola, que a build
// moderna deixa de fora. Versao fixa: uma atualizacao do CDN nao muda a tela.
const PDFJS_BASE = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/legacy/build';
const PDFJS_ESPERA_MS = 15000;

// Zoom relativo a "pagina ajustada a largura" (1 = 100%).
const ZOOM_MINIMO = 0.5;
const ZOOM_MAXIMO = 4;
const ZOOM_PASSO = 1.25;

// O Safari do iPhone recusa canvas acima de ~16,7 milhoes de pixels e desenha
// em branco sem avisar. Com zoom alto a densidade da tela baixa ate caber.
const PIXELS_MAXIMOS_CANVAS = 16000000;

const telaDeToque = window.matchMedia('(pointer: coarse)');

const calendarioEscolar = {
    // o gestor ve a area de envio e o botao de remover; o professor so le
    podeEnviar: false,
    carregado: false,
    dados: null,
    arquivoEscolhido: null,
    enviando: false,
};

const leitor = {
    raiz: null,
    area: null,
    conteudo: null,
    documento: null,
    tarefaCarga: null,
    versao: null,
    url: '',
    // true quando ha algo na tela para mandar para a tela cheia
    pronto: false,
    // a ultima tentativa nao mostrou o PDF: reabrir a aba tenta de novo
    falhou: false,
    paginas: [],
    visiveis: new Set(),
    zoom: 1,
    ajuste: 1,
    larguraArea: 0,
    observador: null,
    observadorTamanho: null,
    // aumenta a cada documento aberto: o que chegar atrasado do anterior e descartado
    geracao: 0,
    pinca: null,
    quadroRolagem: 0,
};

/* ------------------------------------------------------------------ */
/* Entrada                                                             */
/* ------------------------------------------------------------------ */

/**
 * Liga os eventos da aba, uma vez so. `podeEnviar` vem do painel do gestor;
 * o servidor confere de novo em /api/gestor/calendario-escolar.
 */
function iniciarCalendarioEscolar({ podeEnviar = false } = {}) {
    calendarioEscolar.podeEnviar = podeEnviar;

    document.getElementById('calendarioArquivoAtivo')
        .addEventListener('click', aoClicarArquivoAtivo);

    const lugarDoLeitor = document.getElementById('calendarioLeitor');
    lugarDoLeitor.addEventListener('click', aoClicarBarraDoLeitor);

    document.addEventListener('fullscreenchange', aoMudarTelaCheia);
    document.addEventListener('webkitfullscreenchange', aoMudarTelaCheia);

    if (podeEnviar) ligarEnvioDoCalendario();
}

/** Busca o calendario da escola e redesenha a aba. Chamado a cada abertura. */
async function carregarCalendarioEscolar() {
    const lugarAtivo = document.getElementById('calendarioArquivoAtivo');
    if (!calendarioEscolar.carregado) {
        lugarAtivo.innerHTML = '<div class="lista-vazia"><span class="carregando"></span></div>';
    }

    let dados;
    try {
        dados = await API.get(CALENDARIO_URL);
    } catch (falha) {
        lugarAtivo.innerHTML = `<div class="aviso aviso--erro"><div>${escapar(falha.message)}</div></div>`;
        return;
    }
    calendarioEscolar.carregado = true;
    calendarioEscolar.dados = dados;

    desenharArquivoAtivo();
    desenharAreaDeEnvio();

    const calendario = dados.calendario;
    if (!calendario) {
        fecharLeitor();
        return;
    }
    // mesma versao ja aberta: nao baixa o PDF de novo so porque a aba reabriu
    if (leitor.versao === calendario.versao && leitor.raiz && !leitor.falhou) return;
    abrirNoLeitor(urlDoCalendario(calendario), calendario.versao);
}

function urlDoCalendario(calendario, baixar = false) {
    const parametros = new URLSearchParams({ v: calendario.versao });
    if (baixar) parametros.set('baixar', '1');
    return `${CALENDARIO_URL}/pdf?${parametros}`;
}

function limiteCalendarioMb() {
    return (calendarioEscolar.dados && calendarioEscolar.dados.limite_mb)
        || LIMITE_CALENDARIO_MB_PADRAO;
}

/* ------------------------------------------------------------------ */
/* Arquivo ativo (ou a faixa de "ainda nao publicado")                 */
/* ------------------------------------------------------------------ */

const ICONE_CALENDARIO = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
        <rect x="3" y="5" width="18" height="16" rx="2"/>
        <path d="M3 10h18M8 3v4M16 3v4"/>
        <path d="M8 14h.01M12 14h.01M16 14h.01M8 17.5h.01M12 17.5h.01"/>
    </svg>`;

const ICONE_TELA_CHEIA = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
        <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>
    </svg>`;

const ICONE_SAIR_TELA_CHEIA = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
        <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>
    </svg>`;

const ICONE_BAIXAR = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
        <path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>
    </svg>`;

function desenharArquivoAtivo() {
    const lugar = document.getElementById('calendarioArquivoAtivo');
    const dados = calendarioEscolar.dados;

    if (dados.escolher_unidade) {
        lugar.innerHTML = faixaDoCalendario(
            'Escolha uma unidade',
            dados.aviso || 'Cada escola tem o seu próprio calendário.',
        );
        return;
    }

    const calendario = dados.calendario;
    if (!calendario) {
        lugar.innerHTML = calendarioEscolar.podeEnviar
            ? faixaDoCalendario(
                'Nenhum calendário publicado',
                'Envie o PDF logo abaixo. Ele aparece na hora para os professores '
                + 'desta escola, no menu Calendário Escolar.',
            )
            : faixaDoCalendario(
                'O calendário escolar ainda não foi publicado',
                'Assim que a coordenação enviar o PDF, ele aparece aqui para você '
                + 'abrir ou baixar, no computador ou no celular.',
            );
        return;
    }

    const partes = [
        `Enviado em ${escapar(dataHoraBR(calendario.enviado_em))}`,
        escapar(formatarTamanhoArquivo(calendario.tamanho)),
    ];
    if (calendario.enviado_por) partes.push(`por ${escapar(calendario.enviado_por)}`);

    lugar.innerHTML = `
        <div class="cartao calendario-ativo">
            <div class="calendario-ativo__arquivo">
                <span class="calendario-ativo__icone" aria-hidden="true">PDF</span>
                <div class="calendario-ativo__dados">
                    <span class="rotulo-pequeno">Calendário ativo</span>
                    <strong class="calendario-ativo__nome">${escapar(calendario.nome)}</strong>
                    <span class="calendario-ativo__meta">${partes.join(' · ')}</span>
                </div>
            </div>
            <div class="calendario-ativo__acoes">
                <a class="botao botao--grande" href="${urlDoCalendario(calendario)}"
                   target="_blank" rel="noopener" data-calendario="tela-cheia">
                    ${ICONE_TELA_CHEIA} Abrir em tela cheia
                </a>
                <a class="botao botao--vazio botao--grande"
                   href="${urlDoCalendario(calendario, true)}"
                   download="${escapar(calendario.nome)}">
                    ${ICONE_BAIXAR} Baixar PDF
                </a>
                ${calendarioEscolar.podeEnviar ? `
                    <button type="button" class="botao botao--perigo botao--grande"
                            data-calendario="remover">Remover</button>` : ''}
            </div>
        </div>`;
}

function faixaDoCalendario(titulo, texto) {
    return `
        <div class="faixa-calendario" role="status">
            <span class="faixa-calendario__icone">${ICONE_CALENDARIO}</span>
            <div class="faixa-calendario__texto">
                <strong>${escapar(titulo)}</strong>
                <p>${escapar(texto)}</p>
            </div>
        </div>`;
}

function aoClicarArquivoAtivo(evento) {
    const alvo = evento.target.closest('[data-calendario]');
    if (!alvo) return;

    if (alvo.dataset.calendario === 'tela-cheia') {
        // o link ja abre o PDF numa aba nova, com o leitor do aparelho. So
        // quando da para pôr o leitor daqui em tela cheia (computador,
        // Android) o clique fica nesta pagina — no iPhone o link segue.
        if (entrarEmTelaCheia()) evento.preventDefault();
        return;
    }
    if (alvo.dataset.calendario === 'remover') confirmarRemocaoDoCalendario();
}

function confirmarRemocaoDoCalendario() {
    const calendario = calendarioEscolar.dados && calendarioEscolar.dados.calendario;
    if (!calendario) return;
    abrirModal({
        titulo: 'Remover o calendário escolar?',
        corpo: `<p>O arquivo <strong>${escapar(calendario.nome)}</strong> deixa de aparecer
                para os professores desta escola. Para voltar a mostrar, será preciso
                enviar o PDF de novo.</p>`,
        textoConfirmar: 'Remover calendário',
        perigo: true,
        aoConfirmar: async () => {
            try {
                await API.del(CALENDARIO_ENVIO_URL);
                notificar('Calendário removido.');
                await carregarCalendarioEscolar();
                return true;
            } catch (falha) {
                notificar(falha.message, 'erro');
                return false;
            }
        },
    });
}

/* ------------------------------------------------------------------ */
/* Envio do PDF (gestor)                                               */
/* ------------------------------------------------------------------ */

function ligarEnvioDoCalendario() {
    const zona = document.getElementById('soltarCalendario');
    const campo = document.getElementById('arquivoCalendario');

    campo.addEventListener('change', () => {
        escolherArquivoDoCalendario(campo.files[0]);
        campo.value = '';
    });

    // arrastar e soltar (computador). O contador existe porque o dragleave
    // tambem dispara ao passar por cima dos filhos da zona, e sem ele o
    // destaque piscaria enquanto o arquivo e arrastado
    let dentro = 0;
    zona.addEventListener('dragenter', (evento) => {
        if (!temArquivo(evento)) return;
        evento.preventDefault();
        dentro += 1;
        zona.classList.add('soltar-arquivo--ativo');
    });
    zona.addEventListener('dragover', (evento) => {
        if (!temArquivo(evento)) return;
        evento.preventDefault();
        evento.dataTransfer.dropEffect = 'copy';
    });
    zona.addEventListener('dragleave', () => {
        dentro = Math.max(0, dentro - 1);
        if (!dentro) zona.classList.remove('soltar-arquivo--ativo');
    });
    zona.addEventListener('drop', (evento) => {
        evento.preventDefault();
        dentro = 0;
        zona.classList.remove('soltar-arquivo--ativo');
        const arquivo = evento.dataTransfer.files && evento.dataTransfer.files[0];
        if (arquivo) escolherArquivoDoCalendario(arquivo);
    });

    // o PDF solto um pouco fora da zona faria o navegador abrir o arquivo no
    // lugar do painel, e quem estava no meio do envio perderia a tela
    ['dragover', 'drop'].forEach((tipo) => {
        document.addEventListener(tipo, (evento) => {
            if (!temArquivo(evento) || zona.contains(evento.target)) return;
            if (document.getElementById('abaCalendarioEscolar').classList.contains('oculto')) return;
            evento.preventDefault();
        });
    });

    document.getElementById('botaoEnviarCalendario')
        .addEventListener('click', enviarCalendarioEscolar);
    document.getElementById('botaoCancelarCalendario')
        .addEventListener('click', () => escolherArquivoDoCalendario(null));
}

function temArquivo(evento) {
    const tipos = evento.dataTransfer && evento.dataTransfer.types;
    return Boolean(tipos && [...tipos].includes('Files'));
}

/**
 * Confere o arquivo antes de gastar o envio. Quem decide de verdade e o
 * servidor, que le a assinatura de bytes; aqui o aviso so chega mais cedo.
 */
function validarPdfDoCalendario(arquivo) {
    const limite = limiteCalendarioMb();
    const nome = (arquivo.name || '').toLowerCase();
    if (arquivo.type !== 'application/pdf' && !nome.endsWith('.pdf')) {
        return 'Envie o calendário em PDF.';
    }
    if (!arquivo.size) return 'Esse arquivo está vazio. Escolha outro PDF.';
    if (arquivo.size > limite * 1024 * 1024) {
        return `Este PDF tem ${formatarTamanhoArquivo(arquivo.size)} e o limite é `
            + `${limite} MB. Escolha um arquivo menor.`;
    }
    return null;
}

function escolherArquivoDoCalendario(arquivo) {
    if (calendarioEscolar.enviando) return;
    const erro = document.getElementById('erroCalendario');
    mostrarErro(erro, '');

    if (arquivo) {
        const problema = validarPdfDoCalendario(arquivo);
        if (problema) {
            mostrarErro(erro, problema);
            arquivo = null;
        }
    }
    calendarioEscolar.arquivoEscolhido = arquivo || null;
    desenharAreaDeEnvio();
}

function desenharAreaDeEnvio() {
    const cartao = document.getElementById('cartaoEnvioCalendario');
    if (!cartao) return;
    const dados = calendarioEscolar.dados || {};
    const ativo = dados.calendario;
    const arquivo = calendarioEscolar.arquivoEscolhido;

    // gerente olhando "Todas as unidades": nao ha escola para receber o PDF
    cartao.classList.toggle('oculto', Boolean(dados.escolher_unidade));

    document.getElementById('tituloEnvioCalendario').textContent =
        ativo ? 'Substituir calendário' : 'Enviar calendário';
    document.getElementById('dicaLimiteCalendario').textContent =
        `Somente PDF, até ${limiteCalendarioMb()} MB.`;

    document.getElementById('soltarCalendario').classList.toggle('oculto', Boolean(arquivo));
    const escolhido = document.getElementById('escolhidoCalendario');
    escolhido.classList.toggle('oculto', !arquivo);
    if (arquivo) {
        escolhido.innerHTML = `
            <span class="calendario-ativo__icone" aria-hidden="true">PDF</span>
            <div class="arquivo-escolhido__dados">
                <strong>${escapar(arquivo.name)}</strong>
                <span>${escapar(formatarTamanhoArquivo(arquivo.size))}</span>
            </div>
            <label class="botao-texto" for="arquivoCalendario">Trocar arquivo</label>`;
    }

    const aviso = document.getElementById('avisoSubstituirCalendario');
    aviso.classList.toggle('oculto', !(arquivo && ativo));
    if (arquivo && ativo) {
        aviso.innerHTML = `<div>O calendário atual, <strong>${escapar(ativo.nome)}</strong>,
            sai do ar e dá lugar a este para todos os professores da escola.</div>`;
    }

    const enviar = document.getElementById('botaoEnviarCalendario');
    enviar.classList.toggle('oculto', !arquivo);
    enviar.textContent = ativo ? 'Substituir calendário' : 'Publicar calendário';
    document.getElementById('botaoCancelarCalendario').classList.toggle('oculto', !arquivo);
}

async function enviarCalendarioEscolar() {
    const arquivo = calendarioEscolar.arquivoEscolhido;
    if (!arquivo || calendarioEscolar.enviando) return;

    const erro = document.getElementById('erroCalendario');
    const botao = document.getElementById('botaoEnviarCalendario');
    const cancelar = document.getElementById('botaoCancelarCalendario');
    const progresso = document.getElementById('progressoCalendario');
    const barra = progresso.querySelector('.progresso__barra');
    const rotulo = progresso.querySelector('.progresso__rotulo');
    const textoOriginal = botao.textContent;

    mostrarErro(erro, '');
    calendarioEscolar.enviando = true;
    botao.disabled = true;
    cancelar.disabled = true;
    botao.textContent = 'Enviando…';
    progresso.classList.remove('oculto');
    const marcar = (fracao) => {
        const porcento = Math.round(fracao * 100);
        barra.style.width = `${porcento}%`;
        progresso.setAttribute('aria-valuenow', String(porcento));
        rotulo.textContent = porcento < 100 ? `${porcento}%` : 'Conferindo o arquivo…';
    };
    marcar(0);

    const formulario = new FormData();
    formulario.append('arquivo', arquivo);
    try {
        const resposta = await enviarArquivoComProgresso(CALENDARIO_ENVIO_URL, formulario, marcar);
        calendarioEscolar.arquivoEscolhido = null;
        notificar(resposta.substituido ? 'Calendário substituído.' : 'Calendário publicado.');
        await carregarCalendarioEscolar();
    } catch (falha) {
        mostrarErro(erro, falha.message);
    } finally {
        calendarioEscolar.enviando = false;
        botao.disabled = false;
        cancelar.disabled = false;
        botao.textContent = textoOriginal;
        progresso.classList.add('oculto');
        desenharAreaDeEnvio();
    }
}

/**
 * POST de arquivo com o andamento do envio. O fetch nao informa quanto do
 * corpo ja subiu, e 20 MB pelo 4G do celular sem nenhuma barra parece
 * travado. Faz o mesmo que API.requisitar na volta: marca a conversa com o
 * servidor e leva ao login quando a sessao caiu.
 */
function enviarArquivoComProgresso(caminho, formulario, aoAndar) {
    return new Promise((resolver, rejeitar) => {
        const pedido = new XMLHttpRequest();
        pedido.open('POST', caminho);
        pedido.responseType = 'json';
        pedido.upload.addEventListener('progress', (evento) => {
            if (evento.lengthComputable) aoAndar(evento.loaded / evento.total);
        });
        pedido.addEventListener('load', () => {
            Sessao.ultimoPedido = Date.now();
            const dados = pedido.response || {};
            if (pedido.status >= 200 && pedido.status < 300) {
                resolver(dados);
                return;
            }
            if (dados.sessao_expirada) encerrarPorInatividade(true);
            const falha = new Error(dados.erro || 'Não foi possível enviar o arquivo.');
            falha.status = pedido.status;
            rejeitar(falha);
        });
        pedido.addEventListener('error', () => {
            rejeitar(new Error('Sem conexão com o servidor. Confira a internet e tente '
                + 'de novo.'));
        });
        pedido.send(formulario);
    });
}

/* ------------------------------------------------------------------ */
/* Leitor de PDF                                                       */
/* ------------------------------------------------------------------ */

let promessaPdfJs = null;
let falhasPdfJs = 0;

/**
 * Carrega o PDF.js uma vez por pagina. Falhou (sem internet)? Tenta de novo na
 * proxima abertura, em vez de guardar o erro para sempre. A nova tentativa
 * muda a URL (`?tentativa=`) de proposito: o navegador guarda o import() que
 * falhou e, pedido o mesmo endereco, devolveria o mesmo erro sem nem buscar.
 */
function carregarPdfJs() {
    if (!promessaPdfJs) {
        const tentativa = falhasPdfJs ? `?tentativa=${falhasPdfJs}` : '';
        const carga = import(`${PDFJS_BASE}/pdf.min.mjs${tentativa}`).then((biblioteca) => {
            biblioteca.GlobalWorkerOptions.workerSrc = `${PDFJS_BASE}/pdf.worker.min.mjs`;
            return biblioteca;
        });
        const espera = new Promise((_, rejeitar) => {
            setTimeout(() => rejeitar(new Error('PDF.js demorou demais')), PDFJS_ESPERA_MS);
        });
        promessaPdfJs = Promise.race([carga, espera]).catch((erro) => {
            promessaPdfJs = null;
            falhasPdfJs += 1;
            throw erro;
        });
    }
    return promessaPdfJs;
}

function montarLeitor() {
    const lugar = document.getElementById('calendarioLeitor');
    lugar.innerHTML = `
        <div class="leitor-pdf">
            <div class="leitor-pdf__barra" role="toolbar" aria-label="Controles do calendário">
                <div class="leitor-pdf__zoom">
                    <button type="button" class="botao-icone leitor-pdf__botao"
                            data-leitor="menos" aria-label="Diminuir o zoom">−</button>
                    <button type="button" class="leitor-pdf__nivel" data-leitor="ajustar"
                            title="Ajustar à largura">100%</button>
                    <button type="button" class="botao-icone leitor-pdf__botao"
                            data-leitor="mais" aria-label="Aumentar o zoom">+</button>
                </div>
                <span class="leitor-pdf__pagina-atual" aria-live="polite"></span>
                <button type="button" class="botao-icone leitor-pdf__botao"
                        data-leitor="tela-cheia" aria-label="Tela cheia" title="Tela cheia">
                    ${ICONE_TELA_CHEIA}
                </button>
            </div>
            <div class="leitor-pdf__area" tabindex="0" aria-label="Páginas do calendário escolar">
                <div class="leitor-pdf__paginas"></div>
                <div class="leitor-pdf__estado"></div>
            </div>
            <p class="leitor-pdf__dica">Use dois dedos para aproximar ou afastar o calendário.</p>
        </div>`;

    leitor.raiz = lugar.querySelector('.leitor-pdf');
    leitor.area = lugar.querySelector('.leitor-pdf__area');
    leitor.conteudo = lugar.querySelector('.leitor-pdf__paginas');
    leitor.zoom = 1;
    leitor.larguraArea = 0;
    leitor.raiz.classList.toggle('leitor-pdf--toque', telaDeToque.matches);

    ligarGestosDoLeitor(leitor.area);
}

function mostrarEstadoDoLeitor(tipo, html) {
    const estado = leitor.raiz && leitor.raiz.querySelector('.leitor-pdf__estado');
    if (!estado) return;
    estado.className = `leitor-pdf__estado${tipo ? ` leitor-pdf__estado--${tipo}` : ''}`;
    estado.innerHTML = html || '';
    estado.classList.toggle('oculto', !tipo);
    // sem PDF para mostrar, o leitor encolhe para so o aviso: uma caixa vazia
    // de meia tela empurraria o resto para baixo sem mostrar nada
    leitor.raiz.classList.toggle('leitor-pdf--erro', tipo === 'erro');
}

async function abrirNoLeitor(url, versao) {
    fecharLeitor();
    const geracao = leitor.geracao;
    montarLeitor();
    leitor.url = url;
    leitor.versao = versao;
    mostrarEstadoDoLeitor('carregando',
        '<span class="carregando"></span><span>Abrindo o calendário…</span>');

    let pdfjs;
    try {
        pdfjs = await carregarPdfJs();
    } catch (erro) {
        if (geracao === leitor.geracao) usarLeitorDoNavegador(url);
        return;
    }
    if (geracao !== leitor.geracao) return;

    try {
        // isEvalSupported: o PDF nao pode rodar codigo gerado a partir do
        // proprio arquivo — defesa contra PDF montado para atacar o leitor
        leitor.tarefaCarga = pdfjs.getDocument({ url, isEvalSupported: false });
        const documento = await leitor.tarefaCarga.promise;
        if (geracao !== leitor.geracao) {
            documento.destroy();
            return;
        }
        leitor.documento = documento;

        const numeros = Array.from({ length: documento.numPages }, (_, indice) => indice + 1);
        const paginas = await Promise.all(numeros.map((numero) => documento.getPage(numero)));
        if (geracao !== leitor.geracao) return;

        leitor.paginas = paginas.map((pagina) => {
            const base = pagina.getViewport({ scale: 1 });
            const caixa = document.createElement('div');
            caixa.className = 'leitor-pdf__pagina';
            caixa.setAttribute('role', 'img');
            caixa.setAttribute('aria-label', `Página ${pagina.pageNumber} de ${paginas.length}`);
            leitor.conteudo.appendChild(caixa);
            return {
                pagina,
                numero: pagina.pageNumber,
                largura: base.width,
                altura: base.height,
                caixa,
                canvas: null,
                escala: 0,
                tarefa: null,
            };
        });
    } catch (erro) {
        if (geracao !== leitor.geracao) return;
        leitor.falhou = true;
        if (erro && erro.status === 401) {
            encerrarPorInatividade(true);
            return;
        }
        mostrarEstadoDoLeitor('erro', `
            <strong>Não foi possível mostrar o PDF aqui</strong>
            <span>Use <b>Abrir em tela cheia</b> ou <b>Baixar PDF</b>, logo acima.</span>`);
        return;
    }

    mostrarEstadoDoLeitor(null);
    leitor.pronto = true;
    observarPaginas();
    ajustarLayoutDoLeitor();
}

/**
 * Sem PDF.js (sem internet, CDN bloqueado): o navegador que sabe mostrar PDF
 * dentro da pagina recebe o arquivo num quadro; o que nao sabe — a maioria dos
 * celulares — fica com os dois botoes do alto, que usam o leitor do aparelho.
 */
function usarLeitorDoNavegador(url) {
    leitor.falhou = true;
    leitor.raiz.classList.add('leitor-pdf--nativo');
    if (navigator.pdfViewerEnabled) {
        mostrarEstadoDoLeitor(null);
        leitor.area.innerHTML = `<iframe class="leitor-pdf__quadro" src="${escapar(url)}#view=FitH"
            title="Calendário escolar"></iframe>`;
        leitor.pronto = true;
        return;
    }
    mostrarEstadoDoLeitor('erro', `
        <strong>O leitor não abriu neste aparelho</strong>
        <span>Toque em <b>Abrir em tela cheia</b> ou <b>Baixar PDF</b>, logo acima,
              para ver o calendário.</span>`);
}

function fecharLeitor() {
    leitor.geracao += 1;
    if (emTelaCheia()) sairDaTelaCheia();
    if (leitor.observador) leitor.observador.disconnect();
    if (leitor.observadorTamanho) leitor.observadorTamanho.disconnect();
    leitor.observador = null;
    leitor.observadorTamanho = null;
    leitor.paginas.forEach((item) => {
        if (item.tarefa) item.tarefa.cancel();
        liberarCanvas(item);
    });
    leitor.paginas = [];
    leitor.visiveis.clear();
    if (leitor.tarefaCarga) leitor.tarefaCarga.destroy();
    leitor.tarefaCarga = null;
    leitor.documento = null;
    leitor.versao = null;
    leitor.pronto = false;
    leitor.falhou = false;
    leitor.pinca = null;
    const lugar = document.getElementById('calendarioLeitor');
    if (lugar) lugar.innerHTML = '';
    leitor.raiz = null;
    leitor.area = null;
    leitor.conteudo = null;
}

/** Desenha so o que esta perto da tela: o celular nao aguenta dez paginas
 * com zoom alto na memoria ao mesmo tempo. */
function observarPaginas() {
    leitor.observador = new IntersectionObserver((entradas) => {
        entradas.forEach((entrada) => {
            const item = leitor.paginas.find((pagina) => pagina.caixa === entrada.target);
            if (!item) return;
            if (entrada.isIntersecting) {
                leitor.visiveis.add(item);
                desenharPagina(item);
            } else {
                leitor.visiveis.delete(item);
                if (item.tarefa) item.tarefa.cancel();
                liberarCanvas(item);
            }
        });
    }, { root: leitor.area, rootMargin: '100% 50%' });
    leitor.paginas.forEach((item) => leitor.observador.observe(item.caixa));

    // aba que acabou de aparecer, celular girado, tela cheia: a largura muda
    // e a pagina precisa voltar a caber
    if ('ResizeObserver' in window) {
        leitor.observadorTamanho = new ResizeObserver(() => {
            if (leitor.area && leitor.area.clientWidth !== leitor.larguraArea) {
                ajustarLayoutDoLeitor();
            }
        });
        leitor.observadorTamanho.observe(leitor.area);
    }
}

function ajustarLayoutDoLeitor() {
    if (!leitor.area || !leitor.paginas.length) return;
    const largura = leitor.area.clientWidth;
    // aba escondida: o ResizeObserver chama de novo quando ela aparecer
    if (!largura) return;
    leitor.larguraArea = largura;

    const estilo = getComputedStyle(leitor.conteudo);
    const folga = parseFloat(estilo.paddingLeft) + parseFloat(estilo.paddingRight);
    const maisLarga = Math.max(...leitor.paginas.map((item) => item.largura));
    leitor.ajuste = Math.max(0.1, (largura - folga) / maisLarga);
    aplicarEscalaDoLeitor();
}

function escalaDoLeitor() {
    return leitor.ajuste * leitor.zoom;
}

function aplicarEscalaDoLeitor() {
    const escala = escalaDoLeitor();
    leitor.paginas.forEach((item) => {
        item.caixa.style.width = `${Math.floor(item.largura * escala)}px`;
        item.caixa.style.height = `${Math.floor(item.altura * escala)}px`;
    });

    const nivel = leitor.raiz.querySelector('.leitor-pdf__nivel');
    nivel.textContent = `${Math.round(leitor.zoom * 100)}%`;
    leitor.raiz.querySelector('[data-leitor="menos"]').disabled = leitor.zoom <= ZOOM_MINIMO + 0.001;
    leitor.raiz.querySelector('[data-leitor="mais"]').disabled = leitor.zoom >= ZOOM_MAXIMO - 0.001;

    leitor.visiveis.forEach((item) => desenharPagina(item));
    atualizarPaginaAtual();
}

async function desenharPagina(item) {
    const escala = escalaDoLeitor();
    if (item.canvas && Math.abs(item.escala - escala) < 0.0001) return;
    if (item.tarefa && Math.abs(item.escalaPedida - escala) < 0.0001) return;
    if (item.tarefa) item.tarefa.cancel();

    const viewport = item.pagina.getViewport({ scale: escala });
    const densidade = Math.min(
        window.devicePixelRatio || 1,
        Math.sqrt(PIXELS_MAXIMOS_CANVAS / (viewport.width * viewport.height)),
    );
    const canvas = document.createElement('canvas');
    canvas.className = 'leitor-pdf__canvas';
    canvas.width = Math.floor(viewport.width * densidade);
    canvas.height = Math.floor(viewport.height * densidade);

    const tarefa = item.pagina.render({
        canvasContext: canvas.getContext('2d'),
        viewport,
        transform: densidade !== 1 ? [densidade, 0, 0, densidade, 0, 0] : null,
    });
    item.tarefa = tarefa;
    item.escalaPedida = escala;

    try {
        await tarefa.promise;
    } catch (erro) {
        // cancelada porque o zoom mudou ou a pagina saiu da tela: a proxima
        // chamada desenha na escala certa
        canvas.width = 0;
        canvas.height = 0;
        if (item.tarefa === tarefa) item.tarefa = null;
        return;
    }
    if (item.tarefa !== tarefa) return;
    item.tarefa = null;

    // o desenho antigo so sai quando o novo esta pronto: durante o zoom a
    // pagina fica esticada por um instante, em vez de piscar em branco
    liberarCanvas(item);
    item.canvas = canvas;
    item.escala = escala;
    item.caixa.appendChild(canvas);
}

function liberarCanvas(item) {
    if (!item.canvas) return;
    // zerar o tamanho devolve a memoria na hora; o Safari do iPhone segura o
    // canvas removido por um bom tempo e trava a aba depois de alguns zooms
    item.canvas.width = 0;
    item.canvas.height = 0;
    item.canvas.remove();
    item.canvas = null;
    item.escala = 0;
}

/**
 * Muda o zoom mantendo parado o ponto em foco (o meio dos dedos, o cursor do
 * mouse ou o centro do leitor). Sem isso o calendario "fugiria" do dedo.
 */
function mudarZoomDoLeitor(novoZoom, focoX, focoY) {
    const area = leitor.area;
    if (!area || !leitor.paginas.length) return;
    const antigo = leitor.zoom;
    const zoom = Math.min(ZOOM_MAXIMO, Math.max(ZOOM_MINIMO, novoZoom));
    if (Math.abs(zoom - antigo) < 0.001) return;

    const x = focoX === undefined ? area.clientWidth / 2 : focoX;
    const y = focoY === undefined ? area.clientHeight / 2 : focoY;
    const conteudoX = area.scrollLeft + x;
    const conteudoY = area.scrollTop + y;

    leitor.zoom = zoom;
    aplicarEscalaDoLeitor();

    const razao = zoom / antigo;
    area.scrollLeft = conteudoX * razao - x;
    area.scrollTop = conteudoY * razao - y;
}

function aoClicarBarraDoLeitor(evento) {
    const botao = evento.target.closest('[data-leitor]');
    if (!botao || !leitor.raiz) return;
    const acao = botao.dataset.leitor;
    if (acao === 'mais') mudarZoomDoLeitor(leitor.zoom * ZOOM_PASSO);
    if (acao === 'menos') mudarZoomDoLeitor(leitor.zoom / ZOOM_PASSO);
    if (acao === 'ajustar') mudarZoomDoLeitor(1);
    if (acao === 'tela-cheia') {
        if (emTelaCheia()) sairDaTelaCheia();
        else if (!entrarEmTelaCheia()) window.open(leitor.url, '_blank', 'noopener');
    }
}

function atualizarPaginaAtual() {
    const rotulo = leitor.raiz && leitor.raiz.querySelector('.leitor-pdf__pagina-atual');
    if (!rotulo || !leitor.paginas.length) return;
    // a pagina que ocupa o terco de cima do leitor e a que a pessoa esta lendo.
    // Rolado ate o fim vale a ultima: pagina deitada e baixa nunca chegaria a
    // essa linha, e o contador pararia uma antes
    const area = leitor.area;
    const linha = area.scrollTop + area.clientHeight / 3;
    const noFim = area.scrollHeight > area.clientHeight
        && area.scrollTop + area.clientHeight >= area.scrollHeight - 2;
    let atual = 1;
    for (const item of leitor.paginas) {
        if (!noFim && item.caixa.offsetTop > linha) break;
        atual = item.numero;
    }
    rotulo.textContent = `Página ${atual} de ${leitor.paginas.length}`;
}

/* ---- Toque, pinca e roda do mouse ---- */

function distanciaEntre(toques) {
    return Math.hypot(toques[0].clientX - toques[1].clientX,
                      toques[0].clientY - toques[1].clientY);
}

function ligarGestosDoLeitor(area) {
    area.addEventListener('scroll', () => {
        if (leitor.quadroRolagem) return;
        leitor.quadroRolagem = requestAnimationFrame(() => {
            leitor.quadroRolagem = 0;
            atualizarPaginaAtual();
        });
    }, { passive: true });

    // Pinca: um dedo rola sozinho (touch-action no CSS); com dois, o zoom e
    // nosso. Enquanto os dedos se mexem a pagina so e esticada com transform —
    // rapido —, e ao soltar ela e redesenhada nitida na escala nova.
    area.addEventListener('touchstart', (evento) => {
        if (evento.touches.length !== 2 || !leitor.paginas.length) return;
        const caixa = area.getBoundingClientRect();
        const meioX = (evento.touches[0].clientX + evento.touches[1].clientX) / 2 - caixa.left;
        const meioY = (evento.touches[0].clientY + evento.touches[1].clientY) / 2 - caixa.top;
        leitor.pinca = {
            distancia: distanciaEntre(evento.touches) || 1,
            razao: 1,
            meioX,
            meioY,
        };
        leitor.conteudo.style.transformOrigin =
            `${area.scrollLeft + meioX}px ${area.scrollTop + meioY}px`;
    }, { passive: true });

    area.addEventListener('touchmove', (evento) => {
        const pinca = leitor.pinca;
        if (!pinca || evento.touches.length !== 2) return;
        evento.preventDefault();
        const razao = distanciaEntre(evento.touches) / pinca.distancia;
        const zoom = Math.min(ZOOM_MAXIMO, Math.max(ZOOM_MINIMO, leitor.zoom * razao));
        pinca.razao = zoom / leitor.zoom;
        leitor.conteudo.style.transform = `scale(${pinca.razao})`;
    }, { passive: false });

    const soltarPinca = (evento) => {
        const pinca = leitor.pinca;
        if (!pinca || evento.touches.length >= 2) return;
        leitor.pinca = null;
        leitor.conteudo.style.transform = '';
        leitor.conteudo.style.transformOrigin = '';
        mudarZoomDoLeitor(leitor.zoom * pinca.razao, pinca.meioX, pinca.meioY);
    };
    area.addEventListener('touchend', soltarPinca);
    area.addEventListener('touchcancel', soltarPinca);

    // Safari antigo ainda tenta dar o zoom da pagina inteira por cima do nosso
    area.addEventListener('gesturestart', (evento) => evento.preventDefault());

    // Ctrl + roda do mouse, e a pinca do touchpad (que chega igual)
    area.addEventListener('wheel', (evento) => {
        if (!evento.ctrlKey || !leitor.paginas.length) return;
        evento.preventDefault();
        const caixa = area.getBoundingClientRect();
        const fator = Math.exp(-evento.deltaY / 300);
        mudarZoomDoLeitor(leitor.zoom * fator,
                          evento.clientX - caixa.left, evento.clientY - caixa.top);
    }, { passive: false });
}

/* ---- Tela cheia ---- */

function emTelaCheia() {
    return document.fullscreenElement || document.webkitFullscreenElement || null;
}

/**
 * Poe o leitor em tela cheia, quando o aparelho deixa. Devolve false quando
 * nao da (iPhone, leitor ainda carregando), para quem chamou abrir o PDF numa
 * aba nova no lugar.
 */
function entrarEmTelaCheia() {
    const raiz = leitor.raiz;
    if (!raiz || !leitor.pronto) return false;
    const pedir = raiz.requestFullscreen || raiz.webkitRequestFullscreen;
    if (!pedir) return false;
    try {
        const resultado = pedir.call(raiz);
        if (resultado && typeof resultado.catch === 'function') {
            resultado.catch(() => window.open(leitor.url, '_blank', 'noopener'));
        }
        return true;
    } catch (erro) {
        return false;
    }
}

function sairDaTelaCheia() {
    const sair = document.exitFullscreen || document.webkitExitFullscreen;
    if (sair) sair.call(document);
}

function aoMudarTelaCheia() {
    if (!leitor.raiz) return;
    const ligada = emTelaCheia() === leitor.raiz;
    leitor.raiz.classList.toggle('leitor-pdf--tela-cheia', ligada);
    const botao = leitor.raiz.querySelector('[data-leitor="tela-cheia"]');
    if (botao) {
        botao.innerHTML = ligada ? ICONE_SAIR_TELA_CHEIA : ICONE_TELA_CHEIA;
        botao.setAttribute('aria-label', ligada ? 'Sair da tela cheia' : 'Tela cheia');
        botao.title = ligada ? 'Sair da tela cheia' : 'Tela cheia';
    }
    // navegador sem ResizeObserver: a largura mudou e ninguem mais avisa
    if (!('ResizeObserver' in window)) ajustarLayoutDoLeitor();
}
