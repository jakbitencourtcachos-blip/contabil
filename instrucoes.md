> **Contexto e Papel:**
> Aja como um Desenvolvedor Full-Stack Sênior especialista em HTML, CSS (Tailwind), JavaScript, integração de APIs e Supabase.
> Seu objetivo é transformar a estrutura visual, o layout e o tema de um arquivo de referência (um layout de delivery chamado Sabor Express) em um **Sistema Web de Gerenciamento de Análise de Processos Contábeis**.
> **Base de Design (Strict):**
> Utilize a exata configuração do Tailwind do arquivo de referência, incluindo:
> * Modo claro e escuro (`class="dark"` e os botões de toggle).
> * Paleta de cores baseada em `violet` (brand 50 a 900) e `slate`.
> * Fonte 'Inter' e ícones FontAwesome.
> * Efeitos de vidro (backdrop-blur), bordas arredondadas (`rounded-2xl`, `rounded-3xl`), botões com gradientes e sombras.
> * Navbar fixa no topo e transições suaves de cor.
> 
> 
> **Requisitos do Sistema e Funcionalidades:**
> **1. Banco de Dados e Autenticação (Supabase):**
> * O sistema deve utilizar o Supabase via CDN (JavaScript client).
> * As credenciais (URL e Anon Key) devem ser importadas de um arquivo/configuração simulada correspondente ao arquivo `cred.sbase.txt`.
> * Tipos de Perfil: **Administrador** e **Usuário Padrão**.
> * Deve haver um sistema de gerenciamento onde o Administrador possa criar, editar e excluir usuários.
> 
> 
> **2. Estrutura de Telas (Single Page Application ou Divs Ocultas):**
> O sistema deve conter as seguintes telas/seções (alternadas via JavaScript):
> * **Tela de Login:**
> * Uma interface limpa usando o fundo com gradiente do Hero section original.
> * Campos de e-mail e senha.
> 
> 
> * **Dashboard (Tela Inicial após Login):**
> * Um painel substituindo a grade de produtos original por uma tabela ou lista de cards elegantes mostrando os "Processos Salvos" (consultas anteriores).
> * Opções para filtrar processos por data ou status.
> 
> 
> * **Tela de "Novo Processo":**
> * Formulário para inserir os dados do cliente/empresa.
> * Uma área de **Upload de Arquivo (PDF)** estilizada (drag and drop).
> * Botão para "Enviar para Análise".
> 
> 
> * **Tela de Configurações (Apenas Administrador):**
> * Um painel onde o Administrador pode inserir e atualizar manualmente a **URL do Webhook do n8n**.
> * Gerenciamento de usuários.
> 
> 
> 
> 
> **3. Integração com Webhook (n8n):**
> * Quando o usuário criar um "Novo Processo" e enviar o PDF, o sistema deve capturar a URL do Webhook salva no banco de dados.
> * O JavaScript deve fazer um `POST` (fetch) para este webhook do n8n, enviando o arquivo PDF e as informações do formulário.
> * **Regra de Negócio Exigida:** O fluxo no n8n (assumido no backend) processará o PDF, extrairá as informações necessárias, fará os cálculos das bases contábeis, preencherá um arquivo Word e devolverá as respostas solicitadas prontas.
> * O frontend deve exibir um estado de "Processando..." (loading animado usando a identidade visual da página) e, ao receber a resposta do n8n, disponibilizar o botão para **"Baixar Arquivo Word"** e exibir o resumo na tela.
> * Após o retorno, todo esse processo (dados e arquivo gerado) deve ser salvo no Supabase para consulta futura no Dashboard.
> 
> 
> **Instruções de Saída:**
> 1. Escreva o código `index.html` completo contendo toda a estrutura visual de Tailwind e as divs das telas.
> 2. Forneça o bloco `<script>` ou um arquivo `app.js` detalhado com a lógica de:
> * Inicialização do Supabase.
> * Sistema de Login/Logout.
> * Navegação entre as telas (Login -> Dashboard -> Novo Processo).
> * Lógica de envio do formulário FormData para o webhook do n8n.
> * Salvamento e listagem dos processos no banco de dados.
> 
> 
> 3. Mantenha os comentários no código explicando onde os dados do `cred.sbase.txt` devem ser inseridos.
