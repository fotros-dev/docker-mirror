FROM node:24-alpine
WORKDIR /app
COPY --chown=node:node package.json README.md LICENSE ./
COPY --chown=node:node src ./src
RUN ["node", "--input-type=module", "-e", "import {mkdir,chown} from 'node:fs/promises';await mkdir('/app/data',{mode:448});await chown('/app/data',1000,1000);"]
USER node
ENV HOST=0.0.0.0
ENV PUSH_ENABLED=false
EXPOSE 5000
CMD ["node", "src/main.js", "serve"]
