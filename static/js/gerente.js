/* =========================================================================
   Painel do gerente geral: visao geral da escola e as contas dos gestores
   locais (o nivel acima do antigo "administrador").

   O fluxo de criacao de conta e o mesmo que o gestor local usa com os
   professores: o sistema sugere o usuario, sorteia a senha e abre a tela de
   envio por e-mail/WhatsApp.
   ========================================================================= */

const estadoGerente = {
    gestores: [],
    unidades: [],
    semUnidade: null,
    visao: null,
};

document.addEventListener('DOMContentLoaded', iniciarGerente);

async function iniciarGerente() {
    ligarEventosGerente();
    try {
        const sessao = await API.get('/api/sessao');
        if (sessao.gerente) {
            await abrirPainelGerente();
        } else {
            document.getElementById('telaLogin').classList.remove('oculto');
        }
    } catch (erro) {
        document.getElementById('telaLogin').classList.remove('oculto');
    }
}

async function abrirPainelGerente() {
    iniciarVigiaDeSessao();     // sai sozinho depois do tempo parado (api.js)
    document.getElementById('telaLogin').classList.add('oculto');
    document.getElementById('app').classList.remove('oculto');
    await Promise.all([carregarVisaoGeral(), carregarUnidades(), carregarGestores()]);
}

function ligarEventosGerente() {
    document.getElementById('formLogin').addEventListener('submit', async (evento) => {
        evento.preventDefault();
        const erro = document.getElementById('erroLogin');
        mostrarErro(erro, '');
        try {
            await API.post('/api/login/gerente', {
                senha: document.getElementById('senha').value,
            });
            await abrirPainelGerente();
        } catch (falha) {
            mostrarErro(erro, falha.message);
        }
    });

    configurarSair();
    preencherDataDeHoje();
    configurarAbas((aba) => {
        if (aba === 'visao') carregarVisaoGeral();
        if (aba === 'gestores') carregarGestores();
        if (aba === 'unidades') carregarUnidades();
    });

    document.getElementById('botaoNovaUnidade')
        .addEventListener('click', () => abrirFormularioUnidade());
    document.getElementById('listaUnidades').addEventListener('click', aoClicarUnidade);

    document.getElementById('visaoDe').value = somarDias(hojeISO(), -30);
    document.getElementById('visaoAte').value = somarDias(hojeISO(), 30);
    document.getElementById('botaoFiltrarVisao').addEventListener('click', carregarVisaoGeral);
    document.getElementById('botaoAtualizarVisao').addEventListener('click', carregarVisaoGeral);

    document.getElementById('botaoNovoGestor')
        .addEventListener('click', () => abrirFormularioGestor());
    document.getElementById('corpoGestores').addEventListener('click', aoClicarGestor);
    document.getElementById('buscaGestor').addEventListener('input', desenharGestores);

    document.getElementById('formSenhaGerente').addEventListener('submit', trocarSenhaGerente);
}

/* ------------------------------------------------------------------ */
/* Visao geral                                                         */
/* ------------------------------------------------------------------ */

async function carregarVisaoGeral() {
    const area = document.getElementById('conteudoVisao');
    area.innerHTML = '<div class="lista-vazia"><span class="carregando"></span></div>';

    const de = document.getElementById('visaoDe').value;
    const ate = document.getElementById('visaoAte').value;

    try {
        const dados = await API.get(`/api/gerente/visao-geral?de=${de}&ate=${ate}`);
        estadoGerente.visao = dados;
        area.innerHTML = montarVisaoGeral(dados);
    } catch (falha) {
        area.innerHTML = `<div class="lista-vazia">${escapar(falha.message)}</div>`;
    }
}

function montarVisaoGeral(dados) {
    const totais = dados.totais;
    const reservas = dados.reservas || {};
    const maiorUso = Math.max(1, ...dados.por_laboratorio.map((lab) => lab.aulas || 0));
    const turnos = dados.por_turno || {};

    return `
        <div class="indicadores">
            <div class="indicador indicador--primaria">
                <strong>${totais.gestores_ativos}</strong>
                <span>Gestores locais ativos</span>
            </div>
            <div class="indicador">
                <strong>${totais.professores_ativos}</strong>
                <span>Professores ativos</span>
            </div>
            <div class="indicador">
                <strong>${totais.laboratorios_ativos}</strong>
                <span>Laboratórios em uso</span>
            </div>
            <div class="indicador indicador--verde">
                <strong>${dados.taxa_ocupacao}%</strong>
                <span>Taxa de ocupação</span>
            </div>
        </div>

        <div class="indicadores">
            <div class="indicador">
                <strong>${reservas.total || 0}</strong><span>Reservas no período</span>
            </div>
            <div class="indicador indicador--verde">
                <strong>${totais.reservas_hoje}</strong><span>Aulas hoje</span>
            </div>
            <div class="indicador indicador--primaria">
                <strong>${totais.reservas_futuras}</strong><span>Reservas futuras</span>
            </div>
            <div class="indicador indicador--ambar">
                <strong>${reservas.faltas || 0}</strong><span>Faltas no período</span>
            </div>
        </div>

        <div class="grade-cartoes">
            <div class="cartao">
                <div class="cartao__topo">
                    <h3>Uso por laboratório</h3>
                    <span class="texto-suave" style="font-size:.78rem">
                        ${dados.periodo.dias_letivos} dias letivos
                    </span>
                </div>
                ${dados.por_laboratorio.length ? `
                <div class="tabela-envolvida">
                    <table>
                        <thead>
                            <tr><th>Laboratório</th><th>Aulas</th><th>Uso</th></tr>
                        </thead>
                        <tbody>
                            ${dados.por_laboratorio.map((lab) => `
                                <tr>
                                    <td data-rotulo="Laboratório">
                                        <strong>${escapar(lab.nome)}</strong>
                                        ${lab.ativo ? '' : ' <span class="selo selo--cancelada">Inativo</span>'}
                                    </td>
                                    <td data-rotulo="Aulas">${lab.aulas || 0}</td>
                                    <td data-rotulo="Uso">
                                        <div class="barra-progresso">
                                            <i style="width:${Math.round(100 * (lab.aulas || 0) / maiorUso)}%"></i>
                                        </div>
                                    </td>
                                </tr>`).join('')}
                        </tbody>
                    </table>
                </div>` : '<div class="lista-vazia">Nenhum laboratório cadastrado.</div>'}
            </div>

            <div class="cartao">
                <div class="cartao__topo"><h3>Reservas por turno</h3></div>
                <div class="tabela-envolvida">
                    <table>
                        <thead><tr><th>Turno</th><th>Aulas</th></tr></thead>
                        <tbody>
                            ${['manha', 'tarde', 'noite'].map((turno) => `
                                <tr>
                                    <td data-rotulo="Turno">${ROTULO_TURNO[turno]}</td>
                                    <td data-rotulo="Aulas">${turnos[turno] || 0}</td>
                                </tr>`).join('')}
                        </tbody>
                    </table>
                </div>
                <div class="divisor"></div>
                <div class="cartao__topo"><h3>Situação das reservas</h3></div>
                <div class="barra-botoes">
                    <span class="selo selo--ativa">${reservas.ativas || 0} ativas</span>
                    <span class="selo selo--realizada">${reservas.realizadas || 0} realizadas</span>
                    <span class="selo selo--falta">${reservas.faltas || 0} faltas</span>
                    <span class="selo selo--cancelada">${reservas.canceladas || 0} canceladas</span>
                </div>
            </div>
        </div>

        <div class="grade-cartoes">
            <div class="cartao">
                <div class="cartao__topo"><h3>Professores que mais usam</h3></div>
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
            </div>

            <div class="cartao">
                <div class="cartao__topo"><h3>Próximas aulas</h3></div>
                ${dados.proximas_reservas.length
                    ? dados.proximas_reservas.map((reserva) => {
                        const data = paraData(reserva.data);
                        return `
                        <div class="item-reserva" style="padding:8px 12px">
                            <div class="item-reserva__data">
                                <strong>${String(data.getDate()).padStart(2, '0')}</strong>
                                <span>${MESES[data.getMonth()]}</span>
                            </div>
                            <div class="item-reserva__corpo">
                                <strong>${escapar(reserva.laboratorio_nome)}</strong>
                                <p>${escapar(reserva.professor_nome)} ·
                                   ${escapar(reserva.disciplina || 'sem disciplina')}</p>
                                <p class="mono">${escapar(reserva.inicio)}–${escapar(reserva.fim)}
                                   · ${ROTULO_TURNO[reserva.turno] || reserva.turno}</p>
                            </div>
                        </div>`;
                    }).join('')
                    : '<div class="lista-vazia">Nenhuma aula marcada daqui para a frente.</div>'}
            </div>
        </div>`;
}

/* ------------------------------------------------------------------ */
/* Unidades / escolas                                                  */
/* ------------------------------------------------------------------ */

async function carregarUnidades() {
    const area = document.getElementById('listaUnidades');
    try {
        const resposta = await API.get('/api/gerente/unidades');
        estadoGerente.unidades = resposta.unidades;
        estadoGerente.semUnidade = resposta.sem_unidade;
        area.innerHTML = montarUnidades();
    } catch (falha) {
        area.innerHTML = `<div class="lista-vazia">${escapar(falha.message)}</div>`;
    }
}

function montarUnidades() {
    const soltos = estadoGerente.semUnidade || { gestores: 0, professores: 0 };
    const total = soltos.gestores + soltos.professores;

    if (!estadoGerente.unidades.length && !total) {
        return `<div class="lista-vazia">
            <strong>Nenhuma unidade cadastrada</strong>
            Cadastre as escolas da rede para organizar gestores e professores por unidade.
        </div>`;
    }

    const cartoes = estadoGerente.unidades.map((unidade) => `
        <div class="cartao unidade">
            <div class="unidade__topo">
                <div>
                    <h3>${escapar(unidade.nome)}</h3>
                    <p class="texto-suave" style="margin:2px 0 0;font-size:.82rem">
                        ${escapar([unidade.cidade, unidade.endereco]
                            .filter(Boolean).join(' · ') || 'Sem endereço cadastrado')}
                    </p>
                </div>
                ${unidade.ativo
                    ? '<span class="selo selo--ativa">Ativa</span>'
                    : '<span class="selo selo--cancelada">Inativa</span>'}
            </div>

            <div class="unidade__numeros">
                <div>
                    <strong>${unidade.gestores_ativos}</strong>
                    <span>gestor(es) ativo(s)${unidade.gestores > unidade.gestores_ativos
                        ? ` de ${unidade.gestores}` : ''}</span>
                </div>
                <div>
                    <strong>${unidade.professores_ativos}</strong>
                    <span>professor(es) ativo(s)${unidade.professores > unidade.professores_ativos
                        ? ` de ${unidade.professores}` : ''}</span>
                </div>
            </div>

            <div class="barra-botoes">
                <button class="botao botao--pequeno" data-abrir-unidade="${unidade.id}">
                    Ver usuários
                </button>
                <button class="botao botao--pequeno botao--vazio"
                        data-editar-unidade="${unidade.id}">Editar</button>
                <button class="botao botao--pequeno botao--perigo"
                        data-excluir-unidade="${unidade.id}">Excluir</button>
            </div>
        </div>`).join('');

    const avulsos = total ? `
        <div class="cartao unidade">
            <div class="unidade__topo">
                <div>
                    <h3>Sem unidade definida</h3>
                    <p class="texto-suave" style="margin:2px 0 0;font-size:.82rem">
                        Pessoas cadastradas antes das unidades ou que ficaram sem vínculo.
                    </p>
                </div>
                <span class="selo selo--falta">Pendente</span>
            </div>
            <div class="unidade__numeros">
                <div><strong>${soltos.gestores}</strong><span>gestor(es)</span></div>
                <div><strong>${soltos.professores}</strong><span>professor(es)</span></div>
            </div>
            <div class="barra-botoes">
                <button class="botao botao--pequeno botao--vazio" data-abrir-unidade="avulsos">
                    Ver usuários
                </button>
            </div>
        </div>` : '';

    return `<div class="grade-cartoes">${cartoes}${avulsos}</div>`;
}

function aoClicarUnidade(evento) {
    const abrir = evento.target.closest('[data-abrir-unidade]');
    if (abrir) {
        abrirDetalheUnidade(abrir.dataset.abrirUnidade);
        return;
    }

    const editar = evento.target.closest('[data-editar-unidade]');
    if (editar) {
        abrirFormularioUnidade(estadoGerente.unidades
            .find((item) => item.id === Number(editar.dataset.editarUnidade)));
        return;
    }

    const excluir = evento.target.closest('[data-excluir-unidade]');
    if (!excluir) return;
    const unidade = estadoGerente.unidades
        .find((item) => item.id === Number(excluir.dataset.excluirUnidade));

    abrirModal({
        titulo: 'Excluir unidade',
        subtitulo: unidade.nome,
        corpo: `<p>A unidade sai da lista. Os gestores e professores dela
                   <strong>continuam no sistema</strong>, apenas ficam sem unidade
                   até você vinculá-los a outra.</p>
                <p class="texto-suave">Para tirar de circulação sem perder o vínculo,
                   use <strong>Editar</strong> e desmarque “Unidade ativa”.</p>`,
        textoCancelar: 'Voltar',
        textoConfirmar: 'Excluir',
        perigo: true,
        aoConfirmar: async () => {
            try {
                await API.del(`/api/gerente/unidades/${unidade.id}`);
            } catch (falha) {
                if (falha.dados && falha.dados.confirmar) {
                    if (!window.confirm(`${falha.message}\n\nExcluir mesmo assim?`)) return false;
                    await API.del(`/api/gerente/unidades/${unidade.id}?forcar=1`);
                } else {
                    notificar(falha.message, 'erro');
                    return false;
                }
            }
            await Promise.all([carregarUnidades(), carregarGestores()]);
            notificar('Unidade excluída.');
            return true;
        },
    });
}

function abrirFormularioUnidade(unidade) {
    const dadosUnidade = unidade || {};
    const nova = !dadosUnidade.id;

    const modal = abrirModal({
        titulo: nova ? 'Nova unidade' : 'Editar unidade',
        subtitulo: nova
            ? 'Depois de criar, vincule o gestor local responsável por ela.'
            : dadosUnidade.nome,
        corpo: `
            <div class="campo">
                <label for="unidadeNome">Nome da escola</label>
                <input type="text" id="unidadeNome" value="${escapar(dadosUnidade.nome || '')}"
                       placeholder="ex.: Escola Municipal Centro">
            </div>
            <div class="campo">
                <label for="unidadeCidade">Cidade</label>
                <input type="text" id="unidadeCidade"
                       value="${escapar(dadosUnidade.cidade || '')}"
                       placeholder="ex.: Recife">
            </div>
            <div class="linha-campos linha-campos--2">
                <div class="campo">
                    <label for="unidadeTelefone">Celular / WhatsApp (com DDD)</label>
                    <input type="text" id="unidadeTelefone" class="mono"
                           value="${escapar(dadosUnidade.telefone || '')}"
                           placeholder="(81)9 8458-7555">
                </div>
                <div class="campo">
                    <label for="unidadeTelefoneFixo">Telefone fixo (com DDD)</label>
                    <input type="text" id="unidadeTelefoneFixo" class="mono"
                           value="${escapar(dadosUnidade.telefone_fixo || '')}"
                           placeholder="(81) 3421-5566">
                </div>
            </div>
            <div class="campo">
                <label for="unidadeEndereco">Endereço</label>
                <input type="text" id="unidadeEndereco"
                       value="${escapar(dadosUnidade.endereco || '')}"
                       placeholder="rua, número e bairro">
            </div>
            ${nova ? '' : `
            <label class="checkbox">
                <input type="checkbox" id="unidadeAtiva" ${dadosUnidade.ativo ? 'checked' : ''}>
                <span>Unidade ativa</span>
            </label>`}
            <div id="erroUnidade" class="aviso aviso--erro oculto"></div>`,
        textoCancelar: 'Cancelar',
        textoConfirmar: nova ? 'Cadastrar' : 'Salvar',
        aoConfirmar: async (janela) => {
            const erro = janela.querySelector('#erroUnidade');
            const campoCelular = janela.querySelector('#unidadeTelefone');
            const campoFixo = janela.querySelector('#unidadeTelefoneFixo');
            const dados = {
                nome: janela.querySelector('#unidadeNome').value.trim(),
                cidade: janela.querySelector('#unidadeCidade').value.trim(),
                endereco: janela.querySelector('#unidadeEndereco').value.trim(),
                telefone: soDigitos(campoCelular.value),
                telefone_fixo: soDigitos(campoFixo.value),
            };
            if (!dados.nome) {
                mostrarErro(erro, 'Informe o nome da unidade.');
                return false;
            }
            // os dois telefones da escola são opcionais, mas não podem ficar pela metade
            if (dados.telefone && erroTelefone(dados.telefone)) {
                mostrarErro(erro, erroTelefone(dados.telefone));
                campoCelular.focus();
                return false;
            }
            if (dados.telefone_fixo && erroTelefoneFixo(dados.telefone_fixo)) {
                mostrarErro(erro, erroTelefoneFixo(dados.telefone_fixo));
                campoFixo.focus();
                return false;
            }
            try {
                if (nova) {
                    await API.post('/api/gerente/unidades', dados);
                } else {
                    dados.ativo = janela.querySelector('#unidadeAtiva').checked;
                    await API.put(`/api/gerente/unidades/${dadosUnidade.id}`, dados);
                }
                await carregarUnidades();
                notificar(nova ? 'Unidade cadastrada.' : 'Unidade atualizada.');
                return true;
            } catch (falha) {
                mostrarErro(janela.querySelector('#erroUnidade'), falha.message);
                return false;
            }
        },
    });

    if (!modal) return;

    limitarCampoTelefone(modal.querySelector('#unidadeTelefone'));
    limitarCampoTelefone(modal.querySelector('#unidadeTelefoneFixo'), 'fixo');
}

/** Lista o gestor local e os professores daquela escola. */
async function abrirDetalheUnidade(identificador) {
    const caminho = identificador === 'avulsos'
        ? '/api/gerente/unidades/sem-vinculo'
        : `/api/gerente/unidades/${identificador}`;

    let unidade;
    try {
        unidade = await API.get(caminho);
    } catch (falha) {
        notificar(falha.message, 'erro');
        return;
    }

    const contato = [unidade.cidade, unidade.endereco,
                     formatarTelefone(unidade.telefone),
                     formatarTelefone(unidade.telefone_fixo)]
        .filter(Boolean).join(' · ');

    const modal = abrirModal({
        titulo: unidade.nome,
        subtitulo: contato || 'Usuários cadastrados nesta unidade',
        corpo: `
            <div class="indicadores" style="margin-bottom:16px">
                <div class="indicador indicador--primaria">
                    <strong>${unidade.gestores.length}</strong><span>Gestores locais</span>
                </div>
                <div class="indicador">
                    <strong>${unidade.professores.length}</strong><span>Professores</span>
                </div>
                <div class="indicador indicador--verde">
                    <strong>${unidade.reservas.total || 0}</strong><span>Aulas reservadas</span>
                </div>
                <div class="indicador indicador--ambar">
                    <strong>${unidade.reservas.futuras || 0}</strong><span>Aulas por vir</span>
                </div>
            </div>

            <span class="rotulo-pequeno">Gestores locais</span>
            ${unidade.gestores.length ? `
            <div class="tabela-envolvida" style="margin:8px 0 20px">
                <table>
                    <thead><tr><th>Nome</th><th>Usuário</th><th>Contato</th><th>Situação</th></tr></thead>
                    <tbody>
                        ${unidade.gestores.map((gestor) => `
                            <tr>
                                <td data-rotulo="Nome">
                                    <button type="button" class="nome-acao"
                                            data-perfil-gestor="${gestor.id}"
                                            title="Ver a ficha de ${escapar(gestor.nome)}"
                                    >${escapar(gestor.nome)}</button>
                                </td>
                                <td data-rotulo="Usuário" class="mono">${escapar(gestor.usuario)}</td>
                                <td data-rotulo="Contato">${escapar(gestor.email
                                    || formatarTelefone(gestor.telefone) || '—')}</td>
                                <td data-rotulo="Situação">${gestor.ativo
                                    ? '<span class="selo selo--ativa">Ativo</span>'
                                    : '<span class="selo selo--cancelada">Inativo</span>'}</td>
                            </tr>`).join('')}
                    </tbody>
                </table>
            </div>` : `<div class="lista-vazia" style="margin:8px 0 20px">
                Nenhum gestor local nesta unidade.</div>`}

            <span class="rotulo-pequeno">Professores</span>
            ${unidade.professores.length ? `
            <div class="tabela-envolvida" style="margin-top:8px">
                <table>
                    <thead>
                        <tr><th>Nome</th><th>Matrícula</th><th>Disciplina</th>
                            <th>Aulas</th><th>Situação</th></tr>
                    </thead>
                    <tbody>
                        ${unidade.professores.map((prof) => `
                            <tr>
                                <td data-rotulo="Nome">
                                    <button type="button" class="nome-acao"
                                            data-perfil-prof="${prof.id}"
                                            title="Ver o perfil de ${escapar(prof.nome)}"
                                    >${escapar(prof.nome)}</button>
                                </td>
                                <td data-rotulo="Matrícula" class="mono">${escapar(prof.matricula)}</td>
                                <td data-rotulo="Disciplina">${escapar(prof.disciplina || '—')}</td>
                                <td data-rotulo="Aulas">${prof.total_reservas}</td>
                                <td data-rotulo="Situação">${prof.ativo
                                    ? '<span class="selo selo--ativa">Ativo</span>'
                                    : '<span class="selo selo--cancelada">Inativo</span>'}
                                    ${prof.tem_senha ? ''
                                        : '<br><span class="selo selo--falta">Sem senha</span>'}
                                </td>
                            </tr>`).join('')}
                    </tbody>
                </table>
            </div>` : `<div class="lista-vazia" style="margin-top:8px">
                Nenhum professor cadastrado nesta unidade.</div>`}`,
        textoCancelar: 'Fechar',
    });

    if (modal) ligarNomesDaUnidade(modal, unidade, identificador);
}

/**
 * Nos dois quadros do detalhe da unidade o nome abre a ficha da pessoa.
 * A do gestor local tem o botao de editar; a do professor nao, porque quem
 * mexe no cadastro dele e o gestor da escola, no painel dele.
 */
function ligarNomesDaUnidade(modal, unidade, identificador) {
    const voltar = { texto: `‹ Voltar para ${unidade.nome}`,
                     ao: () => abrirDetalheUnidade(identificador) };

    modal.addEventListener('click', (evento) => {
        const gestor = evento.target.closest('[data-perfil-gestor]');
        if (gestor) {
            const id = Number(gestor.dataset.perfilGestor);
            // a lista da aba Gestores traz a unidade_id, que o formulario precisa
            const completo = estadoGerente.gestores.find((item) => item.id === id)
                || { ...unidade.gestores.find((item) => item.id === id),
                     unidade: unidade.nome, unidade_id: unidade.id };
            abrirPerfilGestor(completo, voltar);
            return;
        }

        const professor = evento.target.closest('[data-perfil-prof]');
        if (professor) {
            const id = Number(professor.dataset.perfilProf);
            abrirPerfilProfessor(unidade.professores.find((item) => item.id === id),
                                 unidade, voltar);
        }
    });
}

/** Ficha do professor só para leitura — o gerente geral não edita professor. */
function abrirPerfilProfessor(professor, unidade, voltar) {
    if (!professor) return;

    abrirPerfil({
        nome: professor.nome,
        subtitulo: 'Perfil do professor — somente leitura',
        itens: [
            ['Matrícula', professor.matricula, 'mono'],
            ['Disciplina', professor.disciplina || '—'],
            ['Escola', unidade.nome],
            ['Aulas reservadas', String(professor.total_reservas)],
        ],
        telefone: professor.telefone,
        email: professor.email,
        situacao: `<strong>${professor.ativo
            ? '<span class="selo selo--ativa">Ativo</span>'
            : '<span class="selo selo--cancelada">Inativo</span>'}
            ${professor.tem_senha
                ? ''
                : '<span class="selo selo--falta">Sem senha</span>'}</strong>`,
        aviso: `
            <div class="aviso aviso--info" style="margin-top:16px">
                <div><strong>Quem edita este cadastro é o gestor local</strong>
                Nome, matrícula, contato, disciplina e senha do professor são
                mantidos no painel da escola. Daqui o gerente geral só consulta.</div>
            </div>`,
        voltar,
    });
}

/** Ficha do gestor local; a alteração continua no formulário de sempre. */
function abrirPerfilGestor(gestor, voltar) {
    if (!gestor) return;

    abrirPerfil({
        nome: gestor.nome,
        subtitulo: `Gestor local — usuário ${gestor.usuario}`,
        itens: [
            ['Nome do gestor', gestor.nome],
            ['Usuário de acesso', gestor.usuario, 'mono'],
            ['Unidade / escola', gestor.unidade || 'Sem unidade definida'],
            ['Último acesso', quandoFoi(gestor.ultimo_acesso)],
        ],
        telefone: gestor.telefone,
        email: gestor.email,
        situacao: `<strong>${gestor.ativo
            ? '<span class="selo selo--ativa">Ativo</span>'
            : '<span class="selo selo--cancelada">Inativo</span>'}
            ${gestor.tem_senha
                ? ''
                : '<span class="selo selo--falta">Sem senha</span>'}</strong>`,
        editar: {
            texto: 'Editar cadastro',
            ao: () => abrirFormularioGestor(gestor),
        },
        voltar,
    });
}

/* ------------------------------------------------------------------ */
/* Gestores locais                                                     */
/* ------------------------------------------------------------------ */

async function carregarGestores() {
    estadoGerente.gestores = await API.get('/api/gerente/gestores');
    desenharGestores();
}

/** Tira acento e caixa alta para comparar: "José" e "jose" viram iguais. */
function normalizar(texto) {
    return String(texto === null || texto === undefined ? '' : texto)
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase();
}

function gestorCombina(gestor, termo, digitos) {
    if (normalizar(gestor.nome).includes(termo)) return true;
    if (normalizar(gestor.usuario).includes(termo)) return true;
    if (normalizar(gestor.email).includes(termo)) return true;
    if (normalizar(gestor.unidade).includes(termo)) return true;

    const telefone = String(gestor.telefone || '').replace(/\D/g, '');
    return Boolean(digitos) && telefone.includes(digitos);
}

function desenharGestores() {
    const termo = normalizar(document.getElementById('buscaGestor').value.trim());
    const digitos = termo.replace(/\D/g, '');
    const total = estadoGerente.gestores.length;
    const lista = termo
        ? estadoGerente.gestores.filter((gestor) => gestorCombina(gestor, termo, digitos))
        : estadoGerente.gestores;

    document.getElementById('corpoGestores').innerHTML = lista.map((gestor) => `
        <tr>
            <td data-rotulo="Gestor">
                <div class="celula-pessoa">
                    <div class="avatar">${escapar(iniciais(gestor.nome))}</div>
                    <button type="button" class="nome-acao"
                            data-perfil-gestor="${gestor.id}"
                            title="Ver a ficha de ${escapar(gestor.nome)}"
                    >${escapar(gestor.nome)}</button>
                </div>
            </td>
            <td data-rotulo="Usuário" class="mono">${escapar(gestor.usuario)}</td>
            <td data-rotulo="E-mail">${escapar(gestor.email || '—')}</td>
            <td data-rotulo="Telefone" class="mono">
                ${escapar(formatarTelefone(gestor.telefone) || '—')}
            </td>
            <td data-rotulo="Unidade">${escapar(gestor.unidade || '—')}</td>
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
                    <button class="botao botao--pequeno botao--perigo"
                            data-excluir-gestor="${gestor.id}">Excluir</button>
                </div>
            </td>
        </tr>`).join('');

    let vazio = '';
    if (!total) {
        vazio = `
        <div class="lista-vazia">
            <strong>Nenhum gestor local cadastrado</strong>
            Crie a primeira conta para que alguém administre o sistema na escola.
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

/** '2026-08-02 14:03:00' -> 'hoje às 14:03' / '02/08/2026'. */
function quandoFoi(iso) {
    if (!iso) return 'nunca entrou';
    const data = paraData(iso);
    const hora = String(iso).slice(11, 16);
    if (paraISO(data) === hojeISO()) return `hoje às ${hora}`;
    if (paraISO(data) === somarDias(hojeISO(), -1)) return `ontem às ${hora}`;
    return dataBR(iso);
}

/** Tela de envio do acesso do gestor (a função geral mora em api.js). */
function enviarAcessoGestor(gestor, senha) {
    return abrirModalCredenciais({
        nome: gestor.nome,
        rotulo: 'Usuário',
        identificador: gestor.usuario,
        senha,
        base: `/api/gerente/gestores/${gestor.id}`,
        papel: 'gestor local',
    });
}

function abrirFormularioGestor(gestor) {
    const dadosGestor = gestor || {};
    const novo = !dadosGestor.id;

    const modal = abrirModal({
        titulo: novo ? 'Novo gestor local' : 'Editar gestor local',
        subtitulo: novo
            ? 'O usuário é sugerido pelo sistema. Defina a senha e envie o acesso.'
            : 'Alterar o usuário muda o login desta pessoa.',
        corpo: `
            <div class="campo">
                <label for="gestorNome">Nome completo</label>
                <input type="text" id="gestorNome" value="${escapar(dadosGestor.nome || '')}"
                       placeholder="ex.: Marina Alves">
            </div>

            <div class="linha-campos linha-campos--2">
                <div class="campo">
                    <label for="gestorUsuario">Usuário de acesso</label>
                    <input type="text" id="gestorUsuario" class="mono"
                           value="${escapar(dadosGestor.usuario || '')}"
                           placeholder="gerado a partir do nome">
                </div>
                <div class="campo">
                    <label for="gestorUnidade">Unidade / escola</label>
                    <select id="gestorUnidade">
                        <option value="">Sem unidade definida</option>
                        ${estadoGerente.unidades.map((unidade) => `
                            <option value="${unidade.id}"
                                ${unidade.id === dadosGestor.unidade_id ? 'selected' : ''}>
                                ${escapar(unidade.nome)}
                            </option>`).join('')}
                    </select>
                </div>
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
                unidade_id: janela.querySelector('#gestorUnidade').value || null,
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
                    const resposta = await API.post('/api/gerente/gestores', dados);
                    await Promise.all([carregarGestores(), carregarUnidades()]);
                    notificar(`Gestor criado — usuário ${resposta.gestor.usuario}.`);
                    // abre depois que esta janela fechar, para não ser apagada
                    setTimeout(() => enviarAcessoGestor(resposta.gestor, dados.senha), 0);
                    return true;
                }

                dados.ativo = janela.querySelector('#gestorAtivo').checked;
                await API.put(`/api/gerente/gestores/${dadosGestor.id}`, dados);
                await Promise.all([carregarGestores(), carregarUnidades()]);
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
        sugerirUsuarioEnquantoDigita(modal);
    }
}

/**
 * Enquanto o gerente digita o nome, o servidor devolve um usuário livre
 * ("Marina Alves" -> "marina.alves"). Assim que ele escreve o próprio
 * usuário, a sugestão para de mexer no campo.
 */
function sugerirUsuarioEnquantoDigita(modal) {
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
                `/api/gerente/usuario-sugerido?nome=${encodeURIComponent(nome)}`
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
            <p>Defina uma nova senha para o gestor local. A senha anterior deixa de
               valer assim que você confirmar.</p>
            <div class="campo">
                <label for="novaSenhaGestor">Nova senha</label>
                <div class="barra-botoes" style="flex-wrap:nowrap">
                    <input type="text" id="novaSenhaGestor" class="mono"
                           placeholder="mínimo 4 caracteres">
                    <button type="button" class="botao botao--vazio botao--pequeno"
                            id="botaoSortearSenhaGestor2">Gerar</button>
                </div>
            </div>
            <div id="erroSenhaGestor" class="aviso aviso--erro oculto"></div>`,
        textoCancelar: 'Cancelar',
        textoConfirmar: 'Definir e enviar',
        aoConfirmar: async (janela) => {
            const senha = janela.querySelector('#novaSenhaGestor').value.trim();
            if (senha.length < 4) {
                mostrarErro(janela.querySelector('#erroSenhaGestor'),
                            'A senha precisa ter pelo menos 4 caracteres.');
                return false;
            }
            try {
                await API.post(`/api/gerente/gestores/${gestor.id}/senha`, { senha });
                await carregarGestores();
                notificar('Senha definida.');
                setTimeout(() => enviarAcessoGestor(gestor, senha), 0);
                return true;
            } catch (falha) {
                mostrarErro(janela.querySelector('#erroSenhaGestor'), falha.message);
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

function aoClicarGestor(evento) {
    const achar = (elemento, campo) => estadoGerente.gestores
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
        titulo: 'Excluir gestor local',
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
                await API.del(`/api/gerente/gestores/${gestor.id}`);
            } catch (falha) {
                notificar(falha.message, 'erro');
                return false;
            }
            await Promise.all([carregarGestores(), carregarUnidades()]);
            notificar('Gestor excluído.');
            return true;
        },
    });
}

/* ------------------------------------------------------------------ */
/* Minha conta                                                         */
/* ------------------------------------------------------------------ */

async function trocarSenhaGerente(evento) {
    evento.preventDefault();
    const erro = document.getElementById('erroSenhaGerente');
    mostrarErro(erro, '');

    const nova = document.getElementById('senhaNova').value;
    if (nova !== document.getElementById('senhaConfirma').value) {
        mostrarErro(erro, 'A confirmação não é igual à nova senha.');
        return;
    }
    if (nova.length < 6) {
        mostrarErro(erro, 'A nova senha precisa ter pelo menos 6 caracteres.');
        return;
    }

    try {
        await API.post('/api/gerente/senha', {
            senha_atual: document.getElementById('senhaAtual').value,
            nova_senha: nova,
        });
        document.getElementById('formSenhaGerente').reset();
        notificar('Senha do gerente geral atualizada.');
    } catch (falha) {
        mostrarErro(erro, falha.message);
    }
}
