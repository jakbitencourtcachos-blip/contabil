/* =============================================================================
 * app.js  —  ANÁLIA | Sistema de Gerenciamento de Análise de Processos Contábeis
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

/* --- Estado global da aplicação ------------------------------------------ */
const state = {
    session: null,
    profile: null,
    isAdmin: false,
    processos: [],
    users: [],
    webhookUrl: '',
    file: null,            // PDF selecionado na dropzone
    lastResult: null,      // retorno do n8n (resumo + word)
    editingUserId: null,
    abortController: null,
    processingTimer: null
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
        toast('Biblioteca do Supabase não carregou (verifique a conexão).', 'erro');
        return null;
    }
    if (!CRED.URL || !CRED.ANON_KEY) {
        toast('Credenciais do Supabase ausentes. Preencha o config.js (cred.sbase.txt).', 'erro');
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
    // O listener onAuthStateChange cuida da entrada no painel
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
    state.processos = [];
    state.users = [];
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
            ativo: true
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

    const role = $('#menu-user-role');
    role.textContent = state.isAdmin ? 'Administrador' : 'Usuário Padrão';
    role.className = state.isAdmin
        ? 'inline-flex items-center gap-1 mt-2 px-2 py-0.5 rounded-lg text-[10px] font-bold uppercase tracking-wide bg-violet-600 text-white'
        : 'inline-flex items-center gap-1 mt-2 px-2 py-0.5 rounded-lg text-[10px] font-bold uppercase tracking-wide bg-violet-100 text-violet-700 dark:bg-violet-900/50 dark:text-violet-300';

    // Só o Administrador vê as Configurações
    $('#nav-config').classList.toggle('hidden', !state.isAdmin);
    $('#nav-config-mobile').classList.toggle('hidden', !state.isAdmin);
    $('#menu-config-btn').classList.toggle('hidden', !state.isAdmin);
}

/** Entra no painel (após login ou ao restaurar sessão). */
async function enterApp(session) {
    state.session = session;
    showScreen('app');
    await loadProfile(session.user);
    await Promise.all([loadWebhookUrl(), loadProcessos()]);
    if (state.isAdmin) await loadUsers();
}

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
        navigate('dashboard');
    }
}

/* =============================================================================
 * 5. NAVEGAÇÃO ENTRE TELAS
 * ======================================================================== */
function navigate(screen) {
    if (!state.session && screen !== 'login') return showScreen('login');

    if (screen === 'config' && !state.isAdmin) {
        toast('Área restrita ao Administrador.', 'erro');
        screen = 'dashboard';
    }

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

    window.scrollTo({ top: 0, behavior: 'smooth' });

    if (screen === 'dashboard') loadProcessos();
    if (screen === 'config' && state.isAdmin) { loadWebhookUrl(); loadUsers(); }
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
        if (!silent) toast('Tabela `processos` indisponível — rode o schema.sql no Supabase.', 'erro');
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
                        <h3 class="font-bold text-slate-900 dark:text-white text-sm truncate">${esc(p.cliente) || 'Sem cliente'}</h3>
                        <p class="text-[11px] text-slate-400 truncate">${esc(p.numero_processo) || 'Sem nº de processo'}</p>
                    </div>
                </div>
                <span class="shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[10px] font-bold uppercase tracking-wide ${st.cls}">
                    <i class="fa-solid ${st.icon} ${p.status === 'processando' ? 'animate-spin' : ''}"></i>${st.label}
                </span>
            </div>

            <div class="mt-4 space-y-1.5 text-[11px] text-slate-500 dark:text-slate-400">
                <p><i class="fa-solid fa-building w-4 text-slate-300 dark:text-slate-600"></i> ${esc(p.orgao) || '—'}</p>
                <p><i class="fa-solid fa-scale-balanced w-4 text-slate-300 dark:text-slate-600"></i> ${esc(p.tipo_analise) || '—'}</p>
                <p><i class="fa-solid fa-calendar w-4 text-slate-300 dark:text-slate-600"></i> ${fmtDate(p.created_at)}</p>
            </div>

            <p class="mt-3 text-xs text-slate-600 dark:text-slate-400 line-clamp-3 flex-grow">${esc(p.resumo) || 'Sem resumo disponível ainda.'}</p>

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

    $('#process-modal-content').innerHTML = `
        <span class="text-xs font-semibold text-violet-600 dark:text-violet-400 uppercase tracking-wider">Processo salvo</span>
        <h2 class="text-2xl font-extrabold text-slate-900 dark:text-white mt-1 pr-8">${esc(p.cliente) || 'Sem cliente'}</h2>
        <div class="flex flex-wrap items-center gap-2 mt-2 text-xs text-slate-500">
            <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg font-bold ${st.cls}">
                <i class="fa-solid ${st.icon}"></i>${st.label}
            </span>
            <span>·</span><span>${fmtDate(p.created_at)}</span>
            ${p.numero_processo ? `<span>·</span><span>Nº ${esc(p.numero_processo)}</span>` : ''}
        </div>

        <div class="grid sm:grid-cols-2 gap-4 mt-6">
            ${infoBox('fa-id-card', 'Documento', p.documento)}
            ${infoBox('fa-building', 'Órgão / Vara', p.orgao)}
            ${infoBox('fa-balance-scale', 'Tipo de análise', p.tipo_analise)}
            ${infoBox('fa-calendar-days', 'Competência', p.periodo)}
            ${infoBox('fa-envelope', 'E-mail', p.email)}
            ${infoBox('fa-phone', 'Telefone', p.telefone)}
        </div>

        ${p.observacoes ? `<div class="mt-4 p-4 rounded-2xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700">
            <p class="text-[11px] font-bold uppercase tracking-wide text-violet-600 dark:text-violet-400 mb-1">Observações</p>
            <p class="text-sm text-slate-600 dark:text-slate-300">${esc(p.observacoes)}</p></div>` : ''}

        <div class="grid md:grid-cols-2 gap-4 mt-4">
            <div class="p-4 rounded-2xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700">
                <p class="text-[11px] font-bold uppercase tracking-wide text-violet-600 dark:text-violet-400 mb-2">Resumo da análise</p>
                <div class="text-sm text-slate-600 dark:text-slate-300 whitespace-pre-wrap max-h-64 overflow-y-auto">${esc(p.resumo) || '—'}</div>
            </div>
            <div class="p-4 rounded-2xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700">
                <p class="text-[11px] font-bold uppercase tracking-wide text-violet-600 dark:text-violet-400 mb-2">Dados / bases</p>
                <div class="text-sm text-slate-600 dark:text-slate-300 max-h-64 overflow-y-auto">${renderDados(p.resposta)}</div>
            </div>
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
    modal.classList.remove('hidden');
    modal.classList.add('flex');
}

function closeProcessModal() {
    const modal = $('#process-modal');
    modal.classList.add('hidden');
    modal.classList.remove('flex');
}

function infoBox(icon, label, value) {
    return `<div class="p-4 rounded-2xl bg-white dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700">
        <p class="text-[11px] text-slate-400 flex items-center gap-1.5"><i class="fa-solid ${icon} text-violet-500"></i>${label}</p>
        <p class="text-sm font-semibold text-slate-800 dark:text-slate-100 mt-1">${esc(value) || '—'}</p>
    </div>`;
}

async function deleteProcesso(id) {
    if (!confirm('Excluir este processo do Supabase (incluindo os arquivos)?')) return;

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

    const campos = {};
    ['cliente', 'documento', 'numero_processo', 'orgao', 'periodo', 'tipo_analise', 'email', 'telefone', 'observacoes']
        .forEach(id => campos[id] = $('#' + id).value.trim());

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
            : ('Falha ao chamar o n8n: ' + err.message);
        console.error('[n8n]', err);
    } finally {
        stopProcessing();
        $('#btn-send').disabled = false;
    }

    const normalizado = resposta ? normalizeN8nResponse(resposta) : null;
    state.lastResult = normalizado;

    if (falha) {
        toast(falha, 'erro');
        await saveProcesso({ status: 'erro', resumo: falha, resposta: null, campos });
        return;
    }

    showResult(normalizado);
    await saveProcesso({
        status: 'concluido',
        resumo: normalizado.resumo,
        resposta: normalizado.dadosBrutos,
        campos
    });
    toast('Análise concluída e salva no Supabase!');
}

/** Lê a resposta do n8n: JSON, texto puro ou binário (próprio .docx). */
async function parseN8nResponse(response) {
    const ct = (response.headers.get('content-type') || '').toLowerCase();

    if (ct.includes('wordprocessingml') || ct.includes('msword') || ct.includes('octet-stream')) {
        const blob = await response.blob();
        return { arquivo_base64: await blobToBase64(blob), resumo: 'Arquivo Word devolvido pelo n8n.' };
    }
    if (ct.includes('json')) return await response.json();

    const texto = await response.text();
    try { return JSON.parse(texto); } catch (e) { return { resumo: texto }; }
}

/**
 * Normaliza os formatos mais comuns de retorno do n8n:
 *   { resumo, arquivo_base64 } | { resumo, file_url } | { data: {...} } | attachments[]
 */
function normalizeN8nResponse(raw) {
    let data = raw;
    if (data && typeof data === 'object' && data.data && typeof data.data === 'object') data = data.data;

    const resumo = pick(data, ['resumo', 'summary', 'resultado', 'analise', 'texto', 'descricao', 'answer', 'resposta']);
    const dados  = pick(data, ['dados', 'campos', 'valores', 'informacoes', 'calculos', 'bases', 'tabela', 'items']);

    // Word em base64
    let base64 = pick(data, ['arquivo_base64', 'docx_base64', 'word_base64', 'file_base64', 'documento_base64', 'arquivoWord', 'base64']);
    if (!base64 && Array.isArray(data?.attachments)) {
        const att = data.attachments.find(a => a && (a.data || a.base64 || a.content));
        if (att) base64 = att.data || att.base64 || att.content;
    }

    // Word por URL
    let url = pick(data, ['file_url', 'arquivo_url', 'docx_url', 'word_url', 'download_url', 'link']);
    if (!url) {
        const u = pick(data, ['url']);
        if (u && /docx|word|download|storage|blob/i.test(String(u))) url = u;
    }

    const nomeArquivo = pick(data, ['file_name', 'arquivo_nome', 'docx_nome', 'fileName', 'nome_arquivo']) || 'analise-processo.docx';

    return {
        resumo: typeof resumo === 'string' ? resumo : (resumo ? jsonToText(resumo) : 'Análise processada pelo n8n.'),
        dados: dados || null,
        dadosBrutos: data,
        base64: typeof base64 === 'string' ? base64 : null,
        url: typeof url === 'string' ? url : null,
        nomeArquivo
    };
}

function pick(obj, keys) {
    if (!obj || typeof obj !== 'object') return undefined;
    for (const k of keys) {
        if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
    }
    return undefined;
}

function jsonToText(obj) {
    if (Array.isArray(obj)) return obj.map(v => (typeof v === 'object' ? jsonToText(v) : String(v))).join('\n');
    if (typeof obj !== 'object') return String(obj);
    return Object.entries(obj).map(([k, v]) => `• ${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join('\n');
}

/** Renderiza os "dados/bases" devolvidos (tabela chave-valor ou lista). */
function renderDados(dados) {
    if (!dados) return '<span class="text-slate-400">—</span>';

    if (Array.isArray(dados)) {
        return `<ul class="space-y-1.5 text-sm list-disc list-inside">${dados.map(d =>
            `<li>${esc(typeof d === 'object' ? JSON.stringify(d) : d)}</li>`).join('')}</ul>`;
    }
    if (typeof dados === 'string') return `<div class="whitespace-pre-wrap">${esc(dados)}</div>`;
    if (typeof dados === 'object') {
        return `<dl class="space-y-1.5">${Object.entries(dados).map(([k, v]) => `
            <div class="flex items-start justify-between gap-3 text-xs">
                <dt class="text-slate-500 dark:text-slate-400">${esc(k)}</dt>
                <dd class="font-semibold text-slate-800 dark:text-slate-100 text-right">${esc(typeof v === 'object' ? JSON.stringify(v) : v)}</dd>
            </div>`).join('')}</dl>`;
    }
    return String(dados);
}

function showResult(r) {
    $('#result-resumo').textContent = r.resumo || '—';
    $('#result-dados').innerHTML = renderDados(r.dados);
    $('#result-saved').classList.add('hidden');
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

    if (r.base64) return downloadBase64Word(r.base64, r.nomeArquivo);
    if (r.url) return openExternal(r.url, r.nomeArquivo);
    toast('O n8n não devolveu o arquivo Word (use "arquivo_base64" ou "file_url").', 'erro');
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
    if (r?.base64) return downloadBase64Word(r.base64, r.nomeArquivo);
    if (r?.url) return openExternal(r.url, r.nomeArquivo);

    toast('Arquivo Word não disponível para este processo.', 'erro');
}

function downloadBase64Word(base64, nome) {
    const blob = base64ToBlob(base64, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = nome || 'analise-processo.docx';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast('Download do arquivo Word iniciado.');
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
        numero_processo: campos.numero_processo,
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
            const blob = base64ToBlob(r.base64);
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
        badge.className = 'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg font-bold bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-400';
        badge.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span> Configurado';
    } else {
        badge.className = 'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg font-bold bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400';
        badge.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-slate-400"></span> Não configurado';
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
    toast('URL do webhook do n8n salva no Supabase!');
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

    const modal = $('#user-modal');
    modal.classList.remove('hidden');
    modal.classList.add('flex');
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

    if (!nome || !email) return toast('Preencha nome e e-mail.', 'erro');

    // ---------- CRIAR ----------
    if (!state.editingUserId) {
        if (!senha || senha.length < 8) return toast('A senha precisa ter no mínimo 8 caracteres.', 'erro');

        const { data, error } = await db.auth.signUp({
            email,
            password: senha,
            options: { data: { nome, perfil } }     // vai para user_metadata (fallback)
        });
        if (error) return toast('Erro ao criar login: ' + error.message, 'erro');

        const userId = data.user?.id;
        const { error: perfisError } = await db.from('perfis').insert({
            id: userId, nome, email, perfil, ativo
        });
        if (perfisError) console.warn('[perfis insert]', perfisError.message);

        toast('Usuário criado com sucesso!');
        closeUserModal();
        loadUsers();
        return;
    }

    // ---------- EDITAR ----------
    const { error } = await db.from('perfis')
        .update({ nome, perfil, ativo })
        .eq('id', state.editingUserId);

    if (error) return toast('Erro ao atualizar: ' + error.message, 'erro');

    if (senha) await alterarSenhaViaEdgeFunction(state.editingUserId, senha);

    toast('Usuário atualizado!');
    closeUserModal();
    loadUsers();
    if (state.editingUserId === state.session?.user?.id) await loadProfile(state.session.user);
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
        ? 'Usuário excluído do Supabase Auth.'
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

    // Toggle de tema nas duas telas (login e painel)
    $('#theme-toggle')?.addEventListener('click', toggleTheme);
    $('#theme-toggle-login')?.addEventListener('click', toggleTheme);

    if (!initSupabase()) return;

    setupDropzone();
    $('#login-form').addEventListener('submit', handleLogin);
    $('#user-form').addEventListener('submit', handleUserSubmit);
    document.addEventListener('click', (e) => {
        if (!e.target.closest('#user-menu') && !e.target.closest('[onclick*="toggleUserMenu"]')) toggleUserMenu(false);
    });

    // Estado inicial da autenticação
    const { data: { session } } = await db.auth.getSession();
    if (session) {
        await enterApp(session);
    } else {
        showScreen('login');
    }

    // Escuta de login/logout (inclusive em outra aba)
    db.auth.onAuthStateChange(async (event, session) => {
        if (event === 'SIGNED_IN' && session) {
            await enterApp(session);
            showLoginError('');
            toast('Bem-vindo ao painel!');
        }
        if (event === 'SIGNED_OUT') showScreen('login');
    });

    paintWebhookBadge();
});
