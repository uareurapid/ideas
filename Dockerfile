FROM node:20-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3737
ENV VOTES_DB_PATH=/data/votes.sqlite

RUN mkdir -p /data

EXPOSE 3737

CMD ["npm", "start"]
