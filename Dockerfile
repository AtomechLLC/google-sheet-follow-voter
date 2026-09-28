FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY src ./src
COPY public ./public
ENV PORT=3000 DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 3000
CMD ["node", "src/server.js"]
