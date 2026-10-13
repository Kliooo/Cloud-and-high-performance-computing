# Cloud-and-high-performance-computing

Course assignments.

## [docker-containers-basics](docker-containers-basics)

Containerization basics: a database (PostgreSQL 16) and an entry point (FastAPI) running in two
Docker containers joined by a shared network. All reads and writes go through the entry point,
and the data survives container restarts (named volume).

* `docker-compose.yml` — two services, network and volume
* `db/Dockerfile`, `api/Dockerfile` — one image per container
* `scripts/demo.sh` — end-to-end self-check (write, restart, read)
* full instructions: [docker-containers-basics/README.md](docker-containers-basics/README.md)

Images on Docker Hub:
[containers-basics-api](https://hub.docker.com/r/k1io/containers-basics-api) ·
[containers-basics-db](https://hub.docker.com/r/k1io/containers-basics-db)
