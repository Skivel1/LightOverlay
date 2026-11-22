FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server/ server/
COPY tools/ tools/
ENV HOST=0.0.0.0 PORT=9345 DATA_DIR=/data
RUN mkdir /data && chown node:node /data
VOLUME /data
EXPOSE 9345
USER node
CMD ["node", "server/server.js"]
