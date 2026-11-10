# RabbitMQ messaging demo — shortcuts around docker compose and scripts/.
#
#   make up        build and start the stack (broker, producer, consumer)
#   make test      unit tests inside the image, no broker needed
#   make smoke     end-to-end check: routing, results, dead-letter queue
#   make dlq       show what was rejected and why
#   make scale     three consumers on the same queue
#
# Run it with `make -C deploy <target>` from the project root, or from inside deploy/.

# $(CURDIR) is deploy/, so the compose file is always found no matter where make was started.
COMPOSE ?= docker compose -f $(CURDIR)/docker-compose.yml
NAMESPACE ?= rabbitmq-messaging

.PHONY: help up down ps logs stats test smoke dlq dlq-drain scale k8s-apply k8s-delete k8s-ui k8s-logs

help:
	@echo "make up          build images and start the stack"
	@echo "make down        stop everything and delete the broker volume"
	@echo "make ps          container status and health"
	@echo "make logs        follow producer and consumer logs"
	@echo "make stats       counters from the producer's /stats endpoint"
	@echo "make test        unit tests (runs inside the image)"
	@echo "make smoke       end-to-end check (add ARGS=--full to test durability)"
	@echo "make dlq         peek at the dead-letter queue"
	@echo "make dlq-drain   read the dead-letter queue and remove the messages"
	@echo "make scale       run three consumers against one queue"
	@echo "make k8s-apply   deploy k8s/overlays/cloud"
	@echo "make k8s-ui      port-forward the RabbitMQ management UI to localhost:15672"
	@echo "make k8s-logs    consumer logs from the cluster"
	@echo "make k8s-delete  delete the namespace"

up:
	$(COMPOSE) up -d --build
	@echo "management UI: http://localhost:15672  (123 / 123)"

down:
	$(COMPOSE) down -v --remove-orphans

ps:
	$(COMPOSE) ps

logs:
	$(COMPOSE) logs -f --tail=50 producer consumer

stats:
	$(COMPOSE) exec -T producer python -c "import json, urllib.request; print(json.dumps(json.load(urllib.request.urlopen('http://127.0.0.1:8080/stats')), indent=2))"

test:
	$(COMPOSE) run --rm --no-deps producer python -m unittest discover -s tests -t . -v

smoke:
	../scripts/smoke-test.sh $(ARGS)

dlq:
	$(COMPOSE) exec -T producer python -m app.dlq --limit 10

dlq-drain:
	$(COMPOSE) exec -T producer python -m app.dlq --limit 100 --drain

scale:
	$(COMPOSE) up -d --scale consumer=3
	$(COMPOSE) ps consumer

k8s-apply:
	kubectl apply -k ../k8s/overlays/cloud
	kubectl -n $(NAMESPACE) rollout status deployment/rabbitmq --timeout=180s
	kubectl -n $(NAMESPACE) get pods -o wide

k8s-ui:
	kubectl -n $(NAMESPACE) port-forward svc/rabbitmq-management 15672:15672

k8s-logs:
	kubectl -n $(NAMESPACE) logs -l app=consumer --tail=50 --prefix

k8s-delete:
	kubectl delete namespace $(NAMESPACE)
