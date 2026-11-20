# syntax=docker/dockerfile:1
FROM nginx:1.27-alpine

RUN apk add --no-cache jq && mkdir -p /etc/nginx/snippets

# Copy custom nginx configuration and runtime entrypoint
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY docker/entrypoint.sh /docker-entrypoint.d/40-efu-runtime.sh
RUN chmod +x /docker-entrypoint.d/40-efu-runtime.sh

# Clean default nginx html files and copy only static web assets
RUN rm -rf /usr/share/nginx/html/*
COPY index.html styles.css efu-core.js scans-demo-service.js scans-real-service.js scans-view.js app.js config.json /usr/share/nginx/html/
COPY demo /usr/share/nginx/html/demo

ENV SCANS_MODE=demo \
    SCANS_API_BASE=/api/scans \
    SCANS_API_UPSTREAM=http://efu-scanner:3001

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
