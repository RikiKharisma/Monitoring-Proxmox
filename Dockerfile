FROM node:20-alpine

# openssh-client: untuk membaca suhu CPU dari host Proxmox
RUN apk add --no-cache openssh-client

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY index.js servers.json ./

CMD ["npm", "start"]
