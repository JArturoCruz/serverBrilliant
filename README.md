# Brilliant Auth Server

Servidor de autenticación con [Better Auth](https://www.better-auth.com/), Express y SQLite.

## Requisitos

- Node.js 24 o superior
- npm

## Configuración

```powershell
npm install
Copy-Item .env.example .env
```

Edita `.env` y configura `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET` (mínimo 32 caracteres) y `CLIENT_ORIGINS` con los orígenes permitidos, separados por comas. No publiques `.env` ni la base de datos.

## Desarrollo

```powershell
npm run dev
```

El servidor escucha en el puerto indicado por `PORT` (3000 por defecto). `GET /health` devuelve el estado del servicio y las rutas de autenticación están bajo `/api/auth`.

## Compilar y probar

```powershell
npm test
npm start
```
