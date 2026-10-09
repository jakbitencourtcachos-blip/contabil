/* =============================================================================
 * config.js  —  ARQUIVO SIMULADO DO `cred.sbase.txt`
 * -----------------------------------------------------------------------------
 * Este arquivo reproduz, em formato JavaScript, as credenciais que estão no
 * arquivo `cred.sbase.txt` (credenciais do Supabase do projeto Contábil).
 *
 * >>> COLOQUE AQUI OS DADOS EXTRAÍDOS DO SEU `cred.sbase.txt` <<<
 *
 * Dentro do `cred.sbase.txt` original as linhas usadas são:
 *
 *   linha 3 : NEXT_PUBLIC_SUPABASE_URL=https://bvzcrhfkeaoizrwmjrun.supabase.co
 *   linha 4 : NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_aY5RnxYh20ZEVxg4MkJv_A_0AtnbOSC
 *   linha 22: sb_publishable_aY5RnxYh20ZEVxg4MkJv_A_0AtnbOSC  (mesma chave acima)
 *
 * ATENÇÃO DE SEGURANÇA:
 *   - Use APENAS a chave pública (anon / publishable) no FRONTEND.
 *   - NUNCA cole aqui a `sb_secret_...` (service role) nem a senha do banco:
 *     elas ficam SOMENTE no backend (edge functions / servidor).
 * ============================================================================= */

window.CRED_SBASE = {
    // URL do projeto Supabase -> linha "NEXT_PUBLIC_SUPABASE_URL" do cred.sbase.txt
    URL: 'https://bvzcrhfkeaoizrwmjrun.supabase.co',

    // Chave pública (anon / publishable) -> linha "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"
    ANON_KEY: 'sb_publishable_aY5RnxYh20ZEVxg4MkJv_A_0AtnbOSC'
};

/* =============================================================================
 * URL PÚBLICA DO SISTEMA (PRODUÇÃO)
 * -----------------------------------------------------------------------------
 * Usada pelo app.js nos links enviados por e-mail pelo Supabase
 * (recuperação de senha e confirmação/convite de cadastro), para que o e-mail
 * SEMPRE aponte para o domínio real e nunca para http://localhost:3000.
 *
 * ⚠️ ESSE DOMÍNIO TAMBÉM PRECISA ESTAR CONFIGURADO NO SUPABASE:
 *    Dashboard -> Authentication -> URL Configuration
 *      Site URL      : https://contabil.jorgejfc.com.br
 *      Redirect URLs : https://contabil.jorgejfc.com.br
 *                      https://contabil.jorgejfc.com.br/**
 *    (se o Site URL continuar como http://localhost:3000, o Supabase ignora o
 *     redirect enviado pelo app e reescreve o link do e-mail como localhost)
 * ============================================================================= */
window.APP_BASE_URL = 'https://contabil.jorgejfc.com.br';
