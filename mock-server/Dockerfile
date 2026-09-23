FROM node:20-slim

WORKDIR /app

RUN npm install --no-audit --no-fund express axios jsonwebtoken jwks-rsa

COPY server.js .

ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
