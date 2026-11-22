# LWO Node

Overlay de picks y bans de League of Legends para OBS. Todo en Node: sin .NET, sin Caddy.

- `server/`: sirve el overlay y el admin, cachea los assets de Data Dragon y retransmite el estado por WebSocket (`/ws`).
- `agent/`: corre en el PC con League, lee el champ select del cliente y lo publica al servidor.
- `tools/gen-rooms.js`: crea salas con tokens aleatorios.

## Salas y tokens

Cada persona tiene una **sala** con su propio estado y tres tokens:

| Token   | Quien lo usa                 | Puede                                   |
| ------- | ---------------------------- | --------------------------------------- |
| `agent` | el agente (PC con League)    | escribir `session` y `summoners`        |
| `admin` | la pagina admin              | escribir `admin/*`                      |
| `view`  | el overlay en OBS            | solo leer                               |

```
npm install
node tools/gen-rooms.js yo        # crea rooms.json y muestra los enlaces
node tools/gen-rooms.js amigo     # otra sala, con su propio estado
npm run server
```

## Exponerlo a internet

El servidor escucha en `127.0.0.1:9345` (HTTP y WebSocket, mismo puerto). Con Tailscale Funnel:

```
tailscale funnel --bg 9345
```

URLs (reemplaza `TU-HOST` por `tu-maquina.tu-tailnet.ts.net`):

- Overlay (OBS): `https://TU-HOST/lol_picksandbans/overlay.html?token=<view>`
- Admin: `https://TU-HOST/lol_picksandbans/admin.html?token=<admin>`
- Agente: `node agent/agent.js "wss://TU-HOST/ws?token=<agent>"`

Para Cloudflare Tunnel, apunta el tunel a `http://localhost:9345`.

## Docker / Portainer

```
LWO_ROOMS='<contenido de rooms.json en una linea>'
```
y usa `docker-compose.yml`. El estado y la cache van en el volumen `/data`.

## Variables de entorno (servidor)

| Variable          | Por defecto  | Descripcion                                       |
| ----------------- | ------------ | ------------------------------------------------- |
| `PORT`            | `9345`       | Puerto                                            |
| `HOST`            | `127.0.0.1`  | Interfaz (en Docker: `0.0.0.0`)                   |
| `LWO_ROOMS`       | `rooms.json` | Salas y tokens en JSON                            |
| `DATA_DIR`        | `./data`     | Estado guardado y cache de assets                 |
| `ALLOWED_ORIGINS` | (vacio)      | Origenes permitidos para el WebSocket (opcional)  |

## Agente

Requiere Node 20+ en el PC con League (Windows). La URL puede ir como argumento, en `LWO_URL`
o en un archivo `agent.url.txt` junto a `agent.js`. Para entregarselo a un amigo sin que instale
Node se puede empaquetar con `npx @yao-pkg/pkg agent/agent.js -t node20-win-x64 -o LWOAgent.exe`.
