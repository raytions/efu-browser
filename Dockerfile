# syntax=docker/dockerfile:1
FROM nginx:1.27-alpine

# Copy custom nginx configuration
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf

# Copy static assets
COPY . /usr/share/nginx/html

# Reduce image size by removing default html files bundled with nginx
RUN rm -rf /usr/share/nginx/html/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
