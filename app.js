/* =============================================================================
 * app.js  —  VICE CONTABIL | Sistema de Gerenciamento de Análise de Processos Contábeis
 * -----------------------------------------------------------------------------
 * Responsabilidades:
 *   1. Inicialização do Supabase (credenciais vindas do `config.js`,
 *      que simula o conteúdo do arquivo `cred.sbase.txt`);
 *   2. Login / Logout e controle de perfil (Administrador x Usuário Padrão);
 *   3. Navegação entre telas (Login -> Dashboard -> Novo Processo -> Config.);
 *   4. Upload do PDF + envio de FormData para o Webhook do n8n;
 *   5. Salvamento e listagem dos processos no Supabase;
 *   6. Gerenciamento de usuários e da URL do webhook (somente Administrador).
 *
 * ⚠️ BANCO DE DADOS: o SQL com as tabelas (processos, perfis, configuracoes)
 *    e as policies está no arquivo `schema.sql` — execute-o uma única vez no
 *    Supabase SQL Editor antes de usar o sistema.
 * ========================================================================== */

/* =============================================================================
 * 1. CREDENCIAIS DO SUPABASE  (correspondem ao arquivo `cred.sbase.txt`)
 * -----------------------------------------------------------------------------
 * O conteúdo abaixo é o FALLBACK. As credenciais reais são carregadas do
 * arquivo `config.js` (linha <script src="config.js"> no index.html), que é a
 * simulação do `cred.sbase.txt`:
 *
 *   NEXT_PUBLIC_SUPABASE_URL            -> CRED_SBASE.URL
 *   NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY-> CRED_SBASE.ANON_KEY
 *
 * >>> Se preferir colar direto aqui, substitua os valores entre aspas. <<<
 *
 * NUNCA use a chave `sb_secret_...` (service role) nem a senha do banco no
 * navegador: elas só podem existir no backend (Edge Functions).
 * ======================================================================== */
const CRED_SBASE_FALLBACK = {
    URL: 'https://bvzcrhfkeaoizrwmjrun.supabase.co', // <- linha NEXT_PUBLIC_SUPABASE_URL do cred.sbase.txt
    ANON_KEY: 'sb_publishable_aY5RnxYh20ZEVxg4MkJv_A_0AtnbOSC' // <- linha NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY do cred.sbase.txt
};

const CRED = Object.assign({}, CRED_SBASE_FALLBACK, window.CRED_SBASE || {});

/* --- Constantes de negócio ------------------------------------------------ */
const BUCKET = 'processos';          // bucket do Supabase Storage (PDFs e DOCX)
const CHAVE_WEBHOOK = 'webhook_n8n'; // chave da tabela `configuracoes`
const PERFIL_ADMIN = 'admin';

/* --- URL pública do sistema (produção) ------------------------------------
 * Base usada nos links enviados por e-mail pelo Supabase (recuperação de senha
 * e confirmação/convite). Evita que o e-mail aponte para http://localhost:3000
 * quando o sistema é aberto em desenvolvimento.
 *
 * Valor definido em `config.js` (window.APP_BASE_URL); se não houver, o
 * domínio de produção abaixo é usado como padrão.
 *
 * IMPORTANTE: o domínio precisa estar em Supabase > Authentication > URL
 * Configuration (Site URL + Redirect URLs), senão o Supabase descarta o valor
 * abaixo e usa o Site URL — que é como o localhost:3000 volta a aparecer.
 * ------------------------------------------------------------------------ */
const BASE_URL = String(window.APP_BASE_URL || 'https://contabil.jorgejfc.com.br')
    .trim()
    .replace(/\/+$/, '');

/** URL de retorno enviada ao Supabase (raiz do sistema, com barra final). */
function urlDeRetorno() {
    return BASE_URL + '/';
}

/* --- Estado global da aplicação ------------------------------------------ */
const state = {
    session: null,
    profile: null,
    isAdmin: false,
    screen: null,           // tela atualmente aberta (dashboard/novo/config)
    processos: [],
    users: [],
    webhookUrl: '',
    file: null,            // PDF selecionado na dropzone
    lastResult: null,      // retorno do n8n (resumo + word)
    editingUserId: null,
    abortController: null,
    processingTimer: null,
    passwordRecoveryPending: false
};

/* --- Atalhos de DOM ------------------------------------------------------- */
const $  = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

/* =============================================================================
 * 2. INICIALIZAÇÃO DO SUPABASE
 * ======================================================================== */
let db = null;

function initSupabase() {
    if (!window.supabase) {
        toast('Não foi possível carregar a biblioteca de autenticação (verifique a conexão).', 'erro');
        return null;
    }
    if (!CRED.URL || !CRED.ANON_KEY) {
        toast('Credenciais do sistema ausentes. Verifique o arquivo config.js.', 'erro');
        return null;
    }
    db = window.supabase.createClient(CRED.URL, CRED.ANON_KEY, {
        auth: {
            persistSession: true,
            autoRefreshToken: true,
            detectSessionInUrl: true
        }
    });
    return db;
}

/* =============================================================================
 * 3. TEMA (claro/escuro) — mesma lógica do arquivo de referência
 * ======================================================================== */
function applyInitialTheme() {
    const html = document.documentElement;
    if (localStorage.theme === 'dark' || (!('theme' in localStorage) && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
        html.classList.add('dark');
    } else {
        html.classList.remove('dark');
    }
}

function toggleTheme() {
    const html = document.documentElement;
    if (html.classList.contains('dark')) {
        html.classList.remove('dark');
        localStorage.theme = 'light';
    } else {
        html.classList.add('dark');
        localStorage.theme = 'dark';
    }
}

/* =============================================================================
 * 4. AUTENTICAÇÃO (Login / Logout / Perfil)
 * ======================================================================== */
function showLoginError(msg) {
    const box = $('#login-error');
    if (!msg) return box.classList.add('hidden');
    box.innerHTML = `<i class="fa-solid fa-circle-exclamation mr-1.5"></i>${esc(msg)}`;
    box.classList.remove('hidden');
}

function setLoginLoading(loading) {
    const btn = $('#login-btn');
    const txt = $('#login-btn-text');
    btn.disabled = loading;
    txt.textContent = loading ? 'Verificando credenciais...' : 'Entrar no painel';
}

async function handleLogin(event) {
    event.preventDefault();
    showLoginError('');

    const email = $('#login-email').value.trim();
    const password = $('#login-password').value;
    if (!email || !password) return showLoginError('Informe e-mail e senha.');

    setLoginLoading(true);
    const { data, error } = await db.auth.signInWithPassword({ email, password });
    setLoginLoading(false);

    if (error) return showLoginError(mensagemAuth(error));
    toast('Bem-vindo ao painel!');
    // O listener onAuthStateChange cuida da entrada no painel
}

async function requestPasswordRecovery() {
    const emailInput = $('#login-email');
    const email = emailInput.value.trim();
    showLoginError('');
    if (!email) {
        showLoginError('Informe seu e-mail para receber o link de recuperação.');
        emailInput.focus();
        return;
    }
    if (!emailInput.checkValidity()) {
        showLoginError('Informe um endereço de e-mail válido.');
        emailInput.focus();
        return;
    }

    const button = $('#forgot-password-btn');
    button.disabled = true;
    button.textContent = 'Verificando e enviando...';
    try {
        const { data: cadastrado, error: consultaError } = await db.rpc('email_cadastrado', {
            p_email: email
        });
        if (consultaError) {
            console.error('[email_cadastrado]', consultaError.message);
            return showLoginError('Não foi possível consultar o cadastro. Tente novamente mais tarde.');
        }
        if (!cadastrado) return showLoginError('E-mail não cadastrado.');

        const { error } = await db.auth.resetPasswordForEmail(email, {
            redirectTo: urlDeRetorno()
        });
        if (error) {
            const mensagem = (error.message || '').toLowerCase();
            if (mensagem.includes('rate limit') || mensagem.includes('too many')) {
                return showLoginError('Muitas solicitações de recuperação. Aguarde alguns minutos e tente novamente.');
            }
            return showLoginError(mensagemAuth(error));
        }
        toast('Email de recuperação enviado. Verifique sua caixa de entrada.');
    } catch (error) {
        console.error('[recuperação de senha]', error);
        showLoginError('Não foi possível enviar o email agora. Tente novamente mais tarde.');
    } finally {
        button.disabled = false;
        button.textContent = 'Esqueci minha senha';
    }
}

function openPasswordRecoveryModal(session) {
    if (session) state.session = session;
    state.passwordRecoveryPending = true;
    $('#login-screen').classList.remove('hidden');
    $('#app-shell').classList.add('hidden');
    $('#password-recovery-modal').classList.remove('hidden');
    $('#password-recovery-modal').classList.add('flex');
}

async function handlePasswordRecoverySubmit(event) {
    event.preventDefault();
    const password = $('#recovery-password').value;
    const confirmation = $('#recovery-password-confirm').value;
    const errorBox = $('#password-recovery-error');
    errorBox.classList.add('hidden');

    if (password.length < 8) {
        errorBox.textContent = 'A senha precisa ter pelo menos 8 caracteres.';
        errorBox.classList.remove('hidden');
        return;
    }
    if (password !== confirmation) {
        errorBox.textContent = 'As senhas não conferem.';
        errorBox.classList.remove('hidden');
        return;
    }

    const button = $('#password-recovery-submit');
    button.disabled = true;
    button.textContent = 'Salvando senha...';
    const { error } = await db.auth.updateUser({ password });
    button.disabled = false;
    button.textContent = 'Salvar nova senha';

    if (error) {
        errorBox.textContent = mensagemAuth(error);
        errorBox.classList.remove('hidden');
        return;
    }

    state.passwordRecoveryPending = false;
    $('#password-recovery-modal').classList.add('hidden');
    $('#password-recovery-modal').classList.remove('flex');
    $('#password-recovery-form').reset();
    history.replaceState(null, '', location.pathname + location.search);
    await db.auth.signOut();
    state.session = null;
    showScreen('login');
    toast('Senha alterada com sucesso. Entre usando sua nova senha.');
}

function mensagemAuth(error) {
    const map = {
        'Invalid login credentials': 'E-mail ou senha inválidos.',
        'Email not confirmed': 'E-mail ainda não confirmado. Verifique sua caixa de entrada.',
        'rate_limit': 'Muitas tentativas. Aguarde alguns minutos e tente novamente.'
    };
    for (const key of Object.keys(map)) {
        if ((error.message || '').includes(key)) return map[key];
    }
    return error.message || 'Não foi possível entrar.';
}

async function logout() {
    toggleUserMenu(false);
    await db.auth.signOut();
    state.session = null;
    state.profile = null;
    state.isAdmin = false;
    state.screen = null;
    state.processos = [];
    state.users = [];
    localStorage.removeItem(SCREEN_KEY);          // próxima entrada começa no Dashboard
    history.replaceState(null, '', location.pathname + location.search);
    showScreen('login');
    toast('Sessão encerrada com sucesso.');
}

/** Carrega o perfil (admin/usuário) do usuário autenticado. */
async function loadProfile(user) {
    const { data, error } = await db.from('perfis').select('*').eq('id', user.id).maybeSingle();

    if (!error && data) {
        state.profile = data;
    } else {
        // Fallback: usa os metadados gravados no sign-up (veja schema.sql)
        const meta = user.user_metadata || {};
        state.profile = {
            id: user.id,
            nome: meta.nome || user.email.split('@')[0],
            email: user.email,
            perfil: meta.perfil || 'usuario',
            ativo: false,
            tipo_acesso: null,
            creditos_saldo: 0,
            acesso_expira_em: null
        };
        if (error) console.warn('[perfis] não foi possível ler a linha:', error.message);
    }

    state.isAdmin = (state.profile.perfil === PERFIL_ADMIN);
    paintUserInfo();
}

function paintUserInfo() {
    const nome = state.profile?.nome || state.session?.user?.email || 'Usuário';
    const email = state.profile?.email || state.session?.user?.email || '';
    const iniciais = nome.split(' ').filter(Boolean).slice(0, 2).map(p => p[0]).join('').toUpperCase();

    $('#user-avatar').textContent = iniciais || 'US';
    $('#user-name-nav').textContent = nome.split(' ')[0];
    $('#menu-user-name').textContent = nome;
    $('#menu-user-email').textContent = email;
    $('#dash-greeting').textContent = nome.split(' ')[0];
    paintAccessBadge();

    const role = $('#menu-user-role');
    role.textContent = state.isAdmin ? 'Administrador' : 'Usuário Padrão';
    role.className = state.isAdmin
        ? 'inline-flex items-center gap-1 mt-2 px-2 py-0.5 rounded-lg text-[10px] font-bold uppercase tracking-wide bg-violet-600 text-white'
        : 'inline-flex items-center gap-1 mt-2 px-2 py-0.5 rounded-lg text-[10px] font-bold uppercase tracking-wide bg-violet-100 text-violet-700 dark:bg-violet-900/50 dark:text-violet-300';

    const accessInfo = $('#menu-access-info');
    if (state.isAdmin) {
        accessInfo.textContent = 'Acesso administrativo';
    } else if (state.profile?.tipo_acesso === 'creditos') {
        const saldo = Number(state.profile.creditos_saldo) || 0;
        accessInfo.textContent = `${saldo} crédito${saldo === 1 ? '' : 's'} disponível${saldo === 1 ? '' : 'is'}`;
    } else if (state.profile?.tipo_acesso === 'tempo' && state.profile.acesso_expira_em) {
        accessInfo.textContent = `Acesso até ${new Date(state.profile.acesso_expira_em).toLocaleDateString('pt-BR')}`;
    } else {
        accessInfo.textContent = '';
    }

    // Só o Administrador vê as Configurações
    $('#nav-config').classList.toggle('hidden', !state.isAdmin);
    $('#nav-config-mobile').classList.toggle('hidden', !state.isAdmin);
    $('#menu-config-btn').classList.toggle('hidden', !state.isAdmin);
}

/**
 * Badge exibido ao lado do "Olá, nome" no Dashboard:
 *  - acesso por tempo  → data de expiração
 *  - acesso por créditos → saldo disponível
 */
function paintAccessBadge() {
    const badge = $('#dash-access-badge');
    if (!badge) return;

    const profile = state.profile;
    const tipo = profile?.tipo_acesso;

    // Administrador → identificação de acesso (não consome crédito nem expira)
    if (state.isAdmin) {
        setBadge(badge, 'fa-solid fa-shield-halved', 'Acesso administrativo',
            'bg-violet-600 text-white');
        return;
    }

    // Tipo de acesso sem configurar → sem badge
    if (tipo !== 'tempo' && tipo !== 'creditos') {
        badge.classList.add('hidden');
        badge.innerHTML = '';
        return;
    }

    let texto = '';
    let estilo = '';
    let icone = '';

    if (tipo === 'tempo') {
        const expira = profile.acesso_expira_em ? new Date(profile.acesso_expira_em) : null;
        const dataValida = expira && !isNaN(expira.getTime());
        texto = dataValida
            ? `Acesso até ${expira.toLocaleDateString('pt-BR')}`
            : 'Período não configurado';
        icone = 'fa-solid fa-calendar-check';
        estilo = 'bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300';
    } else {
        const saldo = Number(profile.creditos_saldo) || 0;
        texto = `${saldo} crédito${saldo === 1 ? '' : 's'} disponível${saldo === 1 ? '' : 'is'}`;
        icone = 'fa-solid fa-coins';
        estilo = saldo > 0
            ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300'
            : 'bg-rose-100 text-rose-700 dark:bg-rose-900/50 dark:text-rose-300';
    }

    setBadge(badge, icone, texto, estilo);
}

/** Preenche/posiciona o badge ao lado do "Olá, nome". */
function setBadge(badge, icone, texto, estilo) {
    badge.innerHTML = `<i class="${icone}"></i><span>${esc(texto)}</span>`;
    badge.className = `align-middle ml-3 inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold ${estilo}`;
}

/** Entra no painel (após login ou ao restaurar sessão). */
async function enterApp(session) {
    state.session = session;
    await loadProfile(session.user);
    const profile = state.profile;
    let bloqueio = '';
    if (!profile || profile.ativo !== true) bloqueio = 'Seu acesso está inativo ou não foi configurado pelo administrador.';
    else if (!state.isAdmin && profile.tipo_acesso === 'creditos' && Number(profile.creditos_saldo) <= 0) bloqueio = 'Seus créditos acabaram. Fale com o administrador para liberar mais créditos.';
    else if (!state.isAdmin && profile.tipo_acesso === 'tempo' && (!profile.acesso_expira_em || new Date(profile.acesso_expira_em) <= new Date())) bloqueio = 'Seu período de acesso expirou. Fale com o administrador para renová-lo.';
    else if (!state.isAdmin && !['creditos', 'tempo'].includes(profile.tipo_acesso)) bloqueio = 'Seu tipo de acesso não está configurado. Fale com o administrador.';

    if (bloqueio) {
        state.session = null;
        await db.auth.signOut();
        showScreen('login');
        toast(bloqueio, 'erro');
        return;
    }

    showScreen('app');
    await Promise.all([loadWebhookUrl(), loadProcessos()]);
    if (state.isAdmin) await loadUsers();
}

/** Telas do painel — usadas para restaurar a última página visitada. */
const SCREENS = ['dashboard', 'novo', 'config'];
const SCREEN_KEY = 'analia:tela-atual';

function showScreen(which) {
    const login = $('#login-screen');
    const shell = $('#app-shell');
    if (which === 'login') {
        login.classList.remove('hidden');
        shell.classList.add('hidden');
        document.body.classList.remove('overflow-hidden');
    } else {
        login.classList.add('hidden');
        shell.classList.remove('hidden');
        // Restaura a última tela aberta (hash > localStorage > dashboard)
        navigate(telaSalva(), { silent: true });
    }
}

/** Qual tela reabrir: prioriza a última tela salva; o hash é fallback. */
function telaSalva() {
    const salva = localStorage.getItem(SCREEN_KEY);
    if (SCREENS.includes(salva)) return salva;
    const hash = (location.hash || '').replace('#', '');
    return SCREENS.includes(hash) ? hash : 'dashboard';
}

/* =============================================================================
 * 5. NAVEGAÇÃO ENTRE TELAS
 * -----------------------------------------------------------------------------
 * Cada troca de tela é gravada em localStorage e no #hash da URL, então:
 *   - recarregar a página / voltar de outra aba devolve a mesma tela;
 *   - os botões "voltar/avançar" do navegador funcionam entre as telas.
 * ======================================================================== */
function navigate(screen, opts = {}) {
    if (!state.session && screen !== 'login') return showScreen('login');

    let redirecionada = false;
    if (screen === 'config' && !state.isAdmin) {
        toast('Área restrita ao Administrador.', 'erro');
        screen = 'dashboard';
        redirecionada = true;
    }
    if (!SCREENS.includes(screen)) screen = 'dashboard';

    $$('.screen').forEach(s => s.classList.add('hidden'));
    const target = $('#screen-' + screen);
    if (target) {
        target.classList.remove('hidden');
        // reinicia a animação
        target.classList.remove('animate-fade-up');
        void target.offsetWidth;
        target.classList.add('animate-fade-up');
    }

    $$('.nav-link').forEach(a => a.classList.remove('text-violet-600', 'dark:text-violet-400', 'font-semibold'));
    const link = document.querySelector(`.nav-link[data-nav="${screen}"]`);
    if (link) link.classList.add('text-violet-600', 'dark:text-violet-400', 'font-semibold');

    state.screen = screen;
    localStorage.setItem(SCREEN_KEY, screen);

    if (!opts.silent) {
        const destino = '#' + screen;
        if (redirecionada) history.replaceState({ screen }, '', destino);
        else if (location.hash !== destino) history.pushState({ screen }, '', destino);
    }

    if (!opts.noScroll) window.scrollTo({ top: 0, behavior: 'smooth' });

    if (screen === 'dashboard') loadProcessos();
    if (screen === 'config' && state.isAdmin) { loadWebhookUrl(); loadUsers(); }
}

/** Botões voltar/avançar do navegador + edição manual do #hash. */
function voltarParaTelaDoHistory() {
    if (!state.session || state.passwordRecoveryPending) return;
    const hash = (location.hash || '').replace('#', '');
    const alvo = SCREENS.includes(hash) ? hash : telaSalva();
    if (alvo === state.screen) return;
    navigate(alvo, { silent: true, noScroll: true });
}

function toggleMobileMenu() { $('#mobile-menu').classList.toggle('hidden'); }

function toggleUserMenu(force) {
    const menu = $('#user-menu');
    const willOpen = (typeof force === 'boolean') ? force : menu.classList.contains('hidden');
    menu.classList.toggle('hidden', !willOpen);
}

function togglePasswordVisibility() {
    const input = $('#login-password');
    const eye = $('#login-eye');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    eye.className = show ? 'fa-solid fa-eye-slash' : 'fa-solid fa-eye';
}

/* =============================================================================
 * 6. DASHBOARD — listagem, filtros e estatísticas
 * ======================================================================== */
const STATUS = {
    rascunho:    { label: 'Rascunho',    cls: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',                       icon: 'fa-pen' },
    processando: { label: 'Processando', cls: 'bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-400',                       icon: 'fa-spinner' },
    concluido:   { label: 'Concluído',   cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-400',               icon: 'fa-circle-check' },
    erro:        { label: 'Erro',        cls: 'bg-rose-100 text-rose-700 dark:bg-rose-950/60 dark:text-rose-400',                           icon: 'fa-triangle-exclamation' }
};

async function loadProcessos(silent) {
    if (!db) return;
    const { data, error } = await db
        .from('processos')
        .select('*')
        .order('created_at', { ascending: false });

    if (error) {
        console.warn('[processos]', error.message);
        state.processos = [];
        renderProcessos();
        if (!silent) toast('Tabela `processos` indisponível — execute o arquivo schema.sql no banco de dados.', 'erro');
        return;
    }
    state.processos = data || [];
    renderProcessos();
}

function filteredProcessos() {
    const termo = ($('#filter-search')?.value || '').trim().toLowerCase();
    const status = $('#filter-status')?.value || 'all';
    const de = $('#filter-date-from')?.value;
    const ate = $('#filter-date-to')?.value;

    return state.processos.filter(p => {
        const alvo = [p.cliente, p.documento, p.numero_processo, p.orgao, p.tipo_analise]
            .filter(Boolean).join(' ').toLowerCase();
        if (termo && !alvo.includes(termo)) return false;
        if (status !== 'all' && p.status !== status) return false;

        const dia = (p.created_at || '').slice(0, 10);
        if (de && dia < de) return false;
        if (ate && dia > ate) return false;
        return true;
    });
}

function renderProcessos() {
    const container = $('#process-list');
    if (!container) return;

    const list = filteredProcessos();
    $('#process-count').textContent = list.length;
    renderStats();

    if (!list.length) {
        container.className = '';
        container.innerHTML = `
            <div class="col-span-full p-12 rounded-3xl bg-white dark:bg-slate-900 border border-dashed border-slate-300 dark:border-slate-700 text-center">
                <div class="w-16 h-16 mx-auto rounded-2xl bg-violet-50 dark:bg-violet-950/40 text-violet-500 flex items-center justify-center text-xl mb-4">
                    <i class="fa-solid fa-folder-open"></i>
                </div>
                <h3 class="font-bold text-slate-900 dark:text-white">Nenhum processo encontrado</h3>
                <p class="text-sm text-slate-500 mt-1">${state.processos.length ? 'Ajuste os filtros acima ou limpe a busca.' : 'Envie seu primeiro PDF para a análise contábil.'}</p>
                <button onclick="navigate('novo')" class="mt-5 px-5 py-3 rounded-2xl bg-gradient-to-r from-violet-600 to-indigo-600 text-white text-xs font-semibold shadow-lg shadow-violet-500/25 hover:opacity-95 transition-all">
                    <i class="fa-solid fa-plus mr-2"></i>Novo Processo
                </button>
            </div>`;
        return;
    }

    container.className = 'grid md:grid-cols-2 xl:grid-cols-3 gap-5';
    container.innerHTML = list.map(processCard).join('');
}

function processCard(p) {
    const st = STATUS[p.status] || STATUS.rascunho;
    const temWord = !!(p.docx_path || p.docx_base64 || p.docx_url || p.resposta);
    const resultado = !p.numero_processo && p.resposta ? normalizeN8nResponse(p.resposta) : null;
    const numeroProcesso = p.numero_processo || resultado?.dadosAnalise?.processo;
    return `
        <article class="group bg-white dark:bg-slate-900 rounded-3xl p-5 border border-slate-200 dark:border-slate-800
                        shadow-sm hover:shadow-xl transition-all duration-300 flex flex-col">
            <div class="flex items-start justify-between gap-3">
                <div class="flex items-center gap-3 min-w-0">
                    <span class="w-11 h-11 shrink-0 rounded-2xl bg-gradient-to-tr from-violet-600 to-indigo-500 text-white
                                 flex items-center justify-center shadow-lg shadow-violet-500/25">
                        <i class="fa-solid fa-file-lines"></i>
                    </span>
                    <div class="min-w-0">
                        <h3 class="font-bold text-slate-900 dark:text-white text-sm truncate">${esc(numeroProcesso) || 'Sem nº de processo'}</h3>
                        <p class="text-[11px] text-slate-400 truncate">Número do processo</p>
                    </div>
                </div>
                <span class="shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[10px] font-bold uppercase tracking-wide ${st.cls}">
                    <i class="fa-solid ${st.icon} ${p.status === 'processando' ? 'animate-spin' : ''}"></i>${st.label}
                </span>
            </div>

            <div class="mt-4 space-y-1.5 text-[11px] text-slate-500 dark:text-slate-400">
                <p><i class="fa-solid fa-calendar w-4 text-slate-300 dark:text-slate-600"></i> ${fmtDate(p.created_at)}</p>
            </div>

            <p class="mt-3 text-xs text-slate-600 dark:text-slate-400 line-clamp-3 flex-grow">${renderResumoHtml(p.resumo) || 'Sem resumo disponível ainda.'}</p>

            <div class="mt-4 pt-4 border-t border-slate-100 dark:border-slate-800 flex items-center gap-2">
                <button onclick="openProcessModal('${p.id}')"
                        class="flex-grow py-2.5 rounded-xl bg-violet-50 dark:bg-violet-950/50 text-violet-600 dark:text-violet-400
                               hover:bg-violet-600 hover:text-white dark:hover:bg-violet-600 transition-all text-xs font-semibold">
                    <i class="fa-solid fa-eye mr-1.5"></i>Detalhes
                </button>
                <button onclick="downloadWord('${p.id}')" ${temWord ? '' : 'disabled'}
                        class="py-2.5 px-3 rounded-xl ${temWord ? 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200' : 'bg-slate-100 dark:bg-slate-800 text-slate-300 dark:text-slate-600 cursor-not-allowed opacity-60'}
                               transition-all text-xs font-semibold" title="Baixar Word">
                    <i class="fa-solid fa-file-word"></i>
                </button>
                <button onclick="deleteProcesso('${p.id}')"
                        class="py-2.5 px-3 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-400 hover:bg-rose-50 hover:text-rose-500
                               dark:hover:bg-rose-950/40 transition-all text-xs" title="Excluir">
                    <i class="fa-solid fa-trash"></i>
                </button>
            </div>
        </article>`;
}

function renderStats() {
    const total = state.processos.length;
    const concluidos = state.processos.filter(p => p.status === 'concluido').length;
    const andamento = state.processos.filter(p => p.status === 'processando' || p.status === 'rascunho').length;
    const mesAtual = new Date().toISOString().slice(0, 7);
    const mes = state.processos.filter(p => (p.created_at || '').slice(0, 7) === mesAtual).length;

    $('#stat-total').textContent = total;
    $('#stat-concluidos').textContent = concluidos;
    $('#stat-processando').textContent = andamento;
    $('#stat-mes').textContent = mes;
}

function clearFilters() {
    $('#filter-search').value = '';
    $('#filter-status').value = 'all';
    $('#filter-date-from').value = '';
    $('#filter-date-to').value = '';
    renderProcessos();
}

function openProcessModal(id) {
    const p = state.processos.find(x => x.id === id);
    if (!p) return;
    const st = STATUS[p.status] || STATUS.rascunho;
    const resultado = p.resposta ? normalizeN8nResponse(p.resposta, { processo: p.numero_processo }) : null;
    const dadosAnalise = resultado?.dadosAnalise || {};
    const processo = dadosAnalise.processo || p.numero_processo;
    const autuacao = dadosAnalise.autuacao || '';
    const citacao = dadosAnalise.citacao || '';
    const verbasDeferidas = dadosAnalise.verbas_deferidas || '';
    const indicesJuros = dadosAnalise.indices_juros || '';

    $('#process-modal-content').innerHTML = `
        <span class="text-xs font-semibold text-violet-600 dark:text-violet-400 uppercase tracking-wider">Processo salvo</span>
        <h2 class="text-2xl font-extrabold text-slate-900 dark:text-white mt-1 pr-8">${esc(processo) || 'Sem nº de processo'}</h2>
        <div class="flex flex-wrap items-center gap-2 mt-2 text-xs text-slate-500">
            <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg font-bold ${st.cls}">
                <i class="fa-solid ${st.icon}"></i>${st.label}
            </span>
            <span>·</span><span>${fmtDate(p.created_at)}</span>
            ${p.numero_processo ? `<span>·</span><span>Nº ${esc(p.numero_processo)}</span>` : ''}
        </div>

        <div class="grid gap-4 mt-6">
            ${infoBox('fa-hashtag', 'Número do processo', processo)}
            ${infoBox('fa-calendar-days', 'Data de autuação', autuacao)}
            ${infoBox('fa-calendar-check', 'Data de citação', citacao)}
            ${infoBox('fa-scale-balanced', 'Verbas deferidas', verbasDeferidas)}
            ${infoBox('fa-percent', 'Índices de taxas e juros deferidos', indicesJuros)}
        </div>

        ${p.observacoes ? `<div class="mt-4 p-4 rounded-2xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700">
            <p class="text-[11px] font-bold uppercase tracking-wide text-violet-600 dark:text-violet-400 mb-1">Observações</p>
            <p class="text-sm text-slate-600 dark:text-slate-300">${esc(p.observacoes)}</p></div>` : ''}

        <div class="p-4 rounded-2xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 mt-4">
            <p class="text-[11px] font-bold uppercase tracking-wide text-violet-600 dark:text-violet-400 mb-2">Resumo da análise</p>
            <div class="text-sm text-slate-600 dark:text-slate-300 whitespace-pre-wrap max-h-96 overflow-y-auto">${renderResumoHtml(p.resumo) || '—'}</div>
        </div>

        <div class="mt-6 pt-5 border-t border-slate-100 dark:border-slate-800 flex flex-wrap gap-3">
            <button onclick="downloadWord('${p.id}')"
                    class="px-5 py-3 rounded-2xl bg-gradient-to-r from-violet-600 to-indigo-600 text-white text-xs font-semibold shadow-lg shadow-violet-500/25 hover:opacity-95 transition-all">
                <i class="fa-solid fa-download mr-2"></i>Baixar Arquivo Word
            </button>
            <button onclick="closeProcessModal()"
                    class="px-5 py-3 rounded-2xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 text-xs font-semibold hover:bg-slate-50 dark:hover:bg-slate-700 transition-all">
                Fechar
            </button>
        </div>`;

    const modal = $('#process-modal');
    modal.scrollTop = 0;
    modal.classList.remove('hidden');
    modal.classList.add('flex');
}

function closeProcessModal() {
    const modal = $('#process-modal');
    modal.classList.add('hidden');
    modal.classList.remove('flex');
}

function infoBox(icon, label, value) {
    const texto = value === null || value === undefined ? '' : String(value);
    return `<div class="p-4 rounded-2xl bg-white dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700">
        <p class="text-[11px] text-slate-400 flex items-center gap-1.5"><i class="fa-solid ${icon} text-violet-500"></i>${label}</p>
        <div class="flex items-start gap-2 mt-1">
            <p class="text-sm font-semibold text-slate-800 dark:text-slate-100 whitespace-pre-wrap break-words flex-1">${esc(texto) || '—'}</p>
            <button type="button" onclick="copyInfo(this)" data-copy-value="${esc(texto)}"
                    class="shrink-0 p-1.5 rounded-lg text-slate-400 hover:text-violet-600 hover:bg-violet-50 dark:hover:bg-violet-950/40 transition-colors"
                    title="Copiar informação" aria-label="Copiar ${esc(label)}">
                <i class="fa-regular fa-copy"></i>
            </button>
        </div>
    </div>`;
}

async function copyInfo(button) {
    const value = button?.dataset?.copyValue || '';
    if (!value) return toast('Não há informação para copiar.', 'erro');
    try {
        await navigator.clipboard.writeText(value);
    } catch (e) {
        const area = document.createElement('textarea');
        area.value = value;
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        document.execCommand('copy');
        area.remove();
    }
    const icon = button.querySelector('i');
    if (icon) icon.className = 'fa-solid fa-check text-emerald-500';
    toast('Informação copiada.');
    setTimeout(() => { if (icon) icon.className = 'fa-regular fa-copy'; }, 1500);
}

async function deleteProcesso(id) {
    if (!confirm('Excluir este processo (incluindo os arquivos)?')) return;

    const alvo = state.processos.find(p => p.id === id);
    const { error } = await db.from('processos').delete().eq('id', id);
    if (error) return toast('Erro ao excluir: ' + error.message, 'erro');

    // Remove os arquivos do Storage (ignora erros — bucket pode não existir)
    if (db.storage) {
        const paths = [alvo?.arquivo_path, alvo?.docx_path].filter(Boolean);
        if (paths.length) await db.storage.from(BUCKET).remove(paths);
    }
    closeProcessModal();
    toast('Processo excluído.');
    loadProcessos(true);
}

/* =============================================================================
 * 7. DROPZONE — upload do PDF
 * ======================================================================== */
const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB

function setupDropzone() {
    const dz = $('#dropzone');
    const input = $('#file-input');

    dz.addEventListener('click', () => input.click());
    input.addEventListener('change', (e) => e.target.files[0] && setFile(e.target.files[0]));

    ['dragenter', 'dragover'].forEach(evt => dz.addEventListener(evt, (e) => {
        e.preventDefault(); e.stopPropagation(); dz.classList.add('dropzone-drag');
    }));
    ['dragleave', 'drop'].forEach(evt => dz.addEventListener(evt, (e) => {
        e.preventDefault(); e.stopPropagation(); dz.classList.remove('dropzone-drag');
    }));
    dz.addEventListener('drop', (e) => {
        const file = e.dataTransfer.files?.[0];
        if (file) setFile(file);
    });
}

function setFile(file) {
    const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
    if (!isPdf) return toast('Selecione um arquivo PDF.', 'erro');
    if (file.size > MAX_FILE_SIZE) return toast('Arquivo acima de 25 MB.', 'erro');

    state.file = file;
    $('#file-name').textContent = file.name;
    $('#file-size').textContent = fmtBytes(file.size) + ' · pronto para envio';
    $('#file-info').classList.remove('hidden');
    $('#dropzone-idle').innerHTML = `
        <div class="w-16 h-16 mx-auto rounded-2xl bg-rose-50 dark:bg-rose-950/40 text-rose-500 flex items-center justify-center text-xl mb-4">
            <i class="fa-solid fa-file-pdf"></i>
        </div>
        <p class="text-sm font-semibold text-slate-700 dark:text-slate-200">Trocar documento</p>
        <p class="text-xs text-slate-400 mt-1">clique ou arraste outro PDF</p>`;
    toast('PDF anexado ao processo.');
}

function clearFile(event) {
    if (event) { event.stopPropagation(); }
    state.file = null;
    $('#file-input').value = '';
    $('#file-info').classList.add('hidden');
    $('#dropzone-idle').innerHTML = `
        <div class="w-16 h-16 mx-auto rounded-2xl bg-gradient-to-tr from-violet-600 to-indigo-500 flex items-center justify-center
                    text-white shadow-lg shadow-violet-500/30 mb-4">
            <i class="fa-solid fa-cloud-arrow-up text-2xl"></i>
        </div>
        <p class="text-sm font-semibold text-slate-700 dark:text-slate-200">Solte o PDF aqui</p>
        <p class="text-xs text-slate-400 mt-1">ou clique para navegar · máx. 25 MB</p>`;
}

function resetProcessForm(apresentar) {
    $('#process-form').reset();
    clearFile();
    $('#result-panel').classList.add('hidden');
    state.lastResult = null;
    if (apresentar) {
        navigate('novo');
        toast('Formulário limpo. Pode enviar um novo processo.');
    }
}

/* =============================================================================
 * 8. ENVIO AO WEBHOOK DO n8n (FormData com PDF + campos)
 * ======================================================================== */
async function sendForAnalysis() {
    if (!state.webhookUrl) {
        toast('Configure a URL do Webhook nas Configurações (admin).', 'erro');
        if (state.isAdmin) navigate('config');
        return;
    }
    if (!state.file) return toast('Anexe o PDF do processo antes de enviar.', 'erro');

    const form = $('#process-form');
    if (!form.reportValidity()) return;

    const { data: acessoPermitido, error: acessoError } = await db.rpc('consumir_credito');
    if (acessoError) {
        console.error('[consumir_credito]', acessoError.message);
        return toast('Não foi possível validar o acesso. O administrador precisa aplicar a atualização do schema.sql.', 'erro');
    }
    if (!acessoPermitido) {
        return toast(state.profile?.tipo_acesso === 'creditos'
            ? 'Créditos insuficientes. Fale com o administrador para liberar mais créditos.'
            : 'Seu período de acesso expirou. Fale com o administrador para renová-lo.', 'erro');
    }
    if (!state.isAdmin && state.profile?.tipo_acesso === 'creditos') {
        state.profile.creditos_saldo = Math.max(0, Number(state.profile.creditos_saldo) - 1);
        paintUserInfo();
    }

    const campos = {};
    ['cliente', 'documento', 'numero_processo', 'orgao', 'periodo', 'tipo_analise', 'email', 'telefone', 'observacoes']
        .forEach(id => campos[id] = $('#' + id)?.value.trim() || '');

    const fd = new FormData();
    fd.append('arquivo', state.file, state.file.name);   // PDF binário
    fd.append('arquivo_nome', state.file.name);
    Object.entries(campos).forEach(([k, v]) => fd.append(k, v));
    fd.append('usuario_email', state.profile?.email || state.session?.user?.email || '');
    fd.append('usuario_nome', state.profile?.nome || '');
    fd.append('cliente_nome', campos.cliente);           // alias comum esperado nos fluxos n8n

    state.abortController = new AbortController();
    startProcessing();
    $('#btn-send').disabled = true;

    let resposta = null, falha = null;

    try {
        const response = await fetch(state.webhookUrl, {
            method: 'POST',
            body: fd,                       // FormData => multipart/form-data automático
            signal: state.abortController.signal
        });

        if (!response.ok) throw new Error(`Webhook respondeu HTTP ${response.status}`);
        resposta = await parseN8nResponse(response);
    } catch (err) {
        falha = (err.name === 'AbortError')
            ? 'Envio cancelado pelo usuário.'
            : ('Falha ao contactar o Servidor de Análise: ' + err.message);
        console.error('[n8n]', err);
    } finally {
        stopProcessing();
        $('#btn-send').disabled = false;
    }

    const normalizado = resposta
        ? normalizeN8nResponse(resposta, { processo: campos.numero_processo })
        : null;
    state.lastResult = normalizado;

    if (falha) {
        toast(falha, 'erro');
        await saveProcesso({ status: 'erro', resumo: falha, resposta: null, campos });
        // O PDF já terminou o ciclo de envio; não o mantenha selecionado no formulário.
        clearFile();
        return;
    }

    const processoSalvo = await saveProcesso({
        status: 'concluido',
        resumo: normalizado.resumo,
        resposta: normalizado.dadosBrutos,
        campos
    });
    // Libera imediatamente o arquivo do formulário após a conclusão da análise.
    clearFile();

    // O detalhe é a tela de consulta do processo salvo. Abre-a automaticamente
    // em vez de deixar o usuário na tela de upload com o resultado embutido.
    if (processoSalvo) {
        navigate('dashboard');
        openProcessModal(processoSalvo.id);
    }
    toast('Análise concluída e salva com sucesso!');
}

/** Lê a resposta do n8n: JSON, texto puro ou binário (próprio .docx). */
async function parseN8nResponse(response) {
    const ct = (response.headers.get('content-type') || '').toLowerCase();

    if (ct.includes('wordprocessingml') || ct.includes('msword') || ct.includes('octet-stream')) {
        const blob = await response.blob();
        return { arquivo_base64: await blobToBase64(blob), resumo: 'Arquivo Word devolvido pelo Servidor de Análise.' };
    }
    if (ct.includes('json')) return await response.json();

    const texto = await response.text();
    try { return JSON.parse(texto); } catch (e) { return { resumo: texto }; }
}

/* -----------------------------------------------------------------------------
 * Leitura FLEXÍVEL do retorno do n8n.
 * O fluxo pode devolver o Word de vários jeitos (base64 em qualquer campo,
 * data:URI, URL, binaryData do n8n, attachments, JSON embutido em string...).
 * Em vez de depender de nomes fixos, varremos a RESPOSTA INTEIRA em qualquer
 * profundidade procurando o documento.
 * -------------------------------------------------------------------------- */

/** Desembrulha strings que são JSON e envelopamentos comuns (body/data/payload). */
function unwrapPayload(raw, nivel = 0) {
    let valor = raw;
    if (typeof valor === 'string') {
        const s = valor.trim();
        if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))) {
            try { valor = JSON.parse(s); } catch (e) { return valor; }
        } else {
            return valor;
        }
    }
    if (valor && typeof valor === 'object' && !Array.isArray(valor) && nivel < 3) {
        const chaves = Object.keys(valor);
        for (const k of ['body', 'payload', 'result', 'response', 'output']) {
            if (valor[k] !== undefined && chaves.length <= 3) return unwrapPayload(valor[k], nivel + 1);
        }
        // { "data": {...} } do n8n — desce só se não houver mais nada útil aqui
        const uteis = chaves.filter(c => !['data', 'statusCode', 'headers', 'meta'].includes(c));
        if (valor.data !== undefined && uteis.length === 0) return unwrapPayload(valor.data, nivel + 1);
    }
    return valor;
}

/** Coleta todos os pares {chave, valor} string da resposta (profundidade ≤ 8). */
function flattenStrings(no, caminho, saida, nivel) {
    if (nivel > 8 || saida.length > 5000) return;

    if (Array.isArray(no)) {
        no.forEach((item, i) => flattenStrings(item, `${caminho}[${i}]`, saida, nivel + 1));
        return;
    }
    if (no && typeof no === 'object') {
        for (const [k, v] of Object.entries(no)) {
            flattenStrings(v, caminho ? `${caminho}.${k}` : k, saida, nivel + 1);
        }
        return;
    }
    if (typeof no === 'string') {
        const chave = (caminho.split('.').pop() || '').replace(/\[\d+\]$/, '');
        saida.push({ chave, caminho, valor: no });

        // string que esconde um JSON → varre também
        const s = no.trim();
        if (nivel < 6 && s.length < 300000 &&
            ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']')))) {
            try { flattenStrings(JSON.parse(s), `${caminho}(json)`, saida, nivel + 1); } catch (e) { /* não é JSON */ }
        }
    }
}

/** Identifica o tipo do arquivo pelo começo dos bytes (assina mágica). */
function detectarTipoBinario(base64) {
    try {
        // aceita base64 comum e URL-safe (usa - e _ no lugar de + e /)
        const limpo = String(base64).replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/');
        if (!limpo || limpo.startsWith('data:')) return null;
        const corte = Math.floor(limpo.length / 4) * 4;   // atob exige múltiplo de 4
        if (corte < 4) return null;
        const bin = atob(limpo.slice(0, corte));
        if (bin.startsWith('PK')) return 'docx';                                    // .docx é um ZIP
        if (bin.charCodeAt(0) === 0xD0 && bin.charCodeAt(1) === 0xCF) return 'doc'; // OLE (Word 97)
        if (bin.startsWith('%PDF')) return 'pdf';
        if (bin.startsWith('GIF8')) return 'gif';
        if (bin.charCodeAt(0) === 0xFF && bin.charCodeAt(1) === 0xD8) return 'jpg';
        if (bin.charCodeAt(0) === 0x89 && bin.startsWith('PNG')) return 'png';
        return null;
    } catch (e) {
        return null;
    }
}

const MIME_ARQUIVO = {
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    doc:  'application/msword',
    pdf:  'application/pdf'
};

/** Procura o arquivo (Word/PDF) em qualquer canto da resposta. */
function procurarArquivo(itens) {
    let base64 = null, url = null, nome = null, ext = '.docx';

    for (const { chave, valor } of itens) {
        const k = chave.toLowerCase();
        const v = valor;
        if (!v || typeof v !== 'string') continue;

        // nome de arquivo, quando o n8n devolve um
        if (!nome && /(file_?name|arquivo_?nome|nome_?arquivo|docx_?nome)/i.test(k) && /\.(docx|doc|pdf)$/i.test(v)) {
            nome = v;
        }

        // 1) data:URI  ("data:application/vnd...;base64,XXXX")
        if (!base64 && v.startsWith('data:')) {
            const m = v.match(/^data:([^;,]*);base64,([\s\S]*)$/);
            if (m) {
                const mime = m[1] || '';
                const tipo = /word|officedocument|msword/i.test(mime) ? 'docx'
                    : (/pdf/i.test(mime) ? 'pdf' : detectarTipoBinario(m[2]));
                if (tipo) {
                    base64 = m[2].replace(/\s/g, '');
                    ext = '.' + tipo;
                    if (!nome) nome = `analise-processo.${tipo}`;
                }
            }
        }

        // 2) base64 puro em qualquer campo (confere a assina mágica do arquivo)
        if (!base64 && v.length >= 500 && v.length <= 25000000 && /^[A-Za-z0-9+/=\-_\s]+$/.test(v)) {
            const tipo = detectarTipoBinario(v);
            const campoDeArquivo = /(docx|word|arquivo|file|documento|binary|anexo|attachment|output|download|base64|blob|conteudo|content)/i.test(k);
            if (tipo === 'docx' || tipo === 'doc' || tipo === 'pdf' || (!tipo && /(docx|word)/i.test(k))) {
                base64 = v.replace(/\s/g, '');
                ext = '.' + (tipo || 'docx');
                if (!nome) nome = `analise-processo${ext}`;
            } else if (!tipo && campoDeArquivo && v.length > 5000) {
                console.warn('[n8n] string grande em campo de arquivo, mas a assina não bate:', k);
            }
        }

        // 3) URL de download (absoluta, assinada ou caminho relativo do n8n)
        if (!url && v.length < 4000) {
            const relativo = /^\/[\w\-./]+\.(docx|doc|pdf)(\?.*)?$/i.test(v);
            const absoluta = /^(https?:\/\/|s3:\/\/)/i.test(v);
            if (relativo && state.webhookUrl) {
                try { url = new URL(v, state.webhookUrl).href; } catch (e) { url = v; }
            } else if (absoluta) {
                const pareceArquivo = /(\.docx|\.doc|\.pdf)(\?|$)/i.test(v) ||
                    /(download|object|storage|file|arquivo|word|docx|blob|signed|x-amz|signature|expires|tempurl|minio)/i.test(v) ||
                    /(url|link|href)/i.test(k);
                const eExterna = /(jwks|auth\/v1|supabase\.co\/rest|googleapis\.com\/identity)/i.test(v);
                if (pareceArquivo && !eExterna) url = v;
            }
        }
    }

    return { base64, url, nome, ext };
}

/** Procura um texto por nome de chave (em qualquer profundidade). */
function acharTexto(itens, chaves) {
    for (const alvo of chaves) {
        const achado = itens.find(it => it.chave.toLowerCase() === alvo && it.valor && it.valor.trim());
        if (achado) return achado.valor;
    }
    return null;
}

/** Procura um valor (objeto/lista/string) por nome de chave, recursivamente. */
function acharValor(no, chaves, nivel = 0) {
    if (!no || typeof no !== 'object' || nivel > 6) return undefined;
    for (const alvo of chaves) {
        if (no[alvo] !== undefined && no[alvo] !== null && no[alvo] !== '') return no[alvo];
    }
    for (const v of Object.values(no)) {
        if (v && typeof v === 'object') {
            const achado = acharValor(v, chaves, nivel + 1);
            if (achado !== undefined) return achado;
        }
    }
    return undefined;
}

/** Se ninguém chamou o campo de "resumo", usa o maior texto plausível. */
function resumoAutomatico(itens) {
    const candidatos = itens.filter(it => {
        const v = it.valor;
        if (v.length < 40 || v.length > 15000) return false;
        if (v.length >= 400 && /^[A-Za-z0-9+/=\r\n]+$/.test(v)) return false;   // base64 (sem espaços)
        if (/^https?:\/\//i.test(v)) return false;                        // URL
        if (/^(SELECT|INSERT|CREATE|function |const |<\?|<!doctype)/i.test(v)) return false;
        return /[a-záéíóúãõç]{4,}/i.test(v);                              // tem texto de verdade
    });
    if (!candidatos.length) return null;
    candidatos.sort((a, b) => b.valor.length - a.valor.length);
    return candidatos[0].valor;
}

/* >>> ORGANIZADOR-INICIO >>> */
/* =============================================================================
 * 8.1 ORGANIZAÇÃO DO RESULTADO (formato padrão exigido)
 * -----------------------------------------------------------------------------
 * O servidor de análise pode devolver campos estruturados ou texto corrido.
 * Aqui o conteúdo é reorganizado no formato padronizado:
 *
 *   Processo: 1038851-48.2024.8.11.0041
 *   Autuação: 02/09/2024
 *   Citação: 30/10/2017
 *
 *   Direito reconhecido: pagamento do terço constitucional ...
 *
 *   Atualização do débito:
 *
 *   De 30/10/2017 a 30/11/2021: IPCA-E + juros da caderneta de poupança.
 *   De 01/12/2021 em diante: somente SELIC.
 * ======================================================================== */

/** Rótulos reconhecidos dentro do texto devolvido pelo servidor. */
const ROTULOS_RESUMO = [
    ['processo',    /(?:^|\n)[ \t]*(?:n[úu]mero\s+(?:do\s+)?|n[º°]\s*)?processo(?:\s+n[º°])?[ \t]*[:\-–][ \t]*/i],
    ['autuacao',    /(?:^|\n)[ \t]*autua[çc][ãa]o[ \t]*[:\-–][ \t]*/i],
    ['citacao',     /(?:^|\n)[ \t]*cita[çc][ãa]o[ \t]*[:\-–][ \t]*/i],
    ['direito',     /(?:^|\n)[ \t]*direitos?\s+reconhecidos?\s*[:\-–][ \t]*/i],
    ['atualizacao', /(?:^|\n)[ \t]*atualiza[çc][ãa]o\s+(?:do\s+)?d[eé]bito\s*[:\-–][ \t]*/i]
];

/** Sinônimos de chave aceitos quando o servidor devolve campos estruturados. */
const CAMPOS_RESUMO = {
    processo: ['numero_processo', 'numero_do_processo', 'processo_numero', 'num_processo', 'numero_cnj', 'cnj', 'processo'],
    autuacao: ['data_autuacao', 'autuacao', 'data_da_autuacao', 'data_de_autuacao', 'ajuizamento',
               'data_ajuizamento', 'distribuicao', 'data_distribuicao', 'distribuida_em', 'autuada_em'],
    citacao:  ['data_citacao', 'citacao', 'data_da_citacao', 'data_de_citacao', 'citado_em'],
    verbas_deferidas: ['verbas_deferidas', 'verba_deferida', 'verbas_deferida', 'verbas'],
    indices_juros: ['indices_juros', 'indices_de_juros', 'indices_taxas_juros', 'taxas_juros',
                    'juros_deferidos', 'indices_e_juros'],
    direito:  ['direito_reconhecido', 'direitos_reconhecidos', 'direito', 'tese_acolhida', 'tese_juridica',
               'pedido_acolhido', 'dispositivo', 'fundamentacao', 'fundamento', 'conclusao'],
    atualizacao: ['atualizacao_do_debito', 'atualizacao_debito', 'criterios_de_atualizacao',
                  'criterios_atualizacao', 'criterio_de_atualizacao', 'criterio_atualizacao',
                  'atualizacao_monetaria', 'juros_e_atualizacao', 'atualizacao']
};

/** Texto usado pelo fallback quando o servidor não manda resumo nenhum. */
const RESUMO_PADRAO = 'Análise processada pelo Servidor de Análise.';

/** Pedaços de data aceitos nas datas (10/2017, 30-10-2017, 2017-10-30...). */
const RX_DATA = '(?:\\d{1,2}[\\/\\-.]\\d{1,2}[\\/\\-.]\\d{4}|\\d{4}-\\d{2}-\\d{2})';

/** Minúsculas, sem acento e sem espaço — para comparar nomes de chave. */
function chaveNormalizada(k) {
    return String(k === null || k === undefined ? '' : k)
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

/** Procura um texto pelos nomes de chave (exato primeiro, depois "contém"). */
function campoFlexivel(itens, chaves) {
    const norm = (itens || [])
        .map(it => ({ k: chaveNormalizada(it.chave), v: String(it.valor === null || it.valor === undefined ? '' : it.valor).trim() }))
        .filter(it => it.v && !/^(https?:|data:)/i.test(it.v));

    for (const alvo of chaves) {
        const exatos = norm.filter(it => it.k === alvo).map(it => it.v);
        if (exatos.length) return [...new Set(exatos)].join('\n');
    }
    for (const alvo of chaves) {
        const parcial = norm.find(it => it.k.includes(alvo));
        if (parcial) return parcial.v;
    }
    return null;
}

/** Chave interna de um objeto simples (já normalizada). */
function valorInterno(obj, chaves) {
    if (!obj || typeof obj !== 'object') return null;
    const alvos = chaves.map(chaveNormalizada);
    for (const alvo of alvos) {
        for (const [k, v] of Object.entries(obj)) {
            if (chaveNormalizada(k) === alvo && v !== null && v !== undefined && v !== '') return v;
        }
    }
    return null;
}

/** 2017-10-30 / 30.10.2017 -> 30/10/2017 (mantém o que não é data). */
function normData(txt) {
    const t = String(txt === null || txt === undefined ? '' : txt).trim();
    let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[3]}/${m[2]}/${m[1]}`;
    m = t.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/);
    if (m) return `${m[1].padStart(2, '0')}/${m[2].padStart(2, '0')}/${m[3]}`;
    return t.replace(/\s+/g, ' ');
}

/** Padroniza o critério de atualização ("ipca-e + poupança" -> texto pronto). */
function normalizarCriterio(txt) {
    const t = String(txt === null || txt === undefined ? '' : txt)
        .replace(/\s+/g, ' ').trim().replace(/[.;,]+$/, '').trim();
    if (!t || t.length < 2) return '';

    const temSelic     = /\bselic\b/i.test(t);
    const temIpca      = /\bipca\b/i.test(t);
    const temPoupanca  = /poupan[çc]a/i.test(t);
    const temJuros     = /juros/i.test(t);
    const temOutroInd  = /\bigp[\s-]?m\b|\binpc\b/i.test(t);

    // Só a SELIC -> "somente SELIC"
    if (temSelic && !temIpca && !temPoupanca && !temOutroInd) return 'somente SELIC';

    // Mais de um critério no mesmo trecho -> preserva o texto original
    if (temSelic && (temIpca || temPoupanca)) return t;

    const ipcaE   = /\bIPCA[-–]?E\b/.test(t) || /\bIPCA\s+E\b/.test(t);
    const temIpcaTok = /\bIPCA\b/i.test(t);
    const indice = ipcaE ? 'IPCA-E'
        : (temIpcaTok ? 'IPCA'
        : (/\bIGP[\s-]?M\b/i.test(t) ? 'IGP-M'
        : (/\bINPC\b/i.test(t) ? 'INPC' : '')));

    const partes = [];
    if (indice) partes.push(indice);
    if (temPoupanca) partes.push('juros da caderneta de poupança');
    else if (temJuros) {
        const mj = t.match(/juros[^,;+]*/i);
        if (mj) partes.push(mj[0].replace(/\s+/g, ' ').trim());
    }

    return partes.length ? partes.join(' + ') : t;
}

/** Monta uma linha "De 30/10/2017 a 30/11/2021: IPCA-E + ..." (ou null). */
function montarPeriodo(segmento) {
    const l = String(segmento === null || segmento === undefined ? '' : segmento)
        .replace(/^[\s\-–•*·]+/, '').replace(/\s+/g, ' ').trim();
    if (!l || !new RegExp(RX_DATA).test(l)) return null;

    let m;
    // De 30/10/2017 a 30/11/2021: criterio   |   30/10/2017 a 30/11/2021 - criterio
    if ((m = l.match(new RegExp('^(?:de\\s+)?(' + RX_DATA + ')\\s+(?:a|at[ée])\\s+(' + RX_DATA + ')\\s*[:\\-–,]?\\s*(.+)$', 'i')))) {
        const c = normalizarCriterio(m[3]);
        return c ? `De ${normData(m[1])} a ${normData(m[2])}: ${c}.` : `De ${normData(m[1])} a ${normData(m[2])}.`;
    }
    // De 01/12/2021 em diante: criterio
    if ((m = l.match(new RegExp('^(?:(?:a\\s+partir\\s+de|de|ap[óo]s)\\s+)?(' + RX_DATA + ')\\s+em\\s+diante\\s*[:\\-–,]?\\s*(.*)$', 'i')))) {
        const c = normalizarCriterio(m[2]);
        return c ? `De ${normData(m[1])} em diante: ${c}.` : `De ${normData(m[1])} em diante.`;
    }
    // criterio no período de 30/10/2017 a 30/11/2021
    if ((m = l.match(new RegExp('^(.+?)\\s+no\\s+per[íi]odo\\s+(?:de|entre)\\s+(' + RX_DATA + ')\\s+(?:a|at[ée])\\s+(' + RX_DATA + ')\\s*[.;]?\\s*$', 'i')))) {
        return `De ${normData(m[2])} a ${normData(m[3])}: ${normalizarCriterio(m[1])}.`;
    }
    // criterio de 30/10/2017 a 30/11/2021
    if ((m = l.match(new RegExp('^(.+?)\\s+de\\s+(' + RX_DATA + ')\\s+(?:a|at[ée])\\s+(' + RX_DATA + ')\\s*[.;]?\\s*$', 'i')))) {
        return `De ${normData(m[2])} a ${normData(m[3])}: ${normalizarCriterio(m[1])}.`;
    }
    // criterio de 01/12/2021 em diante  |  criterio a partir de 01/12/2021
    if ((m = l.match(new RegExp('^(.+?)\\s+(?:(?:de|a\\s+partir\\s+de|ap[óo]s)\\s+)?(' + RX_DATA + ')\\s+em\\s+diante\\s*[:\\-–,]?\\s*(.*)$', 'i')))) {
        const c = normalizarCriterio([m[1], m[3]].filter(Boolean).join(' '));
        return c ? `De ${normData(m[2])} em diante: ${c}.` : `De ${normData(m[2])} em diante.`;
    }
    if ((m = l.match(new RegExp('^(.+?)\\s+(?:a\\s+partir\\s+de|ap[óo]s)\\s+(' + RX_DATA + ')\\s*[:\\-–,]?\\s*(.*)$', 'i')))) {
        const c = normalizarCriterio([m[1], m[3]].filter(Boolean).join(' '));
        return c ? `De ${normData(m[2])} em diante: ${c}.` : `De ${normData(m[2])} em diante.`;
    }
    // a partir de 01/12/2021: criterio
    if ((m = l.match(new RegExp('^(?:a\\s+partir\\s+de|ap[óo]s|de)\\s+(' + RX_DATA + ')\\s*[:\\-–,]\\s*(.+)$', 'i')))) {
        const c = normalizarCriterio(m[2]);
        return c ? `De ${normData(m[1])} em diante: ${c}.` : `De ${normData(m[1])} em diante.`;
    }
    return null;
}

/** Quebra o texto em pedaços de frase (preserva datas como 30.10.2017). */
function segmentarTexto(texto) {
    return String(texto === null || texto === undefined ? '' : texto)
        .split(/\n+/)
        .flatMap(l => l.split(/(?<=;)(?=\s)/))   // ";" fica no pedaço da esquerda
        .flatMap(l => l.split(/(?<=\.)(?=\s)/))  // "." final também
        .map(s => s.trim())
        .filter(Boolean);
}

/**
 * Separa o texto em { texto, periodos }: tudo que for período de atualização
 * vira linha pronta ("De X a Y: critério.") e o restante volta em `texto`.
 */
function extrairPeriodos(texto) {
    const bruto = String(texto === null || texto === undefined ? '' : texto);
    if (!bruto.trim()) return { texto: '', periodos: [] };

    const periodos = [];
    const sobras = [];
    for (const pedaco of segmentarTexto(bruto)) {
        const l = montarPeriodo(pedaco);
        if (l) periodos.push(l);
        else sobras.push(pedaco);
    }
    if (!periodos.length) return { texto: bruto.trim(), periodos: [] };

    const separador = /\n/.test(bruto) ? '\n' : ' ';
    return { texto: sobras.join(separador).replace(/\s*\n\s*/g, '\n').trim(), periodos };
}

/** Aceita o bloco de atualização como texto, lista ou lista de objetos. */
function linhasDeAtualizacao(valor) {
    if (valor === null || valor === undefined || valor === '') return [];

    if (Array.isArray(valor)) return valor.flatMap(v => linhasDeAtualizacao(v)).filter(Boolean);

    if (typeof valor === 'object') {
        const periodo  = valorInterno(valor, ['periodo', 'periodo_aquisitivo', 'vigencia', 'intervalo', 'competencia']);
        const inicio   = valorInterno(valor, ['data_inicio', 'inicio', 'inicial', 'data_inicial', 'de']);
        const fim      = valorInterno(valor, ['data_fim', 'fim', 'final', 'data_final', 'ate', 'data_ate']);
        const criterio = valorInterno(valor, ['criterio', 'criterio_de_atualizacao', 'indice', 'indexador', 'taxa', 'juros', 'descricao', 'texto', 'valor']);
        let base = periodo ? String(periodo).trim()
            : (inicio && fim ? `${normData(inicio)} a ${normData(fim)}`
            : (inicio ? `${normData(inicio)} em diante` : ''));
        const txt = [base, criterio].filter(Boolean).join(base && criterio ? ': ' : '');
        const l = montarPeriodo(txt);
        return l ? [l] : (txt ? [normalizarCriterio(txt) || txt] : []);
    }

    const texto = String(valor);
    const ex = extrairPeriodos(texto);
    if (ex.periodos.length) return ex.periodos;
    const l = montarPeriodo(texto);
    if (l) return [l];
    return [texto.trim()].filter(Boolean);
}

/** Corta o texto pelos rótulos "Processo:", "Autuação:", "Citação:" etc. */
function fatiarPorRotulos(texto) {
    const bruto = String(texto === null || texto === undefined ? '' : texto);
    const marcas = [];

    for (const [campo, rx] of ROTULOS_RESUMO) {
        const re = new RegExp(rx.source, 'gi');
        let m;
        while ((m = re.exec(bruto)) !== null) {
            marcas.push({ inicio: m.index, fim: m.index + m[0].length, campo });
            if (m[0].length === 0) re.lastIndex++;
        }
    }
    marcas.sort((a, b) => a.inicio - b.inicio);

    const saida = {};
    const sobras = [];
    let cursor = 0;

    for (let i = 0; i < marcas.length; i++) {
        const mk = marcas[i];
        if (mk.inicio > cursor) sobras.push(bruto.slice(cursor, mk.inicio).trim());

        const fim = (i + 1 < marcas.length) ? marcas[i + 1].inicio : bruto.length;
        const valor = bruto.slice(mk.fim, fim).trim();
        cursor = Math.max(cursor, fim);

        if (!valor) continue;
        if (!saida[mk.campo]) saida[mk.campo] = valor;
        else sobras.push(valor);
    }
    if (cursor < bruto.length) sobras.push(bruto.slice(cursor).trim());

    saida._sobras = sobras.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    return saida;
}

/** Monta o texto final no formato padronizado. */
function montarResumo({ processo, autuacao, citacao, direito, periodos }) {
    const cabecalho = [];
    if (processo) cabecalho.push(`Processo: ${processo}`);
    if (autuacao) cabecalho.push(`Autuação: ${autuacao}`);
    if (citacao)  cabecalho.push(`Citação: ${citacao}`);

    let out = cabecalho.join('\n');

    const dir = String(direito === null || direito === undefined ? '' : direito)
        .replace(/[ \t]+\n/g, '\n').trim();
    if (dir) out += (out ? '\n\n' : '') + `Direito reconhecido: ${dir}`;

    const linhas = (periodos || []).filter(Boolean);
    if (linhas.length) out += (out ? '\n\n' : '') + 'Atualização do débito:\n\n' + linhas.join('\n');

    return out.trim();
}

/**
 * Reorganiza o retorno do n8n no formato padrão.
 * @param {string} bruto   resumo/texto devolvido pelo servidor (pode ser null)
 * @param {Array}  itens   pares {chave, valor} achados na resposta
 * @param {*}      data    objeto já desembrulhado da resposta
 * @param {Object} contexto { processo } — dados do formulário (fallback)
 */
function organizarResumo(bruto, itens, data, contexto) {
    const texto = typeof bruto === 'string' ? bruto.trim() : '';
    const lixo = new RegExp('^(' + RESUMO_PADRAO.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')$', 'i');
    const textoUtil = (texto && !lixo.test(texto)) ? texto : '';

    // 1) campos estruturados da resposta -----------------------------------
    const campos = {};
    const estruturados = new Set();
    for (const [campo, chaves] of Object.entries(CAMPOS_RESUMO)) {
        const v = campoFlexivel(itens, chaves);
        if (v) { campos[campo] = v; estruturados.add(campo); }
    }

    // 2) rótulos escritos dentro do texto -----------------------------------
    let rotulos = [];
    let sobras = '';
    if (textoUtil) {
        const fatias = fatiarPorRotulos(textoUtil);
        rotulos = Object.keys(fatias).filter(k => k !== '_sobras' && fatias[k]);
        sobras = fatias._sobras || '';
        rotulos.forEach(k => { if (!campos[k]) campos[k] = fatias[k]; });
        if (!campos.direito && sobras) campos.direito = sobras;
    }

    // 3) bloco "Atualização do débito" (texto, lista ou lista de objetos) ---
    let periodos = [];
    if (campos.atualizacao) {
        const ex = extrairPeriodos(campos.atualizacao);
        periodos = ex.periodos.length ? ex.periodos : linhasDeAtualizacao(campos.atualizacao);
    } else if (data) {
        const val = acharValor(data, ['atualizacao_do_debito', 'atualizacao_debito', 'criterios_de_atualizacao',
                                      'criterios_atualizacao', 'criterio_de_atualizacao', 'atualizacao_monetaria']);
        if (val !== undefined) periodos = linhasDeAtualizacao(val);
    }

    // 4) períodos escondidos dentro do texto do "direito" -------------------
    if (campos.direito) {
        const ex = extrairPeriodos(campos.direito);
        campos.direito = ex.texto;
        ex.periodos.forEach(p => { if (!periodos.includes(p)) periodos.push(p); });
    }

    // 5) nº do processo vem do formulário quando o servidor não devolve -----
    if (!campos.processo && contexto && contexto.processo) campos.processo = contexto.processo;
    if (campos.processo) campos.processo = String(campos.processo).trim();

    // Sem nenhuma estrutura reconhecida => devolve o texto original.
    const temEstrutura = rotulos.length || estruturados.size || periodos.length ||
        (campos.processo && campos.direito);
    if (!temEstrutura) return textoUtil;

    return montarResumo({
        processo: campos.processo || '',
        autuacao: campos.autuacao ? normData(campos.autuacao) : '',
        citacao:  campos.citacao ? normData(campos.citacao) : '',
        direito:  campos.direito || '',
        periodos
    }) || textoUtil;
}

/** Escape + rótulos do formato padrão em negrito (para exibir na tela). */
function renderResumoHtml(texto) {
    const t = esc(texto);
    if (!t) return '';
    return t.replace(/^(Processo|Autua[çc][ãa]o|Cita[çc][ãa]o|Direito reconhecido|Atualiza[çc][ãa]o do d[ée]bito):/gm,
        '<strong class="text-slate-800 dark:text-white">$1:</strong>');
}
/* <<< ORGANIZADOR-FIM <<< */

/** Mostra no painel o que sobrou da resposta (campos/bases calculadas). */
function dadosFallback(data) {
    if (!data || typeof data !== 'object') return null;
    const ignorar = /^(resumo|summary|resultado|analise|texto|descricao|answer|resposta|message|msg|success|statuscode|status|chave|webhook_url)$/i;
    const saida = {};
    for (const [k, v] of Object.entries(data)) {
        if (ignorar.test(k)) continue;
        if (typeof v === 'string' && (v.length > 3000 || /^https?:/i.test(v))) continue;
        saida[k] = v;
    }
    return Object.keys(saida).length ? saida : null;
}

/**
 * Normaliza o retorno do n8n de qualquer formato para:
 *   { resumo, dados, base64, url, mime, nomeArquivo, chaves, dadosBrutos }
 *
 * `contexto` (opcional) traz dados do formulário — ex.: { processo: '123456-78...' }
 * — usados como fallback quando o servidor não devolve o número do processo.
 */
function normalizeN8nResponse(raw, contexto) {
    console.log('[n8n] resposta bruta:', raw);

    const data = unwrapPayload(raw);
    const itens = [];
    flattenStrings(data, '', itens, 0);

    const resumoTxt = acharTexto(itens, [
        'resumo', 'summary', 'resultado', 'analise', 'texto', 'descricao',
        'answer', 'resposta', 'conclusao', 'parecer', 'explicacao'
    ]) || resumoAutomatico(itens);

    // >>> Resultado reorganizado no formato padrão (Processo / Autuação /
    //     Citação / Direito reconhecido / Atualização do débito) <<<
    const resumo = organizarResumo(resumoTxt, itens, data, contexto) || RESUMO_PADRAO;

    // Campos exibidos diretamente na tela de detalhes. Eles são extraídos do
    // JSON estruturado do n8n e continuam disponíveis após o processo ser salvo.
    const dadosAnalise = {};
    for (const campo of ['processo', 'autuacao', 'citacao', 'verbas_deferidas', 'indices_juros']) {
        const valor = campoFlexivel(itens, CAMPOS_RESUMO[campo]);
        if (valor) dadosAnalise[campo] = campo === 'autuacao' || campo === 'citacao' ? normData(valor) : valor;
    }
    if (!dadosAnalise.processo && contexto?.processo) dadosAnalise.processo = String(contexto.processo).trim();

    const dados = acharValor(data, ['dados', 'campos', 'valores', 'informacoes', 'calculos', 'bases', 'tabela', 'items', 'detalhes', 'resultados']);

    const arq = procurarArquivo(itens);
    const ext = (arq.ext || '.docx').replace('.', '');

    return {
        resumo,
        dadosAnalise,
        dados: dados !== undefined ? dados : dadosFallback(data),
        dadosBrutos: data,
        base64: arq.base64 || null,
        url: arq.url || null,
        mime: MIME_ARQUIVO[ext] || MIME_ARQUIVO.docx,
        nomeArquivo: arq.nome || `analise-processo.${ext}`,
        chaves: (data && typeof data === 'object') ? Object.keys(data) : []
    };
}

function showResult(r) {
    const alvo = $('#result-resumo');
    alvo.innerHTML = renderResumoHtml(r.resumo) || '—';
    $('#result-saved').classList.add('hidden');

    // Resposta bruta (depuração) — mostra exatamente o que o n8n devolveu
    const raw = $('#result-raw-json');
    if (raw) {
        let bruto;
        try {
            bruto = JSON.stringify(r.dadosBrutos, null, 2) || String(r.dadosBrutos);
        } catch (e) {
            bruto = String(r.dadosBrutos);
        }
        raw.textContent = bruto.length > 60000 ? bruto.slice(0, 60000) + '\n… (truncado)' : bruto;
    }
    const aviso = $('#result-aviso');
    if (aviso) {
        if (!r.base64 && !r.url) {
            aviso.classList.remove('hidden');
            const temCampos = Object.keys(r.dadosAnalise || {}).length > 0;
            aviso.innerHTML = temCampos
                ? `<i class="fa-solid fa-circle-check text-emerald-500 mr-1.5"></i>
                   Dados da análise recebidos com sucesso. O n8n não retornou um arquivo Word nesta resposta.`
                : `<i class="fa-solid fa-triangle-exclamation text-amber-500 mr-1.5"></i>
                   O Servidor de Análise respondeu, mas não encontrei o arquivo na resposta. Chaves recebidas:
                   <code class="text-violet-600 dark:text-violet-400">${esc((r.chaves || []).join(', ') || '(objeto vazio)')}</code>.`;
        } else {
            aviso.classList.add('hidden');
        }
    }

    $('#result-panel').classList.remove('hidden');
    $('#result-panel').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/* --- Overlay "Processando..." --------------------------------------------- */
function startProcessing() {
    const overlay = $('#processing-overlay');
    overlay.classList.remove('hidden');
    overlay.classList.add('flex');
    document.body.classList.add('overflow-hidden');

    let step = 0;
    paintSteps(step);
    state.processingTimer = setInterval(() => {
        step = Math.min(step + 1, 3);
        paintSteps(step);
    }, 2500);
}

function paintSteps(active) {
    $$('.processing-step').forEach((el, i) => {
        const dot = el.querySelector('.step-dot');
        const label = el.querySelector('span:last-child');
        if (i < active) {
            dot.className = 'step-dot w-5 h-5 rounded-full bg-emerald-500 text-white flex items-center justify-center text-[9px]';
            dot.innerHTML = '<i class="fa-solid fa-check"></i>';
            label.className = 'text-slate-500 dark:text-slate-400';
        } else if (i === active) {
            dot.className = 'step-dot w-5 h-5 rounded-full bg-violet-600 text-white flex items-center justify-center text-[9px]';
            dot.innerHTML = '<i class="fa-solid fa-circle-notch animate-spin"></i>';
            label.className = 'text-slate-800 dark:text-slate-100 font-semibold';
        } else {
            dot.className = 'step-dot w-5 h-5 rounded-full bg-slate-200 dark:bg-slate-800 text-white flex items-center justify-center text-[9px]';
            dot.innerHTML = '<i class="fa-solid fa-circle-notch"></i>';
            label.className = 'text-slate-400';
        }
    });
}

function stopProcessing() {
    clearInterval(state.processingTimer);
    state.processingTimer = null;
    const overlay = $('#processing-overlay');
    overlay.classList.add('hidden');
    overlay.classList.remove('flex');
    document.body.classList.remove('overflow-hidden');
}

function cancelProcessing() {
    if (state.abortController) state.abortController.abort();
    stopProcessing();
    $('#btn-send').disabled = false;
}

/* =============================================================================
 * 9. DOWNLOAD DO ARQUIVO WORD — base64, URL ou Supabase Storage
 * ======================================================================== */
function downloadWordFromResult() {
    const r = state.lastResult;
    if (!r) return toast('Nenhum resultado disponível.', 'erro');

    if (r.base64) return downloadBase64Word(r.base64, r.nomeArquivo, r.mime);
    if (r.url) return openExternal(r.url, r.nomeArquivo);

    toast(`O Servidor de Análise respondeu mas não devolveu o arquivo. Chaves: ${(r.chaves || []).join(', ') || '(vazio)'}. Abra a resposta bruta e me envie.`, 'erro');
}

async function downloadWord(id) {
    const p = state.processos.find(x => x.id === id) || (state.lastResult ? null : null);
    if (!p) return downloadWordFromResult();

    // 1) Supabase Storage (URL assinada)
    if (p.docx_path && db.storage) {
        const { data, error } = await db.storage.from(BUCKET).createSignedUrl(p.docx_path, 3600);
        if (!error && data?.signedUrl) return openExternal(data.signedUrl, p.docx_nome || 'analise.docx');
    }
    // 2) Coluna base64
    if (p.docx_base64) return downloadBase64Word(p.docx_base64, p.docx_nome || 'analise.docx');
    // 3) URL direta
    if (p.docx_url) return openExternal(p.docx_url, p.docx_nome || 'analise.docx');
    // 4) Guardado no JSON bruto do n8n
    const r = p.resposta ? normalizeN8nResponse(p.resposta) : null;
    if (r?.base64) return downloadBase64Word(r.base64, r.nomeArquivo, r.mime);
    if (r?.url) return openExternal(r.url, r.nomeArquivo);

    toast('Arquivo Word não disponível para este processo.', 'erro');
}

function downloadBase64Word(base64, nome, mime) {
    const ext = String(nome || '').split('.').pop().toLowerCase();
    const tipo = mime || MIME_ARQUIVO[ext] || MIME_ARQUIVO.docx;
    const blob = base64ToBlob(base64, tipo);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = nome || 'analise-processo.docx';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast('Download do arquivo iniciado.');
}

function openExternal(url, nome) {
    const a = document.createElement('a');
    a.href = url; a.target = '_blank'; a.rel = 'noopener';
    if (nome) a.download = nome;
    document.body.appendChild(a); a.click(); a.remove();
}

/* =============================================================================
 * 10. PERSISTÊNCIA NO SUPABASE (upload dos arquivos + registro do processo)
 * ======================================================================== */

/** Troca strings base64 enormes por um marcador (o arquivo já está salvo). */
function semBase64Pesado(valor, nivel = 0) {
    if (nivel > 8) return valor;
    if (typeof valor === 'string') {
        if (valor.length > 20000 && /^[A-Za-z0-9+/=\s]+$/.test(valor)) {
            return '[base64 do arquivo removido — ver docx_path / docx_base64]';
        }
        return valor;
    }
    if (Array.isArray(valor)) return valor.map(v => semBase64Pesado(v, nivel + 1));
    if (valor && typeof valor === 'object') {
        const saida = {};
        for (const [k, v] of Object.entries(valor)) saida[k] = semBase64Pesado(v, nivel + 1);
        return saida;
    }
    return valor;
}

/** Envia o arquivo ao Storage; retorna o path ou null (bucket inexistente). */
async function uploadToStorage(file, path) {
    if (!file || !db.storage) return null;
    try {
        const { error } = await db.storage.from(BUCKET).upload(path, file, {
            upsert: true,
            contentType: file.type || 'application/octet-stream'
        });
        if (error) { console.warn('[storage]', error.message); return null; }
        return path;
    } catch (e) {
        console.warn('[storage]', e);
        return null;
    }
}

async function saveProcesso({ status, resumo, resposta, campos }) {
    const registro = {
        user_id: state.session.user.id,
        cliente: campos.cliente,
        documento: campos.documento,
        numero_processo: campos.numero_processo || state.lastResult?.dadosAnalise?.processo || '',
        orgao: campos.orgao,
        periodo: campos.periodo,
        tipo_analise: campos.tipo_analise,
        email: campos.email,
        telefone: campos.telefone,
        observacoes: campos.observacoes,
        status,
        resumo: resumo || '',
        resposta: resposta || null,
        webhook_url: state.webhookUrl
    };

    // --- PDF original no Storage -------------------------------------------
    const stamp = Date.now();
    const pdfPath = state.file
        ? `${state.session.user.id}/${stamp}-${safeName(state.file.name)}`
        : null;
    if (pdfPath) {
        const saved = await uploadToStorage(state.file, pdfPath);
        if (saved) { registro.arquivo_path = saved; registro.arquivo_nome = state.file.name; }
    }

    // --- Word gerado pelo n8n ----------------------------------------------
    const r = state.lastResult;
    if (r) {
        registro.docx_nome = r.nomeArquivo || 'analise-processo.docx';
        registro.docx_url = r.url || null;

        if (r.base64) {
            const blob = base64ToBlob(r.base64, r.mime);
            const docxPath = `${state.session.user.id}/${stamp}-${safeName(registro.docx_nome)}`;
            const saved = await uploadToStorage(blob, docxPath);
            if (saved) {
                registro.docx_path = saved;
            } else if (blob.size <= 1_500_000) {
                registro.docx_base64 = r.base64; // fallback: guardado na própria linha
            } else {
                toast('Word grande demais e sem bucket: não foi possível salvar a cópia.', 'erro');
            }
        }
    }

    // Com o arquivo já guardado, o base64 gigante sai do JSON `resposta`
    // (senão a linha do banco fica com dezenas de MB e o insert falha).
    if (registro.resposta && (registro.docx_path || registro.docx_base64 || registro.docx_url)) {
        registro.resposta = semBase64Pesado(registro.resposta);
    }

    const { data, error } = await db.from('processos').insert(registro).select().single();
    if (error) {
        console.warn('[insert processos]', error.message);
        toast('Não foi possível gravar o processo — rode o schema.sql (' + error.message + ').', 'erro');
        return null;
    }

    state.processos.unshift(data);
    renderProcessos();
    const saved = $('#result-saved');
    if (saved && $('#result-panel') && !$('#result-panel').classList.contains('hidden')) saved.classList.remove('hidden');
    return data;
}

/* =============================================================================
 * 11. CONFIGURAÇÕES (admin) — Webhook do n8n
 * ======================================================================== */
async function loadWebhookUrl() {
    // Fallback local (caso a tabela configuracoes ainda não exista)
    state.webhookUrl = localStorage.getItem(CHAVE_WEBHOOK) || '';
    paintWebhookBadge();

    if (!db) return;
    const { data, error } = await db.from('configuracoes').select('valor').eq('chave', CHAVE_WEBHOOK).maybeSingle();
    if (error) { console.warn('[configuracoes]', error.message); return; }

    if (data?.valor) {
        state.webhookUrl = data.valor;
        localStorage.setItem(CHAVE_WEBHOOK, data.valor);
        paintWebhookBadge();
    }
    $('#webhook-input').value = state.webhookUrl;
}

function paintWebhookBadge() {
    const badge = $('#webhook-badge');
    if (!badge) return;
    if (state.webhookUrl) {
        // Servidor de Análise disponível -> ponto VERDE "Online"
        badge.className = 'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg font-bold bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-400';
        badge.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span> Online';
    } else {
        // Sem URL configurada -> ponto VERMELHO "Offline"
        badge.className = 'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg font-bold bg-rose-100 text-rose-700 dark:bg-rose-950/60 dark:text-rose-400';
        badge.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-rose-500"></span> Offline';
    }
}

async function saveWebhookUrl() {
    if (!state.isAdmin) return toast('Somente o Administrador pode alterar o webhook.', 'erro');

    const url = $('#webhook-input').value.trim();
    if (!/^https?:\/\/.+/i.test(url)) return toast('Informe uma URL válida (http:// ou https://).', 'erro');

    localStorage.setItem(CHAVE_WEBHOOK, url);   // já libera o uso imediato
    state.webhookUrl = url;
    paintWebhookBadge();

    const { error } = await db.from('configuracoes').upsert(
        { chave: CHAVE_WEBHOOK, valor: url, updated_at: new Date().toISOString() },
        { onConflict: 'chave' }
    );

    if (error) {
        toast('URL salva localmente; a tabela `configuracoes` ainda não existe (rode o schema.sql).', 'erro');
        return;
    }
    toast('URL do webhook do n8n salva com sucesso!');
}

async function testWebhook() {
    const url = $('#webhook-input').value.trim();
    if (!/^https?:\/\/.+/i.test(url)) return toast('Informe a URL do webhook primeiro.', 'erro');

    toast('Enviando requisição de teste...');
    try {
        const fd = new FormData();
        fd.append('teste', 'true');
        fd.append('origem', 'Analia-frontend');
        const res = await fetch(url, { method: 'POST', body: fd });
        toast(`Webhook respondeu HTTP ${res.status}`, res.ok ? '' : 'erro');
    } catch (e) {
        toast('Falha no teste: ' + e.message + ' (confira CORS no n8n).', 'erro');
    }
}

/* =============================================================================
 * 12. GERENCIAMENTO DE USUÁRIOS (apenas Administrador)
 * ======================================================================== */
async function loadUsers() {
    if (!state.isAdmin) return;
    const { data, error } = await db.from('perfis').select('*').order('created_at', { ascending: false });

    if (error) {
        console.warn('[perfis]', error.message);
        $('#users-tbody').innerHTML = `<tr><td colspan="4" class="py-6 text-center text-slate-400">Tabela \`perfis\` indisponível — rode o schema.sql.</td></tr>`;
        return;
    }
    state.users = data || [];
    renderUsers();
}

function renderUsers() {
    const tbody = $('#users-tbody');
    if (!state.users.length) {
        tbody.innerHTML = '<tr><td colspan="4" class="py-6 text-center text-slate-400">Nenhum usuário cadastrado.</td></tr>';
        return;
    }

    tbody.innerHTML = state.users.map(u => `
        <tr class="align-middle">
            <td class="py-3 pr-3">
                <div class="flex items-center gap-2.5">
                    <span class="w-8 h-8 rounded-lg bg-gradient-to-tr from-violet-600 to-indigo-500 text-white text-[10px] font-bold flex items-center justify-center shrink-0">
                        ${esc((u.nome || u.email || '?').split(' ').slice(0, 2).map(p => p[0]).join('').toUpperCase())}
                    </span>
                    <div class="min-w-0">
                        <p class="font-semibold text-slate-800 dark:text-slate-100 truncate text-xs">${esc(u.nome) || '—'}</p>
                        <p class="text-[11px] text-slate-400 truncate">${esc(u.email)}</p>
                    </div>
                </div>
            </td>
            <td class="py-3 pr-3">
                <span class="px-2 py-1 rounded-lg text-[10px] font-bold uppercase ${u.perfil === 'admin'
                    ? 'bg-violet-100 text-violet-700 dark:bg-violet-900/50 dark:text-violet-300'
                    : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'}">
                    ${u.perfil === 'admin' ? 'Administrador' : 'Usuário'}
                </span>
            </td>
            <td class="py-3 pr-3">
                <span class="text-[11px] font-semibold ${u.ativo === false ? 'text-rose-500' : 'text-emerald-600'}">
                    <i class="fa-solid ${u.ativo === false ? 'fa-circle-xmark' : 'fa-circle-check'} mr-1"></i>
                    ${u.ativo === false ? 'Inativo' : 'Ativo'}
                </span>
                <p class="text-[10px] text-slate-400 mt-1">${esc(resumoAcessoUser(u))}</p>
            </td>
            <td class="py-3 text-right whitespace-nowrap">
                <button onclick="openUserModal('${u.id}')" class="p-2 rounded-lg text-slate-400 hover:text-violet-600 hover:bg-violet-50 dark:hover:bg-violet-950/40 transition-all" title="Editar">
                    <i class="fa-solid fa-pen text-xs"></i>
                </button>
                <button onclick="deleteUser('${u.id}')" class="p-2 rounded-lg text-slate-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/40 transition-all" title="Excluir" ${u.id === state.session?.user?.id ? 'disabled' : ''}>
                    <i class="fa-solid fa-trash text-xs"></i>
                </button>
            </td>
        </tr>`).join('');
}

function openUserModal(id) {
    if (!state.isAdmin) return toast('Somente o Administrador gerencia usuários.', 'erro');

    state.editingUserId = id || null;
    const user = id ? state.users.find(u => u.id === id) : null;

    $('#user-modal-title').textContent = user ? 'Editar usuário' : 'Novo usuário';
    $('#user-id').value = user?.id || '';
    $('#user-nome').value = user?.nome || '';
    $('#user-email').value = user?.email || '';
    $('#user-email').disabled = !!user;              // e-mail não muda depois de criado
    $('#user-password').value = '';
    $('#user-password').required = !user;
    $('#user-password-hint').textContent = user ? '(deixe vazio para manter)' : '(mín. 8 caracteres)';
    $('#user-perfil').value = user?.perfil || 'usuario';
    $('#user-ativo').value = String(user ? user.ativo !== false : true);
    $('#user-tipo-acesso').value = user?.tipo_acesso || 'creditos';
    $('#user-creditos').value = Number(user?.creditos_saldo) || 0;
    $('#user-periodo-quantidade').value = '1';
    $('#user-periodo-unidade').value = 'meses';
    $('#user-periodo-atual').textContent = '';
    if (user?.tipo_acesso === 'tempo' && user.acesso_expira_em) {
        const restante = Math.ceil((new Date(user.acesso_expira_em) - new Date()) / 86400000);
        if (restante > 0) {
            $('#user-periodo-quantidade').value = String(restante);
            $('#user-periodo-unidade').value = 'dias';
            $('#user-periodo-atual').textContent = `Validade atual: ${new Date(user.acesso_expira_em).toLocaleString('pt-BR')}. Ao salvar, o prazo será contado novamente a partir de agora.`;
        } else {
            $('#user-periodo-atual').textContent = 'Acesso expirado. Informe um novo período para renovar.';
        }
    }
    atualizarCamposAcessoUsuario();

    const modal = $('#user-modal');
    modal.classList.remove('hidden');
    modal.classList.add('flex');
}

function resumoAcessoUser(user) {
    if (user.perfil === 'admin') return 'Acesso administrativo';
    if (user.tipo_acesso === 'creditos') return `${Number(user.creditos_saldo) || 0} crédito(s)`;
    if (user.tipo_acesso === 'tempo') {
        return user.acesso_expira_em
            ? `Até ${new Date(user.acesso_expira_em).toLocaleDateString('pt-BR')}`
            : 'Período não definido';
    }
    return 'Acesso não configurado';
}

function atualizarCamposAcessoUsuario() {
    const admin = $('#user-perfil').value === 'admin';
    const porCreditos = $('#user-tipo-acesso').value === 'creditos';
    $('#user-access-settings').classList.toggle('hidden', admin);
    $('#user-creditos-wrap').classList.toggle('hidden', !porCreditos);
    $('#user-periodo-wrap').classList.toggle('hidden', porCreditos);
}

function closeUserModal() {
    const modal = $('#user-modal');
    modal.classList.add('hidden');
    modal.classList.remove('flex');
    $('#user-form').reset();
    state.editingUserId = null;
}

async function handleUserSubmit(event) {
    event.preventDefault();
    if (!state.isAdmin) return;

    const nome = $('#user-nome').value.trim();
    const email = $('#user-email').value.trim().toLowerCase();
    const senha = $('#user-password').value;
    const perfil = $('#user-perfil').value;
    const ativo = $('#user-ativo').value === 'true';
    const tipo_acesso = $('#user-tipo-acesso').value;
    const creditosInformados = Number($('#user-creditos').value);
    if (perfil !== 'admin' && tipo_acesso === 'creditos' && (!Number.isInteger(creditosInformados) || creditosInformados < 0)) {
        return toast('Informe uma quantidade inteira de créditos igual ou maior que zero.', 'erro');
    }
    const creditos_saldo = perfil === 'admin' ? 0 : creditosInformados;
    let acesso_expira_em = null;

    if (perfil !== 'admin' && tipo_acesso === 'tempo') {
        const quantidade = parseInt($('#user-periodo-quantidade').value, 10);
        if (!Number.isInteger(quantidade) || quantidade < 1) return toast('Informe um período de acesso válido.', 'erro');
        const validade = new Date();
        if ($('#user-periodo-unidade').value === 'meses') {
            const dia = validade.getDate();
            validade.setDate(1);
            validade.setMonth(validade.getMonth() + quantidade);
            const ultimoDia = new Date(validade.getFullYear(), validade.getMonth() + 1, 0).getDate();
            validade.setDate(Math.min(dia, ultimoDia));
        } else {
            validade.setDate(validade.getDate() + quantidade);
        }
        acesso_expira_em = validade.toISOString();
    }

    if (!nome || !email) return toast('Preencha nome e e-mail.', 'erro');

    // ---------- CRIAR ----------
    if (!state.editingUserId) {
        if (!senha || senha.length < 8) return toast('A senha precisa ter no mínimo 8 caracteres.', 'erro');

        const { data, error } = await db.auth.signUp({
            email,
            password: senha,
            options: {
                data: { nome, perfil },             // vai para user_metadata (fallback)
                emailRedirectTo: urlDeRetorno()
            }
        });
        if (error) return toast('Erro ao criar login: ' + error.message, 'erro');

        const userId = data.user?.id;
        const { error: perfisError } = await db.from('perfis').insert({
            id: userId, nome, email, perfil, ativo,
            tipo_acesso: perfil === 'admin' ? 'creditos' : tipo_acesso,
            creditos_saldo,
            acesso_expira_em
        });
        if (perfisError) {
            console.error('[perfis insert]', perfisError.message);
            return toast('Login criado, mas o perfil/acesso não foi salvo. Execute a atualização do schema.sql e confira as permissões do banco de dados.', 'erro');
        }

        toast('Usuário criado com sucesso!');
        closeUserModal();
        loadUsers();
        return;
    }

    // ---------- EDITAR ----------
    const userId = state.editingUserId;
    const { error } = await db.from('perfis')
        .update({
            nome, perfil, ativo,
            tipo_acesso: perfil === 'admin' ? 'creditos' : tipo_acesso,
            creditos_saldo,
            acesso_expira_em
        })
        .eq('id', userId);

    if (error) return toast('Erro ao atualizar: ' + error.message, 'erro');

    if (senha) await alterarSenhaViaEdgeFunction(state.editingUserId, senha);

    toast('Usuário atualizado!');
    closeUserModal();
    loadUsers();
    if (userId === state.session?.user?.id) await loadProfile(state.session.user);
}

async function deleteUser(id) {
    if (!state.isAdmin) return;
    if (id === state.session?.user?.id) return toast('Você não pode excluir o próprio usuário.', 'erro');

    const alvo = state.users.find(u => u.id === id);
    if (!confirm(`Excluir o usuário ${alvo?.email || ''}?`)) return;

    // 1) Tenta excluir de verdade via Edge Function (service role no backend)
    const removido = await chamarEdgeFunction('DELETE', { id });

    // 2) Sem Edge Function: remove/inativa o perfil (o login continua existindo)
    const { error } = removido
        ? await db.from('perfis').delete().eq('id', id)
        : await db.from('perfis').update({ ativo: false }).eq('id', id);

    if (error) return toast('Erro ao excluir: ' + error.message, 'erro');

    toast(removido
        ? 'Usuário excluído com sucesso.'
        : 'Usuário inativado (para excluir o login, publique a Edge Function `admin-users`).');
    loadUsers();
}

async function alterarSenhaViaEdgeFunction(userId, senha) {
    const ok = await chamarEdgeFunction('PATCH', { id: userId, password: senha });
    if (!ok) console.warn('[admin-users] Edge Function indisponível: a senha não foi alterada na autenticação.');
    return ok;
}

/** Chama a Edge Function `admin-users` (usa a service role SOMENTE no backend). */
async function chamarEdgeFunction(method, body) {
    try {
        const { error } = await db.functions.invoke('admin-users', {
            method,
            body: JSON.stringify(body)
        });
        if (error) { console.warn('[admin-users]', error.message); return false; }
        return true;
    } catch (e) {
        console.warn('[admin-users]', e.message);
        return false;
    }
}

/* =============================================================================
 * 13. UTILITÁRIOS
 * ======================================================================== */
function esc(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d)) return iso;
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' }) +
        ' · ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function fmtBytes(bytes) {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return (bytes / Math.pow(1024, i)).toFixed(i ? 1 : 0) + ' ' + units[i];
}

function safeName(name) {
    return String(name || 'arquivo').replace(/[^\w.\-]+/g, '_').slice(-80);
}

function base64ToBlob(base64, mime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    let limpo = String(base64);
    const match = limpo.match(/^data:([^;]+);base64,(.*)$/);
    if (match) { mime = match[1]; limpo = match[2]; }
    limpo = limpo.replace(/\s/g, '');

    const bin = atob(limpo);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
}

function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(String(reader.result).split(',')[1] || '');
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

function toast(message, tipo = '') {
    const box = document.createElement('div');
    const cor = tipo === 'erro'
        ? 'text-rose-500'
        : (tipo === 'info' ? 'text-amber-500' : 'text-emerald-500');
    box.className = 'bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 px-4 py-3 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-800 text-xs font-semibold flex items-start gap-2 transform translate-y-10 opacity-0 transition-all duration-300 max-w-xs';
    box.innerHTML = `<i class="fa-solid ${tipo === 'erro' ? 'fa-circle-exclamation' : 'fa-circle-check'} ${cor} mt-0.5"></i><span>${esc(message)}</span>`;
    $('#toast-container').appendChild(box);
    setTimeout(() => box.classList.remove('translate-y-10', 'opacity-0'), 80);
    setTimeout(() => {
        box.classList.add('translate-y-10', 'opacity-0');
        setTimeout(() => box.remove(), 300);
    }, 4000);
}

/* =============================================================================
 * 14. BOOTSTRAP
 * ======================================================================== */
document.addEventListener('DOMContentLoaded', async () => {
    applyInitialTheme();
    const recoveryInUrl = new URLSearchParams(location.hash.replace(/^#/, '')).get('type') === 'recovery';

    // Toggle de tema nas duas telas (login e painel)
    $('#theme-toggle')?.addEventListener('click', toggleTheme);
    $('#theme-toggle-login')?.addEventListener('click', toggleTheme);

    if (!initSupabase()) return;

    setupDropzone();
    $('#login-form').addEventListener('submit', handleLogin);
    $('#forgot-password-btn').addEventListener('click', requestPasswordRecovery);
    $('#password-recovery-form').addEventListener('submit', handlePasswordRecoverySubmit);
    $('#user-form').addEventListener('submit', handleUserSubmit);
    $('#user-tipo-acesso').addEventListener('change', atualizarCamposAcessoUsuario);
    $('#user-perfil').addEventListener('change', atualizarCamposAcessoUsuario);
    document.addEventListener('click', (e) => {
        if (!e.target.closest('#user-menu') && !e.target.closest('[onclick*="toggleUserMenu"]')) toggleUserMenu(false);
    });

    // Escuta eventos antes de obter a sessão para capturar PASSWORD_RECOVERY.
    db.auth.onAuthStateChange((event, session) => {
        if (event === 'PASSWORD_RECOVERY' && session) {
            openPasswordRecoveryModal(session);
            return;
        }
        if (event === 'SIGNED_IN' && session) {
            queueMicrotask(async () => {
                if (state.passwordRecoveryPending) return;
                await enterApp(session);
                showLoginError('');
            });
        }
        if (event === 'SIGNED_OUT') showScreen('login');
    });

    // Estado inicial da autenticação
    const { data: { session } } = await db.auth.getSession();
    if (recoveryInUrl || state.passwordRecoveryPending) {
        if (session) openPasswordRecoveryModal(session);
        else {
            showScreen('login');
            showLoginError('O link de recuperação expirou ou já foi usado. Solicite um novo.');
        }
    } else if (session) {
        await enterApp(session);
    } else {
        showScreen('login');
    }

    paintWebhookBadge();

    // Histórico do navegador: voltar/avançar entre as telas e manter a última
    // tela aberta ao recarregar ou voltar para a aba do site.
    window.addEventListener('popstate', voltarParaTelaDoHistory);
    window.addEventListener('hashchange', voltarParaTelaDoHistory);
    // Alguns navegadores restauram/reativam a página ao voltar de outra aba.
    // Reaplica a última tela persistida sem criar uma nova entrada no histórico.
    window.addEventListener('pageshow', () => {
        if (state.session && SCREENS.includes(localStorage.getItem(SCREEN_KEY))) {
            navigate(localStorage.getItem(SCREEN_KEY), { silent: true, noScroll: true });
        }
    });
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && state.session) {
            const screen = localStorage.getItem(SCREEN_KEY);
            if (SCREENS.includes(screen) && screen !== state.screen) {
                navigate(screen, { silent: true, noScroll: true });
            }
        }
    });
});
