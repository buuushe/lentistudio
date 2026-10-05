COMPOSE := docker compose
PORT ?= 8080
export PORT

.DEFAULT_GOAL := up

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-8s\033[0m %s\n", $$1, $$2}'

up: ## Build and start the studio on http://localhost:$(PORT)
	$(COMPOSE) up -d --build --wait
	@echo "Lenti Studio is running at http://localhost:$(PORT)"

down: ## Stop the studio
	$(COMPOSE) down

logs: ## Follow the studio logs
	$(COMPOSE) logs -f --tail=100

clean: ## Stop the studio and delete uploaded frames and renders
	$(COMPOSE) down --volumes

test: ## Run server and web checks in Docker
	docker build --target server-test .
	docker build --target web-test .

.PHONY: help up down logs clean test
