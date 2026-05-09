# Examples Reference

CLI batch examples and layout patterns for building diagrams.

---

## 3-Tier Architecture

```bash
echo '[
  {"command":"draw","type":"ellipse","id":"user","x":150,"y":50,"width":100,"height":60,"text":"User","stroke":"#1971c2","bg":"#e7f5ff"},
  {"command":"draw","type":"rect","id":"frontend","x":100,"y":180,"width":200,"height":80,"text":"Frontend\nNext.js","stroke":"#1971c2","bg":"#a5d8ff"},
  {"command":"draw","type":"rect","id":"api","x":100,"y":330,"width":200,"height":80,"text":"API Server\nExpress","stroke":"#2f9e44","bg":"#b2f2bb"},
  {"command":"draw","type":"rect","id":"database","x":100,"y":480,"width":200,"height":80,"text":"PostgreSQL\nDatabase","stroke":"#e8590c","bg":"#ffec99"},
  {"command":"draw","type":"arrow","from":"user","to":"frontend"},
  {"command":"draw","type":"arrow","from":"frontend","to":"api","text":"REST"},
  {"command":"draw","type":"arrow","from":"api","to":"database","text":"SQL"}
]' | excalidraw -f architecture.excalidraw batch
```

## Microservices with Shared Database

```bash
echo '[
  {"command":"draw","type":"rect","id":"gateway","x":250,"y":50,"width":200,"height":80,"text":"API Gateway","stroke":"#1971c2","bg":"#a5d8ff"},
  {"command":"draw","type":"rect","id":"auth","x":0,"y":220,"width":180,"height":80,"text":"Auth Service","stroke":"#862e9c","bg":"#e599f7"},
  {"command":"draw","type":"rect","id":"orders","x":250,"y":220,"width":180,"height":80,"text":"Order Service","stroke":"#2f9e44","bg":"#b2f2bb"},
  {"command":"draw","type":"rect","id":"notify","x":500,"y":220,"width":180,"height":80,"text":"Notification","stroke":"#e8590c","bg":"#ffd8a8"},
  {"command":"draw","type":"rect","id":"db","x":200,"y":400,"width":300,"height":80,"text":"PostgreSQL","stroke":"#1971c2","bg":"#ffec99"},
  {"command":"draw","type":"rect","id":"redis","x":550,"y":400,"width":180,"height":80,"text":"Redis Cache","stroke":"#c92a2a","bg":"#ffe3e3"},
  {"command":"draw","type":"arrow","from":"gateway","to":"auth"},
  {"command":"draw","type":"arrow","from":"gateway","to":"orders"},
  {"command":"draw","type":"arrow","from":"gateway","to":"notify"},
  {"command":"draw","type":"arrow","from":"auth","to":"db","text":"SQL"},
  {"command":"draw","type":"arrow","from":"orders","to":"db","text":"SQL"},
  {"command":"draw","type":"arrow","from":"orders","to":"redis","text":"cache"},
  {"command":"draw","type":"arrow","from":"orders","to":"notify","text":"events"}
]' | excalidraw -f microservices.excalidraw batch
```

## Incremental Addition with Piping

```bash
# Start with core components
echo '[
  {"command":"draw","type":"rect","id":"api","x":100,"y":100,"width":200,"height":100,"text":"API Server"},
  {"command":"draw","type":"rect","id":"db","x":100,"y":300,"width":200,"height":100,"text":"Database"},
  {"command":"draw","type":"arrow","from":"api","to":"db"}
]' | excalidraw -f d.excalidraw batch

# Render and inspect
excalidraw -f d.excalidraw view --scale 2

# Add more components
excalidraw -f d.excalidraw draw rect --id cache -x 400 -y 100 -w 200 -h 100 --text "Redis"
excalidraw -f d.excalidraw draw arrow --from api --to cache --text "GET/SET"

# Render focused view of just the api subgraph
excalidraw -f d.excalidraw query api --connected --ids | excalidraw -f d.excalidraw view -o api-subgraph.png

# Delete all arrows and redraw after rearranging
excalidraw -f d.excalidraw query --type arrow --ids | excalidraw -f d.excalidraw delete
```

## Grouping Example

```bash
echo '[
  {"command":"draw","type":"rect","id":"group-infra","x":50,"y":180,"width":650,"height":250,"stroke":"#9c36b5","bg":"transparent","strokeStyle":"dashed","roughness":0},
  {"command":"draw","type":"text","text":"Infrastructure Layer","id":"group-infra-label","x":70,"y":190,"fontSize":14,"fontFamily":"normal"},
  {"command":"draw","type":"rect","id":"k8s","x":80,"y":240,"width":180,"height":80,"text":"Kubernetes","stroke":"#1971c2","bg":"#a5d8ff"},
  {"command":"draw","type":"rect","id":"terraform","x":290,"y":240,"width":180,"height":80,"text":"Terraform","stroke":"#2f9e44","bg":"#b2f2bb"},
  {"command":"draw","type":"rect","id":"monitoring","x":500,"y":240,"width":180,"height":80,"text":"Grafana","stroke":"#e8590c","bg":"#ffd8a8"}
]' | excalidraw -f infra.excalidraw batch
```

---

## Layout Patterns

### Vertical Flow (Most Common)

```
Grid positioning:
- Column width: 200-250px
- Row height: 130-150px
- Element size: 160-200px x 80-100px
- Spacing: 40-50px between elements

Row positions (y):
  Row 0: 20   (title)
  Row 1: 100  (users/entry points)
  Row 2: 230  (frontend/gateway)
  Row 3: 380  (orchestration)
  Row 4: 530  (services)
  Row 5: 680  (data layer)
  Row 6: 830  (external services)

Column positions (x):
  Col 0: 100
  Col 1: 300
  Col 2: 500
  Col 3: 700
  Col 4: 900
```

### Horizontal Flow (Pipelines)

```
Stage positions (x):
  Stage 0: 100  (input/source)
  Stage 1: 350  (transform 1)
  Stage 2: 600  (transform 2)
  Stage 3: 850  (transform 3)
  Stage 4: 1100 (output/sink)

All stages at same y: 200
```

### Hub-and-Spoke

```
Center hub: x=500, y=350
8 positions at 45-degree increments:
  N:  (500, 150)    NE: (640, 210)
  E:  (700, 350)    SE: (640, 490)
  S:  (500, 550)    SW: (360, 490)
  W:  (300, 350)    NW: (360, 210)
```

---

## Diagram Complexity Guidelines

| Complexity   | Max Elements | Approach                     |
| ------------ | ------------ | ---------------------------- |
| Simple       | 5-10         | Single file, no groups       |
| Medium       | 10-25        | Use grouping rectangles      |
| Complex      | 25-50        | Split into multiple diagrams |
| Very Complex | 50+          | Multiple focused diagrams    |

**When to split:** More than 50 elements. Create `architecture-overview.excalidraw`, `architecture-data-layer.excalidraw`, etc.
