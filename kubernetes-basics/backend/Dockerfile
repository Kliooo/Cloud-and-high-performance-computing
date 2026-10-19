FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=8080

WORKDIR /app

# No npm install: the service only uses Node.js built-in modules.
COPY --chown=node:node package.json server.js ./

USER node

EXPOSE 8080

CMD ["node", "server.js"]
