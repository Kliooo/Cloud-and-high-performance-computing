# Cloud-and-high-performance-computing

Course assignments.

## [retro-rally](retro-rally)

Cloud VM deployment (assignment 1): a browser racing game with an online leaderboard, served by a
Node.js application (no npm dependencies) that runs on a **cloud.ru** virtual machine behind nginx.

* the game itself: HTML5 Canvas, procedurally drawn tracks, checkpoints, bots, keyboard controls
* online features: 2–4 player lobby over Server-Sent Events (rooms, password lock, ready check,
  chat, synchronised start), pilot registry and an admin panel
* leaderboard with track tabs and mode filter (`training` / `vs bots` / `multiplayer`)
* deployment assets: `deploy/retro-rally.service` (systemd), `deploy/nginx-retro-rally.conf`,
  `deploy/deploy-cloudru.ps1` (one-command deploy), `deploy/Dockerfile`

Full description: [retro-rally/README.md](retro-rally/README.md)

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

Full description: [docker-containers-basics/README.md](docker-containers-basics/README.md)

## [kubernetes-basics](kubernetes-basics)

Kubernetes basics (assignment 3): a replicated Node.js backend behind a `ClusterIP` Service and an
nginx frontend published with a `LoadBalancer` Service, so it gets an IP address usable outside the
cluster. The page shows which replica answered each request, which makes load balancing and HPA
scaling observable.

* manifests: 2 Deployments, 2 Services, ConfigMap, HPA (3…8 replicas at 60% CPU), PodDisruptionBudget
* kustomize base plus `local` (kind, NodePort) and `cloud` (VM, LoadBalancer on :8081) overlays
* images built from `backend/` and `frontend/`, imported into the k3s containerd
* `scripts/` — bootstrap, build, deploy, smoke test, load test; CI validates the manifests with kubeconform

Live demo: <http://176.109.100.164:8081/> (also at <http://176.109.100.164/k8s-demo/>)

Full description: [kubernetes-basics/README.md](kubernetes-basics/README.md)

## [rabbitmq-messaging](rabbitmq-messaging)

Messaging for inter-service communication (assignment 4): a producer publishes calculation jobs to
a topic exchange with a per-operation routing key, the consumers compute them and write the results
to the log, and whatever cannot be computed is rejected into a dead-letter queue.

* one image, three entry points — producer, consumer and a tool that reads the dead-letter queue
* topology declared by the services themselves: topic exchange, durable work queue, direct
  dead-letter exchange, DLQ, and `mandatory` publishing so nothing is dropped silently
* guarantees: persistent messages, publisher confirms, manual ack with a bounded prefetch
* runs on Docker Compose (RabbitMQ + producer + consumer) or Kubernetes (kustomize base with
  local and cloud overlays, probes, PVC, PodDisruptionBudget)
* 50 tests (unit plus an end-to-end flow against a toy broker) and `scripts/smoke-test.sh`,
  which passes against a real RabbitMQ 3.13: routing keys, computed results, dead-lettering with
  `x-death`, and two consumers sharing one queue

Full description: [rabbitmq-messaging/README.md](rabbitmq-messaging/README.md)
