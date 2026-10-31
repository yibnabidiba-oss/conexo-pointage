FROM node:22-alpine
ENV NODE_ENV=production DATA_DIR=/data APP_TZ=Africa/Casablanca PORT=3000
RUN apk add --no-cache tzdata
WORKDIR /app
COPY package.json server.js ./
COPY lib ./lib
COPY public ./public
VOLUME ["/data"]
EXPOSE 3000
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
