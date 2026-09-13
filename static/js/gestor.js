/* =========================================================================
   Painel do gestor local: laboratorios, professores, reservas, horarios,
   calendario de bloqueios, regras e relatorios.

   As contas de gestor sao criadas pelo gerente geral (/gerente) — aqui ele
   so entra com o usuario e a senha que recebeu.
   ========================================================================= */

const estadoAdmin = {
    laboratorios: [],
    professores: [],
    horarios: [],
    salas: [],
    bloqueios: [],
    // aba Alunos: a lista carregada, as turmas que já têm alunos, as turmas
    // que aparecem na grade de aulas (mesmo sem lista montada ainda) e as que
    // o gestor abriu pelo "Criar turma" — estas trazem curso e turno
    alunos: [],
    turmasDeAlunos: [],
    turmasConhecidas: [],
    turmasCadastradas: [],
    // aba Uso de Computadores: as aulas registradas pelos professores
    usoComputadores: [],
    config: {},
    gestor: null,
    gerente: false,
    unidade: null,
    unidadeId: null,
    // segunda-feira (AAAA-MM-DD) da semana aberta na aba Grades de Aulas
    semanaGrade: null,
    // dia útil aberto nessa aba no celular (0 = segunda), onde a semana
    // inteira não cabe lado a lado
    diaGrade: null,
    // a grade já carregada, para redesenhar ao trocar de dia sem pedir de novo
    gradeEscola: null,
    // de quem é o horário na tela do celular: '' = escola toda, 'p12' = o
    // professor 12, 't3º Info A' = a turma. Vazio no computador, onde a
    // semana inteira da escola cabe de uma vez
    focoGrade: '',
    // aba Regras > exceção de aulas seguidas: a lista de professores da escola,
    // as exceções já gravadas e quem está marcado agora na tela
    excecaoAulas: {
        professores: [],
        excecoes: [],
        selecionados: new Set(),
        maxAulasSeguidas: 0,
        opcoesAulas: [],
        opcoesDias: [],
    },
};

document.addEventListener('DOMContentLoaded', iniciarAdmin);

async function iniciarAdmin() {
    ligarEventosAdmin();
    try {
        const sessao = await API.get('/api/sessao');
        if (sessao.gestor || sessao.gerente) {
            await abrirPainel(sessao.gestor, sessao);
        } else {
            document.getElementById('telaLogin').classList.remove('oculto');
        }
    } catch (erro) {
        document.getElementById('telaLogin').classList.remove('oculto');
    }
}

async function abrirPainel(gestor, sessao) {
    iniciarVigiaDeSessao();     // sai sozinho depois do tempo parado (api.js)
    estadoAdmin.gestor = gestor || null;
    estadoAdmin.gerente = Boolean(sessao && sessao.gerente && !gestor);
    estadoAdmin.unidade = (sessao && sessao.unidade) || (gestor && gestor.unidade) || null;
    estadoAdmin.unidadeId = sessao ? sessao.unidade_id : null;
    mostrarGestorLogado();
    if (estadoAdmin.gerente) await montarSeletorDeFoco();
    // o gerente geral ja administra os gestores em /gerente; aqui a aba e so
    // para o gestor local trazer ajuda para a propria escola
    document.getElementById('botaoAbaGestores')
        .classList.toggle('oculto', estadoAdmin.gerente);
    document.getElementById('telaLogin').classList.add('oculto');
    document.getElementById('app').classList.remove('oculto');
    await Promise.all([
        carregarLaboratorios(),
        carregarProfessores(),
        carregarHorarios(),
        carregarSalas(),
        carregarBloqueios(),
        carregarConfig(),
        carregarExcecaoAulas(),
    ]);
    carregarReservas();
    carregarGradeEscola();
}

/** Sem gestor na sessao quem entrou foi o gerente geral (que ve tudo). */
function mostrarGestorLogado() {
    const gestor = estadoAdmin.gestor;
    const nome = gestor ? gestor.nome : 'Gerente Geral';
    const detalhe = gestor ? `Usuário ${gestor.usuario}` : 'Visitando a gestão local';
    const marca = gestor ? iniciais(gestor.nome) : 'GG';

    document.getElementById('nomeGestor').textContent = nome;
    document.getElementById('usuarioGestor').textContent = detalhe;
    document.getElementById('avatarGestor').textContent = marca;
    document.getElementById('avatarTopo').textContent = marca;

    // a escola em que o painel está mexendo fica visível o tempo todo
    const escola = estadoAdmin.unidade
        || (estadoAdmin.gerente ? 'Todas as unidades' : 'Sem unidade definida');
    document.getElementById('migalhaTopo').textContent = escola;
    document.getElementById('marcaUnidade').textContent = escola;
}

/**
 * O gerente geral escolhe em qual escola quer trabalhar. O gestor local não vê
 * este seletor: ele fica preso à unidade dele, decidida no servidor.
 */
async function montarSeletorDeFoco() {
    const seletor = document.getElementById('seletorFoco');
    let unidades = [];
    try {
        unidades = (await API.get('/api/gerente/unidades')).unidades;
    } catch (falha) {
        return;
    }

    seletor.innerHTML = '<option value="">Todas as unidades</option>'
        + unidades.map((unidade) => `
            <option value="${unidade.id}"
                ${unidade.id === estadoAdmin.unidadeId ? 'selected' : ''}>
                ${escapar(unidade.nome)}
            </option>`).join('');
    seletor.classList.remove('oculto');

    seletor.addEventListener('change', async () => {
        try {
            const resposta = await API.post('/api/gerente/foco',
                                            { unidade_id: seletor.value || null });
            estadoAdmin.unidade = resposta.unidade;
            estadoAdmin.unidadeId = seletor.value ? Number(seletor.value) : null;
            mostrarGestorLogado();
            await recarregarTudo();
            notificar(resposta.unidade
                ? `Mostrando ${resposta.unidade}.`
                : 'Mostrando todas as unidades.');
        } catch (falha) {
            notificar(falha.message, 'erro');
        }
    });
}

async function recarregarTudo() {
    await Promise.all([
        carregarLaboratorios(),
        carregarProfessores(),
        carregarHorarios(),
        carregarSalas(),
        carregarBloqueios(),
        carregarExcecaoAulas(),
    ]);
    carregarReservas();
    carregarGradeEscola();
    // cada escola tem o seu PDF: trocar de unidade troca o calendário na tela
    if (calendarioEscolar.carregado) carregarCalendarioEscolar();
}

function ligarEventosAdmin() {
    document.getElementById('formLogin').addEventListener('submit', async (evento) => {
        evento.preventDefault();
        const erro = document.getElementById('erroLogin');
        mostrarErro(erro, '');
        try {
            const resposta = await API.post('/api/login/gestor', {
                identificador: document.getElementById('identificador').value.trim(),
                senha: document.getElementById('senha').value,
            });
            await abrirPainel(resposta.gestor, await API.get('/api/sessao'));
        } catch (falha) {
            mostrarErro(erro, falha.message);
        }
    });

    configurarSair();
    preencherDataDeHoje();

    let gestoresCarregados = false;
    let alunosCarregados = false;
    configurarAbas((aba) => {
        if (aba === 'relatorio') gerarRelatorio();
        if (aba === 'reservas') carregarReservas();
        if (aba === 'conta') carregarMinhaContaGestor();
        if (aba === 'computadores') carregarUsoComputadores();
        if (aba === 'projetos') carregarProjetosGestor();
        if (aba === 'calendarioEscolar') carregarCalendarioEscolar();
        if (aba === 'gestores' && !gestoresCarregados) {
            gestoresCarregados = true;
            carregarGestores();
        }
        // a lista de alunos pode passar de mil linhas: só busca quando a aba
        // é aberta, e depois disso os botões da tela é que recarregam
        if (aba === 'alunos' && !alunosCarregados) {
            alunosCarregados = true;
            carregarAlunos();
        }
    });

    // envio, substituição e leitura do PDF do ano letivo (calendario.js)
    iniciarCalendarioEscolar({ podeEnviar: true });

    document.getElementById('gradeEscola').addEventListener('click', aoClicarAulaDaGrade);
    document.getElementById('semanaAnterior')
        .addEventListener('click', () => irParaSemana(deslocarSemana(semanaDaGrade(), -1)));
    document.getElementById('semanaSeguinte')
        .addEventListener('click', () => irParaSemana(deslocarSemana(semanaDaGrade(), 1)));
    document.getElementById('voltarSemanaAtual')
        .addEventListener('click', () => irParaSemana(segundaDaSemana()));
    // no celular a grade da semana sai um dia de cada vez, de um professor
    // (ou de uma turma) de cada vez
    ligarSeletorDias('seletorDiasGrade', (indice) => {
        estadoAdmin.diaGrade = indice;
        desenharGradeEscola();
    });
    document.getElementById('focoDaGrade').addEventListener('change', (evento) => {
        estadoAdmin.focoGrade = evento.target.value;
        desenharGradeEscola();
    });
    // girar o celular ou abrir num monitor troca entre um dia e a semana toda
    telaMobile.addEventListener('change', desenharGradeEscola);

    document.getElementById('botaoNovoLaboratorio')
        .addEventListener('click', () => abrirFormularioLaboratorio());
    document.getElementById('corpoLaboratorios').addEventListener('click', aoClicarLaboratorio);

    document.getElementById('botaoNovoProfessor')
        .addEventListener('click', () => abrirFormularioProfessor());
    document.getElementById('corpoProfessores').addEventListener('click', aoClicarProfessor);
    // filtra a lista ja carregada, sem ida ao servidor a cada tecla
    document.getElementById('buscaProfessor').addEventListener('input', desenharProfessores);

    document.getElementById('botaoNovoGestor')
        .addEventListener('click', () => abrirFormularioGestor());
    document.getElementById('corpoGestores').addEventListener('click', aoClicarGestor);
    document.getElementById('buscaGestor').addEventListener('input', desenharGestores);

    document.getElementById('botaoFiltrar').addEventListener('click', carregarReservas);
    document.getElementById('botaoLimparFiltro').addEventListener('click', () => {
        document.getElementById('filtroLaboratorio').value = '';
        document.getElementById('filtroStatus').value = '';
        document.getElementById('filtroDe').value = '';
        carregarReservas();
    });
    document.getElementById('listaReservas').addEventListener('change', aoMudarStatusReserva);

    document.getElementById('botaoNovoAluno')
        .addEventListener('click', () => abrirFormularioAluno());
    document.getElementById('botaoImportarAlunos')
        .addEventListener('click', abrirImportacaoDeAlunos);
    document.getElementById('botaoNovaTurma')
        .addEventListener('click', abrirFormularioTurma);
    document.getElementById('botaoExcluirTurma')
        .addEventListener('click', abrirExclusaoDeTurma);
    document.getElementById('corpoAlunos').addEventListener('click', aoClicarAluno);
    // filtram a lista já carregada, sem ida ao servidor a cada tecla
    document.getElementById('buscaAluno').addEventListener('input', desenharAlunos);
    document.getElementById('filtroTurmaAlunos').addEventListener('change', desenharAlunos);

    document.getElementById('botaoFiltrarUso')
        .addEventListener('click', carregarUsoComputadores);
    document.getElementById('botaoLimparUso').addEventListener('click', () => {
        ['usoDe', 'usoAte', 'usoProfessor', 'usoTurma', 'usoLaboratorio', 'usoOrigem']
            .forEach((campo) => { document.getElementById(campo).value = ''; });
        carregarUsoComputadores();
    });
    document.getElementById('corpoUso').addEventListener('click', (evento) => {
        const botao = evento.target.closest('[data-ver-uso]');
        if (botao) abrirDetalheDoUso(Number(botao.dataset.verUso));
    });

    document.getElementById('botaoNovoProjeto')
        .addEventListener('click', () => abrirFormularioProjeto());
    document.getElementById('botaoFiltrarProjetos')
        .addEventListener('click', listarProjetosGestor);
    document.getElementById('botaoLimparProjetos').addEventListener('click', () => {
        ['projetoDe', 'projetoAte', 'projetoFiltroProfessor',
         'projetoFiltroLaboratorio', 'projetoFiltroStatus']
            .forEach((campo) => { document.getElementById(campo).value = ''; });
        listarProjetosGestor();
    });
    document.getElementById('corpoProjetos')
        .addEventListener('click', aoClicarProjetoGestor);

    configurarSubAbasHorarios();
    document.getElementById('formHorario').addEventListener('submit', criarHorario);
    document.getElementById('listaHorariosAdmin').addEventListener('click', aoClicarHorario);
    document.getElementById('formSala').addEventListener('submit', criarSala);
    document.getElementById('listaSalas').addEventListener('click', aoClicarSala);
    document.getElementById('cfgGradeVisivel').addEventListener('change', salvarVisibilidadeGeral);
    document.getElementById('listaOcultosGrade').addEventListener('click', aoClicarOcultoDaGrade);
    document.getElementById('formBloqueio').addEventListener('submit', criarBloqueio);
    document.getElementById('listaBloqueios').addEventListener('click', aoClicarBloqueio);

    document.getElementById('formConfig').addEventListener('submit', salvarConfig);
    document.getElementById('formEnvio').addEventListener('submit', salvarEnvio);

    document.getElementById('formExcecaoAulas')
        .addEventListener('submit', salvarExcecaoAulas);
    document.getElementById('buscaExcecaoProfessor')
        .addEventListener('input', desenharExcecaoAulas);
    document.getElementById('listaExcecaoProfessores')
        .addEventListener('change', aoMarcarProfessorExcecao);
    document.getElementById('botaoMarcarTodosExcecao')
        .addEventListener('click', () => marcarProfessoresVisiveis(true));
    document.getElementById('botaoLimparExcecao')
        .addEventListener('click', () => marcarProfessoresVisiveis(false));
    document.getElementById('botaoGerarRelatorio').addEventListener('click', gerarRelatorio);

    document.getElementById('formContatoGestor')
        .addEventListener('submit', salvarContatoGestor);
    limitarCampoTelefone(document.getElementById('contaGestorTelefone'));
    document.getElementById('formSenhaGestor')
        .addEventListener('submit', trocarMinhaSenhaGestor);

    document.getElementById('relDe').value = somarDias(hojeISO(), -30);
    document.getElementById('relAte').value = somarDias(hojeISO(), 30);
}

/* ------------------------------------------------------------------ */
/* Laboratorios                                                        */
/* ------------------------------------------------------------------ */

async function carregarLaboratorios() {
    estadoAdmin.laboratorios = await API.get('/api/laboratorios?todos=1');
    const corpo = document.getElementById('corpoLaboratorios');
    const vazio = document.getElementById('vazioLaboratorios');

    corpo.innerHTML = estadoAdmin.laboratorios.map((lab) => `
        <tr>
            <td data-rotulo="Laboratório">
                <strong>${escapar(lab.nome)}</strong>
                ${lab.observacoes ? `<br><span class="texto-suave" style="font-size:.78rem">${escapar(lab.observacoes)}</span>` : ''}
            </td>
            <td data-rotulo="Tipo">${escapar(lab.tipo || '—')}</td>
            <td data-rotulo="Capacidade">${lab.capacidade} alunos<br>
                <span class="texto-suave" style="font-size:.76rem">${lab.equipamentos || 0} equip.</span></td>
            <td data-rotulo="Responsável">${escapar(lab.responsavel || '—')}</td>
            <td data-rotulo="Situação">
                ${lab.ativo
                    ? '<span class="selo selo--ativa">Ativo</span>'
                    : '<span class="selo selo--cancelada">Inativo</span>'}
            </td>
            <td data-rotulo="Ações">
                <div class="barra-botoes" style="justify-content:flex-end">
                    <button class="botao botao--pequeno botao--vazio"
                            data-editar-lab="${lab.id}">Editar</button>
                    <button class="botao botao--pequeno botao--perigo"
                            data-excluir-lab="${lab.id}">Excluir</button>
                </div>
            </td>
        </tr>`).join('');

    vazio.innerHTML = estadoAdmin.laboratorios.length ? '' : `
        <div class="lista-vazia">
            <strong>Nenhum laboratório cadastrado</strong>
            Clique em “Novo laboratório” para começar.
        </div>`;

    const opcoes = '<option value="">Todos</option>' + estadoAdmin.laboratorios
        .map((lab) => `<option value="${lab.id}">${escapar(lab.nome)}</option>`).join('');
    document.getElementById('filtroLaboratorio').innerHTML = opcoes;
    document.getElementById('usoLaboratorio').innerHTML = opcoes;
    document.getElementById('bloqueioLaboratorio').innerHTML =
        '<option value="">Toda a escola</option>' + estadoAdmin.laboratorios
            .map((lab) => `<option value="${lab.id}">${escapar(lab.nome)}</option>`).join('');
}

function abrirFormularioLaboratorio(laboratorio) {
    const lab = laboratorio || {};
    abrirModal({
        titulo: lab.id ? 'Editar laboratório' : 'Novo laboratório',
        subtitulo: 'Os dados aparecem para o professor na hora de reservar.',
        corpo: `
            <div class="campo">
                <label for="labNome">Nome / identificação</label>
                <input type="text" id="labNome" value="${escapar(lab.nome || '')}"
                       placeholder="ex.: Laboratório de Informática 2">
            </div>
            <div class="linha-campos linha-campos--2">
                <div class="campo">
                    <label for="labTipo">Tipo</label>
                    <input type="text" id="labTipo" value="${escapar(lab.tipo || '')}"
                           placeholder="Informática, Ciências…">
                </div>
                <div class="campo">
                    <label for="labResponsavel">Responsável</label>
                    <input type="text" id="labResponsavel" value="${escapar(lab.responsavel || '')}">
                </div>
            </div>
            <div class="linha-campos linha-campos--2">
                <div class="campo">
                    <label for="labCapacidade">Capacidade (alunos)</label>
                    <input type="number" id="labCapacidade" min="1" max="200"
                           value="${lab.capacidade || 30}">
                </div>
                <div class="campo">
                    <label for="labEquipamentos">Computadores / equipamentos</label>
                    <input type="number" id="labEquipamentos" min="0" max="200"
                           value="${lab.equipamentos || 0}">
                </div>
            </div>
            <div class="campo">
                <label for="labObservacoes">Observações (softwares, regras de uso)</label>
                <textarea id="labObservacoes">${escapar(lab.observacoes || '')}</textarea>
            </div>
            ${lab.id ? `
            <label class="checkbox">
                <input type="checkbox" id="labAtivo" ${lab.ativo ? 'checked' : ''}>
                <span>Laboratório ativo (aparece para os professores)</span>
            </label>` : ''}
            <div id="erroLab" class="aviso aviso--erro oculto"></div>`,
        textoCancelar: 'Cancelar',
        textoConfirmar: lab.id ? 'Salvar' : 'Cadastrar',
        aoConfirmar: async (modal) => {
            const dados = {
                nome: modal.querySelector('#labNome').value.trim(),
                tipo: modal.querySelector('#labTipo').value.trim(),
                responsavel: modal.querySelector('#labResponsavel').value.trim(),
                capacidade: Number(modal.querySelector('#labCapacidade').value) || 30,
                equipamentos: Number(modal.querySelector('#labEquipamentos').value) || 0,
                observacoes: modal.querySelector('#labObservacoes').value.trim(),
                ativo: lab.id ? modal.querySelector('#labAtivo').checked : true,
            };
            try {
                if (lab.id) {
                    await API.put(`/api/gestor/laboratorios/${lab.id}`, dados);
                } else {
                    await API.post('/api/gestor/laboratorios', dados);
                }
                await carregarLaboratorios();
                notificar(lab.id ? 'Laboratório atualizado.' : 'Laboratório cadastrado.');
                return true;
            } catch (falha) {
                mostrarErro(modal.querySelector('#erroLab'), falha.message);
                return false;
            }
        },
    });
}

function aoClicarLaboratorio(evento) {
    const editar = evento.target.closest('[data-editar-lab]');
    if (editar) {
        const lab = estadoAdmin.laboratorios
            .find((item) => item.id === Number(editar.dataset.editarLab));
        abrirFormularioLaboratorio(lab);
        return;
    }

    const excluir = evento.target.closest('[data-excluir-lab]');
    if (!excluir) return;
    const lab = estadoAdmin.laboratorios
        .find((item) => item.id === Number(excluir.dataset.excluirLab));

    abrirModal({
        titulo: 'Excluir laboratório',
        subtitulo: lab.nome,
        corpo: `<p>O laboratório sai da lista e todo o histórico de reservas dele
                   é apagado. Essa ação não pode ser desfeita.</p>
                <p class="texto-suave">Para apenas tirar de circulação sem perder o
                   histórico, use <strong>Editar</strong> e desmarque “Laboratório ativo”.</p>`,
        textoCancelar: 'Voltar',
        textoConfirmar: 'Excluir',
        perigo: true,
        aoConfirmar: async () => {
            try {
                await API.del(`/api/gestor/laboratorios/${lab.id}`);
            } catch (falha) {
                if (falha.dados && falha.dados.confirmar) {
                    const confirmado = window.confirm(
                        `${falha.message}\n\nExcluir mesmo assim? As reservas serão apagadas.`);
                    if (!confirmado) return false;
                    await API.del(`/api/gestor/laboratorios/${lab.id}?forcar=1`);
                } else {
                    notificar(falha.message, 'erro');
                    return false;
                }
            }
            await carregarLaboratorios();
            notificar('Laboratório excluído.');
            return true;
        },
    });
}

/* ------------------------------------------------------------------ */
/* Professores                                                         */
/* ------------------------------------------------------------------ */

async function carregarProfessores() {
    estadoAdmin.professores = await API.get('/api/gestor/professores');
    desenharProfessores();
    desenharVisibilidadeGrade();
    montarFiltroDeProfessoresDoUso();
}

/** Nomes do filtro por professor do histórico de uso dos computadores. */
function montarFiltroDeProfessoresDoUso() {
    const seletor = document.getElementById('usoProfessor');
    const escolhido = seletor.value;
    seletor.innerHTML = '<option value="">Todos</option>'
        + estadoAdmin.professores.map((professor) => `
            <option value="${professor.id}">${escapar(professor.nome)}</option>`).join('');
    seletor.value = escolhido;
}

/** Tira acento e caixa alta para comparar: "José" e "jose" viram iguais. */
function normalizar(texto) {
    return String(texto === null || texto === undefined ? '' : texto)
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase();
}

/**
 * O mesmo texto digitado e procurado em nome, matricula, e-mail e telefone.
 * No telefone a comparacao e so entre digitos, entao tanto "11987650001"
 * quanto "11 98765-0001" encontram o mesmo professor.
 */
function professorCombina(professor, termo, digitos) {
    if (normalizar(professor.nome).includes(termo)) return true;
    if (normalizar(professor.matricula).includes(termo)) return true;
    if (normalizar(professor.email).includes(termo)) return true;

    const telefone = String(professor.telefone || '').replace(/\D/g, '');
    return Boolean(digitos) && telefone.includes(digitos);
}

function desenharProfessores() {
    const termo = normalizar(document.getElementById('buscaProfessor').value.trim());
    const digitos = termo.replace(/\D/g, '');
    const total = estadoAdmin.professores.length;
    const lista = termo
        ? estadoAdmin.professores.filter((prof) => professorCombina(prof, termo, digitos))
        : estadoAdmin.professores;

    const corpo = document.getElementById('corpoProfessores');

    corpo.innerHTML = lista.map((professor) => `
        <tr>
            <td data-rotulo="Professor">
                <div class="celula-pessoa">
                    <div class="avatar">${avatarHTML(professor)}</div>
                    <button type="button" class="nome-acao"
                            data-perfil-prof="${professor.id}"
                            title="Ver a ficha de ${escapar(professor.nome)}"
                    >${escapar(professor.nome)}</button>
                </div>
            </td>
            <td data-rotulo="Matrícula" class="mono">${escapar(professor.matricula)}</td>
            <td data-rotulo="E-mail">${escapar(professor.email || '—')}</td>
            <td data-rotulo="Telefone" class="mono">
                ${escapar(formatarTelefone(professor.telefone) || '—')}
            </td>
            <td data-rotulo="Disciplina">${escapar(professor.disciplina || '—')}</td>
            <td data-rotulo="Reservas">${professor.total_reservas}</td>
            <td data-rotulo="Situação">
                ${professor.ativo
                    ? '<span class="selo selo--ativa">Ativo</span>'
                    : '<span class="selo selo--cancelada">Inativo</span>'}
                ${professor.tem_senha
                    ? ''
                    : '<br><span class="selo selo--falta" style="margin-top:4px">Sem senha</span>'}
            </td>
            <td data-rotulo="Ações">
                <div class="barra-botoes" style="justify-content:flex-end">
                    <button class="botao botao--pequeno botao--vazio"
                            data-senha-prof="${professor.id}">Senha e envio</button>
                    <button class="botao botao--pequeno botao--vazio"
                            data-editar-prof="${professor.id}">Editar</button>
                    <button class="botao botao--pequeno botao--perigo"
                            data-excluir-prof="${professor.id}">Excluir</button>
                </div>
            </td>
        </tr>`).join('');

    let vazio = '';
    if (!total) {
        vazio = `
        <div class="lista-vazia">
            <strong>Nenhum professor cadastrado</strong>
            Cadastre os professores para que eles consigam entrar no sistema.
        </div>`;
    } else if (!lista.length) {
        vazio = `
        <div class="lista-vazia">
            <strong>Nenhum professor encontrado</strong>
            Nada bateu com essa busca. Confira a escrita ou tente só uma parte
            do nome, da matrícula, do e-mail ou do telefone.
        </div>`;
    }
    document.getElementById('vazioProfessores').innerHTML = vazio;

    const contagem = document.getElementById('contagemProfessores');
    if (!total) {
        contagem.textContent = '';
    } else if (termo) {
        contagem.textContent = `${lista.length.toLocaleString('pt-BR')} de `
            + `${total.toLocaleString('pt-BR')} ${total === 1 ? 'professor' : 'professores'}`;
    } else {
        contagem.textContent = `${total.toLocaleString('pt-BR')} `
            + `${total === 1 ? 'professor cadastrado' : 'professores cadastrados'}`;
    }
}

/** Tela de envio do acesso do professor (a função geral mora em api.js). */
function enviarAcessoProfessor(professor, senha) {
    return abrirModalCredenciais({
        nome: professor.nome,
        rotulo: 'Matrícula',
        identificador: professor.matricula,
        senha,
        base: `/api/gestor/professores/${professor.id}`,
        papel: 'professor',
    });
}

function abrirFormularioProfessor(professor) {
    const prof = professor || {};
    const novo = !prof.id;

    const modal = abrirModal({
        titulo: novo ? 'Novo professor' : 'Editar professor',
        subtitulo: novo
            ? 'A matrícula é gerada pelo sistema. Defina a senha e envie o acesso.'
            : 'A matrícula é definitiva e não pode ser alterada.',
        corpo: `
            <div class="campo">
                <label for="profNome">Nome completo</label>
                <input type="text" id="profNome" value="${escapar(prof.nome || '')}"
                       placeholder="ex.: Fernanda Souza">
            </div>

            ${novo ? `
            <div class="aviso aviso--info">
                <div><strong>Matrícula automática</strong>
                O sistema gera o número no momento do cadastro (de 4 a 7 dígitos,
                em sequência).</div>
            </div>` : `
            <div class="campo">
                <label for="profMatricula">Matrícula (gerada pelo sistema)</label>
                <input type="text" id="profMatricula" class="mono"
                       value="${escapar(prof.matricula || '')}" disabled>
            </div>`}

            <div class="linha-campos linha-campos--2">
                <div class="campo">
                    <label for="profEmail">E-mail institucional</label>
                    <input type="text" id="profEmail" value="${escapar(prof.email || '')}"
                           placeholder="nome@escola.edu.br">
                </div>
                <div class="campo">
                    <label for="profTelefone">WhatsApp (com DDD)</label>
                    <input type="text" id="profTelefone" class="mono"
                           value="${escapar(prof.telefone || '')}"
                           placeholder="(81)9 8458-7555">
                </div>
            </div>

            <div class="campo">
                <label for="profDisciplina">Disciplina principal</label>
                <input type="text" id="profDisciplina" value="${escapar(prof.disciplina || '')}"
                       placeholder="ex.: Química">
            </div>

            ${novo ? `
            <div class="campo">
                <label for="profSenha">Senha de acesso do professor</label>
                <div class="barra-botoes" style="flex-wrap:nowrap">
                    <input type="text" id="profSenha" class="mono"
                           placeholder="mínimo 4 caracteres">
                    <button type="button" class="botao botao--vazio botao--pequeno"
                            id="botaoSortearSenha">Gerar</button>
                </div>
            </div>
            <p class="dica">A senha aparece só uma vez, na tela de envio.
               Depois disso ela fica guardada de forma criptografada.</p>` : `
            <label class="checkbox">
                <input type="checkbox" id="profAtivo" ${prof.ativo ? 'checked' : ''}>
                <span>Professor ativo (consegue entrar e reservar)</span>
            </label>`}

            <div id="erroProf" class="aviso aviso--erro oculto"></div>`,
        textoCancelar: 'Cancelar',
        textoConfirmar: novo ? 'Cadastrar e enviar acesso' : 'Salvar',
        aoConfirmar: async (janela) => {
            const dados = {
                nome: janela.querySelector('#profNome').value.trim(),
                disciplina: janela.querySelector('#profDisciplina').value.trim(),
                email: janela.querySelector('#profEmail').value.trim(),
                telefone: soDigitos(janela.querySelector('#profTelefone').value),
            };

            const avisoTelefone = erroTelefone(dados.telefone);
            if (avisoTelefone) {
                mostrarErro(janela.querySelector('#erroProf'), avisoTelefone);
                janela.querySelector('#profTelefone').focus();
                return false;
            }

            try {
                if (novo) {
                    dados.senha = janela.querySelector('#profSenha').value.trim();
                    if (dados.senha.length < 4) {
                        mostrarErro(janela.querySelector('#erroProf'),
                                    'Defina uma senha com pelo menos 4 caracteres.');
                        return false;
                    }
                    const resposta = await API.post('/api/gestor/professores', dados);
                    await carregarProfessores();
                    notificar(`Professor cadastrado — matrícula ${resposta.professor.matricula}.`);
                    // abre depois que esta janela fechar, para não ser apagada
                    setTimeout(() => enviarAcessoProfessor(resposta.professor, dados.senha), 0);
                    return true;
                }

                dados.ativo = janela.querySelector('#profAtivo').checked;
                await API.put(`/api/gestor/professores/${prof.id}`, dados);
                await carregarProfessores();
                notificar('Professor atualizado.');
                return true;
            } catch (falha) {
                mostrarErro(janela.querySelector('#erroProf'), falha.message);
                return false;
            }
        },
    });

    if (!modal) return;

    limitarCampoTelefone(modal.querySelector('#profTelefone'));

    if (novo) {
        const campoSenha = modal.querySelector('#profSenha');
        campoSenha.value = sortearSenha();
        modal.querySelector('#botaoSortearSenha').addEventListener('click', () => {
            campoSenha.value = sortearSenha();
        });
    }
}

async function abrirRedefinirSenha(professor) {
    const modal = abrirModal({
        titulo: 'Senha e envio de acesso',
        subtitulo: `${professor.nome} — matrícula ${professor.matricula}`,
        corpo: `
            <p>Defina uma nova senha para o professor. A senha anterior deixa de valer
               assim que você confirmar.</p>
            <div class="campo">
                <label for="novaSenhaProf">Nova senha</label>
                <div class="barra-botoes" style="flex-wrap:nowrap">
                    <input type="text" id="novaSenhaProf" class="mono"
                           placeholder="mínimo 4 caracteres">
                    <button type="button" class="botao botao--vazio botao--pequeno"
                            id="botaoSortearSenha2">Gerar</button>
                </div>
            </div>
            <div id="erroSenhaProf" class="aviso aviso--erro oculto"></div>`,
        textoCancelar: 'Cancelar',
        textoConfirmar: 'Definir e enviar',
        aoConfirmar: async (janela) => {
            const senha = janela.querySelector('#novaSenhaProf').value.trim();
            if (senha.length < 4) {
                mostrarErro(janela.querySelector('#erroSenhaProf'),
                            'A senha precisa ter pelo menos 4 caracteres.');
                return false;
            }
            try {
                await API.post(`/api/gestor/professores/${professor.id}/senha`, { senha });
                await carregarProfessores();
                notificar('Senha definida.');
                setTimeout(() => enviarAcessoProfessor(professor, senha), 0);
                return true;
            } catch (falha) {
                mostrarErro(janela.querySelector('#erroSenhaProf'), falha.message);
                return false;
            }
        },
    });

    if (modal) {
        const campo = modal.querySelector('#novaSenhaProf');
        campo.value = sortearSenha();
        modal.querySelector('#botaoSortearSenha2').addEventListener('click', () => {
            campo.value = sortearSenha();
        });
    }
}

/**
 * Ficha do professor: o nome na lista abre esta consulta, e a alteracao
 * continua no formulario de sempre, pelo botao "Editar cadastro".
 */
function abrirPerfilProfessor(professor) {
    if (!professor) return;

    abrirPerfil({
        nome: professor.nome,
        subtitulo: `Matrícula ${professor.matricula}`,
        itens: [
            ['Matrícula', professor.matricula, 'mono'],
            ['Disciplina', professor.disciplina || '—'],
            ['Aulas na grade', String(professor.total_aulas || 0)],
            ['Aulas reservadas', String(professor.total_reservas)],
        ],
        telefone: professor.telefone,
        email: professor.email,
        situacao: `<strong>${professor.ativo
            ? '<span class="selo selo--ativa">Ativo</span>'
            : '<span class="selo selo--cancelada">Inativo</span>'}
            ${professor.tem_senha
                ? ''
                : '<span class="selo selo--falta">Sem senha</span>'}
            ${professor.grade_visivel
                ? ''
                : '<span class="selo selo--falta">Fora da grade da escola</span>'}</strong>`,
        editar: {
            texto: 'Editar cadastro',
            ao: () => abrirFormularioProfessor(professor),
        },
        extra: {
            texto: 'Grade de aulas',
            ao: () => abrirGradeProfessor(professor),
        },
    });
}

const DIAS_UTEIS_GRADE = ['Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta'];

/** A semana aberta na tela; sem nada escolhido ainda, a de hoje. */
function semanaDaGrade() {
    if (!estadoAdmin.semanaGrade) estadoAdmin.semanaGrade = segundaDaSemana();
    return estadoAdmin.semanaGrade;
}

function irParaSemana(inicio) {
    estadoAdmin.semanaGrade = segundaDaSemana(inicio);
    // cada semana abre no dia de hoje, ou na segunda quando é outra semana
    estadoAdmin.diaGrade = diaUtilDeHoje(estadoAdmin.semanaGrade);
    carregarGradeEscola();
}

/**
 * Visão consolidada da escola: todas as aulas da semana escolhida, de todos os
 * professores, num só grid. Clicar numa aula abre a grade daquele professor
 * para editar — a leitura é feita aqui, mas a edição continua lá.
 *
 * O que aparece é o padrão de cada professor já somado às alterações daquela
 * semana; as que valem só ali ficam marcadas como "só nesta semana".
 */
async function carregarGradeEscola() {
    let dados;
    try {
        dados = await API.get(`/api/gestor/grade-escola?inicio=${semanaDaGrade()}`);
    } catch (falha) {
        document.getElementById('gradeEscola').innerHTML = '';
        desenharSeletorDias('seletorDiasGrade', [], 0);
        document.getElementById('vazioGradeEscola').innerHTML =
            '<div class="lista-vazia">Não foi possível carregar a grade: '
            + `${escapar(falha.message)}</div>`;
        notificar(falha.message, 'erro');
        return;
    }

    estadoAdmin.gradeEscola = dados;
    estadoAdmin.semanaGrade = dados.semana.inicio;
    if (estadoAdmin.diaGrade === null) {
        estadoAdmin.diaGrade = diaUtilDeHoje(dados.semana.inicio);
    }
    mostrarRotuloDaSemana(dados.semana, 'rotuloSemana', 'voltarSemanaAtual');
    desenharGradeEscola();
}

/**
 * Desenha a grade já carregada. No computador sai a semana inteira lado a
 * lado, com todos os professores; no celular sai um dia de cada vez e, quando
 * o gestor escolhe um professor ou uma turma no seletor de cima, sai a grade
 * só daquela pessoa — a mesma tela que o professor vê em "Meu horário".
 */
function desenharGradeEscola() {
    const dados = estadoAdmin.gradeEscola;
    if (!dados) return;
    const alvo = document.getElementById('gradeEscola');
    const vazio = document.getElementById('vazioGradeEscola');
    const { horarios, aulas } = dados;

    if (!horarios.length) {
        alvo.innerHTML = '';
        desenharSeletorDias('seletorDiasGrade', [], 0);
        vazio.innerHTML = '<div class="lista-vazia">Cadastre os horários da escola '
            + '(aba Horários) para ver a grade da escola.</div>';
        return;
    }
    vazio.innerHTML = '';

    const semana = diasUteisDaSemana(dados.semana.inicio);
    desenharSeletorDias('seletorDiasGrade', semana, estadoAdmin.diaGrade);
    montarFocoDaGrade(aulas);
    const dias = diasVisiveisDaGrade(semana, estadoAdmin.diaGrade);

    // no celular, com um professor ou uma turma escolhidos, a grade sai igual
    // à do professor: um cartão por aula, em ordem, no dia aberto
    const foco = focoDaGrade();
    if (foco) {
        desenharGradeDoFoco(foco, dias, dados, alvo, vazio);
        return;
    }
    alvo.classList.add('grade');
    alvo.style.setProperty('--colunas', dias.length);

    const mapaAulas = {};
    aulas.forEach((aula) => {
        const chave = `${aula.dia_semana}-${aula.horario_id}`;
        (mapaAulas[chave] = mapaAulas[chave] || []).push(aula);
    });

    let html = '<div class="grade__hora grade__cabecalho-canto"></div>';
    html += dias.map((dia) => `
        <div class="grade__cabecalho-dia${dia.hoje ? ' hoje' : ''}">
            <strong>${escapar(dia.rotulo)}</strong>
            <span>${escapar(dia.dia_mes)}</span>
        </div>`).join('');

    let turnoAtual = null;
    horarios.forEach((horario, indice) => {
        const numero = indice + 1;
        if (horario.turno !== turnoAtual) {
            turnoAtual = horario.turno;
            html += `<div class="grade__turno">${ROTULO_TURNO[turnoAtual] || turnoAtual}</div>`;
        }
        html += `<div class="grade__hora">
                        <span>${numero}ª aula</span>
                        <span>${escapar(horario.inicio)}</span>
                        <span>${escapar(horario.fim)}</span>
                   </div>`;
        dias.forEach((dia) => {
            const lista = mapaAulas[`${dia.indice}-${horario.id}`] || [];
            // o horário só aparece dentro da célula no celular, onde a coluna
            // da hora fica escondida
            html += `<div class="celula celula--multi${lista.length ? '' : ' celula--vazia'}">
                        <span class="celula__hora">${numero}ª · ${escapar(horario.inicio)}–${escapar(horario.fim)}</span>`;
            if (!lista.length) {
                html += '<span class="celula__vazio">Sem aulas</span>';
            } else {
                html += lista.map((aula) => `
                    <button type="button"
                            class="aula-chip${aula.excecao ? ' aula-chip--excecao' : ''}"
                            data-professor-id="${aula.professor_id}">
                        <strong>${escapar(aula.turma || 'Sem turma')}</strong>
                        <span>${escapar(aula.professor)}${aula.sala
                            ? ` · ${escapar(aula.sala)}` : ''}</span>
                        ${aula.excecao
                            ? '<span class="marca-excecao">só nesta semana</span>' : ''}
                    </button>`).join('');
            }
            html += '</div>';
        });
    });
    alvo.innerHTML = html;
}

/* ---- Celular: a grade de um professor ou de uma turma de cada vez ---- */
//
// A escola inteira nao cabe numa tela de celular: com todo mundo junto, cada
// horario vira uma pilha de aulas e nao da para ler a de ninguem. Entao o
// gestor escolhe de quem e o horario, e a grade sai igual a que o professor ve
// em "Meu horario" -- mesmos cartoes, mesma navegacao de semana, mesmo seletor
// de dias (tudo vem do api.js). No computador o seletor some e a visao
// consolidada continua como sempre foi.

/** Monta as opcoes do seletor a partir de quem tem aula na semana carregada. */
function montarFocoDaGrade(aulas) {
    const seletor = document.getElementById('focoDaGrade');
    if (!seletor) return;

    const professores = [...new Map(aulas.map((aula) =>
        [aula.professor_id, aula.professor])).entries()]
        .sort((a, b) => String(a[1]).localeCompare(String(b[1]), 'pt-BR'));
    const turmas = [...new Set(aulas.map((aula) => aula.turma).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b, 'pt-BR'));

    const grupo = (rotulo, itens) => (itens.length
        ? `<optgroup label="${rotulo}">${itens.join('')}</optgroup>` : '');

    seletor.innerHTML = '<option value="">Toda a escola</option>'
        + grupo('Professores', professores.map(([id, nome]) =>
            `<option value="p${id}">${escapar(nome)}</option>`))
        + grupo('Turmas', turmas.map((turma) =>
            `<option value="t${escapar(turma)}">${escapar(turma)}</option>`));

    // a escolha atravessa a troca de semana; se aquele professor (ou turma)
    // nao tem aula na semana nova, a tela volta para a escola toda em vez de
    // ficar com um seletor apontando para o nada
    seletor.value = estadoAdmin.focoGrade || '';
    estadoAdmin.focoGrade = seletor.value;
}

/** O que esta escolhido, so no celular: no computador a escola toda cabe. */
function focoDaGrade() {
    if (!telaMobile.matches || !estadoAdmin.focoGrade) return null;
    const escolha = estadoAdmin.focoGrade;
    return escolha.startsWith('p')
        ? { professorId: Number(escolha.slice(1)) }
        : { turma: escolha.slice(1) };
}

/**
 * A grade de um so professor (ou de uma so turma), com os cartoes do api.js.
 *
 * As aulas vem da mesma resposta que ja monta a visao da escola -- o filtro e
 * daqui, nao do servidor, entao trocar de professor no seletor nao pede nada
 * de novo.
 */
function desenharGradeDoFoco(foco, dias, dados, alvo, vazio) {
    const { horarios, aulas } = dados;
    const doFoco = aulas.filter((aula) => (foco.professorId !== undefined
        ? aula.professor_id === foco.professorId
        : aula.turma === foco.turma));

    if (!doFoco.length) {
        alvo.classList.remove('grade');
        alvo.innerHTML = '';
        vazio.innerHTML = '<div class="lista-vazia">Sem aulas nesta semana.</div>';
        return;
    }

    // Duas aulas no mesmo horario e um choque que o gestor pode ter confirmado
    // na hora de gravar (a tela avisa, mas deixa passar). A grade so tem lugar
    // para uma por horario, entao a outra vai para o rodape do cartao, senao
    // sumiria da tela justo para quem precisa enxergar o problema.
    const porHorario = new Map();
    doFoco.forEach((aula) => {
        const chave = `${aula.dia_semana}-${aula.horario_id}`;
        porHorario.set(chave, [...(porHorario.get(chave) || []), aula]);
    });
    const primeiras = [...porHorario.values()].map((lista) => lista[0]);
    const junto = (aula) => (porHorario.get(`${aula.dia_semana}-${aula.horario_id}`) || [])
        .slice(1);

    // Olhando o horario de um professor, o cartao e igualzinho ao da tela dele:
    // turma em cima, disciplina embaixo. Olhando o de uma turma, repetir o nome
    // dela em todo cartao gastaria a linha de cima -- ali vai a disciplina, e
    // embaixo quem da a aula.
    const porProfessor = foco.professorId !== undefined;
    const titulo = (aula) => (porProfessor
        ? (aula.turma || 'Sem turma')
        : (aula.disciplina || 'Sem disciplina'));
    const detalhe = (aula) => (porProfessor
        ? (aula.disciplina || '')
        : aula.professor);

    alvo.classList.remove('grade');
    alvo.style.removeProperty('--colunas');
    alvo.innerHTML = gradeHTML(
        linhasDaGrade(primeiras, horarios),
        dias,
        (aula) => `
            ${aula.sala ? `<span class="celula__detalhe">${escapar(aula.sala)}</span>` : ''}
            ${aula.excecao ? '<span class="marca-excecao">só nesta semana</span>' : ''}
            ${junto(aula).map((outra) => `<span class="celula__detalhe">
                também: ${escapar(titulo(outra))} ·
                ${escapar(detalhe(outra))}</span>`).join('')}`,
        {
            titulo,
            detalhe,
            // o toque no cartao abre a grade daquele professor, como o chip da
            // visao da escola
            extras: (aula) => `data-professor-id="${aula.professor_id}"`,
        });
}

function aoClicarAulaDaGrade(evento) {
    const aula = evento.target.closest('.aula-chip, .celula[data-professor-id]');
    if (!aula) return;
    const professor = estadoAdmin.professores.find(
        (item) => item.id === Number(aula.dataset.professorId));
    if (professor) abrirGradeProfessor(professor);
}

/**
 * Grade semanal de aulas do professor (turma/disciplina por dia e aula),
 * independente da reserva de laboratório — só usa os horários da escola
 * (aba Horários) para montar as linhas.
 */
async function abrirGradeProfessor(professor) {
    let dados;
    const inicioSemana = semanaDaGrade();
    try {
        dados = await API.get(
            `/api/gestor/professores/${professor.id}/grade?inicio=${inicioSemana}`);
    } catch (falha) {
        notificar(falha.message, 'erro');
        return;
    }

    const { horarios, celulas, salas, ocupadas, semana, excecoes,
        proxima_mudanca: proximaMudanca } = dados;
    if (!horarios.length) {
        abrirModal({
            titulo: 'Grade de aulas',
            subtitulo: professor.nome,
            corpo: '<p>Cadastre os horários da escola (aba Horários) antes de montar '
                + 'a grade de aulas.</p>',
            textoCancelar: 'Fechar',
        });
        return;
    }

    const mapaCelulas = {};
    celulas.forEach((celula) => {
        mapaCelulas[`${celula.dia_semana}-${celula.horario_id}`] = celula;
    });

    // salas que outros professores ja ocupam no mesmo dia/horario, para marcar
    // em vermelho e barrar a escolha na hora de montar a grade deste professor
    const mapaOcupacao = {};
    (ocupadas || []).forEach((registro) => {
        mapaOcupacao[`${registro.dia_semana}-${registro.horario_id}-${registro.sala_id}`] = registro;
    });

    // a chave individual: tira este professor da grade que os colegas enxergam,
    // sem mexer no acesso dele nem na chave geral (aba Horários)
    let corpo = `
        <label class="checkbox" style="margin-bottom:12px">
            <input type="checkbox" id="gradeVisivelProfessor"
                   ${professor.grade_visivel ? 'checked' : ''}>
            <span>Aparece na grade da escola que os outros professores veem</span>
        </label>`;
    if (excecoes) {
        corpo += `
            <p class="dica" style="margin-bottom:12px">
                Esta semana tem <strong>alterações próprias</strong>: ${excecoes} aula(s)
                fora do padrão, destacadas em amarelo.
                <button type="button" class="botao botao--vazio botao--pequeno"
                        id="voltarAoPadrao" style="margin-left:8px">
                    Voltar ao padrão nesta semana
                </button>
            </p>`;
    }
    if (proximaMudanca) {
        corpo += `
            <p class="dica" style="margin-bottom:12px">
                O padrão deste professor muda a partir de
                <strong>${dataBR(proximaMudanca)}</strong>.
                <button type="button" class="botao botao--vazio botao--pequeno"
                        id="cancelarGradeAgendada" style="margin-left:8px">
                    Cancelar essa mudança
                </button>
            </p>`;
    }
    // No celular a semana inteira nao cabe: sao cinco dias de campos editaveis
    // empilhados numa coluna so, sem cabecalho de dia (o CSS esconde) -- daria
    // uma lista de dezenas de campos sem dizer de que dia e cada um. Entao aqui
    // tambem se edita um dia de cada vez, pelo mesmo seletor das outras telas.
    // As celulas dos outros dias continuam no modal, so escondidas: e delas que
    // o lerCelulas() monta o PUT, e sumir com elas apagaria a semana toda.
    corpo += '<div class="seletor-dias" id="seletorDiasGradeProf"></div>';
    corpo += `<div class="grade" style="--colunas:${DIAS_UTEIS_GRADE.length}">`;
    corpo += '<div class="grade__hora grade__cabecalho-canto"></div>';
    corpo += DIAS_UTEIS_GRADE.map((dia) => `
        <div class="grade__cabecalho-dia"><strong>${escapar(dia)}</strong></div>`).join('');

    let turnoAtual = null;
    // número corrido do dia (1ª a 9ª, como na planilha da escola): no banco a
    // ordem recomeça a cada turno, por causa da reserva de laboratório
    horarios.forEach((horario, indice) => {
        const numero = indice + 1;
        if (horario.turno !== turnoAtual) {
            turnoAtual = horario.turno;
            corpo += `<div class="grade__turno">${ROTULO_TURNO[turnoAtual] || turnoAtual}</div>`;
        }
        corpo += `<div class="grade__hora">
                        <span>${numero}ª aula</span>
                        <span>${escapar(horario.inicio)}</span>
                        <span>${escapar(horario.fim)}</span>
                   </div>`;
        DIAS_UTEIS_GRADE.forEach((_dia, diaIndice) => {
            const celula = mapaCelulas[`${diaIndice}-${horario.id}`];
            const salaAtual = celula && celula.sala_id ? celula.sala_id : '';
            const opcoes = ['<option value="">Sem sala</option>'].concat(
                salas.map((sala) => {
                    const ocupacao = mapaOcupacao[`${diaIndice}-${horario.id}-${sala.id}`];
                    if (ocupacao) {
                        return `<option value="${sala.id}"
                            ${sala.id === salaAtual ? 'selected' : ''}
                            data-ocupada="1" data-sala="${escapar(sala.nome)}"
                            data-professor="${escapar(ocupacao.professor)}"
                            data-matricula="${escapar(ocupacao.matricula || '—')}"
                            style="color:#c0392b;font-weight:600">
                            🔒 ${escapar(sala.nome)} — ocupada (${escapar(ocupacao.professor)})</option>`;
                    }
                    return `<option value="${sala.id}"
                        ${sala.id === salaAtual ? 'selected' : ''}>${escapar(sala.nome)}</option>`;
                }),
            ).join('');
            corpo += `
                <div class="celula celula--editavel${celula && celula.excecao
                    ? ' celula--excecao' : ''}" data-dia="${diaIndice}">
                    <span class="celula__hora">${numero}ª · ${escapar(horario.inicio)}–${escapar(horario.fim)}</span>
                    <input type="text" class="celula__titulo-campo" placeholder="Turma"
                           maxlength="40" data-dia="${diaIndice}" data-horario="${horario.id}"
                           data-campo="turma" value="${escapar(celula ? celula.turma : '')}">
                    <input type="text" class="celula__detalhe-campo" placeholder="Disciplina"
                           maxlength="80" data-dia="${diaIndice}" data-horario="${horario.id}"
                           data-campo="disciplina"
                           value="${escapar(celula ? celula.disciplina : '')}">
                    <select class="celula__detalhe-campo" data-dia="${diaIndice}"
                            data-horario="${horario.id}" data-campo="sala_id"
                            data-anterior="${salaAtual}"
                            aria-label="Sala">${opcoes}</select>
                </div>`;
        });
    });
    corpo += '</div>';
    corpo += '<p class="dica" style="margin-top:14px">Deixe turma e disciplina em branco '
        + 'para marcar a aula como livre. A sala é opcional.</p>';
    corpo += `
        <p class="dica"><strong>Salvar nesta semana</strong> muda só a semana de
        ${dataBR(semana.inicio).slice(0, 5)} a ${dataBR(semana.fim)}.
        <strong>Salvar como grade padrão</strong> passa a valer desta semana em diante,
        nas semanas que ainda não têm alterações próprias.</p>
        <div style="display:flex;justify-content:flex-end;margin-top:10px">
            <button type="button" class="botao botao--vazio botao--pequeno"
                    id="salvarComoPadrao">Salvar como grade padrão</button>
        </div>`;

    /** Lê a grade desenhada no modal e devolve o corpo do PUT. */
    const lerCelulas = (modalElemento) => {
        const porCelula = {};
        modalElemento.querySelectorAll(
            '.celula--editavel input, .celula--editavel select',
        ).forEach((campo) => {
            const chave = `${campo.dataset.dia}-${campo.dataset.horario}`;
            if (!porCelula[chave]) {
                porCelula[chave] = {
                    dia_semana: Number(campo.dataset.dia),
                    horario_id: Number(campo.dataset.horario),
                    turma: '', disciplina: '', sala_id: null,
                };
            }
            const valor = campo.value.trim();
            porCelula[chave][campo.dataset.campo] =
                campo.dataset.campo === 'sala_id' ? (Number(valor) || null) : valor;
        });
        return Object.values(porCelula);
    };

    /**
     * `escopo: 'semana'` grava a alteração só nos cinco dias dessa semana;
     * `escopo: 'padrao'` grava no padrão, valendo dessa semana em diante.
     */
    const gravar = async (modalElemento, escopo) => {
        const corpoEnvio = {
            celulas: lerCelulas(modalElemento),
            inicio: semana.inicio,
            escopo,
        };
        const rota = `/api/gestor/professores/${professor.id}/grade`;
        try {
            try {
                await API.put(rota, corpoEnvio);
            } catch (falha) {
                // sala ou turma em dois lugares ao mesmo tempo: o gestor decide
                if (!falha.dados || !falha.dados.confirmar) throw falha;
                if (!window.confirm(`${falha.message}\n\nSalvar mesmo assim?`)) return false;
                await API.put(`${rota}?forcar=1`, corpoEnvio);
            }
            const visivel = modalElemento.querySelector('#gradeVisivelProfessor').checked;
            if (visivel !== Boolean(professor.grade_visivel)) {
                await API.post(`/api/gestor/professores/${professor.id}/visibilidade`,
                    { grade_visivel: visivel });
            }
            await carregarProfessores();
            carregarGradeEscola();
            notificar(escopo === 'padrao'
                ? 'Grade padrão atualizada desta semana em diante.'
                : 'Grade desta semana salva.');
            return true;
        } catch (falha) {
            notificar(falha.message, 'erro');
            return false;
        }
    };

    const modal = abrirModal({
        titulo: 'Grade de aulas',
        subtitulo: `${professor.nome} — semana de `
            + `${dataBR(semana.inicio).slice(0, 5)} a ${dataBR(semana.fim)}`,
        corpo,
        textoCancelar: 'Fechar',
        textoConfirmar: 'Salvar nesta semana',
        aoConfirmar: (modalElemento) => gravar(modalElemento, 'semana'),
        // a grade inteira e preenchida a mao: so sai pelo X ou pelo Fechar,
        // para um clique fora da janela nao apagar o trabalho
        travado: true,
    });
    if (modal) {
        modal.classList.add('modal--largo');

        // Celular: abre no mesmo dia que estava aberto na tela de tras (quem
        // tocou numa aula de terca continua na terca). No computador o CSS
        // esconde o seletor e a semana inteira aparece de uma vez.
        const diasDaSemana = diasUteisDaSemana(semana.inicio);
        let diaAberto = estadoAdmin.diaGrade === null ? 0 : estadoAdmin.diaGrade;
        const mostrarDia = (indice) => {
            diaAberto = indice;
            desenharSeletorDias('seletorDiasGradeProf', diasDaSemana, indice);
            modal.querySelectorAll('.celula--editavel').forEach((celula) => {
                celula.classList.toggle('celula--outro-dia',
                                        Number(celula.dataset.dia) !== indice);
            });
        };
        mostrarDia(diaAberto);
        ligarSeletorDias('seletorDiasGradeProf', mostrarDia);

        const botaoPadrao = modal.querySelector('#salvarComoPadrao');
        if (botaoPadrao) {
            botaoPadrao.addEventListener('click', async () => {
                botaoPadrao.disabled = true;
                try {
                    if (await gravar(modal, 'padrao')) fecharModal();
                } finally {
                    botaoPadrao.disabled = false;
                }
            });
        }

        const botaoVoltarAoPadrao = modal.querySelector('#voltarAoPadrao');
        if (botaoVoltarAoPadrao) {
            botaoVoltarAoPadrao.addEventListener('click', async () => {
                try {
                    await API.del(`/api/gestor/professores/${professor.id}/grade/semana`
                        + `?inicio=${semana.inicio}`);
                    notificar('Semana devolvida ao padrão.');
                    fecharModal();
                    carregarGradeEscola();
                    abrirGradeProfessor(professor);
                } catch (falha) {
                    notificar(falha.message, 'erro');
                }
            });
        }

        const botaoCancelarAgendamento = modal.querySelector('#cancelarGradeAgendada');
        if (botaoCancelarAgendamento) {
            botaoCancelarAgendamento.addEventListener('click', async () => {
                try {
                    await API.del(`/api/gestor/professores/${professor.id}/grade/agendada`);
                    notificar('Mudança do padrão cancelada.');
                    fecharModal();
                    carregarGradeEscola();
                    abrirGradeProfessor(professor);
                } catch (falha) {
                    notificar(falha.message, 'erro');
                }
            });
        }
        modal.querySelectorAll('select[data-campo="sala_id"]').forEach((select) => {
            select.addEventListener('change', () => {
                const opcao = select.selectedOptions[0];
                if (opcao && opcao.dataset.ocupada === '1') {
                    const dia = DIAS_UTEIS_GRADE[Number(select.dataset.dia)];
                    window.alert(
                        `A ${opcao.dataset.sala} já está reservada para `
                        + `${opcao.dataset.professor} (matrícula ${opcao.dataset.matricula}) `
                        + `em ${dia} neste horário.\n\nEscolha outra sala.`,
                    );
                    select.value = select.dataset.anterior || '';
                    return;
                }
                select.dataset.anterior = select.value;
            });
        });
    }
}

function aoClicarProfessor(evento) {
    const perfil = evento.target.closest('[data-perfil-prof]');
    if (perfil) {
        abrirPerfilProfessor(estadoAdmin.professores
            .find((item) => item.id === Number(perfil.dataset.perfilProf)));
        return;
    }

    const editar = evento.target.closest('[data-editar-prof]');
    if (editar) {
        const prof = estadoAdmin.professores
            .find((item) => item.id === Number(editar.dataset.editarProf));
        abrirFormularioProfessor(prof);
        return;
    }

    const senha = evento.target.closest('[data-senha-prof]');
    if (senha) {
        const prof = estadoAdmin.professores
            .find((item) => item.id === Number(senha.dataset.senhaProf));
        abrirRedefinirSenha(prof);
        return;
    }

    const excluir = evento.target.closest('[data-excluir-prof]');
    if (!excluir) return;
    const prof = estadoAdmin.professores
        .find((item) => item.id === Number(excluir.dataset.excluirProf));

    abrirModal({
        titulo: 'Excluir professor',
        subtitulo: prof.nome,
        corpo: `<p>O professor perde o acesso e as reservas dele são apagadas.</p>
                <p class="texto-suave">Para manter o histórico, use <strong>Editar</strong>
                   e desmarque “Professor ativo”.</p>`,
        textoCancelar: 'Voltar',
        textoConfirmar: 'Excluir',
        perigo: true,
        aoConfirmar: async () => {
            try {
                await API.del(`/api/gestor/professores/${prof.id}`);
            } catch (falha) {
                if (falha.dados && falha.dados.confirmar) {
                    const confirmado = window.confirm(
                        `${falha.message}\n\nExcluir mesmo assim?`);
                    if (!confirmado) return false;
                    await API.del(`/api/gestor/professores/${prof.id}?forcar=1`);
                } else {
                    notificar(falha.message, 'erro');
                    return false;
                }
            }
            await carregarProfessores();
            notificar('Professor excluído.');
            return true;
        },
    });
}

/* ------------------------------------------------------------------ */
/* Outros gestores da escola                                           */
/* ------------------------------------------------------------------ */

async function carregarGestores() {
    estadoAdmin.gestores = await API.get('/api/gestor/gestores');
    desenharGestores();
}

/** '2026-08-02 14:03:00' -> 'hoje às 14:03' / '02/08/2026'. */
function quandoFoi(iso) {
    if (!iso) return 'nunca entrou';
    const data = paraData(iso);
    const hora = String(iso).slice(11, 16);
    if (paraISO(data) === hojeISO()) return `hoje às ${hora}`;
    if (paraISO(data) === somarDias(hojeISO(), -1)) return `ontem às ${hora}`;
    return dataBR(iso);
}

function gestorCombina(gestor, termo, digitos) {
    if (normalizar(gestor.nome).includes(termo)) return true;
    if (normalizar(gestor.usuario).includes(termo)) return true;
    if (normalizar(gestor.email).includes(termo)) return true;

    const telefone = String(gestor.telefone || '').replace(/\D/g, '');
    return Boolean(digitos) && telefone.includes(digitos);
}

function desenharGestores() {
    const termo = normalizar(document.getElementById('buscaGestor').value.trim());
    const digitos = termo.replace(/\D/g, '');
    const total = estadoAdmin.gestores.length;
    const lista = termo
        ? estadoAdmin.gestores.filter((gestor) => gestorCombina(gestor, termo, digitos))
        : estadoAdmin.gestores;
    const meuId = estadoAdmin.gestor && estadoAdmin.gestor.id;

    document.getElementById('corpoGestores').innerHTML = lista.map((gestor) => `
        <tr>
            <td data-rotulo="Gestor">
                <div class="celula-pessoa">
                    <div class="avatar">${escapar(iniciais(gestor.nome))}</div>
                    <button type="button" class="nome-acao"
                            data-perfil-gestor="${gestor.id}"
                            title="Ver a ficha de ${escapar(gestor.nome)}"
                    >${escapar(gestor.nome)}${gestor.id === meuId ? ' (você)' : ''}</button>
                </div>
            </td>
            <td data-rotulo="Usuário" class="mono">${escapar(gestor.usuario)}</td>
            <td data-rotulo="E-mail">${escapar(gestor.email || '—')}</td>
            <td data-rotulo="Telefone" class="mono">
                ${escapar(formatarTelefone(gestor.telefone) || '—')}
            </td>
            <td data-rotulo="Último acesso">${escapar(quandoFoi(gestor.ultimo_acesso))}</td>
            <td data-rotulo="Situação">
                ${gestor.ativo
                    ? '<span class="selo selo--ativa">Ativo</span>'
                    : '<span class="selo selo--cancelada">Inativo</span>'}
                ${gestor.tem_senha
                    ? ''
                    : '<br><span class="selo selo--falta" style="margin-top:4px">Sem senha</span>'}
            </td>
            <td data-rotulo="Ações">
                <div class="barra-botoes" style="justify-content:flex-end">
                    <button class="botao botao--pequeno botao--vazio"
                            data-senha-gestor="${gestor.id}">Senha e envio</button>
                    <button class="botao botao--pequeno botao--vazio"
                            data-editar-gestor="${gestor.id}">Editar</button>
                    ${gestor.id === meuId ? '' : `
                    <button class="botao botao--pequeno botao--perigo"
                            data-excluir-gestor="${gestor.id}">Excluir</button>`}
                </div>
            </td>
        </tr>`).join('');

    let vazio = '';
    if (!total) {
        vazio = `
        <div class="lista-vazia">
            <strong>Só você administra esta escola por enquanto</strong>
            Crie outro gestor — ou promova um professor já cadastrado — para
            dividir a administração do sistema.
        </div>`;
    } else if (!lista.length) {
        vazio = `
        <div class="lista-vazia">
            <strong>Nenhum gestor encontrado</strong>
            Nada bateu com essa busca. Confira a escrita ou tente só uma parte
            do nome, do usuário, do e-mail ou do telefone.
        </div>`;
    }
    document.getElementById('vazioGestores').innerHTML = vazio;

    const contagem = document.getElementById('contagemGestores');
    if (!total) {
        contagem.textContent = '';
    } else if (termo) {
        contagem.textContent = `${lista.length} de ${total} `
            + `${total === 1 ? 'gestor' : 'gestores'}`;
    } else {
        contagem.textContent = `${total} `
            + `${total === 1 ? 'gestor cadastrado' : 'gestores cadastrados'}`;
    }
}

/** Tela de envio do acesso do gestor (a função geral mora em api.js). */
function enviarAcessoGestor(gestor, senha) {
    return abrirModalCredenciais({
        nome: gestor.nome,
        rotulo: 'Usuário',
        identificador: gestor.usuario,
        senha,
        base: `/api/gestor/gestores/${gestor.id}`,
        papel: 'gestor',
    });
}

function abrirFormularioGestor(gestor) {
    const dadosGestor = gestor || {};
    const novo = !dadosGestor.id;

    const modal = abrirModal({
        titulo: novo ? 'Novo gestor' : 'Editar gestor',
        subtitulo: novo
            ? 'O usuário é sugerido pelo sistema. Defina a senha e envie o acesso.'
            : 'Alterar o usuário muda o login desta pessoa.',
        corpo: `
            ${novo && estadoAdmin.professores.length ? `
            <div class="campo">
                <label for="gestorApartirProfessor">Promover um professor (opcional)</label>
                <select id="gestorApartirProfessor">
                    <option value="">— Preencher manualmente —</option>
                    ${estadoAdmin.professores.map((professor) => `
                        <option value="${professor.id}">${escapar(professor.nome)}</option>
                    `).join('')}
                </select>
            </div>
            <p class="dica">Copia nome, e-mail e telefone para os campos abaixo. A conta de
               gestor fica separada, com usuário e senha próprios; o login de professor
               continua valendo para consultar a agenda, mas <strong>quem administra deixa
               de reservar laboratório</strong> enquanto o acesso de gestor estiver
               ativo.</p>` : ''}

            <div class="campo">
                <label for="gestorNome">Nome completo</label>
                <input type="text" id="gestorNome" value="${escapar(dadosGestor.nome || '')}"
                       placeholder="ex.: Marina Alves">
            </div>

            <div class="campo">
                <label for="gestorUsuario">Usuário de acesso</label>
                <input type="text" id="gestorUsuario" class="mono"
                       value="${escapar(dadosGestor.usuario || '')}"
                       placeholder="gerado a partir do nome">
            </div>

            <div class="linha-campos linha-campos--2">
                <div class="campo">
                    <label for="gestorEmail">E-mail institucional</label>
                    <input type="text" id="gestorEmail" value="${escapar(dadosGestor.email || '')}"
                           placeholder="nome@escola.edu.br">
                </div>
                <div class="campo">
                    <label for="gestorTelefone">WhatsApp (com DDD)</label>
                    <input type="text" id="gestorTelefone" class="mono"
                           value="${escapar(dadosGestor.telefone || '')}"
                           placeholder="(81)9 8458-7555">
                </div>
            </div>

            ${novo ? `
            <div class="campo">
                <label for="gestorSenha">Senha de acesso do gestor</label>
                <div class="barra-botoes" style="flex-wrap:nowrap">
                    <input type="text" id="gestorSenha" class="mono"
                           placeholder="mínimo 4 caracteres">
                    <button type="button" class="botao botao--vazio botao--pequeno"
                            id="botaoSortearSenhaGestor">Gerar</button>
                </div>
            </div>
            <p class="dica">A senha aparece só uma vez, na tela de envio. Depois disso
               ela fica guardada de forma criptografada.</p>` : `
            <label class="checkbox">
                <input type="checkbox" id="gestorAtivo" ${dadosGestor.ativo ? 'checked' : ''}>
                <span>Gestor ativo (consegue entrar no painel da escola)</span>
            </label>`}

            <div id="erroGestor" class="aviso aviso--erro oculto"></div>`,
        textoCancelar: 'Cancelar',
        textoConfirmar: novo ? 'Criar e enviar acesso' : 'Salvar',
        aoConfirmar: async (janela) => {
            const dados = {
                nome: janela.querySelector('#gestorNome').value.trim(),
                usuario: janela.querySelector('#gestorUsuario').value.trim().toLowerCase(),
                email: janela.querySelector('#gestorEmail').value.trim(),
                telefone: soDigitos(janela.querySelector('#gestorTelefone').value),
            };
            if (!dados.nome) {
                mostrarErro(janela.querySelector('#erroGestor'), 'Informe o nome do gestor.');
                return false;
            }

            const avisoTelefone = erroTelefone(dados.telefone);
            if (avisoTelefone) {
                mostrarErro(janela.querySelector('#erroGestor'), avisoTelefone);
                janela.querySelector('#gestorTelefone').focus();
                return false;
            }

            try {
                if (novo) {
                    dados.senha = janela.querySelector('#gestorSenha').value.trim();
                    if (dados.senha.length < 4) {
                        mostrarErro(janela.querySelector('#erroGestor'),
                                    'Defina uma senha com pelo menos 4 caracteres.');
                        return false;
                    }
                    // promoção: guarda de quem é a conta, para tirar a pessoa das reservas
                    const promovido = janela.querySelector('#gestorApartirProfessor');
                    if (promovido && promovido.value) {
                        dados.professor_id = Number(promovido.value);
                    }
                    const resposta = await API.post('/api/gestor/gestores', dados);
                    await carregarGestores();
                    notificar(`Gestor criado — usuário ${resposta.gestor.usuario}.`);
                    // abre depois que esta janela fechar, para não ser apagada
                    setTimeout(() => enviarAcessoGestor(resposta.gestor, dados.senha), 0);
                    return true;
                }

                dados.ativo = janela.querySelector('#gestorAtivo').checked;
                await API.put(`/api/gestor/gestores/${dadosGestor.id}`, dados);
                await carregarGestores();
                notificar('Gestor atualizado.');
                return true;
            } catch (falha) {
                mostrarErro(janela.querySelector('#erroGestor'), falha.message);
                return false;
            }
        },
    });

    if (!modal) return;

    limitarCampoTelefone(modal.querySelector('#gestorTelefone'));

    if (novo) {
        const campoSenha = modal.querySelector('#gestorSenha');
        campoSenha.value = sortearSenha();
        modal.querySelector('#botaoSortearSenhaGestor').addEventListener('click', () => {
            campoSenha.value = sortearSenha();
        });
        sugerirUsuarioParaGestorEnquantoDigita(modal);

        const seletorProfessor = modal.querySelector('#gestorApartirProfessor');
        if (seletorProfessor) {
            seletorProfessor.addEventListener('change', () => {
                const professor = estadoAdmin.professores
                    .find((item) => item.id === Number(seletorProfessor.value));
                if (!professor) return;
                modal.querySelector('#gestorEmail').value = professor.email || '';
                modal.querySelector('#gestorTelefone').value = professor.telefone || '';
                const campoNome = modal.querySelector('#gestorNome');
                campoNome.value = professor.nome;
                campoNome.dispatchEvent(new Event('input'));
            });
        }
    }
}

/**
 * Enquanto a pessoa digita o nome, o servidor devolve um usuário livre
 * ("Marina Alves" -> "marina.alves"). Assim que o usuário é editado à mão,
 * a sugestão para de mexer no campo.
 */
function sugerirUsuarioParaGestorEnquantoDigita(modal) {
    const campoNome = modal.querySelector('#gestorNome');
    const campoUsuario = modal.querySelector('#gestorUsuario');
    let editadoAMao = false;
    let pedido = 0;

    campoUsuario.addEventListener('input', () => { editadoAMao = true; });

    campoNome.addEventListener('input', async () => {
        if (editadoAMao) return;
        const nome = campoNome.value.trim();
        if (!nome) {
            campoUsuario.value = '';
            return;
        }
        const meu = ++pedido;
        try {
            const resposta = await API.get(
                `/api/gestor/usuario-sugerido?nome=${encodeURIComponent(nome)}`
            );
            // ignora respostas que chegaram fora de ordem
            if (meu === pedido && !editadoAMao) campoUsuario.value = resposta.usuario;
        } catch (falha) {
            /* sem sugestão: o servidor gera o usuário ao salvar */
        }
    });
}

async function abrirRedefinirSenhaGestor(gestor) {
    const modal = abrirModal({
        titulo: 'Senha e envio de acesso',
        subtitulo: `${gestor.nome} — usuário ${gestor.usuario}`,
        corpo: `
            <p>Defina uma nova senha para o gestor. A senha anterior deixa de valer
               assim que você confirmar.</p>
            <div class="campo">
                <label for="novaSenhaGestor">Nova senha</label>
                <div class="barra-botoes" style="flex-wrap:nowrap">
                    <input type="text" id="novaSenhaGestor" class="mono"
                           placeholder="mínimo 4 caracteres">
                    <button type="button" class="botao botao--vazio botao--pequeno"
                            id="botaoSortearSenhaGestor2">Gerar</button>
                </div>
            </div>
            <div id="erroSenhaOutroGestor" class="aviso aviso--erro oculto"></div>`,
        textoCancelar: 'Cancelar',
        textoConfirmar: 'Definir e enviar',
        aoConfirmar: async (janela) => {
            const senha = janela.querySelector('#novaSenhaGestor').value.trim();
            if (senha.length < 4) {
                mostrarErro(janela.querySelector('#erroSenhaOutroGestor'),
                            'A senha precisa ter pelo menos 4 caracteres.');
                return false;
            }
            try {
                await API.post(`/api/gestor/gestores/${gestor.id}/senha`, { senha });
                await carregarGestores();
                notificar('Senha definida.');
                setTimeout(() => enviarAcessoGestor(gestor, senha), 0);
                return true;
            } catch (falha) {
                mostrarErro(janela.querySelector('#erroSenhaOutroGestor'), falha.message);
                return false;
            }
        },
    });

    if (modal) {
        const campo = modal.querySelector('#novaSenhaGestor');
        campo.value = sortearSenha();
        modal.querySelector('#botaoSortearSenhaGestor2').addEventListener('click', () => {
            campo.value = sortearSenha();
        });
    }
}

function abrirPerfilGestor(gestor) {
    if (!gestor) return;
    const meuId = estadoAdmin.gestor && estadoAdmin.gestor.id;

    abrirPerfil({
        nome: gestor.nome,
        subtitulo: `Gestor — usuário ${gestor.usuario}`,
        itens: [
            ['Nome do gestor', gestor.nome],
            ['Usuário de acesso', gestor.usuario, 'mono'],
            ['Último acesso', quandoFoi(gestor.ultimo_acesso)],
        ],
        telefone: gestor.telefone,
        email: gestor.email,
        situacao: `<strong>${gestor.ativo
            ? '<span class="selo selo--ativa">Ativo</span>'
            : '<span class="selo selo--cancelada">Inativo</span>'}
            ${gestor.tem_senha
                ? ''
                : '<span class="selo selo--falta">Sem senha</span>'}
            ${gestor.id === meuId ? ' <span class="selo">Você</span>' : ''}</strong>`,
        editar: {
            texto: 'Editar cadastro',
            ao: () => abrirFormularioGestor(gestor),
        },
    });
}

function aoClicarGestor(evento) {
    const achar = (elemento, campo) => estadoAdmin.gestores
        .find((item) => item.id === Number(elemento.dataset[campo]));

    const perfil = evento.target.closest('[data-perfil-gestor]');
    if (perfil) {
        abrirPerfilGestor(achar(perfil, 'perfilGestor'));
        return;
    }

    const editar = evento.target.closest('[data-editar-gestor]');
    if (editar) {
        abrirFormularioGestor(achar(editar, 'editarGestor'));
        return;
    }

    const senha = evento.target.closest('[data-senha-gestor]');
    if (senha) {
        abrirRedefinirSenhaGestor(achar(senha, 'senhaGestor'));
        return;
    }

    const excluir = evento.target.closest('[data-excluir-gestor]');
    if (!excluir) return;
    const gestor = achar(excluir, 'excluirGestor');

    abrirModal({
        titulo: 'Excluir gestor',
        subtitulo: gestor.nome,
        corpo: `<p>A conta perde o acesso ao painel da escola. Os laboratórios,
                   professores e reservas continuam como estão.</p>
                <p class="texto-suave">Para tirar o acesso sem apagar o cadastro,
                   use <strong>Editar</strong> e desmarque “Gestor ativo”.</p>`,
        textoCancelar: 'Voltar',
        textoConfirmar: 'Excluir',
        perigo: true,
        aoConfirmar: async () => {
            try {
                await API.del(`/api/gestor/gestores/${gestor.id}`);
            } catch (falha) {
                notificar(falha.message, 'erro');
                return false;
            }
            await carregarGestores();
            notificar('Gestor excluído.');
            return true;
        },
    });
}

/* ------------------------------------------------------------------ */
/* Reservas                                                            */
/* ------------------------------------------------------------------ */

async function carregarReservas() {
    const lista = document.getElementById('listaReservas');
    lista.innerHTML = '<div class="lista-vazia"><span class="carregando"></span></div>';

    const parametros = new URLSearchParams();
    const laboratorio = document.getElementById('filtroLaboratorio').value;
    const status = document.getElementById('filtroStatus').value;
    const de = document.getElementById('filtroDe').value;
    if (laboratorio) parametros.set('laboratorio_id', laboratorio);
    if (status) parametros.set('status', status);
    if (de) parametros.set('de', de);

    try {
        const reservas = await API.get(`/api/gestor/reservas?${parametros.toString()}`);
        if (!reservas.length) {
            lista.innerHTML = `<div class="lista-vazia">
                <strong>Nenhuma reserva encontrada</strong>Ajuste os filtros.</div>`;
            return;
        }
        lista.innerHTML = reservas.map((reserva) => {
            const data = paraData(reserva.data);
            return `
            <div class="item-reserva item-reserva--${reserva.status}">
                <div class="item-reserva__data">
                    <strong>${String(data.getDate()).padStart(2, '0')}</strong>
                    <span>${MESES[data.getMonth()]}</span>
                </div>
                <div class="item-reserva__corpo">
                    <strong>${escapar(reserva.laboratorio_nome)}</strong>
                    <p>${escapar(reserva.professor_nome)} ·
                       ${escapar(reserva.disciplina || 'sem disciplina')}
                       ${reserva.tipo_aula ? `· ${escapar(reserva.tipo_aula)}` : ''}</p>
                    <p class="mono">${escapar(reserva.inicio)}–${escapar(reserva.fim)}
                       · ${ROTULO_TURNO[reserva.turno] || reserva.turno}
                       ${reserva.qtd_alunos ? `· ${reserva.qtd_alunos} alunos` : ''}</p>
                </div>
                <div class="item-reserva__acoes">
                    ${selo(reserva.status)}
                    <select data-status="${reserva.id}" aria-label="Mudar situação">
                        ${['ativa', 'realizada', 'falta', 'cancelada'].map((opcao) => `
                            <option value="${opcao}" ${opcao === reserva.status ? 'selected' : ''}>
                                ${ROTULO_STATUS[opcao]}
                            </option>`).join('')}
                    </select>
                </div>
            </div>`;
        }).join('');
    } catch (falha) {
        lista.innerHTML = `<div class="lista-vazia">${escapar(falha.message)}</div>`;
    }
}

async function aoMudarStatusReserva(evento) {
    const seletor = evento.target.closest('select[data-status]');
    if (!seletor) return;
    try {
        await API.post(`/api/gestor/reservas/${seletor.dataset.status}/status`,
                       { status: seletor.value });
        notificar('Situação atualizada.');
    } catch (falha) {
        notificar(falha.message, 'erro');
    }
    carregarReservas();
}

/* ------------------------------------------------------------------ */
/* Alunos por turma                                                    */
/* ------------------------------------------------------------------ */
/*
 * O cadastro existe para uma coisa so: dar ao professor a lista pronta da
 * turma na hora de distribuir os computadores do laboratorio. Por isso e
 * enxuto (nome, turma e o numero de chamada) e ganha o "Importar turma", que
 * aceita colar a lista inteira de uma vez — digitar 35 nomes um a um, doze
 * vezes, ninguem faria.
 */

async function carregarAlunos() {
    const corpo = document.getElementById('corpoAlunos');
    corpo.innerHTML = '';
    try {
        const [resposta, cadastro] = await Promise.all([
            API.get('/api/gestor/alunos'),
            API.get('/api/gestor/turmas'),
        ]);
        estadoAdmin.alunos = resposta.alunos || [];
        estadoAdmin.turmasDeAlunos = resposta.turmas || [];
        estadoAdmin.turmasConhecidas = resposta.turmas_conhecidas || [];
        estadoAdmin.turmasCadastradas = cadastro.turmas || [];
    } catch (falha) {
        document.getElementById('vazioAlunos').innerHTML =
            `<div class="lista-vazia">${escapar(falha.message)}</div>`;
        return;
    }
    montarFiltroDeTurmas();
    desenharAlunos();
}

/**
 * Todas as turmas que a tela conhece, cada uma com quantos alunos ativos tem.
 *
 * Junta as duas listas que o servidor manda: as que ja tem aluno (com a
 * contagem) e as `turmas_conhecidas` — a turma recem-criada e a que so existe
 * na grade, ambas ainda com zero. E por isso que a turma aparece no filtro e
 * no "Importar turma" desde a hora em que o gestor a cria, e nao so depois de
 * ela ganhar o primeiro aluno.
 */
function turmasComContagem() {
    const contagem = new Map(estadoAdmin.turmasDeAlunos
        .map((turma) => [turma.turma, turma.ativos]));
    estadoAdmin.turmasConhecidas.forEach((turma) => {
        if (!contagem.has(turma)) contagem.set(turma, 0);
    });
    return [...contagem.entries()]
        .map(([turma, ativos]) => ({ turma, ativos }))
        .sort((a, b) => a.turma.localeCompare(b.turma, 'pt-BR'));
}

/** Turmas do filtro, marcadas com quantos alunos ativos cada uma tem. */
function montarFiltroDeTurmas() {
    const seletor = document.getElementById('filtroTurmaAlunos');
    const escolhida = seletor.value;
    seletor.innerHTML = '<option value="">Todas as turmas</option>'
        + turmasComContagem().map((turma) => `
            <option value="${escapar(turma.turma)}">
                ${escapar(turma.turma)} (${turma.ativos})
            </option>`).join('');
    seletor.value = escolhida;
}

/**
 * A situacao escrita do jeito que a secretaria escreve.
 *
 * O banco guarda em maiuscula ("TRANSFERIDO") porque e o que a planilha manda;
 * a tela mostra so a primeira letra maiuscula. Aluno sem situacao gravada
 * (cadastro antigo, anterior a ficha) cai em "Inativo".
 */
function rotuloDeSituacao(situacao) {
    const texto = String(situacao || '').trim();
    if (!texto || texto === 'ATIVO') return 'Inativo';
    return texto.charAt(0) + texto.slice(1).toLowerCase();
}

const SEXO_POR_EXTENSO = { F: 'Feminino', M: 'Masculino' };

// Os graus de parentesco oferecidos na ficha do aluno. A mesma lista existe em
// app.py (PARENTESCOS), que recusa qualquer valor fora dela: aqui e so a tela.
const PARENTESCOS = ['Mãe', 'Pai', 'Avó', 'Avô', 'Tia / Tio', 'Irmã / Irmão',
                     'Prima / Primo', 'Outro'];

/** "12/05/2009" a partir do "2009-05-12" que vem do banco. */
function dataBonita(iso) {
    const partes = String(iso || '').split('-');
    return partes.length === 3 ? `${partes[2]}/${partes[1]}/${partes[0]}` : '';
}

/** Idade em anos completos, para a lista dizer de quem se trata sem abrir a ficha. */
function idadeEmAnos(iso) {
    const nascimento = new Date(`${iso}T00:00:00`);
    if (Number.isNaN(nascimento.getTime())) return null;
    const hoje = new Date();
    let anos = hoje.getFullYear() - nascimento.getFullYear();
    const mes = hoje.getMonth() - nascimento.getMonth();
    if (mes < 0 || (mes === 0 && hoje.getDate() < nascimento.getDate())) anos -= 1;
    return anos >= 0 && anos < 120 ? anos : null;
}

/** "Técnico em Administração" a partir de "Ensino Médio - Técnico em ...". */
function cursoCurto(curso) {
    const texto = String(curso || '').trim();
    const traco = texto.lastIndexOf(' - ');
    return traco >= 0 ? texto.slice(traco + 3) : texto;
}

/**
 * A segunda linha da celula do nome: sexo, nascimento e curso.
 *
 * Fica embaixo do nome, e nao em colunas proprias, porque a tabela ja tem seis
 * e a ficha completa (raça/cor, procedência, contato) abre no "Editar".
 */
function fichaResumida(aluno) {
    const partes = [];
    if (SEXO_POR_EXTENSO[aluno.sexo]) partes.push(SEXO_POR_EXTENSO[aluno.sexo]);
    if (aluno.data_nascimento) {
        const idade = idadeEmAnos(aluno.data_nascimento);
        partes.push(dataBonita(aluno.data_nascimento)
            + (idade === null ? '' : ` (${idade} anos)`));
    }
    if (aluno.curso) partes.push(cursoCurto(aluno.curso));
    return partes.length
        ? `<p class="texto-suave" style="margin:2px 0 0;font-size:.82rem">
               ${escapar(partes.join(' · '))}</p>`
        : '';
}

function desenharAlunos() {
    const termo = normalizar(document.getElementById('buscaAluno').value.trim());
    const turma = document.getElementById('filtroTurmaAlunos').value;
    const lista = estadoAdmin.alunos.filter((aluno) => {
        if (turma && aluno.turma !== turma) return false;
        if (!termo) return true;
        return normalizar(aluno.nome).includes(termo)
            || normalizar(aluno.turma).includes(termo)
            || normalizar(aluno.matricula).includes(termo)
            || normalizar(aluno.curso).includes(termo);
    });

    const corpo = document.getElementById('corpoAlunos');
    corpo.innerHTML = lista.map((aluno) => `
        <tr>
            <td data-rotulo="Aluno">
                <button type="button" class="nome-acao" data-perfil-aluno="${aluno.id}"
                        title="Ver a ficha de ${escapar(aluno.nome)}">${escapar(aluno.nome)}</button>
                ${fichaResumida(aluno)}
            </td>
            <td data-rotulo="Matrícula" class="mono">
                ${aluno.matricula
                    ? escapar(aluno.matricula)
                    : '<span class="texto-suave">a preencher</span>'}
            </td>
            <td data-rotulo="Nº" class="mono">${aluno.numero || '—'}</td>
            <td data-rotulo="Turma">${escapar(aluno.turma)}</td>
            <td data-rotulo="Situação">
                ${aluno.ativo
                    ? '<span class="selo selo--ativa">Ativo</span>'
                    : `<span class="selo selo--cancelada">${escapar(
                        rotuloDeSituacao(aluno.situacao))}</span>`}
            </td>
            <td data-rotulo="Ações">
                <div class="barra-botoes" style="justify-content:flex-end">
                    <button class="botao botao--pequeno botao--vazio"
                            data-editar-aluno="${aluno.id}">Editar</button>
                    <button class="botao botao--pequeno botao--perigo"
                            data-excluir-aluno="${aluno.id}">Excluir</button>
                </div>
            </td>
        </tr>`).join('');

    const contagem = lista.length === estadoAdmin.alunos.length
        ? `${lista.length} aluno(s) cadastrado(s)`
        : `${lista.length} de ${estadoAdmin.alunos.length} aluno(s)`;
    document.getElementById('contagemAlunos').textContent =
        [contagem, ...fichaDaTurma(turma)].join(' · ');

    document.getElementById('vazioAlunos').innerHTML = lista.length ? '' : `
        <div class="lista-vazia">
            <strong>Nenhum aluno nesta lista</strong>
            Use “Importar turma” para colar a lista de uma turma inteira.
        </div>`;

    desenharIndicadoresDeAlunos();
}

/**
 * Curso e turno da turma escolhida no filtro, quando ela foi criada aqui.
 *
 * E o unico lugar onde os dois campos do "Criar turma" aparecem de volta: eles
 * nao entram na ficha do aluno (la o curso e por aluno, porque a planilha da
 * secretaria traz assim), e sim ao lado do filtro, dizendo de que turma e a
 * lista que esta na tela.
 */
function fichaDaTurma(turma) {
    const cadastro = estadoAdmin.turmasCadastradas
        .find((registro) => registro.nome === turma);
    if (!cadastro) return [];
    return [cadastro.curso, ROTULO_TURNO[cadastro.turno]].filter(Boolean);
}

/**
 * Tira do cadastro a turma escolhida no filtro.
 *
 * So da para excluir turma que foi criada no "Criar turma": e a unica que tem
 * linha na tabela. A turma que nasceu do primeiro aluno ou da grade e apenas
 * texto repetido nas outras tabelas, e nao existe nada para apagar — o caminho
 * ali e excluir os alunos, ou tirar a turma da grade.
 */
function abrirExclusaoDeTurma() {
    const turma = document.getElementById('filtroTurmaAlunos').value;
    if (!turma) {
        notificar('Escolha a turma no filtro acima para poder excluí-la.', 'erro');
        document.getElementById('filtroTurmaAlunos').focus();
        return;
    }

    const cadastro = estadoAdmin.turmasCadastradas
        .find((registro) => registro.nome === turma);
    if (!cadastro) {
        notificar(`A turma ${turma} não foi criada no “Criar turma”: ela existe `
                + 'só porque tem aluno ou aula na grade. Para fazê-la sumir das '
                + 'listas, exclua os alunos dela ou tire-a da grade de aulas.',
                  'erro');
        return;
    }

    const comAturma = estadoAdmin.alunos
        .filter((aluno) => aluno.turma === turma).length;

    abrirModal({
        titulo: 'Excluir turma',
        subtitulo: [turma, ...fichaDaTurma(turma)].join(' — '),
        corpo: `
            <p>A turma sai da lista de opções do filtro, do “Novo aluno” e do
               “Importar turma”.</p>
            ${comAturma ? `
                <p class="aviso aviso--atencao">
                    Os <strong>${comAturma} aluno(s)</strong> desta turma
                    <strong>não são excluídos</strong> e continuam com
                    “${escapar(turma)}” na ficha. Por causa deles, a turma vai
                    continuar aparecendo no filtro.
                </p>
                <p class="texto-suave">Para a turma sumir de vez, exclua os alunos
                   dela antes.</p>`
              : `<p class="texto-suave">Esta turma ainda não tem aluno cadastrado,
                    então ela some das listas na hora.</p>`}
            <p class="texto-suave">As aulas na grade e o histórico dos laboratórios
               não mudam.</p>`,
        textoCancelar: 'Cancelar',
        textoConfirmar: 'Sim, excluir',
        perigo: true,
        aoConfirmar: async () => {
            try {
                await API.del(`/api/gestor/turmas/${cadastro.id}`);
                await carregarAlunos();
                // o filtro foi remontado: se a turma sumiu de vez, volta para
                // "Todas as turmas" em vez de ficar num valor que nao existe
                const seletor = document.getElementById('filtroTurmaAlunos');
                if (![...seletor.options].some((opcao) => opcao.value === turma)) {
                    seletor.value = '';
                }
                desenharAlunos();
                notificar(`Turma ${turma} excluída do cadastro.`);
                return true;
            } catch (falha) {
                notificar(falha.message, 'erro');
                return false;
            }
        },
    });
}

function desenharIndicadoresDeAlunos() {
    const turmas = estadoAdmin.turmasDeAlunos;
    const ativos = estadoAdmin.alunos.filter((aluno) => aluno.ativo).length;
    // turma que aparece na grade de aulas mas ainda nao tem lista de alunos:
    // e nela que o professor vai esbarrar na hora de alocar os computadores
    const comAlunos = new Set(turmas.map((turma) => turma.turma));
    const semLista = estadoAdmin.turmasConhecidas
        .filter((turma) => !comAlunos.has(turma)).length;

    const media = turmas.length ? Math.round(ativos / turmas.length) : 0;

    document.getElementById('indicadoresAlunos').innerHTML = `
        <div class="indicador indicador--primaria">
            <strong>${ativos}</strong><span>Alunos ativos</span>
        </div>
        <div class="indicador indicador--verde">
            <strong>${turmas.length}</strong><span>Turmas com lista</span>
        </div>
        <div class="indicador ${semLista ? 'indicador--ambar' : ''}">
            <strong>${semLista}</strong><span>Turmas sem lista</span>
        </div>
        <div class="indicador">
            <strong>${media}</strong><span>Alunos por turma</span>
        </div>`;
}

/**
 * Ficha do aluno em modo consulta — a mesma janela usada em Professores.
 *
 * O nome na lista abre esta consulta, e a alteracao continua no formulario de
 * sempre, pelo botao "Editar cadastro". O telefone sai formatado e clicavel:
 * `abrirPerfil` monta o link do WhatsApp sozinho, entao o comportamento e
 * identico ao da ficha do professor sem repetir codigo.
 */
function abrirPerfilAluno(aluno) {
    if (!aluno) return;

    const nascimento = aluno.data_nascimento
        ? `${dataBonita(aluno.data_nascimento)}${
            idadeEmAnos(aluno.data_nascimento) === null
                ? '' : ` (${idadeEmAnos(aluno.data_nascimento)} anos)`}`
        : '—';

    const itens = [
        ['Matrícula', aluno.matricula || '—', 'mono'],
        ['Turma', aluno.turma || '—'],
        ['Nº de chamada', aluno.numero ? String(aluno.numero) : '—', 'mono'],
        ['Nascimento', nascimento],
        ['Sexo', SEXO_POR_EXTENSO[aluno.sexo] || '—'],
        ['Raça/Cor', aluno.raca_cor || '—'],
        ['Curso', cursoCurto(aluno.curso) || '—'],
    ];
    if (aluno.procedencia_modalidade_curso) {
        itens.push(['Procedência', aluno.procedencia_modalidade_curso]);
    }
    itens.push(['Endereço', aluno.endereco || '—']);
    if (aluno.cep) itens.push(['CEP', formatarCep(aluno.cep), 'mono']);

    // O responsavel so aparece quando existe: ficha de aluno maior de idade
    // costuma nao ter, e tres tracos seguidos nao dizem nada a ninguem.
    if (aluno.responsavel_nome) {
        itens.push(['Responsável', aluno.responsavel_parentesco
            ? `${aluno.responsavel_nome} (${aluno.responsavel_parentesco})`
            : aluno.responsavel_nome]);
    }

    abrirPerfil({
        nome: aluno.nome,
        subtitulo: aluno.matricula
            ? `Matrícula ${aluno.matricula} · ${aluno.turma}`
            : aluno.turma,
        itens,
        telefone: aluno.telefone,
        email: aluno.email,
        telefonesExtras: aluno.responsavel_nome
            ? [['WhatsApp do responsável', aluno.responsavel_telefone]]
            : [],
        situacao: `<strong>${aluno.ativo
            ? '<span class="selo selo--ativa">Ativo</span>'
            : `<span class="selo selo--cancelada">${escapar(
                rotuloDeSituacao(aluno.situacao))}</span>`}</strong>`,
        editar: {
            texto: 'Editar cadastro',
            ao: () => abrirFormularioAluno(aluno),
        },
    });
}

function abrirFormularioAluno(aluno) {
    const dadosAluno = aluno || {};
    // Ficha com endereco e sem CEP so pode ter sido preenchida na mao — rua de
    // sitio, povoado ou vila que o CEP geral do municipio nao alcanca. O modal
    // abre ja no modo manual para nao dar a impressao de que falta o CEP.
    const enderecoManual = !dadosAluno.cep && Boolean(
        dadosAluno.logradouro || dadosAluno.bairro || dadosAluno.cidade);
    const turmas = [...new Set([
        ...estadoAdmin.turmasConhecidas,
        ...estadoAdmin.turmasDeAlunos.map((turma) => turma.turma),
    ])].sort((a, b) => a.localeCompare(b, 'pt-BR'));

    const modal = abrirModal({
        titulo: dadosAluno.id ? 'Editar aluno' : 'Novo aluno',
        subtitulo: 'O nome aparece para o professor na alocação dos computadores.',
        corpo: `
            <div class="campo">
                <label for="alunoNome">Nome completo</label>
                <input type="text" id="alunoNome" maxlength="80"
                       value="${escapar(dadosAluno.nome || '')}"
                       placeholder="ex.: Ana Beatriz Moraes">
            </div>
            <div class="linha-campos linha-campos--2">
                <div class="campo">
                    <label for="alunoTurma">Turma</label>
                    <input type="text" id="alunoTurma" maxlength="40" list="listaTurmasAluno"
                           value="${escapar(dadosAluno.turma || '')}"
                           placeholder="ex.: 1º A ADM">
                    <datalist id="listaTurmasAluno">
                        ${turmas.map((turma) => `<option value="${escapar(turma)}">`).join('')}
                    </datalist>
                </div>
                <div class="campo">
                    <label for="alunoNumero">Nº de chamada (opcional)</label>
                    <input type="number" id="alunoNumero" min="1" max="999"
                           value="${dadosAluno.numero || ''}">
                </div>
            </div>
            <div class="campo">
                <label for="alunoMatricula">Matrícula (opcional)</label>
                <input type="text" id="alunoMatricula" maxlength="20" class="mono"
                       value="${escapar(dadosAluno.matricula || '')}"
                       placeholder="ex.: 20260012">
                <p class="dica" style="margin:6px 0 0">
                    É por ela que o professor chama o aluno no laboratório de
                    projetos. Não se repete dentro da escola.
                </p>
            </div>
            <div class="linha-campos linha-campos--2">
                <div class="campo">
                    <label for="alunoSexo">Sexo</label>
                    <select id="alunoSexo">
                        <option value="">Não informado</option>
                        <option value="F" ${dadosAluno.sexo === 'F' ? 'selected' : ''}>Feminino</option>
                        <option value="M" ${dadosAluno.sexo === 'M' ? 'selected' : ''}>Masculino</option>
                    </select>
                </div>
                <div class="campo">
                    <label for="alunoNascimento">Data de nascimento</label>
                    <input type="date" id="alunoNascimento"
                           value="${escapar(dadosAluno.data_nascimento || '')}">
                </div>
            </div>
            <div class="linha-campos linha-campos--2">
                <div class="campo">
                    <label for="alunoRaca">Raça/Cor</label>
                    <input type="text" id="alunoRaca" maxlength="50"
                           value="${escapar(dadosAluno.raca_cor || '')}"
                           placeholder="ex.: Parda">
                </div>
                <div class="campo">
                    <label for="alunoCurso">Curso</label>
                    <input type="text" id="alunoCurso" maxlength="100"
                           value="${escapar(dadosAluno.curso || '')}"
                           placeholder="ex.: Ensino Médio - Técnico em Administração">
                </div>
            </div>
            <div class="linha-campos linha-campos--2">
                <div class="campo">
                    <label for="alunoTelefone">WhatsApp (com DDD)</label>
                    <input type="text" id="alunoTelefone" class="mono"
                           value="${escapar(dadosAluno.telefone || '')}"
                           placeholder="(81)9 8458-7555">
                    <p class="dica" style="margin:6px 0 0" id="linhaZapAluno"></p>
                </div>
                <div class="campo">
                    <label for="alunoEmail">E-mail</label>
                    <input type="email" id="alunoEmail" maxlength="120"
                           value="${escapar(dadosAluno.email || '')}"
                           placeholder="nome@exemplo.com">
                </div>
            </div>

            <p class="rotulo-pequeno" style="margin:18px 0 0">Endereço</p>
            <div class="linha-campos linha-campos--2">
                <div class="campo">
                    <label for="alunoCep">CEP</label>
                    <input type="text" id="alunoCep" class="mono"
                           value="${escapar(dadosAluno.cep || '')}"
                           placeholder="55190-002">
                    <label class="checkbox" style="margin:8px 0 0">
                        <input type="checkbox" id="alunoEnderecoManual"
                               ${enderecoManual ? 'checked' : ''}>
                        <span>CEP Geral / Digitar endereço manualmente</span>
                    </label>
                    <p class="dica" style="margin:6px 0 0" id="retornoCep"></p>
                </div>
                <div class="campo">
                    <label for="alunoLogradouro">Rua / Logradouro</label>
                    <input type="text" id="alunoLogradouro" maxlength="120"
                           value="${escapar(dadosAluno.logradouro || '')}"
                           placeholder="ex.: Rua Santa Tereza">
                </div>
            </div>
            <div class="linha-campos linha-campos--2">
                <div class="campo">
                    <label for="alunoNumeroEndereco">Número</label>
                    <input type="text" id="alunoNumeroEndereco" maxlength="10"
                           value="${escapar(dadosAluno.numero_endereco || '')}"
                           placeholder="ex.: 120 ou s/n">
                </div>
                <div class="campo">
                    <label for="alunoComplemento">Complemento / Observação (opcional)</label>
                    <input type="text" id="alunoComplemento" maxlength="60"
                           value="${escapar(dadosAluno.complemento || '')}"
                           placeholder="ex.: Apto 102, em frente à igreja">
                </div>
            </div>
            <div class="linha-campos linha-campos--2">
                <div class="campo">
                    <label for="alunoBairro">Bairro</label>
                    <input type="text" id="alunoBairro" maxlength="60"
                           value="${escapar(dadosAluno.bairro || '')}"
                           placeholder="ex.: Centro">
                </div>
                <div class="campo">
                    <label for="alunoCidade">Cidade / UF</label>
                    <div class="barra-botoes" style="flex-wrap:nowrap">
                        <input type="text" id="alunoCidade" maxlength="60"
                               value="${escapar(dadosAluno.cidade || '')}"
                               placeholder="ex.: Santa Cruz do Capibaribe">
                        <input type="text" id="alunoUf" class="mono" maxlength="2"
                               style="max-width:64px;text-transform:uppercase"
                               value="${escapar(dadosAluno.uf || '')}"
                               placeholder="PE">
                    </div>
                </div>
            </div>
            <p class="rotulo-pequeno" style="margin:18px 0 0">Dados do responsável</p>
            <p class="dica" style="margin:4px 0 12px">
                Quem a escola procura quando precisa falar sobre o aluno.
            </p>
            <div class="linha-campos linha-campos--2">
                <div class="campo">
                    <label for="alunoRespNome">Nome do responsável</label>
                    <input type="text" id="alunoRespNome" maxlength="80"
                           value="${escapar(dadosAluno.responsavel_nome || '')}"
                           placeholder="Nome completo do responsável">
                </div>
                <div class="campo">
                    <label for="alunoRespParentesco">Grau de parentesco</label>
                    <select id="alunoRespParentesco">
                        <option value="">Não informado</option>
                        ${PARENTESCOS.map((grau) => `
                            <option value="${escapar(grau)}"
                                ${grau === dadosAluno.responsavel_parentesco
                                    ? 'selected' : ''}>${escapar(grau)}</option>`).join('')}
                    </select>
                </div>
            </div>
            <div class="campo">
                <label for="alunoRespTelefone">WhatsApp do responsável (com DDD)</label>
                <input type="text" id="alunoRespTelefone" class="mono"
                       value="${escapar(dadosAluno.responsavel_telefone || '')}"
                       placeholder="(81)9 8458-7555">
                <p class="dica" style="margin:6px 0 0" id="linhaZapResponsavel"></p>
            </div>

            ${dadosAluno.procedencia_modalidade_curso ? `
            <p class="dica" style="margin:0 0 4px">
                <strong>Procedência:</strong>
                ${escapar(dadosAluno.procedencia_modalidade_curso)}
                ${dadosAluno.turma_codigo
                    ? ` · código da turma na secretaria: ${escapar(dadosAluno.turma_codigo)}`
                    : ''}
            </p>` : ''}
            ${dadosAluno.id ? `
            <label class="checkbox">
                <input type="checkbox" id="alunoAtivo" ${dadosAluno.ativo ? 'checked' : ''}>
                <span>Aluno ativo (aparece na lista do professor)</span>
            </label>` : ''}
            <div id="erroAluno" class="aviso aviso--erro oculto"></div>`,
        textoCancelar: 'Cancelar',
        textoConfirmar: dadosAluno.id ? 'Salvar' : 'Cadastrar',
        aoConfirmar: async (modal) => {
            const ativo = dadosAluno.id
                ? modal.querySelector('#alunoAtivo').checked : true;
            const dados = {
                nome: modal.querySelector('#alunoNome').value.trim(),
                turma: modal.querySelector('#alunoTurma').value.trim(),
                numero: Number(modal.querySelector('#alunoNumero').value) || 0,
                matricula: modal.querySelector('#alunoMatricula').value.trim(),
                sexo: modal.querySelector('#alunoSexo').value,
                data_nascimento: modal.querySelector('#alunoNascimento').value,
                raca_cor: modal.querySelector('#alunoRaca').value.trim(),
                curso: modal.querySelector('#alunoCurso').value.trim(),
                // so os digitos, como em Professores: no banco o telefone
                // fica sem mascara para o link do WhatsApp sair sempre igual
                telefone: soDigitos(modal.querySelector('#alunoTelefone').value),
                email: modal.querySelector('#alunoEmail').value.trim(),
                // o endereco de uma linha nao e enviado: o servidor o monta a
                // partir destes pedacos, entao ele nunca discorda deles
                cep: soDigitos(modal.querySelector('#alunoCep').value),
                logradouro: modal.querySelector('#alunoLogradouro').value.trim(),
                numero_endereco: modal.querySelector('#alunoNumeroEndereco').value.trim(),
                complemento: modal.querySelector('#alunoComplemento').value.trim(),
                bairro: modal.querySelector('#alunoBairro').value.trim(),
                cidade: modal.querySelector('#alunoCidade').value.trim(),
                uf: modal.querySelector('#alunoUf').value.trim().toUpperCase(),
                responsavel_nome: modal.querySelector('#alunoRespNome').value.trim(),
                responsavel_parentesco: modal.querySelector('#alunoRespParentesco').value,
                responsavel_telefone: soDigitos(
                    modal.querySelector('#alunoRespTelefone').value),
                // a situacao escrita vem da secretaria; o gestor mexe pelo
                // "aluno ativo" e o servidor mantem os dois combinando
                situacao: ativo ? 'ATIVO' : (dadosAluno.situacao || 'INATIVO'),
                ativo,
            };
            // o WhatsApp do aluno e opcional, entao so vale conferir quando
            // alguem digitou alguma coisa: meio numero nao abre conversa
            if (dados.telefone && erroTelefone(dados.telefone)) {
                mostrarErro(modal.querySelector('#erroAluno'),
                            erroTelefone(dados.telefone));
                modal.querySelector('#alunoTelefone').focus();
                return false;
            }

            try {
                if (dadosAluno.id) await API.put(`/api/gestor/alunos/${dadosAluno.id}`, dados);
                else await API.post('/api/gestor/alunos', dados);
                await carregarAlunos();
                notificar(dadosAluno.id ? 'Aluno atualizado.' : 'Aluno cadastrado.');
                return true;
            } catch (falha) {
                mostrarErro(modal.querySelector('#erroAluno'), falha.message);
                return false;
            }
        },
    });

    if (modal) {
        ligarCampoDeWhatsapp(modal, '#alunoTelefone', '#linhaZapAluno');
        ligarCampoDeWhatsapp(modal, '#alunoRespTelefone', '#linhaZapResponsavel');
        ligarBuscaDeCep(modal);
    }
}

/**
 * Campo de WhatsApp com mascara e o atalho "abrir conversa" logo abaixo.
 *
 * O aluno e o responsavel dele usam o mesmo caminho: a mascara enquanto digita
 * e o link so quando os 11 numeros estao la.
 */
function ligarCampoDeWhatsapp(modal, seletorCampo, seletorAtalho) {
    const campo = modal.querySelector(seletorCampo);
    const atalho = modal.querySelector(seletorAtalho);
    limitarCampoTelefone(campo);
    const mostrar = () => { atalho.innerHTML = atalhoDeConversa(campo.value); };
    campo.addEventListener('input', mostrar);
    mostrar();
}

/**
 * O CEP preenche rua, bairro, cidade e UF sozinho.
 *
 * A consulta dispara nos 8 digitos e tambem no `blur`, porque quem cola o CEP
 * nem sempre passa pelo evento de digitacao. Nada fica bloqueado: o ViaCEP
 * adianta o trabalho, mas todo campo continua editavel — CEP errado no cadastro
 * da secretaria e comum, e travar a tela deixaria o gestor sem saida.
 *
 * O "CEP Geral / Digitar endereço manualmente" desliga so a consulta. Rua de
 * povoado costuma cair no CEP geral do municipio, que volta sem logradouro e
 * ainda por cima sobrescreveria o bairro digitado a cada `blur` no campo; com a
 * marca ligada, o que o gestor escreve fica de pe. O CEP continua editavel,
 * porque o CEP geral tambem e CEP e vale guardar na ficha.
 */
function ligarBuscaDeCep(modal) {
    const campoCep = modal.querySelector('#alunoCep');
    const manual = modal.querySelector('#alunoEnderecoManual');
    const retorno = modal.querySelector('#retornoCep');
    const campos = {
        logradouro: modal.querySelector('#alunoLogradouro'),
        bairro: modal.querySelector('#alunoBairro'),
        cidade: modal.querySelector('#alunoCidade'),
        uf: modal.querySelector('#alunoUf'),
    };
    limitarCampoCep(campoCep);

    // o ultimo CEP consultado, para nao repetir a chamada a cada `blur`
    let consultado = soDigitos(campoCep.value);
    let emAndamento = false;

    const avisar = (texto, tipo) => {
        retorno.className = tipo === 'erro' ? 'dica dica--erro' : 'dica';
        retorno.textContent = texto;
    };

    async function consultar() {
        const digitos = soDigitos(campoCep.value);
        if (manual.checked || emAndamento
            || digitos.length !== 8 || digitos === consultado) return;
        emAndamento = true;
        avisar('Consultando o CEP…');
        try {
            const lugar = await buscarCep(digitos);
            consultado = digitos;
            campos.bairro.value = lugar.bairro || campos.bairro.value;
            campos.cidade.value = lugar.cidade;
            campos.uf.value = lugar.uf;
            if (lugar.semRua) {
                // CEP geral do municipio: o ViaCEP nao tem a rua, quem digita
                // e o gestor — por isso o campo ganha o foco em vez de um erro
                avisar(`CEP geral de ${lugar.cidade}/${lugar.uf}. Digite a rua.`);
                campos.logradouro.focus();
            } else {
                campos.logradouro.value = lugar.logradouro;
                avisar(`${lugar.cidade}/${lugar.uf}. Confira o número.`);
                modal.querySelector('#alunoNumeroEndereco').focus();
            }
        } catch (falha) {
            avisar(falha.message, 'erro');
        } finally {
            emAndamento = false;
        }
    }

    // A dica embaixo do CEP conta qual dos dois modos esta valendo; desmarcar
    // volta ao automatico e ja consulta o CEP que estiver digitado.
    function atualizarModo() {
        if (manual.checked) {
            avisar('Endereço manual: escreva rua, bairro, cidade e UF. '
                 + 'O CEP fica opcional.');
            return;
        }
        avisar('Digite o CEP para preencher rua, bairro e cidade.');
        consultar();
    }

    campoCep.addEventListener('input', () => {
        if (manual.checked) return;
        const digitos = soDigitos(campoCep.value);
        if (digitos.length < 8) {
            consultado = '';
            avisar('Digite o CEP para preencher rua, bairro e cidade.');
            return;
        }
        consultar();
    });
    campoCep.addEventListener('blur', consultar);
    manual.addEventListener('change', atualizarModo);
    atualizarModo();
}

/**
 * O "abrir conversa" que acompanha o campo de WhatsApp enquanto o gestor digita.
 *
 * Fica vazio com o campo vazio e vira um aviso enquanto faltam digitos — assim o
 * atalho so aparece quando ele de fato leva a algum lugar.
 */
function atalhoDeConversa(valor) {
    const numeros = soDigitos(valor);
    if (!numeros) return '';
    if (erroTelefone(numeros)) {
        return '<span class="texto-suave">Faltam números para abrir a conversa.</span>';
    }
    return `<a class="contato" href="${linkWhatsapp(numeros)}"
               target="_blank" rel="noopener"
               title="Abrir a conversa no WhatsApp">${escapar(formatarTelefone(numeros))}
               <span class="contato__dica">abrir conversa</span></a>`;
}

/**
 * Abre uma turma nova, antes de ela ter aluno ou aula.
 *
 * A turma sempre foi texto livre: ela so passava a existir quando alguem
 * cadastrava o primeiro aluno ou montava a grade, e ate la cada tela dependia
 * de o nome ser redigitado igual. Criando a turma aqui, o nome vira uma opcao
 * pronta no filtro, no "Novo aluno" e no "Importar turma" — que e justamente o
 * proximo passo, e por isso a turma criada ja fica escolhida no filtro.
 */
function abrirFormularioTurma() {
    const modal = abrirModal({
        titulo: 'Criar turma',
        subtitulo: 'A turma entra nas listas mesmo sem aluno cadastrado ainda.',
        corpo: `
            <div class="campo">
                <label for="turmaNome">Nome da turma</label>
                <input type="text" id="turmaNome" maxlength="40"
                       placeholder="ex.: 1º A ADM">
                <p class="dica" style="margin:6px 0 0">
                    Escreva do jeito que a escola chama a turma: é este mesmo
                    texto que vai aparecer na ficha do aluno e na grade de aulas.
                </p>
            </div>
            <div class="linha-campos linha-campos--2">
                <div class="campo">
                    <label for="turmaCurso">Curso (opcional)</label>
                    <input type="text" id="turmaCurso" maxlength="100"
                           placeholder="ex.: Técnico em Administração">
                </div>
                <div class="campo">
                    <label for="turmaTurno">Turno (opcional)</label>
                    <select id="turmaTurno">
                        <option value="">Não informado</option>
                        <option value="manha">Manhã</option>
                        <option value="tarde">Tarde</option>
                        <option value="noite">Noite</option>
                    </select>
                </div>
            </div>
            <div id="erroTurma" class="aviso aviso--erro oculto"></div>`,
        textoCancelar: 'Cancelar',
        textoConfirmar: 'Criar turma',
        aoConfirmar: async (janela) => {
            const nome = janela.querySelector('#turmaNome').value.trim();
            if (!nome) {
                mostrarErro(janela.querySelector('#erroTurma'),
                            'Informe o nome da turma.');
                janela.querySelector('#turmaNome').focus();
                return false;
            }

            try {
                const resposta = await API.post('/api/gestor/turmas', {
                    nome,
                    curso: janela.querySelector('#turmaCurso').value.trim(),
                    turno: janela.querySelector('#turmaTurno').value,
                });
                await carregarAlunos();
                // deixa a turma nova escolhida: e dela que o "Importar turma"
                // parte, entao o gestor cai no proximo passo com o campo pronto
                document.getElementById('filtroTurmaAlunos').value = resposta.nome;
                desenharAlunos();
                notificar(`Turma ${resposta.nome} criada. `
                        + 'Use “Importar turma” para colar a lista de alunos.');
                return true;
            } catch (falha) {
                mostrarErro(janela.querySelector('#erroTurma'), falha.message);
                return false;
            }
        },
    });

    if (modal) modal.querySelector('#turmaNome').focus();
}

/**
 * Importa uma turma inteira a partir da lista colada.
 *
 * O servidor aceita o formato que sai do diario ("12 - Ana Souza", "12. Ana
 * Souza", "12 Ana Souza" ou so o nome) e ignora quem ja esta na turma, entao
 * colar a lista de novo depois de uma transferencia so acrescenta o novato.
 */
// `&#10;` e a quebra de linha dentro do atributo: o placeholder precisa sair
// em tres linhas para o formato aceito ficar obvio antes de colar.
const EXEMPLO_DE_LISTA = '01 - Ana Beatriz Moraes;20260001&#10;'
    + '02 - Bruno Carvalho;20260002&#10;03 - Carla Dias';

function abrirImportacaoDeAlunos() {
    const turmas = [...new Set([
        ...estadoAdmin.turmasConhecidas,
        ...estadoAdmin.turmasDeAlunos.map((turma) => turma.turma),
    ])].sort((a, b) => a.localeCompare(b, 'pt-BR'));

    const modal = abrirModal({
        titulo: 'Importar turma',
        subtitulo: 'Cole a lista da turma, um aluno por linha.',
        corpo: `
            <div class="campo">
                <label for="importarTurma">Turma</label>
                <input type="text" id="importarTurma" maxlength="40" list="listaTurmasImportar"
                       value="${escapar(document.getElementById('filtroTurmaAlunos').value)}"
                       placeholder="ex.: 1º A ADM">
                <datalist id="listaTurmasImportar">
                    ${turmas.map((turma) => `<option value="${escapar(turma)}">`).join('')}
                </datalist>
            </div>
            <div class="campo">
                <label for="importarTexto">Alunos</label>
                <textarea id="importarTexto" rows="10"
                          placeholder="${EXEMPLO_DE_LISTA}"></textarea>
            </div>
            <p class="dica">O número de chamada no começo da linha é opcional —
               com ou sem ele, a lista entra. Quem já está na turma é ignorado,
               então dá para colar a lista de novo sem duplicar ninguém.</p>
            <div id="resultadoImportacao"></div>
            <div id="erroImportar" class="aviso aviso--erro oculto"></div>`,
        textoCancelar: 'Fechar',
        textoConfirmar: 'Importar',
        aoConfirmar: async (janela) => {
            try {
                const resposta = await API.post('/api/gestor/alunos/importar', {
                    turma: janela.querySelector('#importarTurma').value.trim(),
                    texto: janela.querySelector('#importarTexto').value,
                });
                await carregarAlunos();
                mostrarResultadoDaImportacao(janela, resposta);
                notificar(`${resposta.importados} aluno(s) importado(s).`);
                return false;   // a janela fica aberta mostrando o resultado
            } catch (falha) {
                mostrarErro(janela.querySelector('#erroImportar'), falha.message);
                return false;
            }
        },
    });

    if (modal) modal.querySelector('#importarTurma').focus();
}

function mostrarResultadoDaImportacao(modal, resposta) {
    modal.querySelector('#erroImportar').classList.add('oculto');
    modal.querySelector('#importarTexto').value = '';

    const avisos = [`<div class="aviso aviso--sucesso"><div>
        <strong>${resposta.importados} aluno(s)</strong> entraram na turma
        ${escapar(resposta.turma)}.</div></div>`];

    if (resposta.repetidos.length) {
        avisos.push(`<div class="aviso aviso--info"><div>
            ${resposta.repetidos.length} já estavam na turma e foram mantidos:
            ${escapar(resposta.repetidos.slice(0, 8).join(', '))}${
                resposta.repetidos.length > 8 ? '…' : ''}</div></div>`);
    }
    if (resposta.invalidos.length) {
        avisos.push(`<div class="aviso aviso--atencao"><div>
            ${resposta.invalidos.length} linha(s) não pareciam nomes e ficaram de
            fora: ${escapar(resposta.invalidos.slice(0, 5).join(' · '))}</div></div>`);
    }
    if (resposta.matriculas_repetidas && resposta.matriculas_repetidas.length) {
        avisos.push(`<div class="aviso aviso--atencao"><div>
            ${resposta.matriculas_repetidas.length} matrícula(s) já eram de outro
            aluno: esses entraram sem matrícula, para você corrigir —
            ${escapar(resposta.matriculas_repetidas.slice(0, 5).join(' · '))}</div></div>`);
    }
    if (resposta.sem_matricula) {
        avisos.push(`<div class="aviso aviso--info"><div>
            ${resposta.sem_matricula} aluno(s) entraram <strong>sem matrícula</strong>.
            Sem ela o professor não consegue chamá-los no laboratório de projetos —
            preencha na ficha de cada um.</div></div>`);
    }
    modal.querySelector('#resultadoImportacao').innerHTML = avisos.join('');
}

function aoClicarAluno(evento) {
    const perfil = evento.target.closest('[data-perfil-aluno]');
    if (perfil) {
        abrirPerfilAluno(estadoAdmin.alunos
            .find((aluno) => aluno.id === Number(perfil.dataset.perfilAluno)));
        return;
    }

    const editar = evento.target.closest('[data-editar-aluno]');
    if (editar) {
        abrirFormularioAluno(estadoAdmin.alunos
            .find((aluno) => aluno.id === Number(editar.dataset.editarAluno)));
        return;
    }

    const excluir = evento.target.closest('[data-excluir-aluno]');
    if (!excluir) return;
    const aluno = estadoAdmin.alunos
        .find((item) => item.id === Number(excluir.dataset.excluirAluno));

    abrirModal({
        titulo: 'Excluir aluno',
        subtitulo: `${aluno.nome} — ${aluno.turma}`,
        corpo: `<p>O aluno sai da lista que os professores usam para alocar os
                   computadores.</p>
                <p class="texto-suave">As aulas já registradas não mudam: o histórico
                   guarda o nome de quem sentou em cada máquina.</p>`,
        textoCancelar: 'Cancelar',
        textoConfirmar: 'Sim, excluir',
        perigo: true,
        aoConfirmar: async () => {
            try {
                await API.del(`/api/gestor/alunos/${aluno.id}`);
                await carregarAlunos();
                notificar('Aluno excluído.');
                return true;
            } catch (falha) {
                notificar(falha.message, 'erro');
                return false;
            }
        },
    });
}

/* ------------------------------------------------------------------ */
/* Projetos no intervalo                                               */
/* ------------------------------------------------------------------ */
/*
 * A agenda do intervalo, do ponto de vista de quem organiza a escola: a lista
 * inteira, de todos os professores, com o filtro por período e a possibilidade
 * de reservar em nome de alguém. O registro dos computadores continua sendo do
 * professor responsável — aqui o gestor só o consulta.
 */

const projetosGestor = {
    janela: null,
    janelas: [],
    nomePadrao: 'Elaboração de Projetos',
    lista: [],
};

async function carregarProjetosGestor() {
    // a aba Regras ja pode ter buscado a janela ao carregar a configuracao:
    // nesse caso so falta desenhar, mas desenhar nunca pode ser pulado
    if (projetosGestor.janelas.length) desenharJanelaDoGestor();
    else await carregarJanelaDoGestor();
    montarFiltrosDeProjeto();
    await listarProjetosGestor();
}

async function carregarJanelaDoGestor() {
    try {
        const dados = await API.get('/api/projetos/janela');
        projetosGestor.janelas = dados.janelas || [];
        projetosGestor.janela = projetosGestor.janelas.find((j) => j.cabe)
            || projetosGestor.janelas[0] || null;
        projetosGestor.nomePadrao = dados.nome_padrao || projetosGestor.nomePadrao;
    } catch (falha) {
        notificar(falha.message, 'erro');
    }
    desenharJanelaDoGestor();
}

/** O mesmo cartão de leitura do professor: de onde sai a hora da reserva. */
function desenharJanelaDoGestor() {
    const area = document.getElementById('projetoJanelaGestor');
    const janela = projetosGestor.janela;
    const botao = document.getElementById('botaoNovoProjeto');

    if (!janela) {
        area.innerHTML = `
            <div class="aviso aviso--atencao"><div>
                <strong>A grade de horários não tem a 5ª aula.</strong>
                Sem ela o sistema não sabe onde fica o intervalo. Cadastre os
                horários da escola em <em>Horários</em> para liberar a reserva.
            </div></div>`;
        botao.disabled = true;
        return;
    }

    botao.disabled = !janela.cabe;

    if (!janela.cabe) {
        area.innerHTML = `
            <div class="aviso aviso--atencao"><div>
                <strong>O intervalo depois da ${janela.aula_referencia}ª aula tem só
                ${janela.livre} minutos</strong> (${escapar(janela.inicio)}–${escapar(janela.fim_intervalo)}).
                A reserva precisa de ${janela.duracao}: ajuste os horários em
                <em>Horários</em>.
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
               ${escapar(janela.fim_intervalo)}. Para mudar essa conta, mexa nos
               horários da escola ou nos parâmetros em <em>Regras</em>.</p>
        </div>`;
}

function montarFiltrosDeProjeto() {
    const professores = document.getElementById('projetoFiltroProfessor');
    if (professores.options.length <= 1) {
        professores.innerHTML = '<option value="">Todos</option>'
            + estadoAdmin.professores
                .filter((professor) => professor.ativo)
                .map((professor) => `
                    <option value="${professor.id}">${escapar(professor.nome)}</option>`)
                .join('');
    }

    const laboratorios = document.getElementById('projetoFiltroLaboratorio');
    if (laboratorios.options.length <= 1) {
        laboratorios.innerHTML = '<option value="">Todos</option>'
            + estadoAdmin.laboratorios
                .map((lab) => `<option value="${lab.id}">${escapar(lab.nome)}</option>`)
                .join('');
    }
}

async function listarProjetosGestor() {
    const corpo = document.getElementById('corpoProjetos');
    const vazio = document.getElementById('vazioProjetos');
    corpo.innerHTML = '';
    vazio.innerHTML = '<div class="lista-vazia"><span class="carregando"></span></div>';

    const parametros = new URLSearchParams();
    [['de', 'projetoDe'], ['ate', 'projetoAte'],
     ['professor_id', 'projetoFiltroProfessor'],
     ['laboratorio_id', 'projetoFiltroLaboratorio'],
     ['status', 'projetoFiltroStatus']].forEach(([chave, campo]) => {
        const valor = document.getElementById(campo).value;
        if (valor) parametros.set(chave, valor);
    });

    let resposta;
    try {
        resposta = await API.get(`/api/projetos?${parametros}`);
    } catch (falha) {
        vazio.innerHTML = `<div class="lista-vazia">${escapar(falha.message)}</div>`;
        return;
    }
    projetosGestor.lista = resposta.projetos || [];
    desenharProjetosGestor(resposta.resumo);
}

function desenharProjetosGestor(resumo) {
    const lista = projetosGestor.lista;

    document.getElementById('indicadoresProjetos').innerHTML = `
        <div class="indicador indicador--primaria">
            <strong>${resumo.reservas}</strong><span>Reservas no período</span>
        </div>
        <div class="indicador indicador--verde">
            <strong>${resumo.ativas}</strong><span>Ativas</span>
        </div>
        <div class="indicador">
            <strong>${resumo.registradas}</strong><span>Com computadores registrados</span>
        </div>
        <div class="indicador">
            <strong>${resumo.alunos}</strong><span>Alunos atendidos</span>
        </div>`;

    document.getElementById('corpoProjetos').innerHTML = lista.map((projeto) => `
        <tr>
            <td data-rotulo="Data / hora">
                <strong>${escapar(dataBR(projeto.data))}</strong>
                <br><span class="texto-suave mono" style="font-size:.76rem">
                    ${escapar(projeto.inicio)}–${escapar(projeto.fim)} ·
                    ${ROTULO_TURNO[projeto.turno] || ''}</span>
            </td>
            <td data-rotulo="Projeto">
                <button type="button" class="nome-acao" data-ver-projeto="${projeto.id}"
                        title="Abrir a reserva">${escapar(projeto.projeto)}</button>
                ${projeto.observacao
                    ? `<br><span class="texto-suave" style="font-size:.76rem">
                           ${escapar(projeto.observacao)}</span>`
                    : ''}
            </td>
            <td data-rotulo="Responsável">${escapar(projeto.professor_nome)}</td>
            <td data-rotulo="Laboratório">${escapar(projeto.laboratorio_nome)}</td>
            <td data-rotulo="Computadores" class="mono">
                ${projeto.sessao_id
                    ? `${projeto.computadores_usados} PC · ${projeto.total_alunos} aluno(s)`
                    : '<span class="texto-suave">sem registro</span>'}
            </td>
            <td data-rotulo="Situação">${selo(projeto.status)}</td>
            <td data-rotulo="Ações">
                <div class="barra-botoes" style="justify-content:flex-end">
                    <button class="botao botao--pequeno botao--vazio"
                            data-ver-projeto="${projeto.id}">Abrir</button>
                    <button class="botao botao--pequeno botao--perigo"
                            data-excluir-projeto="${projeto.id}">Excluir</button>
                </div>
            </td>
        </tr>`).join('');

    document.getElementById('vazioProjetos').innerHTML = lista.length ? '' : `
        <div class="lista-vazia">
            <strong>Nenhuma reserva de projeto no período</strong>
            Use “+ Nova reserva” para marcar o intervalo em nome de um professor.
        </div>`;
}

function aoClicarProjetoGestor(evento) {
    const abrir = evento.target.closest('[data-ver-projeto]');
    if (abrir) return abrirProjetoGestor(Number(abrir.dataset.verProjeto));

    const excluir = evento.target.closest('[data-excluir-projeto]');
    if (excluir) return excluirProjetoGestor(Number(excluir.dataset.excluirProjeto));
    return undefined;
}

/* ---- Nova reserva / edição ---- */

function abrirFormularioProjeto(projeto) {
    const dados = projeto || {};
    const editando = Boolean(dados.id);
    const janelas = projetosGestor.janelas.filter((j) => j.cabe);
    const professores = estadoAdmin.professores.filter(
        (professor) => professor.ativo || professor.id === dados.professor_id);

    const modal = abrirModal({
        titulo: editando ? 'Editar a reserva do intervalo' : 'Nova reserva no intervalo',
        subtitulo: projetosGestor.janela
            ? `${projetosGestor.janela.inicio}–${projetosGestor.janela.fim} · `
              + `${projetosGestor.janela.duracao} minutos fixos, depois da `
              + `${projetosGestor.janela.aula_referencia}ª aula`
            : '',
        corpo: `
            <div class="campo">
                <label for="formProjetoNome">Nome do projeto ou evento</label>
                <input type="text" id="formProjetoNome" maxlength="120"
                       value="${escapar(dados.projeto || projetosGestor.nomePadrao)}"
                       placeholder="${escapar(projetosGestor.nomePadrao)}">
            </div>
            <div class="linha-campos linha-campos--2">
                <div class="campo">
                    <label for="formProjetoProfessor">Professor responsável</label>
                    <select id="formProjetoProfessor">
                        <option value="">Escolha…</option>
                        ${professores.map((professor) => `
                            <option value="${professor.id}"
                                ${professor.id === dados.professor_id ? 'selected' : ''}>
                                ${escapar(professor.nome)}</option>`).join('')}
                    </select>
                </div>
                <div class="campo">
                    <label for="formProjetoLaboratorio">Laboratório</label>
                    <select id="formProjetoLaboratorio">
                        ${estadoAdmin.laboratorios.filter((lab) => lab.ativo).map((lab) => `
                            <option value="${lab.id}"
                                ${lab.id === dados.laboratorio_id ? 'selected' : ''}>
                                ${escapar(lab.nome)}</option>`).join('')}
                    </select>
                </div>
            </div>
            <div class="linha-campos linha-campos--2">
                <div class="campo">
                    <label for="formProjetoData">Data</label>
                    <input type="date" id="formProjetoData"
                           value="${escapar(dados.data || hojeISO())}">
                </div>
                <div class="campo ${janelas.length > 1 ? '' : 'oculto'}">
                    <label for="formProjetoTurno">Turno do intervalo</label>
                    <select id="formProjetoTurno">
                        ${janelas.map((j) => `
                            <option value="${escapar(j.turno)}"
                                ${j.turno === dados.turno ? 'selected' : ''}>
                                ${ROTULO_TURNO[j.turno] || j.turno} ·
                                ${escapar(j.inicio)}–${escapar(j.fim)}</option>`).join('')}
                    </select>
                </div>
            </div>
            <div class="campo">
                <label for="formProjetoObs">Observação (opcional)</label>
                <input type="text" id="formProjetoObs" maxlength="400"
                       value="${escapar(dados.observacao || '')}"
                       placeholder="ex.: grupo do 3º ano, apresentação na sexta">
            </div>
            <div id="erroFormProjeto" class="aviso aviso--erro oculto"></div>`,
        textoCancelar: 'Cancelar',
        textoConfirmar: editando ? 'Salvar' : 'Reservar',
        aoConfirmar: async (modal) => {
            const turno = modal.querySelector('#formProjetoTurno');
            const corpo = {
                projeto: modal.querySelector('#formProjetoNome').value.trim(),
                professor_id: Number(modal.querySelector('#formProjetoProfessor').value),
                laboratorio_id: Number(modal.querySelector('#formProjetoLaboratorio').value),
                data: modal.querySelector('#formProjetoData').value,
                turno: turno ? turno.value : '',
                observacao: modal.querySelector('#formProjetoObs').value.trim(),
            };
            try {
                if (editando) await API.put(`/api/projetos/${dados.id}`, corpo);
                else await API.post('/api/projetos', corpo);
            } catch (falha) {
                mostrarErro(modal.querySelector('#erroFormProjeto'), falha.message,
                    falha.dados && falha.dados.erros);
                return false;
            }
            notificar(editando ? 'Reserva atualizada.' : 'Intervalo reservado.');
            await listarProjetosGestor();
            return true;
        },
    });

    if (modal) vigiarChoqueDeProjeto(modal, dados.id || null);
    return modal;
}

/**
 * Avisa o choque de laboratório enquanto o gestor ainda monta a reserva.
 *
 * Quem marca em nome de um professor não tem a agenda do laboratório na cabeça:
 * a reserva daquele dia pode ter sido feita pelo próprio professor, ou por ele
 * mesmo para outro colega, semanas atrás. Esperar o clique em “Reservar” para
 * mostrar isso é tarde — então a cada troca de laboratório ou de data a tela
 * pergunta ao servidor e, havendo reserva na data, trava o botão com a mesma
 * frase que o envio devolveria.
 *
 * `ignorarId` é a própria reserva quando o gestor está editando: sem isso ela
 * se acusaria de estar ocupando o próprio horário.
 */
function vigiarChoqueDeProjeto(modal, ignorarId) {
    const laboratorio = modal.querySelector('#formProjetoLaboratorio');
    const data = modal.querySelector('#formProjetoData');
    const erro = modal.querySelector('#erroFormProjeto');
    const confirmar = modal.querySelector('[data-confirmar]');
    if (!laboratorio || !data) return;

    let pedido = 0;

    const conferir = async () => {
        const meu = pedido + 1;
        pedido = meu;

        if (!laboratorio.value || !data.value) {
            marcarChoqueDeProjeto(erro, confirmar, null);
            return;
        }

        const parametros = new URLSearchParams({
            laboratorio_id: laboratorio.value,
            data: data.value,
        });
        if (ignorarId) parametros.set('ignorar_id', ignorarId);

        let resposta;
        try {
            resposta = await API.get(`/api/projetos/ocupacao?${parametros}`);
        } catch (falha) {
            return;   // sem resposta o aviso some, mas o envio ainda barra
        }
        // enquanto a resposta vinha o gestor já trocou de novo: vale a última
        if (meu !== pedido) return;
        marcarChoqueDeProjeto(erro, confirmar,
            resposta.ocupado ? resposta.mensagem : null);
    };

    laboratorio.addEventListener('change', conferir);
    data.addEventListener('change', conferir);
    data.addEventListener('input', conferir);
    conferir();
}

function marcarChoqueDeProjeto(erro, confirmar, mensagem) {
    mostrarErro(erro, mensagem || '');
    if (confirmar) confirmar.disabled = Boolean(mensagem);
}

/* ---- Ficha da reserva ---- */

async function abrirProjetoGestor(projetoId) {
    const projeto = projetosGestor.lista.find((item) => item.id === projetoId);
    if (!projeto) return;

    let registro = null;
    if (projeto.sessao_id) {
        try {
            registro = await API.get(`/api/gestor/uso-computadores/${projeto.sessao_id}`);
        } catch (falha) {
            registro = null;
        }
    }

    const modal = abrirModal({
        titulo: projeto.projeto,
        subtitulo: `${projeto.laboratorio_nome} · ${dataBR(projeto.data)} · `
                 + `${projeto.inicio}–${projeto.fim}`,
        corpo: `
            <div class="ficha">
                <div class="ficha__item">
                    <span class="rotulo-pequeno">Professor responsável</span>
                    <strong>${escapar(projeto.professor_nome)}</strong>
                </div>
                <div class="ficha__item">
                    <span class="rotulo-pequeno">Turno do intervalo</span>
                    <strong>${ROTULO_TURNO[projeto.turno] || projeto.turno}</strong>
                </div>
                <div class="ficha__item">
                    <span class="rotulo-pequeno">Situação</span>
                    <strong>${selo(projeto.status)}</strong>
                </div>
                <div class="ficha__item">
                    <span class="rotulo-pequeno">Reservada em</span>
                    <strong>${escapar(dataHoraBR(projeto.criado_em))}</strong>
                </div>
            </div>
            ${projeto.observacao
                ? `<div class="aviso aviso--info"><div>${escapar(projeto.observacao)}</div></div>`
                : ''}

            <div class="campo">
                <label for="projetoStatusNovo">Mudar a situação</label>
                <select id="projetoStatusNovo">
                    <option value="ativa" ${projeto.status === 'ativa' ? 'selected' : ''}>Ativa</option>
                    <option value="realizada" ${projeto.status === 'realizada' ? 'selected' : ''}>Realizada</option>
                    <option value="falta" ${projeto.status === 'falta' ? 'selected' : ''}>Falta</option>
                    <option value="cancelada" ${projeto.status === 'cancelada' ? 'selected' : ''}>Cancelada</option>
                </select>
            </div>

            <span class="rotulo-pequeno">Computadores</span>
            ${registro
                ? `<p class="texto-suave" style="margin:4px 0 8px;font-size:.8rem">
                       ${registro.total_alunos} aluno(s) em ${registro.computadores_usados}
                       de ${registro.qtd_computadores} máquina(s), registrados em
                       ${escapar(dataHoraBR(registro.registrado_em))}.
                   </p>
                   <div class="computadores computadores--leitura">
                       ${mapaDeComputadoresHTML(registro.computadores)}
                   </div>`
                : `<div class="lista-vazia" style="padding:18px 12px">
                       O professor responsável ainda não registrou quem usou cada
                       computador. Ele faz isso em <strong>Projetos no intervalo</strong>,
                       na tela dele.
                   </div>`}

            <div class="divisor"></div>
            <div class="barra-botoes">
                <button type="button" class="botao botao--pequeno" id="botaoEditarProjeto">
                    Editar a reserva
                </button>
            </div>`,
        textoCancelar: 'Fechar',
        textoConfirmar: 'Salvar situação',
        aoConfirmar: async (janela) => {
            const status = janela.querySelector('#projetoStatusNovo').value;
            if (status === projeto.status) return true;
            try {
                await API.post(`/api/projetos/${projeto.id}/status`, { status });
            } catch (falha) {
                notificar(falha.message, 'erro');
                return false;
            }
            notificar('Situação atualizada.');
            await listarProjetosGestor();
            return true;
        },
    });

    if (!modal) return;
    modal.querySelector('#botaoEditarProjeto').addEventListener('click', () => {
        fecharModal();
        abrirFormularioProjeto(projeto);
    });
}

function excluirProjetoGestor(projetoId) {
    const projeto = projetosGestor.lista.find((item) => item.id === projetoId);
    if (!projeto) return;

    abrirModal({
        titulo: 'Excluir a reserva',
        subtitulo: `${projeto.projeto} · ${dataBR(projeto.data)}`,
        corpo: `<p>A reserva sai da agenda${projeto.sessao_id
            ? ' <strong>e o registro de computadores dela sai do histórico</strong>'
            : ''}. Para apenas liberar o intervalo mantendo o histórico, mude a
            situação para <em>cancelada</em>.</p>`,
        textoCancelar: 'Voltar',
        textoConfirmar: 'Sim, excluir',
        perigo: true,
        aoConfirmar: async () => {
            try {
                await API.del(`/api/projetos/${projetoId}`);
            } catch (falha) {
                notificar(falha.message, 'erro');
                return false;
            }
            notificar('Reserva excluída.');
            await listarProjetosGestor();
            return true;
        },
    });
}

/* ------------------------------------------------------------------ */
/* Uso de computadores: o historico do laboratorio                     */
/* ------------------------------------------------------------------ */
/*
 * Cada linha aqui e uma aula que um professor fechou na tela dele: a data, a
 * turma, o laboratorio e o mapa de quem sentou em qual maquina. O gestor so
 * le e filtra — quem registra e quem deu a aula.
 */

async function carregarUsoComputadores() {
    const corpo = document.getElementById('corpoUso');
    const vazio = document.getElementById('vazioUso');
    corpo.innerHTML = '';
    vazio.innerHTML = '<div class="lista-vazia"><span class="carregando"></span></div>';

    const parametros = new URLSearchParams();
    [['de', 'usoDe'], ['ate', 'usoAte'], ['professor_id', 'usoProfessor'],
     ['turma', 'usoTurma'], ['laboratorio_id', 'usoLaboratorio'],
     ['origem', 'usoOrigem']]
        .forEach(([chave, campo]) => {
            const valor = document.getElementById(campo).value;
            if (valor) parametros.set(chave, valor);
        });

    try {
        const resposta = await API.get(`/api/gestor/uso-computadores?${parametros}`);
        estadoAdmin.usoComputadores = resposta.registros || [];
        montarFiltroDeTurmasDoUso(resposta.turmas || []);
        desenharUsoComputadores(resposta.resumo);
    } catch (falha) {
        vazio.innerHTML = `<div class="lista-vazia">${escapar(falha.message)}</div>`;
    }
}

/**
 * As turmas do filtro saem do proprio resultado.
 *
 * A escolha em vigor e preservada mesmo quando ela some da lista (o filtro de
 * data pode ter deixado a turma de fora): tirar a opcao debaixo do seletor
 * faria a tela mostrar um filtro diferente do que esta valendo.
 */
function montarFiltroDeTurmasDoUso(turmas) {
    const seletor = document.getElementById('usoTurma');
    const escolhida = seletor.value;
    const opcoes = [...new Set([...turmas, escolhida].filter(Boolean))]
        .sort((a, b) => a.localeCompare(b, 'pt-BR'));

    seletor.innerHTML = '<option value="">Todas</option>'
        + opcoes.map((turma) => `
            <option value="${escapar(turma)}">${escapar(turma)}</option>`).join('');
    seletor.value = escolhida;
}

function desenharUsoComputadores(resumo) {
    const registros = estadoAdmin.usoComputadores;
    const corpo = document.getElementById('corpoUso');

    document.getElementById('indicadoresUso').innerHTML = `
        <div class="indicador indicador--primaria">
            <strong>${resumo.aulas}</strong><span>Aulas registradas</span>
        </div>
        <div class="indicador indicador--verde">
            <strong>${resumo.alunos}</strong><span>Alunos atendidos</span>
        </div>
        <div class="indicador">
            <strong>${resumo.computadores}</strong><span>Computadores ocupados</span>
        </div>
        <div class="indicador">
            <strong>${resumo.turmas}</strong><span>Turmas diferentes</span>
        </div>`;

    corpo.innerHTML = registros.map((registro) => `
        <tr>
            <td data-rotulo="Data / hora">
                <button type="button" class="nome-acao" data-ver-uso="${registro.id}"
                        title="Ver a alocação computador a computador">
                    ${escapar(dataBR(registro.data_aula))}
                </button>
                <br><span class="texto-suave mono" style="font-size:.76rem">
                    ${registro.inicio
                        ? `${escapar(registro.inicio)}–${escapar(registro.fim)}
                           · ${ROTULO_TURNO[registro.turno] || ''}`
                        : 'horário removido'}
                </span>
            </td>
            <td data-rotulo="Professor">${escapar(registro.professor_nome)}</td>
            <td data-rotulo="Turma">
                ${registro.projeto
                    ? `<span class="projeto-nome">${escapar(registro.projeto)}</span>
                       <br><span class="texto-suave" style="font-size:.76rem">
                           projeto no intervalo</span>`
                    : `${escapar(registro.turma || '—')}
                       ${registro.disciplina
                           ? `<br><span class="texto-suave" style="font-size:.76rem">
                                  ${escapar(registro.disciplina)}</span>`
                           : ''}`}
            </td>
            <td data-rotulo="Laboratório">${escapar(registro.laboratorio_nome)}</td>
            <td data-rotulo="Computadores" class="mono">
                ${registro.computadores_usados} de ${registro.qtd_computadores}
            </td>
            <td data-rotulo="Alunos" class="mono">${registro.total_alunos}</td>
            <td data-rotulo="Ações">
                <div class="barra-botoes" style="justify-content:flex-end">
                    <button class="botao botao--pequeno botao--vazio"
                            data-ver-uso="${registro.id}">Ver alocação</button>
                </div>
            </td>
        </tr>`).join('');

    document.getElementById('vazioUso').innerHTML = registros.length ? '' : `
        <div class="lista-vazia">
            <strong>Nenhum registro no período</strong>
            Os registros aparecem quando os professores salvam a alocação dos
            computadores na tela de aula deles.
        </div>`;
}

const ICONE_MAQUINA = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
    aria-hidden="true"><rect x="2.5" y="4" width="19" height="12" rx="2"/>
    <path d="M8 20h8M10.5 16l-.5 4M13.5 16l.5 4"/></svg>`;

async function abrirDetalheDoUso(sessaoId) {
    let registro;
    try {
        registro = await API.get(`/api/gestor/uso-computadores/${sessaoId}`);
    } catch (falha) {
        notificar(falha.message, 'erro');
        return;
    }

    const horario = registro.inicio
        ? `${registro.inicio}–${registro.fim} · ${ROTULO_TURNO[registro.turno] || ''}`
        : 'horário não informado';
    const origem = registro.projeto
        ? `projeto “${registro.projeto}” no intervalo`
        : (registro.turma || 'sem turma');

    const modal = abrirModal({
        titulo: `${registro.laboratorio_nome} — ${dataBR(registro.data_aula)}`,
        subtitulo: `${registro.professor_nome} · ${origem} · ${horario}`,
        corpo: `
            <div class="ficha">
                <div class="ficha__item">
                    <span class="rotulo-pequeno">Alunos</span>
                    <strong>${registro.total_alunos}</strong>
                </div>
                <div class="ficha__item">
                    <span class="rotulo-pequeno">Computadores usados</span>
                    <strong>${registro.computadores_usados} de ${registro.qtd_computadores}</strong>
                </div>
                <div class="ficha__item">
                    <span class="rotulo-pequeno">Registrado em</span>
                    <strong>${escapar(dataHoraBR(registro.registrado_em))}</strong>
                </div>
                ${registro.atualizado_em ? `
                <div class="ficha__item">
                    <span class="rotulo-pequeno">Corrigido em</span>
                    <strong>${escapar(dataHoraBR(registro.atualizado_em))}</strong>
                </div>` : ''}
            </div>
            ${registro.observacao ? `
                <div class="aviso aviso--info"><div>${escapar(registro.observacao)}</div></div>`
                : ''}
            <span class="rotulo-pequeno">Alocação</span>
            <div class="computadores computadores--leitura" style="margin-top:8px">
                ${mapaDeComputadoresHTML(registro.computadores)}
            </div>
            <div class="divisor"></div>
            <div class="barra-botoes">
                <button type="button" class="botao botao--pequeno botao--perigo"
                        id="botaoExcluirUso">Excluir registro</button>
            </div>`,
        textoCancelar: 'Fechar',
    });

    if (!modal) return;
    modal.querySelector('#botaoExcluirUso').addEventListener('click', () => {
        excluirRegistroDeUso(registro.id);
    });
}

function mapaDeComputadoresHTML(computadores) {
    if (!computadores.length) {
        return '<div class="lista-vazia">Sem computadores no registro.</div>';
    }
    return computadores.map((maquina) => `
        <div class="maquina ${maquina.alunos.length ? '' : 'maquina--vazia'}">
            <div class="maquina__topo">
                <span class="maquina__numero">${ICONE_MAQUINA}${maquina.numero}</span>
                <span class="maquina__lotacao">${maquina.alunos.length}/2</span>
            </div>
            ${maquina.alunos.length
                ? maquina.alunos.map((aluno) => `
                    <span class="cadeira" title="${escapar(aluno.aluno_nome)}">
                        <span>${escapar(aluno.aluno_nome)}</span>
                        ${aluno.aluno_matricula
                            ? `<span class="cadeira__matricula mono">
                                   ${escapar(aluno.aluno_matricula)}</span>`
                            : ''}
                    </span>`).join('')
                : '<span class="cadeira cadeira--livre">Não usado</span>'}
        </div>`).join('');
}

function excluirRegistroDeUso(sessaoId) {
    abrirModal({
        titulo: 'Excluir registro de uso',
        subtitulo: 'A aula sai do histórico do laboratório.',
        corpo: `<p>A reserva da aula continua como está — some apenas o registro de
                   quem sentou em cada computador.</p>
                <p class="texto-suave">O professor pode registrar de novo pela tela
                   de aula dele.</p>`,
        textoCancelar: 'Cancelar',
        textoConfirmar: 'Sim, excluir',
        perigo: true,
        aoConfirmar: async () => {
            try {
                await API.del(`/api/gestor/uso-computadores/${sessaoId}`);
                notificar('Registro excluído.');
                carregarUsoComputadores();
                return true;
            } catch (falha) {
                notificar(falha.message, 'erro');
                return false;
            }
        },
    });
}

/* ------------------------------------------------------------------ */
/* Horarios e bloqueios                                                */
/* ------------------------------------------------------------------ */

/**
 * No celular a grade e as datas bloqueadas viram duas abas, para nao ser
 * preciso rolar a tela inteira ate o segundo cartao. Quem esta no
 * computador nao ve o seletor: la os dois cartoes ficam lado a lado e o
 * CSS ignora as classes de aba.
 */
function configurarSubAbasHorarios() {
    const secao = document.getElementById('abaCalendario');
    const seletor = document.getElementById('subAbasCalendario');

    seletor.addEventListener('click', (evento) => {
        const botao = evento.target.closest('[data-painel]');
        if (!botao) return;
        const alvo = botao.dataset.painel;

        seletor.querySelectorAll('[data-painel]').forEach((item) => {
            item.classList.toggle('sub-abas__item--ativo', item.dataset.painel === alvo);
        });
        secao.querySelectorAll('.painel-aba').forEach((painel) => {
            painel.classList.toggle('painel-aba--ativo', painel.dataset.painel === alvo);
        });
    });
}

async function carregarHorarios() {
    estadoAdmin.horarios = await API.get('/api/horarios');
    const lista = document.getElementById('listaHorariosAdmin');

    if (!estadoAdmin.horarios.length) {
        lista.innerHTML = '<div class="lista-vazia">Nenhum horário cadastrado.</div>';
        return;
    }

    let html = '';
    let turnoAtual = null;
    // "6ª aula" e não "1ª da tarde": é assim que a escola numera o dia
    estadoAdmin.horarios.forEach((horario, indice) => {
        if (horario.turno !== turnoAtual) {
            turnoAtual = horario.turno;
            html += `<div class="grade__turno">${ROTULO_TURNO[turnoAtual] || turnoAtual}</div>`;
        }
        html += `
            <div class="item-reserva" style="padding:8px 12px">
                <div class="item-reserva__corpo">
                    <strong class="mono">${escapar(horario.inicio)} – ${escapar(horario.fim)}</strong>
                    <p>${indice + 1}ª aula</p>
                </div>
                <div class="item-reserva__acoes">
                    <button class="botao-icone" data-editar-horario="${horario.id}"
                            aria-label="Editar horário">✎</button>
                    <button class="botao-icone" data-excluir-horario="${horario.id}"
                            aria-label="Excluir horário">✕</button>
                </div>
            </div>`;
    });
    lista.innerHTML = html;
}

/**
 * Muda o inicio/fim de uma aula da escola. Vale para todo mundo de uma vez:
 * a grade dos professores e a reserva de laboratorio apontam para o mesmo
 * horario, entao os dois passam a valer no horario novo.
 */
function abrirFormularioHorario(horario) {
    const modal = abrirModal({
        titulo: 'Editar horário',
        subtitulo: `${estadoAdmin.horarios.indexOf(horario) + 1}ª aula`
            + ` · ${ROTULO_TURNO[horario.turno] || horario.turno}`,
        corpo: `
            <div class="linha-campos linha-campos--3">
                <div class="campo">
                    <label for="editHorarioTurno">Turno</label>
                    <select id="editHorarioTurno">
                        <option value="manha">Manhã</option>
                        <option value="tarde">Tarde</option>
                        <option value="noite">Noite</option>
                    </select>
                </div>
                <div class="campo">
                    <label for="editHorarioInicio">Início</label>
                    <input type="time" id="editHorarioInicio" value="${escapar(horario.inicio)}">
                </div>
                <div class="campo">
                    <label for="editHorarioFim">Fim</label>
                    <input type="time" id="editHorarioFim" value="${escapar(horario.fim)}">
                </div>
            </div>
            <p class="dica">As aulas que já estão nesse horário — na grade dos professores e
               nas reservas de laboratório — passam a valer no horário novo.</p>`,
        textoCancelar: 'Cancelar',
        textoConfirmar: 'Salvar',
        aoConfirmar: async (elemento) => {
            const dados = {
                turno: elemento.querySelector('#editHorarioTurno').value,
                inicio: elemento.querySelector('#editHorarioInicio').value,
                fim: elemento.querySelector('#editHorarioFim').value,
            };
            try {
                try {
                    await API.put(`/api/gestor/horarios/${horario.id}`, dados);
                } catch (falha) {
                    // passou a acontecer junto com outra aula: o servidor pede confirmação
                    if (!falha.dados || !falha.dados.confirmar) throw falha;
                    if (!window.confirm(`${falha.message}\n\nSalvar mesmo assim?`)) return false;
                    await API.put(`/api/gestor/horarios/${horario.id}?forcar=1`, dados);
                }
            } catch (falha) {
                notificar(falha.message, 'erro');
                return false;
            }
            await carregarHorarios();
            notificar('Horário atualizado.');
            return true;
        },
    });
    if (modal) modal.querySelector('#editHorarioTurno').value = horario.turno;
}

async function criarHorario(evento) {
    evento.preventDefault();
    const dados = {
        turno: document.getElementById('horarioTurno').value,
        inicio: document.getElementById('horarioInicio').value,
        fim: document.getElementById('horarioFim').value,
    };

    try {
        try {
            await API.post('/api/gestor/horarios', dados);
        } catch (falha) {
            // aula que acontece junto com outra: o servidor pede confirmação
            if (!falha.dados || !falha.dados.confirmar) throw falha;
            const confirmado = window.confirm(
                `${falha.message}\n\nAdicionar mesmo assim?`);
            if (!confirmado) return;
            await API.post('/api/gestor/horarios?forcar=1', dados);
        }
        document.getElementById('horarioInicio').value = '';
        document.getElementById('horarioFim').value = '';
        await carregarHorarios();
        notificar('Horário adicionado.');
    } catch (falha) {
        notificar(falha.message, 'erro');
    }
}

function aoClicarHorario(evento) {
    const editar = evento.target.closest('[data-editar-horario]');
    if (editar) {
        const horario = estadoAdmin.horarios.find(
            (item) => item.id === Number(editar.dataset.editarHorario));
        if (horario) abrirFormularioHorario(horario);
        return;
    }

    const botao = evento.target.closest('[data-excluir-horario]');
    if (!botao) return;
    const id = botao.dataset.excluirHorario;

    abrirModal({
        titulo: 'Excluir horário',
        corpo: '<p>Esse horário some da grade dos professores e da reserva '
            + 'de todos os laboratórios.</p>',
        textoCancelar: 'Voltar',
        textoConfirmar: 'Excluir',
        perigo: true,
        aoConfirmar: async () => {
            try {
                await API.del(`/api/gestor/horarios/${id}`);
            } catch (falha) {
                if (falha.dados && falha.dados.confirmar) {
                    if (!window.confirm(`${falha.message}\n\nExcluir mesmo assim?`)) return false;
                    await API.del(`/api/gestor/horarios/${id}?forcar=1`);
                } else {
                    notificar(falha.message, 'erro');
                    return false;
                }
            }
            await carregarHorarios();
            notificar('Horário excluído.');
            return true;
        },
    });
}


/* ------------------------------------------------------------------ */
/* Salas de aula                                                       */
/* ------------------------------------------------------------------ */
/*
 * Sala e onde a turma tem aula todo dia; laboratorio e o que o professor
 * reserva aula a aula. Mexer aqui nao afeta reserva nenhuma.
 */

async function carregarSalas() {
    estadoAdmin.salas = await API.get('/api/salas?todas=1');
    const lista = document.getElementById('listaSalas');

    if (!estadoAdmin.salas.length) {
        lista.innerHTML = '<div class="lista-vazia">Nenhuma sala cadastrada.</div>';
        return;
    }

    lista.innerHTML = estadoAdmin.salas.map((sala) => `
        <div class="item-reserva" style="padding:8px 12px">
            <div class="item-reserva__corpo">
                <strong>${escapar(sala.nome)}</strong>
                <p>${sala.capacidade} lugares${sala.ativo ? '' : ' · <em>inativa</em>'}
                   ${sala.observacoes ? ` · ${escapar(sala.observacoes)}` : ''}</p>
            </div>
            <div class="item-reserva__acoes">
                <button class="botao-icone" data-editar-sala="${sala.id}"
                        aria-label="Editar sala">✎</button>
                <button class="botao-icone" data-excluir-sala="${sala.id}"
                        aria-label="Excluir sala">✕</button>
            </div>
        </div>`).join('');
}

async function criarSala(evento) {
    evento.preventDefault();
    const dados = {
        nome: document.getElementById('salaNome').value.trim(),
        capacidade: document.getElementById('salaCapacidade').value || 35,
    };
    try {
        await API.post('/api/gestor/salas', dados);
        document.getElementById('formSala').reset();
        document.getElementById('salaCapacidade').value = 35;
        await carregarSalas();
        notificar('Sala adicionada.');
    } catch (falha) {
        notificar(falha.message, 'erro');
    }
}

function abrirFormularioSala(sala) {
    const modal = abrirModal({
        titulo: 'Editar sala',
        subtitulo: sala.nome,
        corpo: `
            <div class="linha-campos linha-campos--2">
                <div class="campo">
                    <label for="editSalaNome">Nome</label>
                    <input type="text" id="editSalaNome" maxlength="60"
                           value="${escapar(sala.nome)}">
                </div>
                <div class="campo">
                    <label for="editSalaCapacidade">Lugares</label>
                    <input type="number" id="editSalaCapacidade" min="1" max="200"
                           value="${sala.capacidade}">
                </div>
            </div>
            <div class="campo">
                <label for="editSalaObs">Observações</label>
                <input type="text" id="editSalaObs" maxlength="120"
                       value="${escapar(sala.observacoes || '')}">
            </div>
            <label class="checkbox">
                <input type="checkbox" id="editSalaAtiva" ${sala.ativo ? 'checked' : ''}>
                <span>Sala em uso (aparece na hora de montar a grade)</span>
            </label>`,
        textoCancelar: 'Cancelar',
        textoConfirmar: 'Salvar',
        aoConfirmar: async (elemento) => {
            try {
                await API.put(`/api/gestor/salas/${sala.id}`, {
                    nome: elemento.querySelector('#editSalaNome').value.trim(),
                    capacidade: elemento.querySelector('#editSalaCapacidade').value || 35,
                    observacoes: elemento.querySelector('#editSalaObs').value.trim(),
                    ativo: elemento.querySelector('#editSalaAtiva').checked,
                });
            } catch (falha) {
                notificar(falha.message, 'erro');
                return false;
            }
            await carregarSalas();
            notificar('Sala atualizada.');
            return true;
        },
    });
    return modal;
}

function aoClicarSala(evento) {
    const editar = evento.target.closest('[data-editar-sala]');
    if (editar) {
        const sala = estadoAdmin.salas.find(
            (item) => item.id === Number(editar.dataset.editarSala));
        if (sala) abrirFormularioSala(sala);
        return;
    }

    const botao = evento.target.closest('[data-excluir-sala]');
    if (!botao) return;
    const id = botao.dataset.excluirSala;

    abrirModal({
        titulo: 'Excluir sala',
        corpo: '<p>As aulas que estavam nessa sala continuam na grade, só ficam sem sala.</p>',
        textoCancelar: 'Voltar',
        textoConfirmar: 'Excluir',
        perigo: true,
        aoConfirmar: async () => {
            try {
                await API.del(`/api/gestor/salas/${id}`);
            } catch (falha) {
                if (falha.dados && falha.dados.confirmar) {
                    if (!window.confirm(`${falha.message}\n\nExcluir mesmo assim?`)) return false;
                    await API.del(`/api/gestor/salas/${id}?forcar=1`);
                } else {
                    notificar(falha.message, 'erro');
                    return false;
                }
            }
            await carregarSalas();
            notificar('Sala excluída.');
            return true;
        },
    });
}


/* ------------------------------------------------------------------ */
/* Visibilidade da grade                                               */
/* ------------------------------------------------------------------ */
/*
 * Duas chaves: a geral, aqui, que libera a grade da escola inteira para os
 * professores; e a de cada professor (Professores > Grade de aulas), que tira
 * so uma pessoa dessa grade. Quem esta oculto continua vendo a propria grade.
 */

function desenharVisibilidadeGrade() {
    document.getElementById('cfgGradeVisivel').checked =
        estadoAdmin.config.grade_visivel_todos === '1';

    const area = document.getElementById('listaOcultosGrade');
    const ocultos = estadoAdmin.professores.filter(
        (professor) => professor.ativo && !professor.grade_visivel);
    if (!ocultos.length) {
        area.innerHTML = '';
        return;
    }
    area.innerHTML = `
        <p class="dica" style="margin-top:12px"><strong>Fora da grade da escola:</strong></p>
        ${ocultos.map((professor) => `
            <div class="item-reserva" style="padding:6px 12px">
                <div class="item-reserva__corpo"><strong>${escapar(professor.nome)}</strong></div>
                <div class="item-reserva__acoes">
                    <button class="botao botao--pequeno botao--secundario"
                            data-mostrar-na-grade="${professor.id}">Mostrar</button>
                </div>
            </div>`).join('')}`;
}

async function salvarVisibilidadeGeral(evento) {
    const ligado = evento.target.checked ? '1' : '0';
    try {
        await API.put('/api/gestor/config', { grade_visivel_todos: ligado });
        estadoAdmin.config.grade_visivel_todos = ligado;
        notificar(ligado === '1'
            ? 'Os professores agora veem a grade da escola inteira.'
            : 'Cada professor volta a ver apenas a própria grade.');
    } catch (falha) {
        evento.target.checked = !evento.target.checked;
        notificar(falha.message, 'erro');
    }
}

async function aoClicarOcultoDaGrade(evento) {
    const botao = evento.target.closest('[data-mostrar-na-grade]');
    if (!botao) return;
    try {
        await API.post(`/api/gestor/professores/${botao.dataset.mostrarNaGrade}/visibilidade`,
            { grade_visivel: true });
        await carregarProfessores();
        desenharVisibilidadeGrade();
        notificar('Professor de volta à grade da escola.');
    } catch (falha) {
        notificar(falha.message, 'erro');
    }
}

async function carregarBloqueios() {
    estadoAdmin.bloqueios = await API.get('/api/bloqueios');
    const lista = document.getElementById('listaBloqueios');

    if (!estadoAdmin.bloqueios.length) {
        lista.innerHTML = `<div class="lista-vazia">
            Nenhuma data bloqueada. Cadastre feriados, recessos e manutenções.</div>`;
        return;
    }

    lista.innerHTML = estadoAdmin.bloqueios.map((bloqueio) => `
        <div class="item-reserva" style="padding:8px 12px">
            <div class="item-reserva__corpo">
                <strong>${escapar(bloqueio.descricao || 'Bloqueio')}</strong>
                <p class="mono">${dataBR(bloqueio.data_inicio)}
                   ${bloqueio.data_fim !== bloqueio.data_inicio
                        ? `→ ${dataBR(bloqueio.data_fim)}` : ''}</p>
                <p>${bloqueio.laboratorio_nome
                        ? escapar(bloqueio.laboratorio_nome) : 'Toda a escola'}</p>
            </div>
            <div class="item-reserva__acoes">
                <button class="botao-icone" data-excluir-bloqueio="${bloqueio.id}"
                        aria-label="Excluir bloqueio">✕</button>
            </div>
        </div>`).join('');
}

async function criarBloqueio(evento) {
    evento.preventDefault();
    const inicio = document.getElementById('bloqueioInicio').value;
    try {
        await API.post('/api/gestor/bloqueios', {
            data_inicio: inicio,
            data_fim: document.getElementById('bloqueioFim').value || inicio,
            descricao: document.getElementById('bloqueioDescricao').value.trim(),
            laboratorio_id: document.getElementById('bloqueioLaboratorio').value || null,
        });
        document.getElementById('formBloqueio').reset();
        await carregarBloqueios();
        notificar('Bloqueio cadastrado.');
    } catch (falha) {
        notificar(falha.message, 'erro');
    }
}

async function aoClicarBloqueio(evento) {
    const botao = evento.target.closest('[data-excluir-bloqueio]');
    if (!botao) return;
    try {
        await API.del(`/api/gestor/bloqueios/${botao.dataset.excluirBloqueio}`);
        await carregarBloqueios();
        notificar('Bloqueio removido.');
    } catch (falha) {
        notificar(falha.message, 'erro');
    }
}

/* ------------------------------------------------------------------ */
/* Configuracoes                                                       */
/* ------------------------------------------------------------------ */

async function carregarConfig() {
    estadoAdmin.config = await API.get('/api/gestor/config');
    const config = estadoAdmin.config;

    document.getElementById('cfgAntecedencia').value = config.antecedencia_maxima_dias;
    document.getElementById('cfgMaxAulas').value = config.max_aulas_seguidas;
    document.getElementById('cfgCancelamento').value = config.cancelamento_antecedencia_horas;
    document.getElementById('cfgCarencia').value = config.carencia_dias;
    document.getElementById('cfgEscopo').value = config.carencia_escopo;
    document.getElementById('cfgContagem').value = config.carencia_dias_letivos === '1' ? '1' : '0';
    document.getElementById('cfgFalta').checked = config.falta_conta_como_uso === '1';
    document.getElementById('cfgFimDeSemana').checked = config.permitir_fim_de_semana === '1';

    document.getElementById('cfgProjetoAula').value = config.projeto_aula_referencia || '5';
    document.getElementById('cfgProjetoIntervalo').value = config.projeto_intervalo_min || '60';
    document.getElementById('cfgProjetoDuracao').value = config.projeto_duracao_min || '50';
    document.getElementById('cfgProjetoNome').value = config.projeto_nome_padrao || '';
    mostrarJanelaNasRegras();

    // envio de acesso
    const endereco = document.getElementById('cfgEndereco');
    endereco.value = config.endereco_sistema || '';
    endereco.placeholder = config.endereco_detectado || 'http://192.168.0.10:5000';
    document.getElementById('cfgSmtpServidor').value = config.smtp_servidor || '';
    document.getElementById('cfgSmtpPorta').value = config.smtp_porta || '587';
    document.getElementById('cfgSmtpUsuario').value = config.smtp_usuario || '';
    document.getElementById('cfgSmtpRemetente').value = config.smtp_remetente || '';
    document.getElementById('cfgSmtpTls').checked = config.smtp_tls === '1';
    document.getElementById('avisoSmtpSenha').textContent =
        config.smtp_senha_definida ? '(já cadastrada)' : '(não cadastrada)';

    // fica na aba Horários, não no formulário de regras: salva sozinho ao marcar
    desenharVisibilidadeGrade();
}

/**
 * Diz, ali no formulario, que hora os parametros acabaram de produzir.
 *
 * O gestor mexe em numeros abstratos ("depois da 5a aula", "50 minutos") e o
 * que ele quer saber e o resultado: "12:10-13:00". Sem isto, so descobriria
 * abrindo a outra aba.
 */
async function mostrarJanelaNasRegras() {
    const aviso = document.getElementById('avisoJanelaRegras');
    let janelas = [];
    try {
        janelas = (await API.get('/api/projetos/janela')).janelas || [];
    } catch (falha) {
        aviso.classList.add('oculto');
        return;
    }

    projetosGestor.janelas = janelas;
    projetosGestor.janela = janelas.find((j) => j.cabe) || janelas[0] || null;

    if (!janelas.length) {
        aviso.className = 'aviso aviso--atencao';
        aviso.innerHTML = `<div>A grade de <strong>Horários</strong> não tem uma aula
            com essa ordem, então nenhum intervalo é reservável hoje.</div>`;
        return;
    }

    aviso.className = 'aviso aviso--info';
    aviso.innerHTML = janelas.map((janela) => `<div>
        <strong>${ROTULO_TURNO[janela.turno] || janela.turno}:</strong>
        a ${janela.aula_referencia}ª aula termina às ${escapar(janela.aula_termina)},
        então a reserva vai das <strong>${escapar(janela.inicio)} às
        ${escapar(janela.fim)}</strong>
        ${janela.cabe
            ? `— o intervalo tem ${janela.livre} minutos e a reserva cabe.`
            : `— <strong>não cabe</strong>: o intervalo tem só ${janela.livre} minutos.`}
        </div>`).join('');
}


async function salvarConfig(evento) {
    evento.preventDefault();
    const erro = document.getElementById('erroConfig');
    mostrarErro(erro, '');

    const dados = {
        antecedencia_maxima_dias: document.getElementById('cfgAntecedencia').value,
        max_aulas_seguidas: document.getElementById('cfgMaxAulas').value,
        cancelamento_antecedencia_horas: document.getElementById('cfgCancelamento').value,
        carencia_dias: document.getElementById('cfgCarencia').value,
        carencia_escopo: document.getElementById('cfgEscopo').value,
        carencia_dias_letivos: document.getElementById('cfgContagem').value,
        falta_conta_como_uso: document.getElementById('cfgFalta').checked ? '1' : '0',
        permitir_fim_de_semana: document.getElementById('cfgFimDeSemana').checked ? '1' : '0',
        projeto_aula_referencia: document.getElementById('cfgProjetoAula').value,
        projeto_intervalo_min: document.getElementById('cfgProjetoIntervalo').value,
        projeto_duracao_min: document.getElementById('cfgProjetoDuracao').value,
        projeto_nome_padrao: document.getElementById('cfgProjetoNome').value.trim(),
    };

    try {
        await API.put('/api/gestor/config', dados);
        projetosGestor.janelas = [];   // a janela do intervalo saiu destes campos
        await carregarConfig();
        notificar('Regras salvas.');
    } catch (falha) {
        mostrarErro(erro, falha.message);
    }
}

/* O endereço do sistema e o SMTP moram no próprio cartão, depois da exceção:
   são a configuração de envio das credenciais, não uma regra de reserva. */
async function salvarEnvio(evento) {
    evento.preventDefault();
    const erro = document.getElementById('erroEnvio');
    mostrarErro(erro, '');

    const dados = {
        endereco_sistema: document.getElementById('cfgEndereco').value.trim(),
        smtp_servidor: document.getElementById('cfgSmtpServidor').value.trim(),
        smtp_porta: document.getElementById('cfgSmtpPorta').value || '587',
        smtp_usuario: document.getElementById('cfgSmtpUsuario').value.trim(),
        smtp_remetente: document.getElementById('cfgSmtpRemetente').value.trim(),
        smtp_tls: document.getElementById('cfgSmtpTls').checked ? '1' : '0',
        smtp_senha: document.getElementById('cfgSmtpSenha').value,
    };

    try {
        await API.put('/api/gestor/config', dados);
        document.getElementById('cfgSmtpSenha').value = '';
        await carregarConfig();
        notificar('Envio de acesso salvo.');
    } catch (falha) {
        mostrarErro(erro, falha.message);
    }
}

/* ------------------------------------------------------------------ */
/* Excecao de aulas seguidas por professor                             */
/* ------------------------------------------------------------------ */
/*
 * O limite de aulas seguidas do formulario acima vale para a escola inteira.
 * Aqui o gestor abre a excecao nome a nome: os professores marcados podem
 * encadear mais aulas num mesmo dia, e so em ate X dias seguidos da semana.
 * O motor da grade recusa a montagem que passar disso.
 */

async function carregarExcecaoAulas() {
    const dados = await API.get('/api/gestor/excecoes-aulas-seguidas');
    const estado = estadoAdmin.excecaoAulas;

    estado.professores = dados.professores || [];
    estado.excecoes = dados.excecoes || [];
    estado.maxAulasSeguidas = dados.max_aulas_seguidas;
    estado.opcoesAulas = dados.opcoes_aulas || [];
    estado.opcoesDias = dados.opcoes_dias || [];
    estado.selecionados = new Set(estado.excecoes.map((item) => item.professor_id));

    document.getElementById('excecaoLimiteGeral').textContent =
        `${estado.maxAulasSeguidas} aula(s) seguidas por dia`;

    preencherSeletoresExcecao();
    desenharExcecaoAulas();
}

/**
 * Monta os dois seletores e deixa neles os valores que já estão valendo.
 *
 * Quando as exceções gravadas não concordam entre si (uma de 3 aulas e outra
 * de 5), o seletor abre na primeira opção que passa do limite geral — salvar
 * assim igualaria todo mundo, então a dica do cartão avisa que os valores
 * escolhidos valem para todos os marcados.
 */
function preencherSeletoresExcecao() {
    const estado = estadoAdmin.excecaoAulas;
    const aulas = document.getElementById('excecaoMaxAulas');
    const dias = document.getElementById('excecaoMaxDias');

    aulas.innerHTML = estado.opcoesAulas
        .map((valor) => `<option value="${valor}">até ${valor} aulas seguidas</option>`).join('');
    dias.innerHTML = estado.opcoesDias
        .map((valor) => `<option value="${valor}">até ${valor} dia(s) seguido(s)</option>`)
        .join('');

    const padraoAulas = estado.opcoesAulas.find((valor) => valor > estado.maxAulasSeguidas)
        || estado.opcoesAulas[estado.opcoesAulas.length - 1];
    const iguais = estado.excecoes.length
        && estado.excecoes.every((item) => item.max_aulas === estado.excecoes[0].max_aulas
                                        && item.max_dias === estado.excecoes[0].max_dias);

    aulas.value = String(iguais ? estado.excecoes[0].max_aulas : padraoAulas);
    dias.value = String(iguais ? estado.excecoes[0].max_dias : estado.opcoesDias[0]);
}

function desenharExcecaoAulas() {
    const estado = estadoAdmin.excecaoAulas;
    const termo = document.getElementById('buscaExcecaoProfessor').value.trim();
    const visiveis = professoresVisiveisNaExcecao();
    const gravadas = new Map(estado.excecoes.map((item) => [item.professor_id, item]));
    const area = document.getElementById('listaExcecaoProfessores');

    if (!estado.professores.length) {
        area.innerHTML = `<div class="lista-vazia">
            <strong>Nenhum professor ativo</strong>
            Cadastre os professores para abrir exceções.</div>`;
    } else if (!visiveis.length) {
        area.innerHTML = `<div class="lista-vazia">
            Nenhum professor encontrado para "${escapar(termo)}".</div>`;
    } else {
        area.innerHTML = visiveis.map((professor) => {
            const excecao = gravadas.get(professor.id);
            return `
            <label class="item-selecao">
                <input type="checkbox" value="${professor.id}"
                       ${estado.selecionados.has(professor.id) ? 'checked' : ''}>
                <span class="item-selecao__dados">
                    <strong>${escapar(professor.nome)}</strong>
                    <span class="mono">Matrícula ${escapar(professor.matricula)}</span>
                    ${professor.disciplina
                        ? `<span>${escapar(professor.disciplina)}</span>` : ''}
                    ${excecao
                        ? `<span class="item-selecao__marca">${excecao.max_aulas} aulas
                           &middot; ${excecao.max_dias} dia(s)</span>` : ''}
                </span>
            </label>`;
        }).join('');
    }

    atualizarContagemExcecao(visiveis.length);
}

/** Professores que passam pela busca (nome ou matrícula), na ordem da lista. */
function professoresVisiveisNaExcecao() {
    const estado = estadoAdmin.excecaoAulas;
    const termo = normalizar(document.getElementById('buscaExcecaoProfessor').value.trim());
    if (!termo) return estado.professores;
    return estado.professores.filter((professor) =>
        normalizar(professor.nome).includes(termo)
        || normalizar(professor.matricula).includes(termo));
}

function atualizarContagemExcecao(visiveis) {
    const estado = estadoAdmin.excecaoAulas;
    const total = estado.selecionados.size;
    const filtrando = visiveis !== estado.professores.length;
    document.getElementById('contagemExcecao').textContent = total
        ? `${total} professor(es) com exceção`
          + (filtrando ? ` — mostrando ${visiveis} de ${estado.professores.length}` : '')
        : 'Nenhum professor selecionado — todos seguem o limite geral';
}

function aoMarcarProfessorExcecao(evento) {
    const caixa = evento.target.closest('input[type="checkbox"]');
    if (!caixa) return;
    const id = Number(caixa.value);
    if (caixa.checked) {
        estadoAdmin.excecaoAulas.selecionados.add(id);
    } else {
        estadoAdmin.excecaoAulas.selecionados.delete(id);
    }
    atualizarContagemExcecao(professoresVisiveisNaExcecao().length);
}

/** Marca (ou desmarca) de uma vez só quem a busca está mostrando. */
function marcarProfessoresVisiveis(marcar) {
    const estado = estadoAdmin.excecaoAulas;
    professoresVisiveisNaExcecao().forEach((professor) => {
        if (marcar) {
            estado.selecionados.add(professor.id);
        } else {
            estado.selecionados.delete(professor.id);
        }
    });
    desenharExcecaoAulas();
}

async function salvarExcecaoAulas(evento) {
    evento.preventDefault();
    const estado = estadoAdmin.excecaoAulas;
    const erro = document.getElementById('erroExcecaoAulas');
    mostrarErro(erro, '');

    const escolhidos = [...estado.selecionados];
    const maxAulas = Number(document.getElementById('excecaoMaxAulas').value);
    const maxDias = Number(document.getElementById('excecaoMaxDias').value);

    // salvar sem ninguém marcado apaga as exceções que existiam: pede confirmação
    if (!escolhidos.length && estado.excecoes.length) {
        const confirmou = await confirmarRemocaoDasExcecoes(estado.excecoes.length);
        if (!confirmou) return;
    }

    try {
        const resposta = await API.put('/api/gestor/excecoes-aulas-seguidas', {
            professores: escolhidos,
            max_aulas: maxAulas,
            max_dias: maxDias,
        });
        await carregarExcecaoAulas();
        notificar(resposta.total
            ? `Exceção salva para ${resposta.total} professor(es): até ${maxAulas} aulas `
              + `seguidas em até ${maxDias} dia(s) seguido(s).`
            : 'Todos os professores voltaram ao limite geral da escola.');
    } catch (falha) {
        mostrarErro(erro, falha.message);
    }
}

/**
 * Confirmação de "salvar com ninguém marcado", que apaga todas as exceções.
 *
 * O modal do sistema fecha pelo botão, pelo Esc ou clicando fora; a promessa
 * só é resolvida quando ele sai da tela, para o formulário não seguir antes
 * de o gestor decidir.
 */
function confirmarRemocaoDasExcecoes(quantidade) {
    return new Promise((resolver) => {
        let confirmou = false;
        const area = document.getElementById('areaModal');
        abrirModal({
            titulo: 'Remover todas as exceções?',
            subtitulo: `${quantidade} professor(es) voltam ao limite geral da escola.`,
            corpo: `<p>Nenhum professor está marcado. Ao salvar, as exceções cadastradas
                    são apagadas e as grades passam a valer pelo limite geral.</p>`,
            textoCancelar: 'Cancelar',
            textoConfirmar: 'Remover exceções',
            perigo: true,
            aoConfirmar: () => { confirmou = true; },
        });
        const observador = new MutationObserver(() => {
            if (!area.querySelector('.fundo-modal')) {
                observador.disconnect();
                resolver(confirmou);
            }
        });
        observador.observe(area, { childList: true });
    });
}

/* ------------------------------------------------------------------ */
/* Minha conta                                                         */
/* ------------------------------------------------------------------ */
/* Escola e nome vem do gerente geral e ficam so para leitura; o gestor
   mantem por conta propria o e-mail e o WhatsApp.                      */

async function carregarMinhaContaGestor() {
    const aviso = document.getElementById('avisoContaGestor');
    const conteudo = document.getElementById('conteudoContaGestor');
    try {
        const conta = await API.get('/api/gestor/minha-conta');
        aviso.classList.add('oculto');
        conteudo.classList.remove('oculto');

        document.getElementById('contaEscolaNome').textContent = conta.escola.nome || '—';
        document.getElementById('contaEscolaCidade').textContent = conta.escola.cidade || '—';
        document.getElementById('contaEscolaEndereco').textContent = conta.escola.endereco || '—';
        document.getElementById('contaGestorNome').textContent = conta.nome;
        document.getElementById('contaGestorUsuario').textContent = conta.usuario;
        document.getElementById('contaGestorEmail').value = conta.email || '';
        // o campo mostra a máscara; só os dígitos vão para o servidor
        document.getElementById('contaGestorTelefone').value = formatarCelular(conta.telefone);
    } catch (falha) {
        // o gerente geral entra no painel sem ter conta de gestor local
        aviso.innerHTML = `<div>${escapar(falha.message)}</div>`;
        aviso.classList.remove('oculto');
        conteudo.classList.add('oculto');
    }
}

async function salvarContatoGestor(evento) {
    evento.preventDefault();
    const erro = document.getElementById('erroContatoGestor');
    mostrarErro(erro, '');

    const campoTelefone = document.getElementById('contaGestorTelefone');
    const telefone = soDigitos(campoTelefone.value);
    const avisoTelefone = erroTelefone(telefone);
    if (avisoTelefone) {
        mostrarErro(erro, avisoTelefone);
        campoTelefone.focus();
        return;
    }

    try {
        await API.put('/api/gestor/minha-conta', {
            email: document.getElementById('contaGestorEmail').value.trim(),
            telefone,
        });
        notificar('Contato salvo.');
        await carregarMinhaContaGestor();
    } catch (falha) {
        mostrarErro(erro, falha.message);
    }
}

async function trocarMinhaSenhaGestor(evento) {
    evento.preventDefault();
    const erro = document.getElementById('erroSenhaGestor');
    mostrarErro(erro, '');

    const nova = document.getElementById('senhaNovaGestor').value;
    if (nova !== document.getElementById('senhaConfirmaGestor').value) {
        mostrarErro(erro, 'A confirmação não é igual à nova senha.');
        return;
    }
    if (nova.length < 6) {
        mostrarErro(erro, 'A nova senha precisa ter pelo menos 6 caracteres.');
        return;
    }

    try {
        await API.post('/api/gestor/minha-conta/senha', {
            senha_atual: document.getElementById('senhaAtualGestor').value,
            nova_senha: nova,
        });
        document.getElementById('formSenhaGestor').reset();
        notificar('Senha atualizada. Use a nova senha no próximo acesso.');
    } catch (falha) {
        mostrarErro(erro, falha.message);
    }
}

/* ------------------------------------------------------------------ */
/* Relatorio                                                           */
/* ------------------------------------------------------------------ */

async function gerarRelatorio() {
    const area = document.getElementById('conteudoRelatorio');
    area.innerHTML = '<div class="lista-vazia"><span class="carregando"></span></div>';

    const de = document.getElementById('relDe').value;
    const ate = document.getElementById('relAte').value;

    try {
        const dados = await API.get(`/api/gestor/relatorio?de=${de}&ate=${ate}`);
        const totais = dados.totais;
        const maiorUso = Math.max(1, ...dados.por_laboratorio.map((lab) => lab.aulas || 0));

        area.innerHTML = `
            <div class="indicadores">
                <div class="indicador">
                    <strong>${totais.total || 0}</strong><span>Reservas no período</span>
                </div>
                <div class="indicador indicador--verde">
                    <strong>${(totais.ativas || 0) + (totais.realizadas || 0)}</strong>
                    <span>Ativas / realizadas</span>
                </div>
                <div class="indicador indicador--ambar">
                    <strong>${totais.faltas || 0}</strong><span>Faltas</span>
                </div>
                <div class="indicador indicador--primaria">
                    <strong>${dados.taxa_ocupacao}%</strong><span>Taxa de ocupação</span>
                </div>
            </div>

            <div class="cartao">
                <div class="cartao__topo">
                    <h3>Uso por laboratório</h3>
                    <span class="texto-suave" style="font-size:.78rem">
                        ${dados.periodo.dias_letivos} dias letivos
                    </span>
                </div>
                <div class="tabela-envolvida">
                    <table>
                        <thead>
                            <tr>
                                <th>Laboratório</th><th>Aulas</th>
                                <th>Manhã</th><th>Tarde</th><th>Noite</th><th>Uso</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${dados.por_laboratorio.map((lab) => `
                                <tr>
                                    <td data-rotulo="Laboratório"><strong>${escapar(lab.nome)}</strong></td>
                                    <td data-rotulo="Aulas">${lab.aulas || 0}</td>
                                    <td data-rotulo="Manhã">${lab.manha || 0}</td>
                                    <td data-rotulo="Tarde">${lab.tarde || 0}</td>
                                    <td data-rotulo="Noite">${lab.noite || 0}</td>
                                    <td data-rotulo="Uso">
                                        <div class="barra-progresso">
                                            <i style="width:${Math.round(100 * (lab.aulas || 0) / maiorUso)}%"></i>
                                        </div>
                                    </td>
                                </tr>`).join('')}
                        </tbody>
                    </table>
                </div>
            </div>

            <div class="cartao">
                <div class="cartao__topo"><h3>Uso por professor</h3></div>
                ${dados.por_professor.length ? `
                <div class="tabela-envolvida">
                    <table>
                        <thead>
                            <tr><th>Professor</th><th>Disciplina</th><th>Aulas</th><th>Faltas</th></tr>
                        </thead>
                        <tbody>
                            ${dados.por_professor.map((prof) => `
                                <tr>
                                    <td data-rotulo="Professor"><strong>${escapar(prof.nome)}</strong></td>
                                    <td data-rotulo="Disciplina">${escapar(prof.disciplina || '—')}</td>
                                    <td data-rotulo="Aulas">${prof.aulas}</td>
                                    <td data-rotulo="Faltas">${prof.faltas || 0}</td>
                                </tr>`).join('')}
                        </tbody>
                    </table>
                </div>` : '<div class="lista-vazia">Nenhuma reserva no período.</div>'}
            </div>`;
    } catch (falha) {
        area.innerHTML = `<div class="lista-vazia">${escapar(falha.message)}</div>`;
    }
}
