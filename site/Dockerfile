# Build context is ./site:  docker build -t constans-site site
FROM caddy:2-alpine
COPY index.html platform.html security.html pricing.html styles.css site.js favicon.svg /srv/
COPY Caddyfile /etc/caddy/Caddyfile
USER 1000:1000
