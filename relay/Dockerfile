# Receipt System relay: no dependencies, just Node.
FROM node:22-alpine
WORKDIR /app
COPY package.json relay.js ./
ENV PORT=8080 DATA_DIR=/data
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
CMD ["node", "relay.js"]
