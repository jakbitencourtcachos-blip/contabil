# syntax=docker/dockerfile:1

FROM node:20-alpine AS build

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY . .

RUN if node -e "const p=require('./package.json');process.exit(p.scripts&&p.scripts.build?0:1)"; then \
        echo '==> npm run build'; \
        npm run build; \
    elif [ -f tsconfig.json ]; then \
        echo '==> npx tsc (TypeScript sem script de build)'; \
        npx tsc; \
    else \
        echo '==> Sem build: projeto estatico (JS puro)'; \
    fi

FROM node:20-alpine

WORKDIR /app

RUN npm install -g serve@14

COPY --from=build /app /app

EXPOSE 3000

ENV NODE_ENV=production

CMD sh -c 'if [ -d dist ]; then serve dist -l "${PORT:-3000}"; else serve . -l "${PORT:-3000}"; fi'
