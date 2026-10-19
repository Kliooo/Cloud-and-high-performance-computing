# Kubernetes basics demo — shortcuts around scripts/.
#
#   make up          deploy the cloud overlay
#   make test        run the end-to-end smoke test
#   make load        generate CPU load and watch the HPA
#   make status      pods, services, HPA

OVERLAY ?= cloud
URL ?= http://localhost:8081
NAMESPACE ?= k8s-demo

.PHONY: help up down status urls test load logs images validate

help:
	@echo "make up                  deploy k8s/overlays/$(OVERLAY)"
	@echo "make down                delete the namespace"
	@echo "make status              pods, services, HPA, PDB"
	@echo "make urls                frontend URL and image tags"
	@echo "make test                end-to-end smoke test ($(URL))"
	@echo "make load                CPU load, 45 s, 4 workers, HPA watch"
	@echo "make logs                backend logs (last 50 lines)"
	@echo "make images              build images and import them into k3s"
	@echo "make validate            kustomize build + kubeconform"

up:
	./scripts/deploy.sh $(OVERLAY)

down:
	./scripts/cleanup.sh $(OVERLAY)

status:
	kubectl -n $(NAMESPACE) get pods -o wide
	kubectl -n $(NAMESPACE) get svc
	kubectl -n $(NAMESPACE) get hpa
	kubectl -n $(NAMESPACE) get pdb

urls:
	kubectl -n $(NAMESPACE) get svc frontend -o wide
	kubectl -n $(NAMESPACE) get deploy -o custom-columns=NAME:.metadata.name,IMAGE:.spec.template.spec.containers[0].image

test:
	./scripts/smoke-test.sh $(URL)

load:
	./scripts/load-test.sh 45 4 $(URL)

logs:
	kubectl -n $(NAMESPACE) logs -l app=backend --tail=50 --prefix

images:
	./scripts/build-images.sh

validate:
	kubectl kustomize k8s/overlays/local > /tmp/k8s-demo-local.yaml
	kubectl kustomize k8s/overlays/cloud > /tmp/k8s-demo-cloud.yaml
	kubeconform -strict -summary -kubernetes-version 1.31.0 /tmp/k8s-demo-local.yaml /tmp/k8s-demo-cloud.yaml
