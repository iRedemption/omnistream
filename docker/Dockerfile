# ─────────────────────────────────────────────────────────────────
# OmniStream – Static site served by Nginx
# Build & Run with Compose:  docker-compose up -d --build
# Access at:  http://localhost:5500
# ─────────────────────────────────────────────────────────────────
FROM nginx:alpine

# Remove the default Nginx welcome page
RUN rm -rf /usr/share/nginx/html/*

# Copy all static assets into Nginx's web root
# Note: the build context is the project root (set in docker-compose.yml),
# so all paths here are relative to the repo root, not this docker/ folder.
COPY index.html               /usr/share/nginx/html/
COPY assets/omnistream.png    /usr/share/nginx/html/assets/
COPY css/                     /usr/share/nginx/html/css/
COPY js/                      /usr/share/nginx/html/js/

# Copy our custom Nginx configuration
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf

# Expose HTTP port
EXPOSE 80

# Nginx runs in the foreground by default in the official image
CMD ["nginx", "-g", "daemon off;"]
