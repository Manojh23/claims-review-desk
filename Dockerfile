FROM node:22-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
USER node
ENV HOST=0.0.0.0 PORT=4173
EXPOSE 4173
CMD ["npm","start"]
