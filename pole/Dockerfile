FROM node:24-alpine
WORKDIR /app
RUN mkdir /data && chown node:node /data
COPY --chown=node:node public ./public
COPY --chown=node:node server.mjs package.json ./
ENV HOST=0.0.0.0 DATA_FILE=/data/pole.sqlite PORT=8080
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
