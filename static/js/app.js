/* =========================================================================
   Area do professor: agenda semanal, nova reserva, minhas aulas e regras.
   ========================================================================= */

const estado = {
    professor: null,
    // o professor que virou gestor continua entrando e consultando a agenda,
    // mas nao reserva enquanto o acesso de gestor estiver ativo
    administra: false,
    regras: null,
    laboratorios: [],
    horarios: [],
    agenda: null,
    // grade de todos os professores, só quando a coordenação libera
    gradeEscola: null,
    inicioSemana: null,
    // segunda-feira da semana aberta na aba "Meu horário" (grade de aulas).
    // Não se confunde com `inicioSemana`, que é a semana da agenda de laboratório.
    semanaHorario: null,
    // grade da semana vigente do próprio professor, guardada para redesenhar
    // ao trocar de dia no celular sem pedir tudo de novo ao servidor
    minhaGrade: null,
    diaAtivo: 0,
    // dia útil aberto na aba "Meu horário" no celular (0 = segunda)
    diaHorario: null,
    selecionados: [],
    ocupacaoDoDia: {},
    // relógio da escola: a hora que o servidor mandou na última agenda e o
    // instante local em que ela chegou, para descontar o tempo que passou
    relogio: null,
};

const AVISO_ADMINISTRA = 'Você administra o sistema, e quem cuida da agenda não '
    + 'reserva laboratório.';

/*
 * A hora de "já passou" é sempre a do servidor, nunca a do computador do
 * professor — que pode estar adiantado, atrasado ou em outro fuso. Guardamos
 * a diferença entre os dois relógios e a somamos na hora de comparar, então a
 * tela continua certa mesmo com a página aberta a manhã inteira.
 */
function marcarRelogio(agenda) {
    if (agenda && agenda.agora) {
        estado.relogio = { servidor: new Date(agenda.agora).getTime(), local: Date.now() };
    }
}

/** Hora atual da escola como "HH:MM", ou null enquanto nenhuma agenda chegou. */
function horaDoServidor() {
    if (!estado.relogio) return null;
    const momento = new Date(Date.now() - estado.relogio.local + estado.relogio.servidor);
    return `${String(momento.getHours()).padStart(2, '0')}`
         + `:${String(momento.getMinutes()).padStart(2, '0')}`;
}

/** A aula de hoje já começou? Os horários são "HH:MM", a comparação é direta. */
function aulaJaComecou(dia, horario) {
    if (!dia || !dia.hoje) return false;
    const agora = horaDoServidor();
    return agora !== null && horario.inicio <= agora;
}

/* ------------------------------------------------------------------ */
/* Entrada                                                             */
/* ------------------------------------------------------------------ */

document.addEventListener('DOMContentLoaded', iniciar);

async function iniciar() {
    ligarEventos();
    try {
        const sessao = await API.get('/api/sessao');
        if (sessao.professor) {
            await abrirSistema(sessao.professor, sessao.professor_administra);
        } else {
            mostrarLogin();
        }
    } catch (erro) {
        mostrarLogin();
    }
}

function mostrarLogin() {
    document.getElementById('telaLogin').classList.remove('oculto');
    document.getElementById('app').classList.add('oculto');
}

async function abrirSistema(professor, administra) {
    estado.professor = professor;
    estado.administra = Boolean(administra);
    iniciarVigiaDeSessao();     // sai sozinho depois do tempo parado (api.js)
    aplicarBloqueioDeReserva();
    document.getElementById('telaLogin').classList.add('oculto');
    document.getElementById('app').classList.remove('oculto');
    document.getElementById('nomeProfessor').textContent = professor.nome;
    document.getElementById('disciplinaProfessor').textContent =
        professor.disciplina || `Matrícula ${professor.matricula}`;
    document.getElementById('avatarProfessor').innerHTML = avatarHTML(professor);
    document.getElementById('avatarTopo').innerHTML = avatarHTML(professor);
    preencherDataDeHoje();

    const [regras, laboratorios, horarios] = await Promise.all([
        API.get('/api/regras'),
        API.get('/api/laboratorios'),
        API.get('/api/horarios'),
    ]);
    estado.regras = regras;
    estado.laboratorios = laboratorios;
    estado.horarios = horarios;

    preencherSeletores();
    montarRegras();

    if (!laboratorios.length) {
        document.getElementById('conteudoGrade').innerHTML = `
            <div class="lista-vazia">
                <strong>Nenhum laboratório cadastrado</strong>
                A coordenação ainda precisa cadastrar os laboratórios da escola.
            </div>`;
        return;
    }

    estado.inicioSemana = segundaDaSemana(semanaInicial());
    await carregarAgenda();
    await carregarMinhasReservas();
}

/**
 * Tira a reserva do caminho de quem administra: some com a aba "Nova reserva",
 * troca o formulário por uma explicação e deixa o resto do sistema (agenda,
 * minhas aulas, relatório) funcionando como antes. O servidor recusa de novo
 * em /api/reservas — aqui é só para a pessoa não perder tempo preenchendo.
 */
function aplicarBloqueioDeReserva() {
    const botaoAba = document.getElementById('botaoAbaReservar');
    const formulario = document.getElementById('formReserva');
    const aviso = document.getElementById('avisoAdministra');

    botaoAba.classList.toggle('oculto', estado.administra);
    formulario.classList.toggle('oculto', estado.administra);
    aviso.classList.toggle('oculto', !estado.administra);
    if (estado.administra) {
        aviso.innerHTML = `<div><strong>Você administra o sistema</strong>
            ${escapar(AVISO_ADMINISTRA)} Para voltar a reservar, é preciso desativar
            o seu acesso de gestor. As aulas que você já tinha reservado continuam
            valendo em <strong>Minhas aulas</strong>.</div>`;
    }
}

/**
 * Os botoes de gravar aparecem duas vezes no painel: no alto, ao lado da
 * quantidade de computadores, e no fim, depois da observação. Registrar a
 * turma é uma tela longa no celular, e obrigar a rolar até o fim só para
 * salvar custava o registro de quem se distraía no caminho.
 *
 * Como são o mesmo botão, tudo o que vale para um vale para o outro — ligar,
 * desligar, esconder, escrever "Salvando…" —, então o código pega os dois de
 * uma vez pelo `data-acao` em vez de um `id`.
 */
function botoes(acao) {
    return [...document.querySelectorAll(`[data-acao="${acao}"]`)];
}

function ligarEventos() {
    document.getElementById('formLogin').addEventListener('submit', fazerLogin);
    configurarSair();

    configurarAbas((aba) => {
        if (aba === 'minhas') carregarMinhasReservas();
        if (aba === 'conta') carregarMinhaConta();
        if (aba === 'horario') carregarMeuHorario();
        if (aba === 'relatorio') gerarMeuRelatorio();
        if (aba === 'calendarioEscolar') carregarCalendarioEscolar();
        // o atalho de "Minhas aulas" já carrega a lista antes de trocar de aba;
        // aqui é para quem entrou pelo menu
        if (aba === 'computadores' && !alocacao.carregada) carregarAulasParaAlocacao();
        if (aba === 'projetos' && !projetos.carregada) carregarProjetos();
    });
    // o professor só lê o calendário; enviar é com a gestão (calendario.js)
    iniciarCalendarioEscolar({ podeEnviar: false });

    document.getElementById('seletorLaboratorio')
        .addEventListener('change', () => carregarAgenda());
    document.getElementById('semanaAnterior').addEventListener('click', () => {
        estado.inicioSemana = somarDias(estado.inicioSemana, -7);
        carregarAgenda();
    });
    document.getElementById('semanaSeguinte').addEventListener('click', () => {
        estado.inicioSemana = somarDias(estado.inicioSemana, 7);
        carregarAgenda();
    });

    document.getElementById('conteudoGrade').addEventListener('click', aoClicarNaGrade);
    document.getElementById('seletorDias').addEventListener('click', (evento) => {
        const item = evento.target.closest('.seletor-dias__item');
        if (!item) return;
        estado.diaAtivo = Number(item.dataset.indice);
        desenharAgenda();
    });

    document.getElementById('reservaLaboratorio')
        .addEventListener('change', atualizarFormularioReserva);
    document.getElementById('reservaData')
        .addEventListener('change', atualizarFormularioReserva);
    document.getElementById('formReserva').addEventListener('submit', enviarReserva);
    document.getElementById('botaoLimpar').addEventListener('click', limparFormulario);
    document.getElementById('listaHorarios').addEventListener('click', alternarHorario);

    document.getElementById('botaoAtualizarMinhas')
        .addEventListener('click', carregarMinhasReservas);

    document.getElementById('botaoAtualizarHorario')
        .addEventListener('click', carregarMeuHorario);
    document.getElementById('semanaAnteriorProf').addEventListener('click',
        () => irParaSemanaDoHorario(deslocarSemana(semanaDoHorario(), -1)));
    document.getElementById('semanaSeguinteProf').addEventListener('click',
        () => irParaSemanaDoHorario(deslocarSemana(semanaDoHorario(), 1)));
    document.getElementById('voltarSemanaAtualProf').addEventListener('click',
        () => irParaSemanaDoHorario(segundaDaSemana()));
    document.getElementById('botaoIrParaHorario')
        .addEventListener('click', () => irParaAba('horario'));
    document.getElementById('seletorProfessorGrade')
        .addEventListener('change', desenharGradeDaEscola);
    // no celular a grade da semana sai um dia de cada vez
    ligarSeletorDias('seletorDiasHorario', trocarDiaDoHorario);
    ligarSeletorDias('seletorDiasEscola', trocarDiaDoHorario);

    document.getElementById('listaProximas').addEventListener('click', aoClicarEmReserva);
    document.getElementById('listaHistorico').addEventListener('click', aoClicarEmReserva);

    document.getElementById('botaoAtualizarAlocacao').addEventListener('click', async () => {
        await carregarAulasParaAlocacao();
        if (alocacao.reservaId) await abrirAlocacaoDaAula(alocacao.reservaId);
    });
    document.getElementById('alocacaoAula')
        .addEventListener('change', aoTrocarAulaDaAlocacao);
    document.getElementById('alocacaoTurma')
        .addEventListener('change', aoTrocarTurmaDaAlocacao);
    document.getElementById('alocacaoQtd').addEventListener('change', mudarQtdComputadores);
    document.getElementById('buscaAlunoAlocacao')
        .addEventListener('input', desenharAlunosDaTurma);
    document.getElementById('listaAlunosTurma')
        .addEventListener('click', aoClicarAlunoDaTurma);
    document.getElementById('listaComputadores')
        .addEventListener('click', aoClicarComputador);
    // a máquina é uma div com role=button: sem isto ela não responderia ao teclado
    document.getElementById('listaComputadores').addEventListener('keydown', (evento) => {
        if (evento.key !== 'Enter' && evento.key !== ' ') return;
        if (!evento.target.closest('[data-maquina]')) return;
        evento.preventDefault();
        aoClicarComputador(evento);
    });
    document.getElementById('botaoDuplas').addEventListener('click', formarDuplas);
    document.getElementById('botaoLimparAlocacao').addEventListener('click', limparAlocacao);
    botoes('salvarAlocacao')
        .forEach((botao) => botao.addEventListener('click', salvarAlocacao));
    document.getElementById('botaoExcluirAlocacao').addEventListener('click', excluirAlocacao);

    document.getElementById('botaoAtualizarProjetos')
        .addEventListener('click', () => carregarProjetos(true));
    document.getElementById('formProjeto').addEventListener('submit', enviarProjeto);
    document.getElementById('listaProjetos').addEventListener('click', aoClicarEmProjeto);
    document.getElementById('filtroProjetos').addEventListener('click', (evento) => {
        const item = evento.target.closest('[data-escopo]');
        if (!item) return;
        projetos.escopo = item.dataset.escopo;
        document.querySelectorAll('#filtroProjetos .alternador__item').forEach((botao) => {
            botao.classList.toggle('alternador__item--ativo', botao === item);
        });
        carregarListaDeProjetos();
    });
    document.getElementById('registroComputadores')
        .addEventListener('click', aoClicarComputadorDoProjeto);
    document.getElementById('registroComputadores').addEventListener('keydown', (evento) => {
        if (evento.key !== 'Enter' && evento.key !== ' ') return;
        if (!evento.target.closest('[data-maquina]')) return;
        evento.preventDefault();
        aoClicarComputadorDoProjeto(evento);
    });
    document.getElementById('registroTurma')
        .addEventListener('change', aoTrocarTurmaDoRegistro);
    document.getElementById('buscaAlunoRegistro')
        .addEventListener('input', desenharAlunosDoRegistro);
    document.getElementById('registroAlunosTurma')
        .addEventListener('click', aoClicarAlunoDoRegistro);
    document.getElementById('registroQtd')
        .addEventListener('change', mudarQtdDeComputadores);
    document.getElementById('botaoLimparRegistro')
        .addEventListener('click', limparRegistroDoProjeto);
    document.getElementById('botaoFecharRegistro')
        .addEventListener('click', fecharRegistroDoProjeto);
    botoes('salvarRegistro')
        .forEach((botao) => botao.addEventListener('click', salvarRegistroDoProjeto));
    botoes('excluirRegistro')
        .forEach((botao) => botao.addEventListener('click', excluirRegistroDoProjeto));

    document.getElementById('botaoGerarMeuRelatorio')
        .addEventListener('click', gerarMeuRelatorio);
    document.getElementById('meuRelDe').value = somarDias(hojeISO(), -60);
    document.getElementById('meuRelAte').value = somarDias(hojeISO(), 60);

    document.getElementById('formContato').addEventListener('submit', salvarContato);
    limitarCampoTelefone(document.getElementById('contaTelefone'));
    document.getElementById('formSenhaProfessor').addEventListener('submit', trocarMinhaSenha);

    document.getElementById('botaoAlterarFoto').addEventListener('click', () => {
        document.getElementById('contaFoto').click();
    });
    document.getElementById('contaFoto').addEventListener('change', (evento) => {
        enviarFoto(evento.target.files[0]);
        evento.target.value = '';
    });
    document.getElementById('botaoRemoverFoto').addEventListener('click', removerFoto);

    // girar o celular ou abrir num monitor troca entre um dia e a semana toda
    telaMobile.addEventListener('change', () => {
        if (estado.agenda) desenharAgenda();
        desenharMinhaGrade();
        desenharGradeDaEscola();
    });
}

async function fazerLogin(evento) {
    evento.preventDefault();
    const campo = document.getElementById('identificador');
    const campoSenha = document.getElementById('senhaProfessor');
    const erro = document.getElementById('erroLogin');
    mostrarErro(erro, '');
    try {
        const resposta = await API.post('/api/login/professor', {
            identificador: campo.value.trim(),
            senha: campoSenha.value,
        });
        campoSenha.value = '';
        await abrirSistema(resposta.professor, resposta.professor_administra);
    } catch (falha) {
        mostrarErro(erro, falha.message);
        campoSenha.value = '';
        campoSenha.focus();
    }
}

/* ------------------------------------------------------------------ */
/* Seletores                                                           */
/* ------------------------------------------------------------------ */

function preencherSeletores() {
    const opcoes = estado.laboratorios
        .map((lab) => `<option value="${lab.id}">${escapar(lab.nome)}</option>`)
        .join('');
    document.getElementById('seletorLaboratorio').innerHTML = opcoes;
    document.getElementById('reservaLaboratorio').innerHTML = opcoes;

    document.getElementById('reservaTipo').innerHTML =
        '<option value="">Selecione…</option>' +
        estado.regras.tipos_aula
            .map((tipo) => `<option value="${escapar(tipo)}">${escapar(tipo)}</option>`)
            .join('');

    const campoData = document.getElementById('reservaData');
    campoData.min = hojeISO();
    campoData.max = somarDias(hojeISO(), estado.regras.antecedencia_maxima_dias);
    campoData.value = hojeISO();
}

/** No fim de semana (com a escola fechada) já abre a agenda na próxima segunda. */
function semanaInicial() {
    const hoje = paraData(hojeISO());
    const fimDeSemana = hoje.getDay() === 0 || hoje.getDay() === 6;
    if (fimDeSemana && !estado.regras.permitir_fim_de_semana) {
        return somarDias(hojeISO(), hoje.getDay() === 6 ? 2 : 1);
    }
    return hojeISO();
}


/* ------------------------------------------------------------------ */
/* Agenda semanal                                                      */
/* ------------------------------------------------------------------ */

async function carregarAgenda() {
    const laboratorioId = document.getElementById('seletorLaboratorio').value;
    if (!laboratorioId) return;

    const container = document.getElementById('conteudoGrade');
    container.innerHTML = '<div class="lista-vazia"><span class="carregando"></span></div>';

    try {
        estado.agenda = await API.get(
            `/api/agenda?laboratorio_id=${laboratorioId}&inicio=${estado.inicioSemana}`
        );
        marcarRelogio(estado.agenda);
        estado.inicioSemana = estado.agenda.inicio_semana;

        const indiceHoje = estado.agenda.dias.findIndex((dia) => dia.hoje);
        estado.diaAtivo = indiceHoje >= 0 ? indiceHoje : 0;

        desenharAgenda();
        verificarCarencia(laboratorioId);
    } catch (falha) {
        container.innerHTML = `<div class="lista-vazia"><strong>Ops</strong>${escapar(falha.message)}</div>`;
    }
}

async function verificarCarencia(laboratorioId) {
    const aviso = document.getElementById('avisoCarencia');
    try {
        const resposta = await API.get(
            `/api/disponibilidade?laboratorio_id=${laboratorioId}&data=${hojeISO()}`
        );
        if (resposta.em_carencia) {
            const liberada = resposta.liberada_em
                ? ` Você volta a poder reservar a partir de <strong>${dataBR(resposta.liberada_em)}</strong>.`
                : '';
            aviso.innerHTML = `<div><strong>Você está em período de carência</strong>
                ${escapar(resposta.motivo)}${liberada}</div>`;
            aviso.classList.remove('oculto');
        } else {
            aviso.classList.add('oculto');
        }
    } catch (falha) {
        aviso.classList.add('oculto');
    }
}

function desenharAgenda() {
    const agenda = estado.agenda;
    if (!agenda) return;

    const inicio = paraData(agenda.dias[0].data);
    const fim = paraData(agenda.dias[agenda.dias.length - 1].data);
    document.getElementById('rotuloSemana').textContent =
        `${inicio.getDate()}/${inicio.getMonth() + 1} – ${fim.getDate()}/${fim.getMonth() + 1}`;

    // seletor de dias (celular)
    document.getElementById('seletorDias').innerHTML = agenda.dias
        .map((dia, indice) => `
            <button class="seletor-dias__item ${indice === estado.diaAtivo ? 'ativo' : ''}"
                    data-indice="${indice}" type="button">
                <strong>${escapar(dia.rotulo_curto)}</strong>
                <span>${escapar(dia.dia_mes)}</span>
            </button>`)
        .join('');

    const ehMobile = telaMobile.matches;
    const dias = ehMobile ? [agenda.dias[estado.diaAtivo]] : agenda.dias;

    let html = `<div class="grade" style="--colunas:${dias.length}">`;
    html += '<div class="grade__hora grade__cabecalho-canto"></div>';
    html += dias.map((dia) => `
        <div class="grade__cabecalho-dia ${dia.hoje ? 'hoje' : ''}">
            <strong>${escapar(dia.rotulo)}</strong>
            <span>${escapar(dia.dia_mes)}</span>
        </div>`).join('');

    let turnoAtual = null;
    agenda.horarios.forEach((horario) => {
        if (horario.turno !== turnoAtual) {
            turnoAtual = horario.turno;
            html += `<div class="grade__turno">${ROTULO_TURNO[turnoAtual] || turnoAtual}</div>`;
        }
        html += `<div class="grade__hora">
                    <span>${numeroDaAula(horario)}ª aula</span>
                    <span>${escapar(horario.inicio)}</span>
                    <span>${escapar(horario.fim)}</span>
                 </div>`;
        html += dias.map((dia) => celulaHTML(dia, horario)).join('');
    });
    html += '</div>';

    document.getElementById('conteudoGrade').innerHTML = html;
}

/**
 * Quando a aula que ocupa a vaga tem outro tamanho (uma dupla de 19:00–21:30
 * cobrindo a linha das 19:45), mostra o intervalo real — senão o professor vê
 * "ocupado" num horário que ninguém aparentemente reservou.
 */
function textoAulaMaior(reserva, horario) {
    const real = reserva.intervalo;
    if (!real || real === `${horario.inicio}–${horario.fim}`) return '';
    return `<span class="celula__detalhe">aula das ${escapar(real)}</span>`;
}

function celulaHTML(dia, horario) {
    const marcaHora = `<span class="celula__hora">${numeroDaAula(horario)}ª · ${escapar(horario.inicio)}–${escapar(horario.fim)}</span>`;
    const reserva = estado.agenda.ocupacao[`${dia.data}|${horario.id}`];

    if (reserva) {
        const classe = reserva.meu ? 'celula celula--ocupada celula--minha' : 'celula celula--ocupada';
        return `<div class="${classe}" data-acao="detalhe" data-id="${reserva.id}"
                     data-data="${dia.data}" data-horario="${horario.id}" role="button" tabindex="0">
                    ${marcaHora}
                    ${reserva.meu ? '<span class="celula__marca">Minha</span>' : ''}
                    <span class="celula__titulo">${escapar(reserva.disciplina || 'Reservado')}</span>
                    <span class="celula__detalhe">${escapar(reserva.professor)}</span>
                    ${textoAulaMaior(reserva, horario)}
                </div>`;
    }

    if (dia.bloqueio) {
        return `<div class="celula celula--indisponivel">
                    ${marcaHora}
                    <span class="celula__titulo">${escapar(dia.bloqueio)}</span>
                </div>`;
    }

    if (dia.passado) {
        return `<div class="celula celula--indisponivel">
                    ${marcaHora}
                    <span class="celula__titulo">—</span>
                </div>`;
    }

    if (aulaJaComecou(dia, horario)) {
        return `<div class="celula celula--indisponivel">
                    ${marcaHora}
                    <span class="celula__titulo">Já passou</span>
                </div>`;
    }

    return `<button type="button" class="celula celula--livre" data-acao="reservar"
                    data-data="${dia.data}" data-horario="${horario.id}">
                ${marcaHora}
                <span class="celula__titulo">Livre</span>
                <span class="celula__detalhe">Toque para reservar</span>
            </button>`;
}

function aoClicarNaGrade(evento) {
    const celula = evento.target.closest('[data-acao]');
    if (!celula) return;

    if (celula.dataset.acao === 'reservar') {
        irParaReserva(celula.dataset.data, Number(celula.dataset.horario));
        return;
    }

    const reserva = estado.agenda.ocupacao[`${celula.dataset.data}|${celula.dataset.horario}`];
    if (!reserva) return;
    const horario = estado.agenda.horarios.find((h) => h.id === Number(celula.dataset.horario));

    abrirModal({
        titulo: reserva.disciplina || 'Aula reservada',
        subtitulo: `${dataExtenso(celula.dataset.data)} · ${horario.inicio}–${horario.fim}`,
        corpo: `
            <p><span class="rotulo-pequeno">Professor</span><br>${escapar(reserva.professor)}</p>
            <p><span class="rotulo-pequeno">Tipo de aula</span><br>${escapar(reserva.tipo_aula || '—')}</p>
            <p><span class="rotulo-pequeno">Laboratório</span><br>${escapar(estado.agenda.laboratorio.nome)}</p>
            <p>${selo(reserva.status)}</p>`,
        textoConfirmar: reserva.meu && reserva.status === 'ativa' ? 'Cancelar minha reserva' : null,
        perigo: true,
        aoConfirmar: async () => {
            await cancelarReserva(reserva.id);
            await carregarAgenda();
        },
    });
}

/* ------------------------------------------------------------------ */
/* Nova reserva                                                        */
/* ------------------------------------------------------------------ */

function irParaReserva(dataISO, horarioId) {
    // a agenda continua clicável para consulta; só o atalho de reservar sai
    if (estado.administra) {
        notificar(AVISO_ADMINISTRA, 'erro');
        return;
    }
    document.getElementById('reservaLaboratorio').value =
        document.getElementById('seletorLaboratorio').value;
    document.getElementById('reservaData').value = dataISO;
    estado.selecionados = horarioId ? [horarioId] : [];
    irParaAba('reservar');
    atualizarFormularioReserva(true);
}

async function atualizarFormularioReserva(manterSelecao) {
    const laboratorioId = document.getElementById('reservaLaboratorio').value;
    const data = document.getElementById('reservaData').value;
    const lista = document.getElementById('listaHorarios');

    if (manterSelecao !== true) estado.selecionados = [];

    const laboratorio = estado.laboratorios.find((lab) => String(lab.id) === String(laboratorioId));
    const info = document.getElementById('infoLaboratorio');
    if (laboratorio) {
        info.innerHTML = `<div>
            <strong>${escapar(laboratorio.nome)}</strong>
            ${escapar(laboratorio.tipo || 'Laboratório')} ·
            capacidade ${laboratorio.capacidade} alunos ·
            ${laboratorio.equipamentos || 0} equipamentos
            ${laboratorio.observacoes ? `<br>${escapar(laboratorio.observacoes)}` : ''}
        </div>`;
        info.classList.remove('oculto');
        document.getElementById('reservaAlunos').max = laboratorio.capacidade;
    } else {
        info.classList.add('oculto');
    }

    if (!laboratorioId || !data) {
        lista.innerHTML = '<div class="lista-vazia">Escolha um laboratório e uma data.</div>';
        return;
    }

    lista.innerHTML = '<div class="lista-vazia"><span class="carregando"></span></div>';
    try {
        const agenda = await API.get(`/api/agenda?laboratorio_id=${laboratorioId}&inicio=${data}`);
        marcarRelogio(agenda);
        const dia = agenda.dias.find((item) => item.data === data);
        estado.ocupacaoDoDia = {};
        agenda.horarios.forEach((horario) => {
            const reserva = agenda.ocupacao[`${data}|${horario.id}`];
            if (reserva) estado.ocupacaoDoDia[horario.id] = reserva;
        });

        if (dia && dia.bloqueio) {
            lista.innerHTML = `<div class="lista-vazia">
                <strong>Data indisponível</strong>${escapar(dia.bloqueio)}</div>`;
            estado.selecionados = [];
            atualizarResumo();
            return;
        }
        if (!dia) {
            lista.innerHTML = `<div class="lista-vazia">
                <strong>Dia sem aulas</strong>A escola não abre nesse dia.</div>`;
            estado.selecionados = [];
            atualizarResumo();
            return;
        }

        let html = '';
        let turnoAtual = null;
        agenda.horarios.forEach((horario) => {
            if (horario.turno !== turnoAtual) {
                turnoAtual = horario.turno;
                html += `<div class="grade__turno">${ROTULO_TURNO[turnoAtual] || turnoAtual}</div>`;
            }
            const reserva = estado.ocupacaoDoDia[horario.id];
            const selecionado = estado.selecionados.includes(horario.id);
            if (!reserva && aulaJaComecou(dia, horario)) {
                html += `<div class="celula celula--indisponivel">
                            <span class="celula__hora">${numeroDaAula(horario)}ª · ${escapar(horario.inicio)}–${escapar(horario.fim)}</span>
                            <span class="celula__titulo">Já passou</span>
                         </div>`;
            } else if (reserva) {
                html += `<div class="celula celula--ocupada">
                            <span class="celula__hora">${numeroDaAula(horario)}ª · ${escapar(horario.inicio)}</span>
                            <span class="celula__titulo">Ocupado</span>
                            <span class="celula__detalhe">${escapar(reserva.professor)}</span>
                            ${textoAulaMaior(reserva, horario)}
                         </div>`;
            } else {
                html += `<button type="button"
                            class="celula ${selecionado ? 'celula--selecionada' : 'celula--livre'}"
                            data-horario="${horario.id}" data-turno="${horario.turno}"
                            data-ordem="${horario.ordem}">
                            <span class="celula__hora">${numeroDaAula(horario)}ª · ${escapar(horario.inicio)}–${escapar(horario.fim)}</span>
                            <span class="celula__titulo">${selecionado ? 'Selecionado' : 'Livre'}</span>
                         </button>`;
            }
        });
        lista.innerHTML = html;
        atualizarResumo();
        verificarCarenciaFormulario(laboratorioId, data);
    } catch (falha) {
        lista.innerHTML = `<div class="lista-vazia">${escapar(falha.message)}</div>`;
    }
}

async function verificarCarenciaFormulario(laboratorioId, data) {
    const erro = document.getElementById('erroReserva');
    try {
        const resposta = await API.get(
            `/api/disponibilidade?laboratorio_id=${laboratorioId}&data=${data}`
        );
        if (resposta.em_carencia) {
            mostrarErro(erro, resposta.motivo);
        } else {
            mostrarErro(erro, '');
        }
    } catch (falha) {
        /* silencioso: o servidor valida de novo no envio */
    }
}

function alternarHorario(evento) {
    const botao = evento.target.closest('button[data-horario]');
    if (!botao) return;

    const id = Number(botao.dataset.horario);
    const ordem = Number(botao.dataset.ordem);
    const turno = botao.dataset.turno;
    const horariosPorId = Object.fromEntries(estado.horarios.map((h) => [h.id, h]));

    if (estado.selecionados.includes(id)) {
        estado.selecionados = estado.selecionados.filter((item) => item !== id);
    } else {
        const atuais = estado.selecionados.map((item) => horariosPorId[item]).filter(Boolean);
        const mesmoTurno = atuais.every((h) => h.turno === turno);
        const ordens = atuais.map((h) => h.ordem).concat(ordem).sort((a, b) => a - b);
        const seguidos = ordens.every((valor, indice) =>
            indice === 0 || valor === ordens[indice - 1] + 1);

        if (!mesmoTurno || !seguidos) {
            estado.selecionados = [id];
            notificar('As aulas precisam ser seguidas e do mesmo turno — seleção reiniciada.', 'erro');
        } else if (ordens.length > limiteDeAulasSeguidas()) {
            notificar(`Máximo de ${limiteDeAulasSeguidas()} aula(s) seguidas.`, 'erro');
            return;
        } else {
            estado.selecionados.push(id);
        }
    }

    atualizarFormularioReserva(true);
}

function atualizarResumo() {
    const resumo = document.getElementById('resumoSelecao');
    const quantidade = estado.selecionados.length;
    resumo.textContent = quantidade
        ? `${quantidade} aula(s) selecionada(s)`
        : 'Nenhum horário selecionado';
    document.getElementById('botaoConfirmar').disabled = quantidade === 0;
}

function limparFormulario() {
    estado.selecionados = [];
    document.getElementById('reservaDisciplina').value = '';
    document.getElementById('reservaTipo').value = '';
    document.getElementById('reservaAlunos').value = '';
    document.getElementById('reservaObservacao').value = '';
    mostrarErro(document.getElementById('erroReserva'), '');
    atualizarFormularioReserva();
}

async function enviarReserva(evento) {
    evento.preventDefault();
    const erro = document.getElementById('erroReserva');
    const botao = document.getElementById('botaoConfirmar');
    mostrarErro(erro, '');

    const corpo = {
        laboratorio_id: Number(document.getElementById('reservaLaboratorio').value),
        data: document.getElementById('reservaData').value,
        horario_ids: estado.selecionados,
        disciplina: document.getElementById('reservaDisciplina').value.trim(),
        tipo_aula: document.getElementById('reservaTipo').value,
        qtd_alunos: document.getElementById('reservaAlunos').value || null,
        observacao: document.getElementById('reservaObservacao').value.trim(),
    };

    botao.disabled = true;
    try {
        const resposta = await API.post('/api/reservas', corpo);
        notificar(`Reserva confirmada: ${resposta.aulas} aula(s).`, 'sucesso');
        estado.selecionados = [];
        limparFormulario();
        await carregarMinhasReservas();
        document.getElementById('seletorLaboratorio').value = corpo.laboratorio_id;
        estado.inicioSemana = segundaDaSemana(corpo.data);
        await carregarAgenda();
        irParaAba('agenda');
    } catch (falha) {
        mostrarErro(erro, falha.message, falha.dados && falha.dados.erros);
        window.scrollTo({ top: 0, behavior: 'smooth' });
    } finally {
        botao.disabled = false;
        atualizarResumo();
    }
}

/* ------------------------------------------------------------------ */
/* Minhas reservas                                                     */
/* ------------------------------------------------------------------ */

async function carregarMinhasReservas() {
    const proximas = document.getElementById('listaProximas');
    const historico = document.getElementById('listaHistorico');
    proximas.innerHTML = '<div class="lista-vazia"><span class="carregando"></span></div>';
    historico.innerHTML = '';

    try {
        // os registros vêm junto para o cartão da aula já dizer quais delas
        // tiveram os computadores anotados, sem esperar a aba "Computadores"
        const [reservas, registros] = await Promise.all([
            API.get('/api/minhas-reservas'),
            API.get('/api/meus-registros-computadores').catch(() => ({})),
        ]);
        alocacao.registros = registros || {};
        const hoje = hojeISO();
        const futuras = reservas.filter((r) => r.data >= hoje && r.status === 'ativa');
        const passadas = reservas.filter((r) => !(r.data >= hoje && r.status === 'ativa'));

        futuras.sort((a, b) => a.data.localeCompare(b.data) || (a.ordem - b.ordem));
        montarIndicadores(reservas, futuras);

        proximas.innerHTML = futuras.length
            ? futuras.map((reserva) => itemReservaHTML(reserva, true)).join('')
            : `<div class="lista-vazia">
                   <strong>Nenhuma aula agendada</strong>
                   Use a aba “Reservar” para agendar seu próximo laboratório.
               </div>`;

        historico.innerHTML = passadas.length
            ? passadas.slice(0, 40).map((reserva) => itemReservaHTML(reserva, false)).join('')
            : '<div class="lista-vazia">Ainda não há histórico.</div>';
    } catch (falha) {
        proximas.innerHTML = `<div class="lista-vazia">${escapar(falha.message)}</div>`;
    }
}

function montarIndicadores(reservas, futuras) {
    const area = document.getElementById('indicadoresProfessor');
    if (!area) return;

    const realizadas = reservas.filter((r) => r.status === 'realizada').length;
    const faltas = reservas.filter((r) => r.status === 'falta').length;
    const proxima = futuras[0];
    const textoProxima = proxima
        ? `${dataBR(proxima.data)} · ${proxima.inicio}`
        : 'Nenhuma';

    area.innerHTML = `
        <div class="indicador indicador--primaria">
            <strong>${futuras.length}</strong><span>Aulas agendadas</span>
        </div>
        <div class="indicador indicador--verde">
            <strong>${realizadas}</strong><span>Aulas realizadas</span>
        </div>
        <div class="indicador indicador--ambar">
            <strong>${faltas}</strong><span>Faltas registradas</span>
        </div>
        <div class="indicador">
            <strong style="font-size:1.02rem;padding-top:8px">${escapar(textoProxima)}</strong>
            <span>Próxima aula</span>
        </div>`;
}

function itemReservaHTML(reserva, podeCancelar) {
    const data = paraData(reserva.data);
    const registro = alocacao.registros[reserva.id];
    return `
        <div class="item-reserva item-reserva--${reserva.status}">
            <div class="item-reserva__data">
                <strong>${String(data.getDate()).padStart(2, '0')}</strong>
                <span>${MESES[data.getMonth()]}</span>
            </div>
            <div class="item-reserva__corpo">
                <strong>${escapar(reserva.laboratorio_nome)}</strong>
                <p>${escapar(reserva.disciplina || '')}
                   ${reserva.tipo_aula ? `· ${escapar(reserva.tipo_aula)}` : ''}</p>
                <p class="mono">${escapar(reserva.inicio)}–${escapar(reserva.fim)}
                   · ${ROTULO_TURNO[reserva.turno] || reserva.turno}
                   · ${numeroDaAula(reserva)}ª aula
                   ${registro ? `· ${registro.total_alunos} aluno(s) nos computadores` : ''}</p>
            </div>
            <div class="item-reserva__acoes">
                ${selo(reserva.status)}
                ${reserva.status === 'cancelada'
                    ? ''
                    : `<button class="botao botao--pequeno botao--vazio"
                               data-computadores="${reserva.id}">
                           ${registro ? 'Ver computadores' : 'Computadores'}
                       </button>`}
                ${podeCancelar
                    ? `<button class="botao botao--pequeno botao--perigo"
                               data-cancelar="${reserva.id}">Cancelar</button>`
                    : ''}
            </div>
        </div>`;
}

function aoClicarEmReserva(evento) {
    const atalho = evento.target.closest('[data-computadores]');
    if (atalho) {
        irParaComputadoresDaAula(Number(atalho.dataset.computadores));
        return;
    }

    const botao = evento.target.closest('[data-cancelar]');
    if (!botao) return;
    const id = Number(botao.dataset.cancelar);

    abrirModal({
        titulo: 'Cancelar reserva',
        subtitulo: 'O horário volta a ficar disponível para os outros professores.',
        corpo: '<p>Tem certeza de que deseja cancelar esta aula?</p>',
        textoCancelar: 'Voltar',
        textoConfirmar: 'Sim, cancelar',
        perigo: true,
        aoConfirmar: async () => {
            const sucesso = await cancelarReserva(id);
            if (!sucesso) return false;
            await carregarMinhasReservas();
            if (estado.agenda) await carregarAgenda();
            return true;
        },
    });
}

async function cancelarReserva(id) {
    try {
        await API.post(`/api/reservas/${id}/cancelar`);
        notificar('Reserva cancelada.', 'sucesso');
        return true;
    } catch (falha) {
        notificar(falha.message, 'erro');
        return false;
    }
}

/* ------------------------------------------------------------------ */
/* Computadores da aula                                                */
/* ------------------------------------------------------------------ */
/*
 * O professor escolhe a aula, escolhe a turma e distribui os alunos pelas
 * máquinas. A tela toda gira em volta de `alocacao.mapa`: computador -> lista
 * de até dois ocupantes. Enquanto nada é salvo, esse mapa só existe aqui.
 *
 * A alocação funciona nos dois sentidos, porque no laboratório o professor tem
 * as duas pressas: às vezes ele olha o aluno e procura a máquina, às vezes olha
 * a máquina vazia e procura quem falta. Tocar num aluno e depois numa máquina
 * senta; tocar numa máquina e depois num aluno também. Tocar num nome já
 * sentado devolve o aluno para a lista.
 */

const alocacao = {
    reservas: [],
    // reserva_id -> resumo do registro já salvo, para marcar a lista de aulas
    registros: {},
    reservaId: null,
    dados: null,
    alunos: [],
    turmas: [],
    // Map: número do computador -> [{ aluno_id, nome }, ...]
    mapa: new Map(),
    qtd: 0,
    porMaquina: 2,
    // seleção pendente: o aluno tocado ({ chave, aluno_id, nome }) ou o número
    // da máquina tocada — nunca os dois, porque o segundo toque já senta
    alunoEscolhido: null,
    maquinaAlvo: null,
    carregada: false,
};

/**
 * Chave estável de um ocupante.
 *
 * Quase sempre é o id do aluno. O nome solto existe para o registro antigo de
 * quem saiu da escola: o cadastro sumiu, mas o histórico guardou o nome, e ele
 * continua editável sem virar um aluno novo.
 */
function chaveDoOcupante(ocupante) {
    return ocupante.aluno_id ? `a${ocupante.aluno_id}` : `n:${textoComparavel(ocupante.nome)}`;
}

/**
 * Texto sem acento, sem caixa e sem espaço repetido, para buscar e comparar
 * nomes. É o mesmo tratamento do `chave_de_nome` do `banco.py`: os dois lados
 * precisam concordar sobre quando dois nomes são a mesma pessoa.
 */
function textoComparavel(texto) {
    return String(texto || '')
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase().split(/\s+/).filter(Boolean).join(' ');
}

/** Todos os ocupantes sentados agora, com o número da máquina de cada um. */
function ocupantesAlocados() {
    const lista = [];
    alocacao.mapa.forEach((ocupantes, maquina) => {
        ocupantes.forEach((ocupante) => lista.push({ ...ocupante, maquina }));
    });
    return lista;
}

function ondeEstaOcupante(chave) {
    const achado = ocupantesAlocados().find((item) => chaveDoOcupante(item) === chave);
    return achado ? achado.maquina : null;
}

/*
 * Trocar para a aba e o atalho de "Minhas aulas" pedem a lista ao mesmo tempo:
 * quem chega primeiro busca, o segundo espera a mesma resposta. Sem isso as
 * duas respostas remontariam o seletor uma sobre a outra e a aula escolhida
 * pelo atalho se perderia.
 */
let listaDeAulasEmCurso = null;

function carregarAulasParaAlocacao() {
    if (!listaDeAulasEmCurso) {
        listaDeAulasEmCurso = buscarAulasParaAlocacao()
            .finally(() => { listaDeAulasEmCurso = null; });
    }
    return listaDeAulasEmCurso;
}

async function buscarAulasParaAlocacao() {
    const seletor = document.getElementById('alocacaoAula');
    const aviso = document.getElementById('alocacaoAviso');

    try {
        const [reservas, registros] = await Promise.all([
            API.get('/api/minhas-reservas'),
            API.get('/api/meus-registros-computadores'),
        ]);
        alocacao.registros = registros || {};
        alocacao.reservas = reservas.filter((reserva) => reserva.status !== 'cancelada');
    } catch (falha) {
        aviso.classList.remove('oculto');
        aviso.innerHTML = `<div>${escapar(falha.message)}</div>`;
        return;
    }

    alocacao.carregada = true;
    if (!alocacao.reservas.length) {
        seletor.innerHTML = '<option value="">Nenhuma aula reservada</option>';
        aviso.classList.remove('oculto');
        aviso.innerHTML = `<div><strong>Você ainda não tem aulas no laboratório</strong>
            Reserve uma aula em <strong>Reservar</strong> e ela aparece aqui para
            você registrar os computadores.</div>`;
        document.getElementById('alocacaoPainel').classList.add('oculto');
        return;
    }

    const hoje = hojeISO();
    const grupos = [
        ['Hoje', alocacao.reservas.filter((r) => r.data === hoje)],
        ['Aulas que já aconteceram', alocacao.reservas
            .filter((reserva) => reserva.data < hoje)
            .sort((a, b) => b.data.localeCompare(a.data))],
        ['Próximas aulas', alocacao.reservas
            .filter((reserva) => reserva.data > hoje)
            .sort((a, b) => a.data.localeCompare(b.data))],
    ];

    seletor.innerHTML = '<option value="">Escolha a aula…</option>'
        + grupos.filter(([, itens]) => itens.length).map(([titulo, itens]) => `
            <optgroup label="${escapar(titulo)}">
                ${itens.map((reserva) => `
                    <option value="${reserva.id}">
                        ${escapar(rotuloDaAula(reserva))}
                    </option>`).join('')}
            </optgroup>`).join('');

    if (alocacao.reservaId) seletor.value = String(alocacao.reservaId);
}

function rotuloDaAula(reserva) {
    const registro = alocacao.registros[reserva.id];
    const marca = registro ? ' ✓ registrada' : '';
    return `${dataBR(reserva.data)} · ${reserva.inicio} · ${reserva.laboratorio_nome}`
         + `${reserva.disciplina ? ` · ${reserva.disciplina}` : ''}${marca}`;
}

/** Abre a aba de computadores já na aula pedida (atalho de “Minhas aulas”). */
async function irParaComputadoresDaAula(reservaId) {
    alocacao.reservaId = reservaId;
    irParaAba('computadores');
    if (!alocacao.carregada) await carregarAulasParaAlocacao();
    document.getElementById('alocacaoAula').value = String(reservaId);
    await abrirAlocacaoDaAula(reservaId);
}

async function aoTrocarAulaDaAlocacao() {
    const valor = document.getElementById('alocacaoAula').value;
    if (!valor) {
        alocacao.reservaId = null;
        document.getElementById('alocacaoPainel').classList.add('oculto');
        return;
    }
    await abrirAlocacaoDaAula(Number(valor));
}

async function abrirAlocacaoDaAula(reservaId) {
    const painel = document.getElementById('alocacaoPainel');
    const aviso = document.getElementById('alocacaoAviso');
    aviso.classList.add('oculto');

    let dados;
    try {
        dados = await API.get(`/api/aulas/${reservaId}/computadores`);
    } catch (falha) {
        painel.classList.add('oculto');
        aviso.classList.remove('oculto');
        aviso.innerHTML = `<div>${escapar(falha.message)}</div>`;
        return;
    }

    alocacao.reservaId = reservaId;
    alocacao.dados = dados;
    alocacao.alunos = dados.alunos || [];
    alocacao.turmas = dados.turmas || [];
    alocacao.qtd = dados.qtd_computadores || 0;
    alocacao.porMaquina = dados.alunos_por_computador || 2;
    alocacao.alunoEscolhido = null;
    alocacao.maquinaAlvo = null;

    alocacao.mapa = new Map();
    (dados.computadores || []).forEach((maquina) => {
        if (maquina.alunos.length) {
            alocacao.mapa.set(maquina.numero, maquina.alunos.map((ocupante) => ({
                aluno_id: ocupante.aluno_id, nome: ocupante.aluno_nome,
            })));
        }
    });

    montarSeletorDeTurma(dados.turma);
    document.getElementById('alocacaoQtd').max = dados.max_computadores || 60;
    document.getElementById('alocacaoQtd').value = alocacao.qtd || '';
    document.getElementById('alocacaoObservacao').value =
        (dados.sessao && dados.sessao.observacao) || '';
    document.getElementById('botaoExcluirAlocacao')
        .classList.toggle('oculto', !dados.sessao);
    document.getElementById('buscaAlunoAlocacao').value = '';

    painel.classList.remove('oculto');
    mostrarAvisoDaAula(dados);
    desenharAlocacao();
}

/** Explica o estado da aula antes de o professor começar a distribuir. */
function mostrarAvisoDaAula(dados) {
    const aviso = document.getElementById('alocacaoAviso');
    const reserva = dados.reserva;
    const partes = [];

    if (dados.sessao) {
        partes.push(`<strong>Aula já registrada</strong> em
            ${escapar(dataHoraBR(dados.sessao.registrado_em))}. Alterar e salvar de novo
            corrige o registro — não cria outro.`);
    }
    if (!dados.turma) {
        partes.push('A grade não diz qual turma você tem nesse horário: '
            + 'escolha a turma acima.');
    } else if (!dados.alunos.length) {
        partes.push(`A turma <strong>${escapar(dados.turma)}</strong> ainda não tem alunos
            cadastrados. Peça à coordenação para cadastrar a lista em
            <strong>Alunos</strong>.`);
    }
    if (!dados.qtd_computadores) {
        partes.push(`<strong>${escapar(reserva.laboratorio_nome)}</strong> não tem
            computadores cadastrados. Diga abaixo quantas máquinas você usou.`);
    }

    aviso.classList.toggle('oculto', !partes.length);
    aviso.innerHTML = partes.map((parte) => `<div>${parte}</div>`).join('');
}

function montarSeletorDeTurma(turmaAtual) {
    const seletor = document.getElementById('alocacaoTurma');
    // a turma do registro antigo pode não estar mais na lista (a última aula
    // daquela turma saiu do cadastro); mesmo assim ela precisa continuar
    // selecionável, senão o professor perderia o registro ao salvar de novo
    const turmas = [...new Set([...alocacao.turmas, turmaAtual].filter(Boolean))];

    seletor.disabled = false;
    seletor.innerHTML = '<option value="">Sem turma definida</option>'
        + turmas.map((turma) => `
            <option value="${escapar(turma)}"
                ${turma === turmaAtual ? 'selected' : ''}>${escapar(turma)}</option>`).join('');
}

async function aoTrocarTurmaDaAlocacao() {
    const turma = document.getElementById('alocacaoTurma').value;

    if (ocupantesAlocados().length) {
        const trocar = await confirmarTrocaDeTurma();
        if (!trocar) {
            document.getElementById('alocacaoTurma').value = alocacao.dados.turma || '';
            return;
        }
    }

    alocacao.mapa = new Map();
    alocacao.alunoEscolhido = null;
    alocacao.maquinaAlvo = null;
    alocacao.dados.turma = turma;

    try {
        const resposta = turma
            ? await API.get(`/api/alunos?turma=${encodeURIComponent(turma)}`)
            : { alunos: [] };
        alocacao.alunos = resposta.alunos || [];
        alocacao.dados.alunos = alocacao.alunos;
    } catch (falha) {
        notificar(falha.message, 'erro');
        alocacao.alunos = [];
    }

    mostrarAvisoDaAula(alocacao.dados);
    desenharAlocacao();
}

/**
 * Pergunta antes de jogar fora a distribuição já feita.
 *
 * Fechar a janela pelo ✕, pelo fundo ou pelo Esc conta como desistir: quem
 * avisa é o observador, já que `abrirModal` só chama de volta na confirmação.
 */
function confirmarTrocaDeTurma() {
    return new Promise((resolver) => {
        const area = document.getElementById('areaModal');
        const observador = new MutationObserver(() => {
            if (area.querySelector('.fundo-modal')) return;
            observador.disconnect();
            resolver(false);
        });

        abrirModal({
            titulo: 'Trocar a turma',
            subtitulo: 'A distribuição feita até agora é para a turma anterior.',
            corpo: '<p>Ao trocar de turma, os computadores voltam a ficar vazios. '
                 + 'Continuar?</p>',
            textoCancelar: 'Voltar',
            textoConfirmar: 'Sim, trocar',
            aoConfirmar: () => { observador.disconnect(); resolver(true); },
        });
        observador.observe(area, { childList: true });
    });
}

/* ---- Desenho ---- */

function desenharAlocacao() {
    desenharAlunosDaTurma();
    desenharComputadores();
    atualizarContagensDaAlocacao();
}

/**
 * A ficha do aluno em uma linha, para o balao do chip.
 *
 * Fica no `title` e nao na tela: a lista da alocacao e uma grade de nomes, e
 * matricula e nascimento so servem quando o professor precisa conferir de quem
 * se trata (dois alunos de mesmo nome na turma, por exemplo).
 */
function fichaDoAluno(aluno) {
    const partes = [];
    if (aluno.matricula) partes.push(`matrícula ${aluno.matricula}`);
    if (aluno.data_nascimento) {
        const [ano, mes, dia] = aluno.data_nascimento.split('-');
        partes.push(`nasc. ${dia}/${mes}/${ano}`);
    }
    return partes.length ? `\n${partes.join(' · ')}` : '';
}

function desenharAlunosDaTurma() {
    const area = document.getElementById('listaAlunosTurma');
    const busca = textoComparavel(document.getElementById('buscaAlunoAlocacao').value);

    // quem está sentado mas não vem mais do cadastro (registro antigo de aluno
    // excluído) continua na lista, senão o professor não teria como tirá-lo
    const soltos = ocupantesAlocados()
        .filter((ocupante) => !ocupante.aluno_id)
        .map((ocupante) => ({ id: null, nome: ocupante.nome, numero: null }));
    const todos = [...alocacao.alunos, ...soltos];

    if (!todos.length) {
        area.innerHTML = `<div class="lista-vazia" style="padding:22px 12px">
            Escolha uma turma com alunos cadastrados.</div>`;
        return;
    }

    const visiveis = todos.filter((aluno) => !busca
        || textoComparavel(aluno.nome).includes(busca)
        || String(aluno.numero || '') === busca);

    if (!visiveis.length) {
        area.innerHTML = `<div class="lista-vazia" style="padding:22px 12px">
            Nenhum aluno com esse nome.</div>`;
        return;
    }

    area.innerHTML = visiveis.map((aluno) => {
        const chave = chaveDoOcupante({ aluno_id: aluno.id, nome: aluno.nome });
        const maquina = ondeEstaOcupante(chave);
        const escolhido = alocacao.alunoEscolhido
            && alocacao.alunoEscolhido.chave === chave;
        const classes = ['aluno-chip'];
        if (maquina) classes.push('aluno-chip--alocado');
        if (escolhido) classes.push('aluno-chip--escolhido');

        const acao = maquina ? `Tirar do computador ${maquina}` : 'Escolher aluno';
        return `
            <button type="button" class="${classes.join(' ')}" data-aluno="${escapar(chave)}"
                    data-nome="${escapar(aluno.nome)}"
                    ${aluno.id ? `data-id="${aluno.id}"` : ''}
                    title="${escapar(`${acao}${fichaDoAluno(aluno)}`)}">
                <span class="aluno-chip__numero">${aluno.numero || '–'}</span>
                <span class="aluno-chip__nome">${escapar(aluno.nome)}</span>
                ${maquina ? `<span class="aluno-chip__onde">PC ${maquina}</span>` : ''}
            </button>`;
    }).join('');
}

const ICONE_MAQUINA = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
    aria-hidden="true"><rect x="2.5" y="4" width="19" height="12" rx="2"/>
    <path d="M8 20h8M10.5 16l-.5 4M13.5 16l.5 4"/></svg>`;

function desenharComputadores() {
    const area = document.getElementById('listaComputadores');
    if (!alocacao.qtd) {
        area.innerHTML = `<div class="lista-vazia" style="padding:22px 12px">
            Diga quantos computadores esta aula usou.</div>`;
        return;
    }

    let html = '';
    for (let numero = 1; numero <= alocacao.qtd; numero += 1) {
        const ocupantes = alocacao.mapa.get(numero) || [];
        const cheia = ocupantes.length >= alocacao.porMaquina;
        const classes = ['maquina'];
        if (cheia) classes.push('maquina--cheia');
        if (alocacao.maquinaAlvo === numero) classes.push('maquina--alvo');

        const cadeiras = [];
        for (let posicao = 0; posicao < alocacao.porMaquina; posicao += 1) {
            const ocupante = ocupantes[posicao];
            cadeiras.push(ocupante
                ? `<button type="button" class="cadeira"
                           data-tirar="${escapar(chaveDoOcupante(ocupante))}"
                           title="Tirar ${escapar(ocupante.nome)} deste computador">
                       ${escapar(primeiroENome(ocupante.nome))}
                   </button>`
                : '<span class="cadeira cadeira--livre">Livre</span>');
        }

        html += `
            <div class="${classes.join(' ')}" data-maquina="${numero}"
                 role="button" tabindex="0"
                 aria-label="Computador ${numero}, ${ocupantes.length} de ${alocacao.porMaquina}">
                <div class="maquina__topo">
                    <span class="maquina__numero">${ICONE_MAQUINA}${numero}</span>
                    <span class="maquina__lotacao">${ocupantes.length}/${alocacao.porMaquina}</span>
                </div>
                ${cadeiras.join('')}
            </div>`;
    }
    area.innerHTML = html;
}

/** "Ana Beatriz Moraes Silva" -> "Ana B. Silva": cabe na cadeira sem cortar. */
function primeiroENome(nome) {
    const partes = String(nome || '').trim().split(/\s+/).filter(Boolean);
    if (partes.length <= 2) return partes.join(' ');
    return `${partes[0]} ${partes[1][0]}. ${partes[partes.length - 1]}`;
}

function atualizarContagensDaAlocacao() {
    const alocados = ocupantesAlocados().length;
    const totalTurma = alocacao.alunos.length;
    const usados = [...alocacao.mapa.values()].filter((lista) => lista.length).length;

    document.getElementById('alocacaoContagem').textContent =
        `${alocados} aluno${alocados === 1 ? '' : 's'} em ${usados} `
        + `computador${usados === 1 ? '' : 'es'}`;

    const faltam = Math.max(0, totalTurma - alocados);
    document.getElementById('alocacaoRestantes').textContent = totalTurma
        ? `${faltam} sem lugar`
        : '—';

    document.getElementById('alocacaoLegenda').textContent = alocacao.qtd
        ? `${alocacao.qtd - usados} máquina(s) livre(s) de ${alocacao.qtd}`
        : '';
}

/* ---- Interação ---- */

function aoClicarAlunoDaTurma(evento) {
    const botao = evento.target.closest('[data-aluno]');
    if (!botao) return;

    const chave = botao.dataset.aluno;
    const maquina = ondeEstaOcupante(chave);

    // aluno já sentado: o clique tira ele da máquina
    if (maquina !== null) {
        tirarDaMaquina(chave);
        return;
    }

    const ocupante = {
        chave,
        aluno_id: botao.dataset.id ? Number(botao.dataset.id) : null,
        nome: botao.dataset.nome,
    };

    // máquina escolhida antes: senta direto, sem passo intermediário
    if (alocacao.maquinaAlvo !== null) {
        sentar(alocacao.maquinaAlvo, ocupante);
        return;
    }

    const jaEstava = alocacao.alunoEscolhido && alocacao.alunoEscolhido.chave === chave;
    alocacao.alunoEscolhido = jaEstava ? null : ocupante;
    desenharAlocacao();
}

function aoClicarComputador(evento) {
    const cadeira = evento.target.closest('[data-tirar]');
    if (cadeira) {
        tirarDaMaquina(cadeira.dataset.tirar);
        return;
    }

    const maquina = evento.target.closest('[data-maquina]');
    if (!maquina) return;
    const numero = Number(maquina.dataset.maquina);

    // aluno escolhido antes: senta nesta máquina
    if (alocacao.alunoEscolhido) {
        sentar(numero, alocacao.alunoEscolhido);
        return;
    }

    const ocupantes = alocacao.mapa.get(numero) || [];
    if (ocupantes.length >= alocacao.porMaquina) {
        notificar(`O computador ${numero} já está com ${alocacao.porMaquina} alunos.`, 'erro');
        return;
    }
    alocacao.maquinaAlvo = alocacao.maquinaAlvo === numero ? null : numero;
    desenharAlocacao();
}

function sentar(numero, ocupante) {
    const ocupantes = alocacao.mapa.get(numero) || [];
    if (ocupantes.length >= alocacao.porMaquina) {
        notificar(`O computador ${numero} já está com ${alocacao.porMaquina} alunos.`, 'erro');
        return;
    }
    alocacao.mapa.set(numero, [...ocupantes, {
        aluno_id: ocupante.aluno_id, nome: ocupante.nome,
    }]);
    alocacao.alunoEscolhido = null;
    alocacao.maquinaAlvo = null;
    desenharAlocacao();
}

function tirarDaMaquina(chave) {
    alocacao.mapa.forEach((ocupantes, numero) => {
        const restantes = ocupantes.filter((item) => chaveDoOcupante(item) !== chave);
        if (restantes.length) alocacao.mapa.set(numero, restantes);
        else alocacao.mapa.delete(numero);
    });
    alocacao.alunoEscolhido = null;
    alocacao.maquinaAlvo = null;
    desenharAlocacao();
}

/**
 * Enche as máquinas na ordem da chamada, dois a dois.
 *
 * Respeita quem já está sentado: só distribui quem sobrou, nas vagas que
 * sobraram — assim dá para começar à mão e deixar o resto para o botão.
 */
function formarDuplas() {
    if (!alocacao.qtd) {
        notificar('Diga quantos computadores esta aula usou.', 'erro');
        return;
    }

    const jaSentados = new Set(ocupantesAlocados().map(chaveDoOcupante));
    const fila = alocacao.alunos
        .map((aluno) => ({ aluno_id: aluno.id, nome: aluno.nome }))
        .filter((ocupante) => !jaSentados.has(chaveDoOcupante(ocupante)));

    for (let numero = 1; numero <= alocacao.qtd && fila.length; numero += 1) {
        const ocupantes = alocacao.mapa.get(numero) || [];
        while (ocupantes.length < alocacao.porMaquina && fila.length) {
            ocupantes.push(fila.shift());
        }
        if (ocupantes.length) alocacao.mapa.set(numero, ocupantes);
    }
    const sobraram = fila.length;

    alocacao.alunoEscolhido = null;
    alocacao.maquinaAlvo = null;
    desenharAlocacao();

    if (sobraram) {
        notificar(`${sobraram} aluno(s) ficaram sem lugar: as ${alocacao.qtd} `
            + 'máquinas encheram.', 'erro');
    } else {
        notificar('Turma distribuída pelos computadores.');
    }
}

function limparAlocacao() {
    if (!ocupantesAlocados().length) return;
    alocacao.mapa = new Map();
    alocacao.alunoEscolhido = null;
    alocacao.maquinaAlvo = null;
    desenharAlocacao();
}

function mudarQtdComputadores() {
    const campo = document.getElementById('alocacaoQtd');
    const maximo = Number(campo.max) || 60;
    const valor = Math.max(0, Math.min(maximo, Number(campo.value) || 0));
    campo.value = valor || '';
    alocacao.qtd = valor;

    // encolher o laboratório não pode deixar aluno sentado numa máquina que
    // não existe mais: quem estava além do novo limite volta para a lista
    [...alocacao.mapa.keys()]
        .filter((numero) => numero > valor)
        .forEach((numero) => alocacao.mapa.delete(numero));

    if (alocacao.maquinaAlvo > valor) alocacao.maquinaAlvo = null;
    desenharAlocacao();
}

/* ---- Gravação ---- */

async function salvarAlocacao() {
    if (!alocacao.reservaId) return;
    const salvar = botoes('salvarAlocacao');

    const alocacoes = [...alocacao.mapa.entries()]
        .filter(([, ocupantes]) => ocupantes.length)
        .map(([computador, ocupantes]) => ({
            computador,
            alunos: ocupantes.map((ocupante) => ({
                aluno_id: ocupante.aluno_id, nome: ocupante.nome,
            })),
        }));

    if (!alocacoes.length) {
        notificar('Coloque pelo menos um aluno em um computador.', 'erro');
        return;
    }

    salvar.forEach((botao) => {
        botao.disabled = true;
        botao.textContent = 'Salvando…';
    });
    try {
        const resposta = await API.post(`/api/aulas/${alocacao.reservaId}/computadores`, {
            turma: document.getElementById('alocacaoTurma').value,
            qtd_computadores: alocacao.qtd,
            observacao: document.getElementById('alocacaoObservacao').value,
            alocacoes,
        });
        notificar(resposta.novo
            ? 'Aula registrada no histórico do laboratório.'
            : 'Registro da aula atualizado.');
        await carregarAulasParaAlocacao();
        await abrirAlocacaoDaAula(alocacao.reservaId);
        carregarMinhasReservas();
    } catch (falha) {
        notificar(falha.message, 'erro');
    } finally {
        salvar.forEach((botao) => {
            botao.disabled = false;
            botao.textContent = 'Salvar registro da aula';
        });
    }
}

function excluirAlocacao() {
    const reservaId = alocacao.reservaId;
    if (!reservaId) return;

    abrirModal({
        titulo: 'Excluir o registro desta aula',
        subtitulo: 'A alocação sai do histórico que a gestão acompanha.',
        corpo: '<p>A reserva da aula continua como está — some apenas o registro '
             + 'de quem sentou em cada computador. Tem certeza?</p>',
        textoCancelar: 'Voltar',
        textoConfirmar: 'Sim, excluir',
        perigo: true,
        aoConfirmar: async () => {
            try {
                await API.del(`/api/aulas/${reservaId}/computadores`);
            } catch (falha) {
                notificar(falha.message, 'erro');
                return false;
            }
            notificar('Registro excluído.');
            await carregarAulasParaAlocacao();
            await abrirAlocacaoDaAula(reservaId);
            return true;
        },
    });
}

/* ------------------------------------------------------------------ */
/* Projetos no intervalo                                               */
/* ------------------------------------------------------------------ */
/*
 * A reserva do intervalo tem uma diferença que muda a tela inteira: a hora não
 * se escolhe. Ela sai da própria grade da escola (o vão de uma hora depois da
 * 5ª aula) e ocupa 50 minutos fixos dali. Por isso o formulário não tem
 * seletor de horário — ele mostra a janela e pede só o laboratório, a data e o
 * nome do projeto.
 *
 * O registro dos computadores também é diferente do da aula comum: o grupo do
 * projeto mistura turmas, então não existe "lista da turma" para tocar. O aluno
 * entra pela matrícula, que é o que o professor tem na mão no laboratório.
 */

const projetos = {
    janela: null,          // a janela vigente (turno, início, fim, duração)
    janelas: [],
    nomePadrao: 'Elaboração de Projetos',
    lista: [],
    escopo: 'meus',        // 'meus' ou 'escola'
    carregada: false,
    // registro aberto no painel de execução
    atual: null,
    // Map: número do computador -> [{ aluno_id, nome, matricula }, ...]
    mapa: new Map(),
    qtd: 0,
    porMaquina: 2,
    // a lista da turma escolhida no painel: o projeto do intervalo recebe
    // alunos de várias turmas, então a turma aqui é só a lista que está aberta
    // no momento — trocar de turma nunca mexe no `mapa`
    turmas: [],
    turma: '',
    alunosTurma: [],
    // o vaivém de sentar: o aluno tocado esperando a máquina, ou a máquina
    // tocada esperando o aluno — nunca os dois ao mesmo tempo
    alunoEscolhido: null,
    maquinaAlvo: null,
};

async function carregarProjetos(recarregarJanela = false) {
    if (recarregarJanela || !projetos.janela) await carregarJanelaDoIntervalo();
    await carregarListaDeProjetos();
    projetos.carregada = true;
}

async function carregarJanelaDoIntervalo() {
    let dados;
    try {
        dados = await API.get('/api/projetos/janela');
    } catch (falha) {
        notificar(falha.message, 'erro');
        return;
    }

    projetos.janelas = dados.janelas || [];
    projetos.janela = projetos.janelas.find((j) => j.cabe) || projetos.janelas[0] || null;
    projetos.nomePadrao = dados.nome_padrao || projetos.nomePadrao;

    document.getElementById('projetoLaboratorio').innerHTML = estado.laboratorios
        .map((lab) => `<option value="${lab.id}">${escapar(lab.nome)}</option>`).join('');

    const campoData = document.getElementById('projetoData');
    campoData.min = hojeISO();
    campoData.max = somarDias(hojeISO(), dados.antecedencia_maxima_dias || 30);
    if (!campoData.value) campoData.value = hojeISO();

    const campoNome = document.getElementById('projetoNome');
    campoNome.placeholder = projetos.nomePadrao;
    if (!campoNome.value) campoNome.value = projetos.nomePadrao;

    // o seletor de turno só aparece quando a escola tem mais de um intervalo
    const campoTurno = document.getElementById('campoProjetoTurno');
    const seletorTurno = document.getElementById('projetoTurno');
    campoTurno.classList.toggle('oculto', projetos.janelas.length < 2);
    seletorTurno.innerHTML = projetos.janelas.map((j) => `
        <option value="${escapar(j.turno)}">
            ${ROTULO_TURNO[j.turno] || j.turno} · ${escapar(j.inicio)}–${escapar(j.fim)}
        </option>`).join('');
    if (projetos.janela) seletorTurno.value = projetos.janela.turno;

    desenharJanelaDoIntervalo();
    aplicarBloqueioDeProjeto();
}

/** O cartão que explica onde fica o intervalo e quanto dura a reserva. */
function desenharJanelaDoIntervalo() {
    const area = document.getElementById('projetoJanela');
    const janela = projetos.janela;

    if (!janela) {
        area.innerHTML = `
            <div class="aviso aviso--atencao"><div>
                <strong>A escola ainda não tem a 5ª aula na grade de horários.</strong>
                Sem ela o sistema não sabe onde fica o intervalo. Peça à coordenação
                para cadastrar os horários em <em>Horários</em>.
            </div></div>`;
        document.getElementById('botaoReservarProjeto').disabled = true;
        return;
    }

    document.getElementById('botaoReservarProjeto').disabled = !janela.cabe;

    if (!janela.cabe) {
        area.innerHTML = `
            <div class="aviso aviso--atencao"><div>
                <strong>O intervalo depois da ${janela.aula_referencia}ª aula tem só
                ${janela.livre} minutos</strong> (${escapar(janela.inicio)}–${escapar(janela.fim_intervalo)}),
                e a reserva precisa de ${janela.duracao}. A coordenação precisa
                ajustar os horários da escola.
            </div></div>`;
        return;
    }

    area.innerHTML = `
        <div class="janela-intervalo__hora">
            <span class="rotulo-pequeno">Intervalo reservável</span>
            <strong>${escapar(janela.inicio)} – ${escapar(janela.fim)}</strong>
            <span class="texto-suave">${janela.duracao} minutos fixos</span>
        </div>
        <div class="janela-intervalo__detalhe">
            <span class="rotulo-pequeno">De onde vem</span>
            <p>Depois da <strong>${janela.aula_referencia}ª aula</strong> do turno da
               ${(ROTULO_TURNO[janela.turno] || janela.turno).toLowerCase()}, que termina
               às ${escapar(janela.aula_termina)}. O intervalo inteiro vai até
               ${escapar(janela.fim_intervalo)} — os ${janela.intervalo - janela.duracao}
               minutos que sobram são para a turma entrar e sair.</p>
        </div>`;
}

/** Quem administra o sistema não reserva — a mesma regra da aula comum. */
function aplicarBloqueioDeProjeto() {
    const aviso = document.getElementById('projetoAvisoGestor');
    const formulario = document.getElementById('formProjeto');
    formulario.classList.toggle('oculto', estado.administra);
    aviso.classList.toggle('oculto', !estado.administra);
    if (estado.administra) {
        aviso.innerHTML = `<div><strong>Você administra o sistema</strong>
            ${escapar(AVISO_ADMINISTRA)} As reservas de projeto da escola continuam
            abaixo, e você as organiza pelo painel do gestor.</div>`;
        projetos.escopo = 'escola';
        document.querySelectorAll('#filtroProjetos .alternador__item').forEach((item) => {
            item.classList.toggle('alternador__item--ativo',
                item.dataset.escopo === 'escola');
        });
    }
}

async function carregarListaDeProjetos() {
    const area = document.getElementById('listaProjetos');
    area.innerHTML = '<div class="lista-vazia"><span class="carregando"></span></div>';

    const parametros = new URLSearchParams({ de: somarDias(hojeISO(), -60) });
    if (projetos.escopo === 'meus') parametros.set('meus', '1');

    try {
        const resposta = await API.get(`/api/projetos?${parametros}`);
        projetos.lista = resposta.projetos || [];
    } catch (falha) {
        area.innerHTML = `<div class="lista-vazia">${escapar(falha.message)}</div>`;
        return;
    }
    desenharListaDeProjetos();
}

function desenharListaDeProjetos() {
    const area = document.getElementById('listaProjetos');
    if (!projetos.lista.length) {
        area.innerHTML = `
            <div class="lista-vazia">
                <strong>Nenhuma reserva de projeto</strong>
                ${projetos.escopo === 'meus'
                    ? 'Reserve o intervalo no formulário acima.'
                    : 'Ninguém da escola reservou o intervalo nesse período.'}
            </div>`;
        return;
    }

    area.innerHTML = projetos.lista.map((projeto) => {
        const registrado = Boolean(projeto.sessao_id);
        const dia = paraData(projeto.data);
        return `
        <div class="item-reserva item-reserva--${escapar(projeto.status)}">
            <div class="item-reserva__data">
                <strong>${String(dia.getDate()).padStart(2, '0')}</strong>
                <span>${MESES[dia.getMonth()]}</span>
            </div>
            <div class="item-reserva__corpo">
                <strong>${escapar(projeto.projeto)}</strong>
                <p>${escapar(projeto.laboratorio_nome)} ·
                   <span class="mono">${escapar(projeto.inicio)}–${escapar(projeto.fim)}</span> ·
                   ${escapar(DIAS_SEMANA[dia.getDay()])}</p>
                <p class="texto-suave">
                    ${projeto.meu ? 'Você é o responsável'
                                  : `Responsável: ${escapar(projeto.professor_nome)}`}
                    ${registrado
                        ? ` · ${projeto.total_alunos} aluno(s) em
                            ${projeto.computadores_usados} computador(es)`
                        : ''}
                    ${projeto.observacao
                        ? ` · ${escapar(projeto.observacao)}` : ''}
                </p>
            </div>
            <div class="item-reserva__acoes">
                ${selo(projeto.status)}
                ${projeto.posso_editar && projeto.status !== 'cancelada' ? `
                    <button class="botao botao--pequeno" data-registrar="${projeto.id}">
                        ${registrado ? 'Ver computadores' : 'Registrar computadores'}
                    </button>
                    <button class="botao botao--pequeno botao--vazio"
                            data-editar-projeto="${projeto.id}">Editar</button>
                    <button class="botao botao--pequeno botao--perigo"
                            data-cancelar-projeto="${projeto.id}">Cancelar</button>`
                : registrado ? `
                    <button class="botao botao--pequeno botao--vazio"
                            data-registrar="${projeto.id}">Ver computadores</button>` : ''}
            </div>
        </div>`;
    }).join('');
}

async function enviarProjeto(evento) {
    evento.preventDefault();
    const erro = document.getElementById('erroProjeto');
    const botao = document.getElementById('botaoReservarProjeto');
    mostrarErro(erro, '');

    const turno = projetos.janelas.length > 1
        ? document.getElementById('projetoTurno').value
        : (projetos.janela && projetos.janela.turno) || '';

    const corpo = {
        laboratorio_id: Number(document.getElementById('projetoLaboratorio').value),
        data: document.getElementById('projetoData').value,
        turno,
        projeto: document.getElementById('projetoNome').value.trim() || projetos.nomePadrao,
        observacao: document.getElementById('projetoObservacao').value.trim(),
    };

    botao.disabled = true;
    try {
        const resposta = await API.post('/api/projetos', corpo);
        notificar(`Intervalo reservado: ${resposta.inicio}–${resposta.fim}.`, 'sucesso');
        document.getElementById('projetoNome').value = projetos.nomePadrao;
        document.getElementById('projetoObservacao').value = '';
        projetos.escopo = 'meus';
        document.querySelectorAll('#filtroProjetos .alternador__item').forEach((item) => {
            item.classList.toggle('alternador__item--ativo', item.dataset.escopo === 'meus');
        });
        await carregarListaDeProjetos();
    } catch (falha) {
        mostrarErro(erro, falha.message, falha.dados && falha.dados.erros);
    } finally {
        botao.disabled = false;
    }
}

function aoClicarEmProjeto(evento) {
    const registrar = evento.target.closest('[data-registrar]');
    if (registrar) return abrirRegistroDoProjeto(Number(registrar.dataset.registrar));

    const editar = evento.target.closest('[data-editar-projeto]');
    if (editar) return editarProjeto(Number(editar.dataset.editarProjeto));

    const cancelar = evento.target.closest('[data-cancelar-projeto]');
    if (cancelar) return cancelarProjeto(Number(cancelar.dataset.cancelarProjeto));
    return undefined;
}

function editarProjeto(projetoId) {
    const projeto = projetos.lista.find((item) => item.id === projetoId);
    if (!projeto) return;

    const modal = abrirModal({
        titulo: 'Editar a reserva',
        subtitulo: `${projeto.laboratorio_nome} · ${dataBR(projeto.data)} · `
                 + `${projeto.inicio}–${projeto.fim}`,
        corpo: `
            <div class="campo">
                <label for="editProjetoNome">Nome do projeto ou evento</label>
                <input type="text" id="editProjetoNome" maxlength="120"
                       value="${escapar(projeto.projeto)}">
            </div>
            <div class="linha-campos linha-campos--2">
                <div class="campo">
                    <label for="editProjetoLab">Laboratório</label>
                    <select id="editProjetoLab">
                        ${estado.laboratorios.map((lab) => `
                            <option value="${lab.id}"
                                ${lab.id === projeto.laboratorio_id ? 'selected' : ''}>
                                ${escapar(lab.nome)}</option>`).join('')}
                    </select>
                </div>
                <div class="campo">
                    <label for="editProjetoData">Data</label>
                    <input type="date" id="editProjetoData"
                           value="${escapar(projeto.data)}" min="${hojeISO()}">
                </div>
            </div>
            <div class="campo">
                <label for="editProjetoObs">Observação</label>
                <input type="text" id="editProjetoObs" maxlength="400"
                       value="${escapar(projeto.observacao || '')}">
            </div>
            <div id="erroEditProjeto" class="aviso aviso--erro oculto"></div>`,
        textoConfirmar: 'Salvar',
        aoConfirmar: async (janela) => {
            const erro = janela.querySelector('#erroEditProjeto');
            mostrarErro(erro, '');
            try {
                await API.put(`/api/projetos/${projetoId}`, {
                    projeto: janela.querySelector('#editProjetoNome').value.trim(),
                    laboratorio_id: Number(janela.querySelector('#editProjetoLab').value),
                    data: janela.querySelector('#editProjetoData').value,
                    observacao: janela.querySelector('#editProjetoObs').value.trim(),
                });
            } catch (falha) {
                mostrarErro(erro, falha.message, falha.dados && falha.dados.erros);
                return false;
            }
            notificar('Reserva atualizada.', 'sucesso');
            await carregarListaDeProjetos();
            return true;
        },
    });
    return modal;
}

function cancelarProjeto(projetoId) {
    const projeto = projetos.lista.find((item) => item.id === projetoId);
    if (!projeto) return;

    abrirModal({
        titulo: 'Cancelar a reserva',
        subtitulo: `${projeto.projeto} · ${dataBR(projeto.data)}`,
        corpo: `<p>O intervalo volta a ficar livre para os outros professores.
                   Esta ação não pode ser desfeita.</p>`,
        textoCancelar: 'Voltar',
        textoConfirmar: 'Sim, cancelar',
        perigo: true,
        aoConfirmar: async () => {
            try {
                await API.post(`/api/projetos/${projetoId}/status`, { status: 'cancelada' });
            } catch (falha) {
                notificar(falha.message, 'erro');
                return false;
            }
            notificar('Reserva cancelada.', 'sucesso');
            if (projetos.atual && projetos.atual.projeto.id === projetoId) {
                fecharRegistroDoProjeto();
            }
            await carregarListaDeProjetos();
            return true;
        },
    });
}

/* ---- Painel de execução: os computadores do projeto ---- */

async function abrirRegistroDoProjeto(projetoId) {
    let dados;
    try {
        dados = await API.get(`/api/projetos/${projetoId}/computadores`);
    } catch (falha) {
        notificar(falha.message, 'erro');
        return;
    }

    projetos.atual = dados;
    projetos.qtd = dados.qtd_computadores || 0;
    projetos.porMaquina = dados.alunos_por_computador || 2;
    projetos.mapa = new Map();
    projetos.alunoEscolhido = null;
    projetos.maquinaAlvo = null;
    (dados.computadores || []).forEach((maquina) => {
        if (maquina.alunos.length) {
            projetos.mapa.set(maquina.numero, maquina.alunos.map((ocupante) => ({
                aluno_id: ocupante.aluno_id,
                nome: ocupante.aluno_nome,
                matricula: ocupante.aluno_matricula || '',
            })));
        }
    });

    const projeto = dados.projeto;
    document.getElementById('registroProjetoTitulo').textContent = projeto.projeto;
    document.getElementById('registroQtd').max = dados.max_computadores || 60;
    document.getElementById('registroQtd').value = projetos.qtd || '';
    document.getElementById('registroObservacao').value =
        (dados.sessao && dados.sessao.observacao) || '';
    document.getElementById('registroRetorno').textContent = '';

    const somenteLeitura = !dados.posso_registrar;
    ['registroQtd', 'registroObservacao', 'botaoLimparRegistro', 'registroTurma']
        .forEach((id) => { document.getElementById(id).disabled = somenteLeitura; });
    botoes('salvarRegistro').forEach((botao) => { botao.disabled = somenteLeitura; });
    botoes('excluirRegistro').forEach((botao) => {
        botao.classList.toggle('oculto', !dados.sessao || somenteLeitura);
    });

    const aviso = document.getElementById('registroAviso');
    const partes = [];
    partes.push(`<strong>${escapar(projeto.laboratorio_nome)}</strong> ·
        ${escapar(dataBR(projeto.data))} ·
        <span class="mono">${escapar(projeto.inicio)}–${escapar(projeto.fim)}</span> ·
        responsável: ${escapar(projeto.professor_nome)}`);
    if (dados.sessao) {
        partes.push(`Registrado em ${escapar(dataHoraBR(dados.sessao.registrado_em))}.
            Salvar de novo corrige o registro — não cria outro.`);
    }
    if (somenteLeitura) {
        partes.push('Só o professor responsável pode mexer neste registro.');
    }
    if (!projetos.qtd) {
        partes.push(`O ${escapar(projeto.laboratorio_nome)} não tem computadores
            cadastrados. Diga acima quantas máquinas o projeto usou.`);
    }
    aviso.innerHTML = partes.map((parte) => `<div>${parte}</div>`).join('');
    aviso.classList.remove('oculto');

    document.getElementById('registroProjeto').classList.remove('oculto');
    desenharRegistroDoProjeto();
    document.getElementById('registroProjeto')
        .scrollIntoView({ behavior: 'smooth', block: 'start' });

    // a lista da turma vem depois de o painel já estar na tela: ela é um apoio
    // para sentar os alunos, e esperar por ela atrasaria o resto sem motivo
    await prepararTurmasDoRegistro();
}

function fecharRegistroDoProjeto() {
    projetos.atual = null;
    document.getElementById('registroProjeto').classList.add('oculto');
}

/* ---- A lista da turma dentro do painel do projeto ---- */

/**
 * Monta o seletor de turma e recarrega a lista que estava aberta.
 *
 * O intervalo junta gente de várias turmas: o professor abre uma turma, senta
 * quem apareceu dela, abre a próxima e continua. Por isso a troca de turma só
 * troca a LISTA — os computadores ficam como estavam.
 */
async function prepararTurmasDoRegistro() {
    const seletor = document.getElementById('registroTurma');

    if (!projetos.turmas.length) {
        try {
            const resposta = await API.get('/api/turmas');
            projetos.turmas = resposta.turmas || [];
        } catch (falha) {
            projetos.turmas = [];
        }
    }

    seletor.innerHTML = '<option value="">Escolha uma turma</option>'
        + projetos.turmas.map((turma) => `
            <option value="${escapar(turma)}">${escapar(turma)}</option>`).join('');

    // a turma escolhida antes continua aberta ao reabrir o painel (salvar o
    // registro reabre esta tela, e recomeçar do zero seria um passo a mais)
    if (projetos.turma && projetos.turmas.includes(projetos.turma)) {
        seletor.value = projetos.turma;
        await carregarAlunosDaTurmaDoRegistro(projetos.turma);
    } else {
        projetos.turma = '';
        projetos.alunosTurma = [];
        document.getElementById('buscaAlunoRegistro').value = '';
        desenharAlunosDoRegistro();
    }
}

async function aoTrocarTurmaDoRegistro() {
    // de propósito não mexe em `projetos.mapa`: quem já está sentado fica
    const turma = document.getElementById('registroTurma').value;
    document.getElementById('buscaAlunoRegistro').value = '';
    await carregarAlunosDaTurmaDoRegistro(turma);
}

async function carregarAlunosDaTurmaDoRegistro(turma) {
    projetos.turma = turma;
    // o aluno escolhido some da tela junto com a lista dele: continuar com uma
    // escolha invisível faria o próximo toque em um computador sentar alguém
    // que o professor não está mais vendo. A máquina marcada fica — ela é do
    // laboratório, não da turma.
    projetos.alunoEscolhido = null;

    if (!turma) {
        projetos.alunosTurma = [];
        desenharAlunosDoRegistro();
        return;
    }

    try {
        const resposta = await API.get(`/api/alunos?turma=${encodeURIComponent(turma)}`);
        projetos.alunosTurma = resposta.alunos || [];
    } catch (falha) {
        notificar(falha.message, 'erro');
        projetos.alunosTurma = [];
    }
    desenharAlunosDoRegistro();
}

/** Em que computador está o aluno, ou `null` se ele ainda não sentou. */
function ondeEstaNoProjeto(alunoId) {
    if (!alunoId) return null;
    const achado = ocupantesDoProjeto()
        .find((ocupante) => ocupante.aluno_id === alunoId);
    return achado ? achado.maquina : null;
}

function desenharAlunosDoRegistro() {
    const area = document.getElementById('registroAlunosTurma');
    const selo = document.getElementById('registroTurmaContagem');

    if (!projetos.turma) {
        selo.textContent = '—';
        area.innerHTML = `<div class="lista-vazia" style="padding:22px 12px">
            Escolha uma turma para ver os alunos.</div>`;
        return;
    }

    const sentados = projetos.alunosTurma
        .filter((aluno) => ondeEstaNoProjeto(aluno.id) !== null).length;
    selo.textContent = `${sentados}/${projetos.alunosTurma.length} sentados`;

    if (!projetos.alunosTurma.length) {
        area.innerHTML = `<div class="lista-vazia" style="padding:22px 12px">
            A turma ${escapar(projetos.turma)} não tem alunos cadastrados.</div>`;
        return;
    }

    const busca = textoComparavel(document.getElementById('buscaAlunoRegistro').value);
    const visiveis = projetos.alunosTurma.filter((aluno) => !busca
        || textoComparavel(aluno.nome).includes(busca)
        || String(aluno.numero || '') === busca
        || String(aluno.matricula || '').includes(busca));

    if (!visiveis.length) {
        area.innerHTML = `<div class="lista-vazia" style="padding:22px 12px">
            Nenhum aluno com esse nome nesta turma.</div>`;
        return;
    }

    area.innerHTML = visiveis.map((aluno) => {
        const maquina = ondeEstaNoProjeto(aluno.id);
        const escolhido = projetos.alunoEscolhido
            && projetos.alunoEscolhido.id === aluno.id;
        const classes = ['aluno-chip'];
        if (maquina) classes.push('aluno-chip--alocado');
        if (escolhido) classes.push('aluno-chip--escolhido');

        const acao = maquina ? `Tirar do computador ${maquina}`
            : (projetos.maquinaAlvo
                ? `Sentar no computador ${projetos.maquinaAlvo}`
                : 'Escolher aluno');
        return `
            <button type="button" class="${classes.join(' ')}"
                    data-aluno-projeto="${aluno.id}"
                    title="${escapar(`${acao}${fichaDoAluno(aluno)}`)}">
                <span class="aluno-chip__numero">${aluno.numero || '–'}</span>
                <span class="aluno-chip__nome">${escapar(aluno.nome)}</span>
                ${maquina ? `<span class="aluno-chip__onde">PC ${maquina}</span>` : ''}
            </button>`;
    }).join('');
}

/**
 * O toque no aluno: escolhe quem vai sentar, senta na máquina já marcada, ou
 * tira da máquina quem já está sentado.
 *
 * Escolher e só depois tocar no computador é o mesmo caminho da aba
 * Computadores. Ali o professor já distribui a turma assim, e é a mesma
 * tarefa: dois jeitos diferentes para a mesma coisa só dariam trabalho de
 * lembrar.
 */
function aoClicarAlunoDoRegistro(evento) {
    const botao = evento.target.closest('[data-aluno-projeto]');
    if (!botao) return;
    if (projetos.atual && !projetos.atual.posso_registrar) return;

    const aluno = projetos.alunosTurma.find(
        (item) => item.id === Number(botao.dataset.alunoProjeto));
    if (!aluno) return;

    const maquina = ondeEstaNoProjeto(aluno.id);
    if (maquina !== null) {
        tirarAlunoDoProjeto(aluno.id, maquina);
        return;
    }

    // máquina marcada antes: este toque já senta, sem o segundo passo
    if (projetos.maquinaAlvo !== null) {
        sentarAluno(aluno, projetos.maquinaAlvo);
        return;
    }

    const jaEstava = projetos.alunoEscolhido && projetos.alunoEscolhido.id === aluno.id;
    projetos.alunoEscolhido = jaEstava ? null : aluno;
    document.getElementById('registroRetorno').textContent = jaEstava ? ''
        : `${aluno.nome} escolhido — toque no computador dele.`;
    desenharRegistroDoProjeto();
}

function tirarAlunoDoProjeto(alunoId, maquina) {
    const ocupantes = projetos.mapa.get(maquina) || [];
    const posicao = ocupantes.findIndex((ocupante) => ocupante.aluno_id === alunoId);
    if (posicao < 0) return;
    tirarDaMaquinaDoProjeto(maquina, posicao);
}

/** Tira quem está na cadeira `posicao` do computador `numero`. */
function tirarDaMaquinaDoProjeto(numero, posicao) {
    const ocupantes = [...(projetos.mapa.get(numero) || [])];
    if (posicao < 0 || posicao >= ocupantes.length) return;

    const [saiu] = ocupantes.splice(posicao, 1);
    if (ocupantes.length) projetos.mapa.set(numero, ocupantes);
    else projetos.mapa.delete(numero);

    projetos.alunoEscolhido = null;
    projetos.maquinaAlvo = null;
    document.getElementById('registroRetorno').textContent =
        `${saiu.nome} saiu do computador ${numero}.`;
    desenharRegistroDoProjeto();
}

/** Todos os alunos sentados agora, com o número da máquina de cada um. */
function ocupantesDoProjeto() {
    const lista = [];
    projetos.mapa.forEach((ocupantes, maquina) => {
        ocupantes.forEach((ocupante) => lista.push({ ...ocupante, maquina }));
    });
    return lista;
}

function desenharRegistroDoProjeto() {
    desenharMaquinasDoProjeto();
    desenharAlunosDoRegistro();

    const alunos = ocupantesDoProjeto().length;
    const usados = [...projetos.mapa.values()].filter((lista) => lista.length).length;
    document.getElementById('registroContagem').textContent =
        `${alunos} aluno${alunos === 1 ? '' : 's'} em ${usados} `
        + `computador${usados === 1 ? '' : 'es'}`;

    document.getElementById('registroLegenda').textContent = projetos.qtd
        ? `${projetos.qtd - usados} máquina(s) livre(s) de ${projetos.qtd}`
        : '';
}

function desenharMaquinasDoProjeto() {
    const area = document.getElementById('registroComputadores');
    if (!projetos.qtd) {
        area.innerHTML = `<div class="lista-vazia" style="padding:22px 12px">
            Diga quantos computadores este projeto usou.</div>`;
        return;
    }

    let html = '';
    for (let numero = 1; numero <= projetos.qtd; numero += 1) {
        const ocupantes = projetos.mapa.get(numero) || [];
        const cheia = ocupantes.length >= projetos.porMaquina;
        const classes = ['maquina'];
        if (cheia) classes.push('maquina--cheia');
        if (projetos.maquinaAlvo === numero) classes.push('maquina--alvo');

        const cadeiras = [];
        for (let posicao = 0; posicao < projetos.porMaquina; posicao += 1) {
            const ocupante = ocupantes[posicao];
            cadeiras.push(ocupante
                ? `<button type="button" class="cadeira" data-tirar="${numero}"
                           data-posicao="${posicao}"
                           title="Tirar ${escapar(ocupante.nome)} deste computador">
                       <span>${escapar(primeiroENome(ocupante.nome))}</span>
                       <span class="cadeira__matricula mono">
                           ${escapar(ocupante.matricula || '—')}</span>
                   </button>`
                : '<span class="cadeira cadeira--livre">Livre</span>');
        }

        html += `
            <div class="${classes.join(' ')}" data-maquina="${numero}"
                 role="button" tabindex="0"
                 aria-label="Computador ${numero}, ${ocupantes.length} de ${projetos.porMaquina}">
                <div class="maquina__topo">
                    <span class="maquina__numero">${ICONE_MAQUINA}${numero}</span>
                    <span class="maquina__lotacao">
                        ${ocupantes.length}/${projetos.porMaquina}</span>
                </div>
                ${cadeiras.join('')}
            </div>`;
    }
    area.innerHTML = html;
}

/** Coloca o aluno na máquina, conferindo as duas travas antes. */
function sentarAluno(aluno, numero) {
    const retorno = document.getElementById('registroRetorno');

    const jaSentado = ocupantesDoProjeto()
        .find((ocupante) => ocupante.aluno_id === aluno.id);
    if (jaSentado) {
        retorno.textContent = `${aluno.nome} já está no computador ${jaSentado.maquina}.`;
        return;
    }

    const ocupantes = projetos.mapa.get(numero) || [];
    if (ocupantes.length >= projetos.porMaquina) {
        retorno.textContent = `O computador ${numero} já está com `
            + `${projetos.porMaquina} alunos. Escolha outro.`;
        return;
    }

    projetos.mapa.set(numero, [...ocupantes, {
        aluno_id: aluno.id, nome: aluno.nome, matricula: aluno.matricula || '',
    }]);
    projetos.alunoEscolhido = null;
    projetos.maquinaAlvo = null;
    retorno.textContent = `${aluno.nome}${aluno.turma ? ` (${aluno.turma})` : ''} `
        + `sentou no computador ${numero}.`;
    desenharRegistroDoProjeto();
}

/**
 * O toque no laboratório: tira quem está na cadeira, senta o aluno escolhido,
 * ou marca a máquina que espera o próximo aluno.
 *
 * O caminho contrário — máquina primeiro, aluno depois — existe porque às
 * vezes o professor está olhando para o computador vago, e não para a lista.
 */
function aoClicarComputadorDoProjeto(evento) {
    const cadeira = evento.target.closest('[data-tirar]');
    if (cadeira) {
        tirarDaMaquinaDoProjeto(Number(cadeira.dataset.tirar),
                                Number(cadeira.dataset.posicao));
        return;
    }

    const maquina = evento.target.closest('[data-maquina]');
    if (!maquina) return;
    if (projetos.atual && !projetos.atual.posso_registrar) return;
    const numero = Number(maquina.dataset.maquina);
    const retorno = document.getElementById('registroRetorno');

    // aluno escolhido antes: este toque é o lugar dele
    if (projetos.alunoEscolhido) {
        sentarAluno(projetos.alunoEscolhido, numero);
        return;
    }

    if ((projetos.mapa.get(numero) || []).length >= projetos.porMaquina) {
        retorno.textContent = `O computador ${numero} já está com `
            + `${projetos.porMaquina} alunos. Escolha outro.`;
        return;
    }

    projetos.maquinaAlvo = projetos.maquinaAlvo === numero ? null : numero;
    retorno.textContent = projetos.maquinaAlvo
        ? `Computador ${numero} escolhido — toque em quem senta nele.`
        : '';
    desenharRegistroDoProjeto();
}

/* ---- Gravar ---- */

function mudarQtdDeComputadores() {
    const campo = document.getElementById('registroQtd');
    const nova = Math.max(0, Math.min(Number(campo.value) || 0, 60));

    // ninguém pode ficar sentado em uma máquina que deixou de existir
    const perdidos = [...projetos.mapa.keys()].filter((numero) => numero > nova);
    perdidos.forEach((numero) => projetos.mapa.delete(numero));
    if (perdidos.length) {
        notificar(`Os computadores acima do ${nova} foram esvaziados.`, 'erro');
    }

    if (projetos.maquinaAlvo !== null && projetos.maquinaAlvo > nova) {
        projetos.maquinaAlvo = null;
    }
    projetos.qtd = nova;
    campo.value = nova || '';
    desenharRegistroDoProjeto();
}

function limparRegistroDoProjeto() {
    projetos.mapa = new Map();
    projetos.alunoEscolhido = null;
    projetos.maquinaAlvo = null;
    document.getElementById('registroRetorno').textContent = '';
    desenharRegistroDoProjeto();
}

async function salvarRegistroDoProjeto() {
    if (!projetos.atual) return;
    const salvar = botoes('salvarRegistro');

    const alocacoes = [];
    projetos.mapa.forEach((ocupantes, numero) => {
        if (!ocupantes.length) return;
        alocacoes.push({
            computador: numero,
            alunos: ocupantes.map((ocupante) => ({
                aluno_id: ocupante.aluno_id,
                matricula: ocupante.matricula,
                nome: ocupante.nome,
            })),
        });
    });

    if (!alocacoes.length) {
        notificar('Coloque pelo menos um aluno em um computador.', 'erro');
        return;
    }

    salvar.forEach((botao) => { botao.disabled = true; });
    try {
        const resposta = await API.post(
            `/api/projetos/${projetos.atual.projeto.id}/computadores`, {
                qtd_computadores: projetos.qtd,
                observacao: document.getElementById('registroObservacao').value.trim(),
                alocacoes,
            });
        notificar(resposta.novo
            ? `Registro salvo: ${resposta.alunos} aluno(s).`
            : `Registro corrigido: ${resposta.alunos} aluno(s).`, 'sucesso');
        await carregarListaDeProjetos();
        await abrirRegistroDoProjeto(projetos.atual.projeto.id);
    } catch (falha) {
        notificar(falha.message, 'erro');
    } finally {
        salvar.forEach((botao) => { botao.disabled = false; });
    }
}

function excluirRegistroDoProjeto() {
    if (!projetos.atual) return;
    const projetoId = projetos.atual.projeto.id;

    abrirModal({
        titulo: 'Excluir o registro',
        subtitulo: 'A reserva continua; some só a lista de quem usou cada máquina.',
        corpo: '<p>O histórico da coordenação perde esta ocorrência. Continuar?</p>',
        textoCancelar: 'Voltar',
        textoConfirmar: 'Sim, excluir',
        perigo: true,
        aoConfirmar: async () => {
            try {
                await API.del(`/api/projetos/${projetoId}/computadores`);
            } catch (falha) {
                notificar(falha.message, 'erro');
                return false;
            }
            notificar('Registro excluído.', 'sucesso');
            await carregarListaDeProjetos();
            await abrirRegistroDoProjeto(projetoId);
            return true;
        },
    });
}

/* ------------------------------------------------------------------ */
/* Aba de regras                                                       */
/* ------------------------------------------------------------------ */

/**
 * Teto de aulas seguidas que vale para quem está logado.
 *
 * É o da escola, a não ser que a coordenação tenha aberto uma exceção para
 * este professor — o servidor já manda o valor dele resolvido.
 */
function limiteDeAulasSeguidas() {
    return estado.regras.meu_max_aulas_seguidas || estado.regras.max_aulas_seguidas;
}

function montarRegras() {
    const regras = estado.regras;
    const contagem = regras.carencia_dias_letivos ? 'dias letivos' : 'dias corridos';
    const escopo = regras.carencia_escopo === 'global'
        ? 'todos os laboratórios'
        : 'o mesmo laboratório';

    const cartoes = [
        ['Antecedência', `${regras.antecedencia_maxima_dias} dias`,
         'Prazo máximo para agendar uma aula a partir de hoje.'],
        ['Aulas seguidas', `${limiteDeAulasSeguidas()} por dia`,
         regras.minha_excecao_aulas_seguidas
            ? `A escola permite ${regras.max_aulas_seguidas} por dia; a coordenação abriu `
              + `uma exceção para você, válida em até `
              + `${regras.minha_excecao_aulas_seguidas.max_dias} dia(s) seguido(s) na semana.`
            : 'Quantidade máxima de aulas consecutivas no mesmo laboratório, por dia.'],
        ['Carência',
         regras.minha_carencia_dispensada ? 'Não se aplica a você'
                                          : `${regras.carencia_dias} ${contagem}`,
         regras.minha_carencia_dispensada
            ? `A escola pede ${regras.carencia_dias} ${contagem} entre um uso e outro, `
              + 'mas a sua exceção de aulas seguidas dispensa esse intervalo.'
            : `Depois de usar, você espera esse intervalo para reservar ${escopo} de novo.`],
        ['Cancelamento', `${regras.cancelamento_antecedencia_horas} horas antes`,
         'Antecedência mínima para cancelar uma reserva já confirmada.'],
        ['Falta', regras.falta_conta_como_uso ? 'Conta como uso' : 'Não conta como uso',
         'Se você reservar e não usar o laboratório no dia.'],
        ['Fim de semana', regras.permitir_fim_de_semana ? 'Liberado' : 'Bloqueado',
         'Reservas aos sábados e domingos.'],
    ];

    document.getElementById('conteudoRegras').innerHTML = cartoes.map(([titulo, valor, texto]) => `
        <div class="cartao">
            <span class="rotulo-pequeno">${escapar(titulo)}</span>
            <h3 style="margin:6px 0 8px;font-size:1.3rem">${escapar(valor)}</h3>
            <p class="texto-suave" style="font-size:.85rem;margin:0">${escapar(texto)}</p>
        </div>`).join('');
}

/* ------------------------------------------------------------------ */
/* Meu relatorio                                                       */
/* ------------------------------------------------------------------ */

/** 150 -> "2h30"; 60 -> "1h"; 0 -> "0h". */
function horasDoTotal(minutos) {
    const total = Number(minutos) || 0;
    const horas = Math.floor(total / 60);
    const resto = total % 60;
    return resto ? `${horas}h${String(resto).padStart(2, '0')}` : `${horas}h`;
}

/** '2026-08' -> 'ago/2026'. */
function rotuloDoMes(mes) {
    const [ano, numero] = String(mes).split('-');
    return `${MESES[Number(numero) - 1] || mes}/${ano}`;
}

/** 3 -> '3 aulas'; 1 -> '1 aula'; 2.5 -> '2,5 aulas' (a média sai quebrada). */
function contarAulas(quantidade) {
    const numero = Number(quantidade) || 0;
    const texto = numero.toLocaleString('pt-BR', { maximumFractionDigits: 1 });
    return `${texto} ${numero === 1 ? 'aula' : 'aulas'}`;
}

/** Lista de barras usada nos quadros de turno, tipo de aula e mês. */
function barrasHTML(itens) {
    if (!itens.length) return '<div class="lista-vazia">Sem aulas no período.</div>';
    const maior = Math.max(1, ...itens.map(([, valor]) => valor));
    return `
        <div class="barras">
            ${itens.map(([rotulo, valor]) => `
                <div class="barras__item">
                    <strong>${escapar(rotulo)}</strong>
                    <div class="barra-progresso">
                        <i style="width:${Math.round(100 * valor / maior)}%"></i>
                    </div>
                    <span class="barras__valor">${valor}</span>
                </div>`).join('')}
        </div>`;
}

async function gerarMeuRelatorio() {
    const area = document.getElementById('conteudoMeuRelatorio');
    area.innerHTML = '<div class="lista-vazia"><span class="carregando"></span></div>';

    const de = document.getElementById('meuRelDe').value;
    const ate = document.getElementById('meuRelAte').value;

    try {
        const dados = await API.get(`/api/meu-relatorio?de=${de}&ate=${ate}`);
        const totais = dados.totais;
        const escola = dados.escola;
        const maiorUso = Math.max(1, ...dados.por_laboratorio.map((lab) => lab.aulas || 0));
        const maiorProfessor = Math.max(1, ...dados.por_professor.map((prof) => prof.aulas || 0));
        const diferenca = Math.round((dados.aulas - escola.media_por_professor) * 10) / 10;
        const comparacao = diferenca === 0
            ? 'exatamente na média da escola'
            : `${contarAulas(Math.abs(diferenca))} ${diferenca > 0 ? 'acima' : 'abaixo'} da média`;

        area.innerHTML = `
            <div class="indicadores">
                <div class="indicador indicador--primaria">
                    <strong>${dados.aulas}</strong><span>Aulas no período</span>
                </div>
                <div class="indicador indicador--verde">
                    <strong>${totais.realizadas || 0}</strong><span>Aulas realizadas</span>
                </div>
                <div class="indicador indicador--ambar">
                    <strong>${totais.faltas || 0}</strong><span>Faltas registradas</span>
                </div>
                <div class="indicador">
                    <strong>${horasDoTotal(totais.minutos)}</strong>
                    <span>Tempo em laboratório</span>
                </div>
            </div>

            <div class="cartao">
                <div class="cartao__topo">
                    <h3>Resumo do período</h3>
                    <span class="texto-suave" style="font-size:.78rem">
                        ${dataBR(dados.periodo.de)} a ${dataBR(dados.periodo.ate)}
                        · ${dados.periodo.dias_letivos} dias letivos
                    </span>
                </div>
                <div class="ficha">
                    <div class="ficha__item">
                        <span class="rotulo-pequeno">Dias com aula marcada</span>
                        <strong>${totais.dias || 0}</strong>
                    </div>
                    <div class="ficha__item">
                        <span class="rotulo-pequeno">Aulas ainda por vir</span>
                        <strong>${totais.proximas || 0}</strong>
                    </div>
                    <div class="ficha__item">
                        <span class="rotulo-pequeno">Reservas canceladas</span>
                        <strong>${totais.canceladas || 0}</strong>
                    </div>
                    <div class="ficha__item">
                        <span class="rotulo-pequeno">Média da escola</span>
                        <strong>${contarAulas(escola.media_por_professor)} por professor</strong>
                    </div>
                </div>
                <p class="dica">Você está ${escapar(comparacao)} e ocupa a
                   ${escola.posicao}ª posição em uso entre ${escola.professores}
                   ${escola.professores === 1 ? 'professor' : 'professores'} da escola.
                   A lista completa está em <em>Uso por professor</em>, logo abaixo.</p>
            </div>

            <div class="cartao">
                <div class="cartao__topo"><h3>Uso por laboratório</h3></div>
                ${dados.por_laboratorio.length ? `
                <div class="tabela-envolvida">
                    <table>
                        <thead>
                            <tr>
                                <th>Laboratório</th><th>Aulas</th>
                                <th>Faltas</th><th>Última aula</th><th>Uso</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${dados.por_laboratorio.map((lab) => `
                                <tr>
                                    <td data-rotulo="Laboratório"><strong>${escapar(lab.nome)}</strong></td>
                                    <td data-rotulo="Aulas">${lab.aulas || 0}</td>
                                    <td data-rotulo="Faltas">${lab.faltas || 0}</td>
                                    <td data-rotulo="Última aula">${dataBR(lab.ultima)}</td>
                                    <td data-rotulo="Uso">
                                        <div class="barra-progresso">
                                            <i style="width:${Math.round(100 * (lab.aulas || 0) / maiorUso)}%"></i>
                                        </div>
                                    </td>
                                </tr>`).join('')}
                        </tbody>
                    </table>
                </div>` : `<div class="lista-vazia">
                        <strong>Nenhuma aula no período</strong>
                        Escolha outras datas ou reserve seu próximo laboratório.
                    </div>`}
            </div>

            <div class="cartao">
                <div class="cartao__topo">
                    <h3>Uso por professor</h3>
                    <span class="texto-suave" style="font-size:.78rem">
                        Média de ${contarAulas(escola.media_por_professor)} por professor
                    </span>
                </div>
                <div class="tabela-envolvida">
                    <table>
                        <thead>
                            <tr><th>Professor</th><th>Disciplina</th><th>Aulas</th><th>Uso</th></tr>
                        </thead>
                        <tbody>
                            ${dados.por_professor.map((prof) => `
                                <tr${prof.sou_eu ? ' class="linha-eu"' : ''}>
                                    <td data-rotulo="Professor">
                                        <strong>${escapar(prof.nome)}</strong>
                                        ${prof.sou_eu ? '<span class="selo selo--info">Você</span>' : ''}
                                    </td>
                                    <td data-rotulo="Disciplina">${escapar(prof.disciplina || '—')}</td>
                                    <td data-rotulo="Aulas">${prof.aulas || 0}</td>
                                    <td data-rotulo="Uso">
                                        <div class="barra-progresso">
                                            <i style="width:${Math.round(100 * (prof.aulas || 0) / maiorProfessor)}%"></i>
                                        </div>
                                    </td>
                                </tr>`).join('')}
                        </tbody>
                    </table>
                </div>
                <p class="dica">A lista mostra quantas aulas cada professor da escola
                   reservou no período — é a mesma informação que já aparece com o nome
                   de cada um na agenda da semana, só que somada, para todo mundo
                   acompanhar o rodízio dos laboratórios.</p>
            </div>

            <div class="grade-cartoes">
                <div class="cartao">
                    <div class="cartao__topo"><h3>Por turno</h3></div>
                    ${barrasHTML(dados.por_turno.map(
                        (item) => [ROTULO_TURNO[item.turno] || item.turno, item.aulas]))}
                </div>
                <div class="cartao">
                    <div class="cartao__topo"><h3>Por tipo de aula</h3></div>
                    ${barrasHTML(dados.por_tipo.map((item) => [item.tipo, item.aulas]))}
                </div>
            </div>

            <div class="cartao">
                <div class="cartao__topo"><h3>Mês a mês</h3></div>
                ${barrasHTML(dados.por_mes.map(
                    (item) => [rotuloDoMes(item.mes), item.aulas]))}
            </div>`;
    } catch (falha) {
        area.innerHTML = `<div class="lista-vazia">${escapar(falha.message)}</div>`;
    }
}

/* ------------------------------------------------------------------ */
/* Conta do professor                                                  */
/* ------------------------------------------------------------------ */

async function carregarMinhaConta() {
    try {
        const conta = await API.get('/api/minha-conta');
        estado.professor = { ...estado.professor, ...conta };
        mostrarMinhaConta(conta);
    } catch (falha) {
        notificar(falha.message, 'erro');
    }
}

function mostrarMinhaConta(conta) {
    document.getElementById('contaMatricula').textContent = conta.matricula;
    document.getElementById('contaDisciplina').textContent = conta.disciplina || '—';

    const total = conta.total_reservas;
    const proximas = conta.proximas_reservas;
    document.getElementById('contaReservas').textContent =
        `${total} no total` + (proximas ? ` · ${proximas} por vir` : '');

    document.getElementById('contaNomeCampo').value = conta.nome || '';
    document.getElementById('contaEmail').value = conta.email || '';
    // o campo mostra a máscara; só os dígitos vão para o servidor
    document.getElementById('contaTelefone').value = formatarCelular(conta.telefone);

    document.getElementById('contaAvatar').innerHTML = avatarHTML(conta);
    document.getElementById('botaoRemoverFoto').classList.toggle('oculto', !conta.foto);
}

async function salvarContato(evento) {
    evento.preventDefault();
    const erro = document.getElementById('erroContato');
    mostrarErro(erro, '');

    const nome = document.getElementById('contaNomeCampo').value.trim();
    if (!nome) {
        mostrarErro(erro, 'Informe o nome.');
        return;
    }

    const campoTelefone = document.getElementById('contaTelefone');
    const telefone = soDigitos(campoTelefone.value);
    const avisoTelefone = erroTelefone(telefone);
    if (avisoTelefone) {
        mostrarErro(erro, avisoTelefone);
        campoTelefone.focus();
        return;
    }

    try {
        const resposta = await API.put('/api/minha-conta', {
            nome,
            email: document.getElementById('contaEmail').value.trim(),
            telefone,
        });
        estado.professor = { ...estado.professor, ...resposta.professor };
        campoTelefone.value = formatarCelular(resposta.professor.telefone);
        document.getElementById('nomeProfessor').textContent = resposta.professor.nome;
        notificar('Perfil atualizado.');
    } catch (falha) {
        mostrarErro(erro, falha.message);
    }
}

/* ------------------------------------------------------------------ */
/* Foto de perfil                                                      */
/* ------------------------------------------------------------------ */

// Precisa bater com LIMITE_FOTO_MB no app.py: aqui o aviso chega antes de
// gastar o envio, la fica a palavra final para quem burlar a validacao.
const LIMITE_FOTO_MB = 10;
const LIMITE_FOTO_BYTES = LIMITE_FOTO_MB * 1024 * 1024;

// Formatos aceitos na foto de perfil. HEIC/HEIF entram porque sao o padrao da
// camera do iPhone: o servidor converte para JPEG na hora do envio.
const TIPOS_FOTO = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
const EXTENSOES_FOTO = ['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif'];

/**
 * Confere tamanho e formato antes de subir o arquivo. Nao olha largura, altura
 * nem proporcao: foto de qualquer dimensao serve, o avatar recorta na exibicao.
 * Devolve a mensagem de erro para mostrar ao professor, ou null quando a foto
 * pode ser enviada.
 */
function validarFotoPerfil(arquivo) {
    if (!arquivo) return 'Escolha uma imagem.';

    if (arquivo.size > LIMITE_FOTO_BYTES) {
        return `Esta foto tem ${formatarTamanhoArquivo(arquivo.size)} e o limite é `
            + `${LIMITE_FOTO_MB} MB. Escolha uma imagem menor.`;
    }
    if (arquivo.size === 0) {
        return 'Esse arquivo está vazio. Escolha outra imagem.';
    }

    // o navegador nem sempre preenche o tipo (HEIC no Windows, arquivo vindo de
    // app de nuvem), entao a extensao serve de segunda chance. Quem decide de
    // verdade e o servidor, que le a assinatura de bytes do arquivo.
    const nome = (arquivo.name || '').toLowerCase();
    const tipoConhecido = TIPOS_FOTO.includes(arquivo.type);
    const extensaoConhecida = EXTENSOES_FOTO.some((extensao) => nome.endsWith(extensao));
    if (!tipoConhecido && !extensaoConhecida) {
        return 'Envie uma imagem JPG, PNG, WEBP ou HEIC.';
    }
    return null;
}

async function enviarFoto(arquivo) {
    // sem arquivo o professor apenas fechou o seletor: nao e erro, nao avisa
    if (!arquivo) return;

    const problema = validarFotoPerfil(arquivo);
    if (problema) {
        notificar(problema, 'erro');
        return;
    }

    const formulario = new FormData();
    formulario.append('foto', arquivo);
    try {
        const resposta = await fetch('/api/minha-conta/foto', {
            method: 'POST',
            body: formulario,
        });
        const dados = await resposta.json().catch(() => null);
        if (!resposta.ok) throw new Error((dados && dados.erro) || 'Não foi possível enviar a foto.');

        estado.professor = { ...estado.professor, foto: dados.foto };
        document.getElementById('contaAvatar').innerHTML = avatarHTML(estado.professor);
        document.getElementById('avatarProfessor').innerHTML = avatarHTML(estado.professor);
        document.getElementById('avatarTopo').innerHTML = avatarHTML(estado.professor);
        document.getElementById('botaoRemoverFoto').classList.remove('oculto');
        notificar('Foto atualizada.');
    } catch (falha) {
        notificar(falha.message, 'erro');
    }
}

async function removerFoto() {
    try {
        await API.del('/api/minha-conta/foto');
        estado.professor = { ...estado.professor, foto: null };
        document.getElementById('contaAvatar').innerHTML = avatarHTML(estado.professor);
        document.getElementById('avatarProfessor').innerHTML = avatarHTML(estado.professor);
        document.getElementById('avatarTopo').innerHTML = avatarHTML(estado.professor);
        document.getElementById('botaoRemoverFoto').classList.add('oculto');
        notificar('Foto removida.');
    } catch (falha) {
        notificar(falha.message, 'erro');
    }
}

/**
 * Número corrido da aula no dia (1ª a 9ª), como a escola numera na planilha e
 * no formulário de reserva de papel.
 *
 * No banco a ordem recomeça a cada turno — a 1ª da tarde é a `ordem` 1 —
 * porque é assim que a regra de "aulas seguidas" conta. Aqui isso vira só um
 * detalhe interno: na tela a aula das 13:10 é a 6ª do dia, e não a 1ª.
 */
function numeroDaAula(horario) {
    const posicao = [...estado.horarios]
        .sort((a, b) => (ORDEM_TURNO[a.turno] || 9) - (ORDEM_TURNO[b.turno] || 9)
            || a.ordem - b.ordem)
        .findIndex((item) => item.turno === horario.turno && item.ordem === horario.ordem);
    return posicao >= 0 ? posicao + 1 : horario.ordem;
}

/**
 * Aba "Meu horário": a grade do próprio professor e, quando a coordenação
 * libera, a grade dos colegas. A liberação é uma chave do painel do gestor —
 * sem ela o servidor devolve `liberada: false` e o cartão nem aparece.
 */
async function carregarMeuHorario() {
    const area = document.getElementById('minhaGradeCompleta');
    if (!area) return;
    try {
        const dados = await API.get(`/api/minha-conta/grade?inicio=${semanaDoHorario()}`);
        // o servidor devolve a semana que realmente usou (sempre segunda a sexta)
        estado.semanaHorario = dados.semana.inicio;
        if (estado.diaHorario === null) estado.diaHorario = diaUtilDeHoje(dados.semana.inicio);
        estado.minhaGrade = dados;
        mostrarRotuloDaSemana(dados.semana, 'rotuloSemanaProf', 'voltarSemanaAtualProf');
        desenharMinhaGrade();
    } catch (falha) {
        area.innerHTML = '<div class="lista-vazia">Não foi possível carregar a grade.</div>';
    }
    await carregarGradeDaEscola();
}

/** A semana aberta na aba "Meu horário"; sem escolha ainda, a de hoje. */
function semanaDoHorario() {
    if (!estado.semanaHorario) estado.semanaHorario = segundaDaSemana();
    return estado.semanaHorario;
}

function irParaSemanaDoHorario(inicio) {
    estado.semanaHorario = segundaDaSemana(inicio);
    // cada semana abre no dia de hoje, ou na segunda quando é outra semana
    estado.diaHorario = diaUtilDeHoje(estado.semanaHorario);
    carregarMeuHorario();
}

/** O dia útil aberto no celular; as duas grades da aba andam juntas. */
function trocarDiaDoHorario(indice) {
    estado.diaHorario = indice;
    desenharMinhaGrade();
    desenharGradeDaEscola();
}

function desenharMinhaGrade() {
    const area = document.getElementById('minhaGradeCompleta');
    const dados = estado.minhaGrade;
    if (!area || !dados) return;
    // a semana em si já aparece na navegação, acima da grade
    const aviso = dados.proxima_mudanca
        ? `<p class="dica">Sua grade de aulas muda a partir de
               <strong>${dataBR(dados.proxima_mudanca)}</strong>.</p>`
        : '';
    if (!dados.celulas.length) {
        desenharSeletorDias('seletorDiasHorario', [], 0);
        area.innerHTML = aviso + '<div class="lista-vazia">Nenhuma aula nesta semana. '
            + 'Se a coordenação ainda não montou a sua grade, ela aparece aqui '
            + 'quando estiver pronta.</div>';
        return;
    }
    const semana = diasUteisDaSemana(dados.semana.inicio);
    desenharSeletorDias('seletorDiasHorario', semana, estado.diaHorario);
    // aula marcada só para esta semana aparece destacada, para o professor
    // notar que aquele dia sai do padrão dele
    area.innerHTML = aviso + gradeHTML(
        linhasDaGrade(dados.celulas, estado.horarios),
        diasVisiveisDaGrade(semana, estado.diaHorario),
        (celula) => `
        ${celula.sala ? `<span class="celula__detalhe">${escapar(celula.sala)}</span>` : ''}
        ${celula.excecao ? '<span class="marca-excecao">só nesta semana</span>' : ''}`);
}

/* ------------------------------------------------------------------ */
/* Grade da escola (só quando a coordenação libera)                    */
/* ------------------------------------------------------------------ */

async function carregarGradeDaEscola() {
    const cartao = document.getElementById('cartaoGradeEscola');
    if (!cartao) return;
    let dados;
    try {
        // segue a mesma semana escolhida em "Minha grade de aulas"
        dados = await API.get(`/api/grade-escola?inicio=${semanaDoHorario()}`);
    } catch (falha) {
        cartao.classList.add('oculto');
        return;
    }

    cartao.classList.toggle('oculto', !dados.liberada);
    if (!dados.liberada) return;

    estado.gradeEscola = dados;
    if (estado.diaHorario === null) estado.diaHorario = diaUtilDeHoje(dados.semana.inicio);
    const seletor = document.getElementById('seletorProfessorGrade');
    const escolhido = seletor.value;
    const professores = [...new Map(dados.aulas.map((aula) =>
        [aula.professor_id, aula.professor])).entries()]
        .sort((a, b) => String(a[1]).localeCompare(String(b[1]), 'pt-BR'));

    seletor.innerHTML = professores.map(([id, nome]) =>
        `<option value="${id}">${escapar(nome)}</option>`).join('');
    if (escolhido && professores.some(([id]) => String(id) === escolhido)) {
        seletor.value = escolhido;
    } else if (estado.professor) {
        // começa no próprio professor, se ele estiver na grade liberada
        const eu = professores.find(([id]) => id === estado.professor.id);
        if (eu) seletor.value = String(eu[0]);
    }
    desenharGradeDaEscola();
}

function desenharGradeDaEscola() {
    const area = document.getElementById('gradeDaEscola');
    const dados = estado.gradeEscola;
    if (!area || !dados) return;

    const escolhido = Number(document.getElementById('seletorProfessorGrade').value);
    if (!escolhido) {
        desenharSeletorDias('seletorDiasEscola', [], 0);
        area.innerHTML = '<div class="lista-vazia">Nenhum professor com aulas na grade.</div>';
        return;
    }

    const celulas = dados.aulas.filter((aula) => aula.professor_id === escolhido);
    if (!celulas.length) {
        desenharSeletorDias('seletorDiasEscola', [], 0);
        area.innerHTML = '<div class="lista-vazia">Esse professor não tem aulas na grade.</div>';
        return;
    }
    const semana = diasUteisDaSemana(dados.semana.inicio);
    desenharSeletorDias('seletorDiasEscola', semana, estado.diaHorario);
    area.innerHTML = gradeHTML(
        linhasDaGrade(celulas, dados.horarios),
        diasVisiveisDaGrade(semana, estado.diaHorario),
        (celula) => (celula.sala
            ? `<span class="celula__detalhe">${escapar(celula.sala)}</span>`
            : ''));
}

async function trocarMinhaSenha(evento) {
    evento.preventDefault();
    const erro = document.getElementById('erroSenhaProfessor');
    mostrarErro(erro, '');

    const nova = document.getElementById('senhaNovaProf').value;
    if (nova !== document.getElementById('senhaConfirmaProf').value) {
        mostrarErro(erro, 'A confirmação não é igual à nova senha.');
        return;
    }
    if (nova.length < 6) {
        mostrarErro(erro, 'A nova senha precisa ter pelo menos 6 caracteres.');
        return;
    }

    try {
        await API.post('/api/minha-conta/senha', {
            senha_atual: document.getElementById('senhaAtualProf').value,
            nova_senha: nova,
        });
        document.getElementById('formSenhaProfessor').reset();
        notificar('Senha atualizada. Use a nova senha no próximo acesso.');
    } catch (falha) {
        mostrarErro(erro, falha.message);
    }
}
