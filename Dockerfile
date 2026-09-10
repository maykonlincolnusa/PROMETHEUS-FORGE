FROM node:24-alpine AS production

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .

ENV NODE_ENV=production
EXPOSE 3000
USER node
CMD ["node", "server.js"]
