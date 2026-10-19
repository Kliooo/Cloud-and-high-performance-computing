FROM nginxinc/nginx-unprivileged:1.27-alpine

# The unprivileged image runs as uid 101 and listens on 8080, so the container
# does not need root or the NET_BIND_SERVICE capability.
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY public/ /usr/share/nginx/html/

EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=2s --retries=3 \
    CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
