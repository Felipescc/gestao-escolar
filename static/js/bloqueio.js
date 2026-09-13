/* =========================================================================
   Bloqueio dos atalhos de "ver codigo" — carregado so quando a pagina esta
   sendo servida para a rede (veja modo_online, em app.py).

   Isto atrapalha quem ia apertar Ctrl+U por curiosidade, e so. Nao protege
   nada: o HTML ja esta no navegador de quem abriu a pagina, e view-source:,
   "salvar pagina", o menu do navegador e o devtools aberto antes do login
   passam por cima disto sem esforco. Quem guarda os dados e a verificacao
   de sessao no servidor, nao esta tela.
   ========================================================================= */

(() => {
    const ATALHOS = [
        // Ctrl+U — ver codigo-fonte
        (e) => e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'u',
        // Ctrl+S — salvar a pagina (outro caminho para o mesmo HTML)
        (e) => e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's',
        // F12 e Ctrl+Shift+I/J/C — ferramentas do desenvolvedor
        (e) => e.key === 'F12',
        (e) => e.ctrlKey && e.shiftKey && ['i', 'j', 'c'].includes(e.key.toLowerCase()),
    ];

    // Ctrl+P fica de fora de proposito: os horarios sao impressos.
    document.addEventListener('keydown', (evento) => {
        if (typeof evento.key !== 'string') return;
        if (ATALHOS.some((testar) => testar(evento))) {
            evento.preventDefault();
            evento.stopPropagation();
        }
    }, true);   // fase de captura: corre antes dos atalhos das telas

    document.addEventListener('contextmenu', (evento) => {
        // O botao direito continua valendo nos campos de texto: e por ali que
        // as pessoas colam um nome ou corrigem a digitacao.
        if (evento.target.closest('input, textarea')) return;
        evento.preventDefault();
    });
})();
