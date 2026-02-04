---
name: honey-inject
description: "Injects recovered context from Honey service after compaction"
metadata: {"openclaw":{"emoji":"🍯","events":["agent:bootstrap"],"requires":{}}}
---

# Honey Context Injection

Injects recent conversation context from the Honey service into the agent bootstrap.

## What It Does

- Listens for agent:bootstrap events
- Fetches recent context from Honey service (localhost:7779)
- Prepends recovered context to bootstrap files

## Requirements

- Honey service running on localhost:7779

## Configuration

No configuration needed.
