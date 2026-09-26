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
