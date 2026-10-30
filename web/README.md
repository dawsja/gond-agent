# Gond Agent workspace

React/Vite app served at `/agents/` by the Node server. Better Auth sessions use same-origin cookies at `/api/auth`; API requests use `/api/v1`, live streams `/ws/runs/:id`.

Run `npm ci`, `npm run lint`, and `npm run build`. For development use `npm run dev` and open `/agents/`; Vite proxies API and sockets to port 8787. Configure the API's public origin to match the browser origin for authentication.
