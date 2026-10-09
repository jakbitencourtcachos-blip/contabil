# Configurações Git — GitHub

## Repositório

| Item     | Valor                                              |
|----------|----------------------------------------------------|
| URL      | https://github.com/jakbitencourtcachos-blip/contabil.git |
| Remoto   | `origin`                                           |
| Branch   | `main`                                             |
| Pasta    | `D:\Contabil\contabil`                             |

## Configuração do remoto (já aplicada)

```bash
git remote add origin https://github.com/jakbitencourtcachos-blip/contabil.git
git branch -M main
```

## Comandos de commit e sincronização

```bash
# 1. Ver o que mudou
git status
git diff

# 2. Adicionar arquivos (todos, ou específicos)
git add .
# git add index.html app.js

# 3. Commitar
git commit -m "Mensagem descrevendo a alteração"

# 4. Enviar para o GitHub
git push origin main
```

## Baixar atualizações do GitHub

```bash
git pull origin main
```

## Situação atual

- Branch `main` em sincronia com `origin/main`
- Último commit: `7701d05` — Sync production: Vice Contabil branding, dashboard stats, APP_BASE_URL
- Produção: https://contabil.jorgejfc.com.br
