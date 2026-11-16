FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
ARG BCH_NETWORK=mainnet
ARG VITE_GITHUB_URL
ARG VITE_TELEGRAM_URL
ARG VITE_GALLERY_FEED_URL
ENV BCH_NETWORK=$BCH_NETWORK
RUN npm run build

FROM caddy:2-alpine
COPY Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/dist /srv
EXPOSE 8080
