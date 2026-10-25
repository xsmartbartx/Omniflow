# Build context is ./site:  docker build -t omniflow-site site
FROM caddy:2-alpine
COPY *.html styles.css site.js favicon.svg /srv/
COPY Caddyfile /etc/caddy/Caddyfile
USER 1000:1000
