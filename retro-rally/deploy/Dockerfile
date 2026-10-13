# RETRO RALLY — image for container hosting (any Docker-compatible platform)
# Build:    docker build -f deploy/Dockerfile -t retro-rally .
# Run:      docker run -p 8080:8080 -e ADMIN_KEY=your-own-key retro-rally
# Data files (results.json, pilots.json, admin-key.txt) are created in /app/data —
# mount a volume if the data must survive container recreation.

FROM node:22-alpine

WORKDIR /app

# The project has no dependencies — copy just the code
# (the build context is the project root, so paths start with src/)
COPY src/package.json ./
COPY src/server.js ./
COPY src/lib ./lib
COPY src/public ./public

ENV PORT=8080
ENV HOST=0.0.0.0
EXPOSE 8080

CMD ["node", "server.js"]
