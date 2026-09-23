# Servidor do Resenha (inclui a interface web). Uso:
#   docker build -t resenha .
#   docker run -d -p 3000:3000 -e INVITE_CODE=segredo -v resenha-data:/app/server/data resenha
FROM node:22-alpine
WORKDIR /app
COPY server/package.json server/package-lock.json* server/
RUN cd server && npm install --omit=dev --no-audit --no-fund
COPY server/src server/src
COPY web web
ENV PORT=3000 DATA_DIR=./data
EXPOSE 3000
CMD ["node", "server/src/index.js"]
