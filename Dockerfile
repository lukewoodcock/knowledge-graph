FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
# Inside a container the service listens on every interface, or a published
# port can't reach it. Publish on the host's loopback only to keep it private:
#   docker run -p 127.0.0.1:5678:5678 ...
ENV HOST=0.0.0.0
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
EXPOSE 5678
CMD ["node", "dist/index.js"]
