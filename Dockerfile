FROM hmctsprod.azurecr.io/base/node:24-alpine

USER root
RUN apk add --no-cache git
USER hmcts

COPY --chown=hmcts:hmcts package*.json ./

RUN npm install --production

COPY --chown=hmcts:hmcts . .

CMD ["node", "app.js"]

EXPOSE 3000
