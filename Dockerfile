# ─────────────────────────────────────────────────────────────────
# OmniStream – Static site served by Nginx
# Build & Run with Compose:  docker-compose up -d --build
# Access at:  http://localhost:5500
# ─────────────────────────────────────────────────────────────────
FROM nginx:alpine

# Remove the default Nginx welcome page
RUN rm -rf /usr/share/nginx/html/*

# Copy all static assets into Nginx's web root
COPY index.html   /usr/share/nginx/html/
COPY style.css    /usr/share/nginx/html/
COPY script.js    /usr/share/nginx/html/
COPY omnistream.png /usr/share/nginx/html/

# Copy our custom Nginx configuration
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Expose HTTP port
EXPOSE 80

# Nginx runs in the foreground by default in the official image
CMD ["nginx", "-g", "daemon off;"]
