# ---------- 构建阶段 ----------
FROM node:22-alpine AS build
WORKDIR /app

# 国内网络：走腾讯云 npm 源（可用 --build-arg NPM_REGISTRY=... 覆盖）
ARG NPM_REGISTRY=https://mirrors.cloud.tencent.com/npm/

COPY package.json package-lock.json ./
RUN npm ci --registry=$NPM_REGISTRY --no-audit --no-fund

COPY index.html vite.config.ts tsconfig.json tailwind.config.js postcss.config.js ./
COPY src ./src

# 内含 vue-tsc 类型检查，类型不过不产出镜像
RUN npm run build

# ---------- 运行阶段 ----------
FROM nginx:alpine

# 静态产物
COPY --from=build /app/dist /usr/share/nginx/html

# nginx 官方镜像入口脚本会对 /etc/nginx/templates/*.template 做 envsubst，
# 只会替换【环境里存在】的变量，nginx 自带的 $host/$uri 不受影响。
COPY nginx.conf /etc/nginx/templates/default.conf.template

# 运行时注入（compose 传进来）；不写默认值，避免误以为有值
ENV HERMES_API_SERVER_KEY=""

EXPOSE 80
