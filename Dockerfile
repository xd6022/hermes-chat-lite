# ---------- 构建阶段 ----------
FROM node:22-alpine AS build
WORKDIR /app

# 国内网络：走腾讯云 npm 源（可用 --build-arg NPM_REGISTRY=... 覆盖）
ARG NPM_REGISTRY=https://mirrors.cloud.tencent.com/npm/

COPY package.json package-lock.json ./
RUN npm ci --registry=$NPM_REGISTRY --no-audit --no-fund

COPY index.html vite.config.ts tsconfig.json tailwind.config.js postcss.config.js ./
COPY src ./src
# ⚠️ public/ 必须一起拷：vite 只把 public/ 下的文件原样拷进产物根目录。
#    这里漏掉它的后果特别隐蔽 —— 产物里没有 favicon.*，而 nginx 的 `try_files … /index.html`
#    会让这些请求以 **200 + text/html** 返回入口 HTML（不是 404），
#    浏览器拿到的"图标"其实是 HTML，于是 tab 上继续显示上一版图标，看着像"改了没生效"。
#    实测：宿主机本地 `vite build` 有 public/ → 全绿；镜像里没拷 → 线上就是这样翻的车。
COPY public ./public

# 内含 vue-tsc 类型检查，类型不过不产出镜像
RUN npm run build

# ★★ 构建期自检（2026-09-15 加）：产物根该有的都得有，缺一个就**在这里炸**，
#    而不是等线上去猜"图标怎么还是旧的"。配合上面 COPY public/ 那段注释看：
#    nginx 的 SPA 回落会把缺文件变成 200 + 入口 HTML，静默得查不出来。
#    这几个文件名直接对应 public/ 下的实际内容（改了 public/ 记得同步改这里）。
RUN test -f dist/index.html \
 && test -f dist/favicon.svg \
 && test -f dist/favicon.ico \
 && test -f dist/apple-touch-icon.png \
 && test -d dist/assets

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
