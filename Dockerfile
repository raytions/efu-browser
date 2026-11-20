# syntax=docker/dockerfile:1
FROM nginx:1.27-alpine

# Copy custom nginx configuration
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf

# Clean default nginx html files and copy only static web assets
RUN rm -rf /usr/share/nginx/html/*
COPY index.html styles.css efu-core.js app.js config.json /usr/share/nginx/html/

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
